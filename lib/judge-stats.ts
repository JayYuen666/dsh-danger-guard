// lib/judge-stats.ts —— 判定成本的**本地滚动统计**（每面一窗），零宿主依赖。
//
import type { StatsSnapshot } from "./stats-shape.ts";
import type { BashDenialKey, RuleTier } from "./danger-rules.ts";
import type { GuardMode } from "./mode-policy.ts";
// 形状单源在零依赖叶子模块（为什么：见那枚模块的文件头）。这里转发一枚，
// 让本模块的既有消费方（host 的接线与用例）不必改导入路径。
export type { StatsSnapshot } from "./stats-shape.ts";

// 为什么单列一枚模块：这段东西的读者不止判定链——它还是一条**运维读数**（设置卡那侧要
// 展示"最近拦了什么、慢在哪"），而 host.ts 已经顶到 `eslint/max-lines` 的 2000 行预算
// （新增规则族的接线没地方放）。抽出来两件事一起解掉：本模块只依赖 `console`，
// 判定链与卡片读数口都单向依赖它。
//
// 出域那一格**不在这里**：`judge-cost` 的 lesson-loop pass 由调用点按 `judgeStats` 决定
// （见 `lib/lesson-report.ts` 的 `sampleJudge`）——本模块只管本地（进程内、退出即消失）。
//
// 除了"耗时与输入规模"，这里还记**拦了什么**（按规则键）与**配额放行用了几次**：
// 前者是设置卡那一栏要展示的主体（"rmrf 5 · noVerify 4"），后者是"防死锁出口被用到了"
// 这条信号——它比任何命中数都更该被用户看见。

/** 一次判定的成本样本（哪个面、多久、多大的输入）。 */
export interface JudgeCost {
  face: string;
  ms: number;
  length: number;
}

/** 单次判定的耗时告警线：超过就立刻出声。参照点是实测数据——1MB 命令最坏 ~336ms、
 *  30 万字符深套 ~64ms、正常输入在 µs~ms 级。 */
export const SLOW_JUDGE_MS = 100;
/** 滚动摘要的窗口：攒够这么多次判定就发一条摘要并清零（看的是"最近这一段"的分布）。 */
export const STATS_WINDOW_CALLS = 200;
/** 耗时分档上界（ms）。 */
const MS_EDGES = [1, 5, 25, SLOW_JUDGE_MS];
/** 输入规模分档上界（字符）：常见命令量级一路到长度上限附近。 */
const LEN_EDGES = [256, 4096, 65_536, 262_144];

/** 每个面各自一窗样本。上限就是 `STATS_WINDOW_CALLS` 条/面——不是无界历史。 */
const samplesByFace = new Map<string, JudgeCost[]>();

/** 累计判定次数与其中的慢判定次数（按面）。**不受滚动窗口影响**：窗口每满一次就清零，
 *  而"这个面一共判了多少次"是只增的——两者回答的是不同问题。 */
const callsByFace = new Map<string, number>();
const slowByFace = new Map<string, number>();
/** 规则键命中次数（按键）。`deny` 与 `ask` 两挡**分开记**：用户要看的是"拦了什么"，
 *  而"直接拒了"与"问过用户"是两种不同的结论。 */
const hitsByKey = new Map<string, number>();
const askByKey = new Map<string, number>();
/** 按档位"看见了但没拦"的命中（规则键 / 档位各一格）。 */
const allowedByKey = new Map<string, number>();
const allowedByMode = new Map<string, number>();
/** 被去重掉的询问（同一会话同一命令重复命中）。 */
const skippedByKey = new Map<string, number>();
/** 事实门配额放行次数（防死锁出口）。它一旦非零，那条目标就带着长期免检。 */
let quotaReleases = 0;

/** 计数进表（`count` 的语义是"加一"而不是"设值"，写成函数免得每处都写一遍 `?? 0`）。 */
function bump(table: Map<string, number>, key: string): void {
  table.set(key, (table.get(key) ?? 0) + 1);
}

/** 落档计数：按升序上界数组给出各档样本数（末档是"最后一条上界之上"）。
 *  下界用游标推进而不是按下标取前一项——那样每处下标都要补一道永远走不到的兜底。 */
function bucketText(
  costs: readonly JudgeCost[],
  edges: readonly number[],
  pick: (cost: JudgeCost) => number,
  unit: string,
): string {
  const parts: string[] = [];
  let lower = 0;
  for (const edge of edges) {
    const from = lower;
    parts.push(
      `<${edge}${unit}=${costs.filter((cost) => pick(cost) >= from && pick(cost) < edge).length}`,
    );
    lower = edge;
  }
  parts.push(`>=${lower}${unit}=${costs.filter((cost) => pick(cost) >= lower).length}`);
  return parts.join(" ");
}

/** 记一次判定的成本：慢判定立刻出声，其余进滚动窗口，攒满一窗发一条摘要并清零。
 *  阈值与窗口撞的是计数与墙钟，用"造一条真要跑 100ms 的输入 / 跑满 200 次真实判定"去测
 *  会让 CI 随时钟与调用顺序抖动，而这两条判断本身与输入内容无关——所以两枚常量导出，
 *  用例按字面喂边界样本。 */
export function noteJudgeCost(cost: JudgeCost): void {
  const { face, ms, length } = cost;
  bump(callsByFace, face);
  if (ms >= SLOW_JUDGE_MS) {
    bump(slowByFace, face);
    console.warn(`[danger-guard] slow judge (${face}): ${ms.toFixed(1)}ms, input ${length} chars`);
  }
  const window = [...(samplesByFace.get(face) ?? []), cost];
  if (window.length < STATS_WINDOW_CALLS) {
    samplesByFace.set(face, window);
    return;
  }
  samplesByFace.set(face, []);
  const maxMs = Math.max(...window.map((item) => item.ms));
  const maxLen = Math.max(...window.map((item) => item.length));
  console.info(
    `[danger-guard] judge stats (${face}): calls=${window.length} ` +
      `ms[${bucketText(window, MS_EDGES, (item) => item.ms, "ms")}] ` +
      `maxMs=${maxMs.toFixed(1)} ` +
      `len[${bucketText(window, LEN_EDGES, (item) => item.length, "")}] maxLen=${maxLen}`,
  );
}

/** 没跑过判定 = 零长度样本（非 bash 调用的 bash 面、无路径键调用的密钥面）不发。 */
export const isJudged = (cost: JudgeCost): boolean => cost.length > 0;

/** 记一次**规则键命中**。`ask` 档另记一格：它表示"问过用户"而不是"拒了"。
 *  由 guard 的 deny 分支与 `tools/pre-execute` 的需确认分支各自调用——两处都调，
 *  所以"拦了什么"这件事在统计里是完整的。 */
export function noteRuleHit(key: BashDenialKey, tier: RuleTier): void {
  bump(tier === "ask" ? askByKey : hitsByKey, key);
}

/** 记一次"看见了但本档选择不动手"。
 *
 *  它与 `hits` / `asks` 分开记：那两格是"动手拦了"，这一格是"按当前档位没拦"。
 *  ⚠ 这一格**不专指**零兵底：自动审查档里交给 reviewer 的命中、已退役规则（长驻服务器）的
 *  命中也会落进来，所以读它是「这一档总共放过多少」，不是「用户选了完全不拦」。
 *  沙箱让路（`rmrf` 交给宿主）**不算**这一格——那是交给别人拦，不是放过。
 *
 *  @param mode 档位名。收窄到 `GuardMode` 是为了让调用点拼错时当场编译失败，
 *              而不是在读数里静默多出一个桶。 */
export function noteAllowedHit(key: BashDenialKey, mode: GuardMode): void {
  bump(allowedByKey, key);
  bump(allowedByMode, mode);
}

/** 记一次**重复命中未再上报**（同一会话 + 同一规则键 + 同一命令原文又命中了一次）。
 *
 *  ⚠ 被去重的那次**仍然会弹给用户**（判定照旧是 `ask`，证据也照旧量）——
 *  这一格表达的是"教训卡没有为同一条命令再炸一张"，不是"用户少被打扰一次"。
 *  所以 `asks` 也不再等于"用户被问过几次"，两者读法不同。 */
export function noteAskSkipped(key: BashDenialKey): void {
  bump(skippedByKey, key);
}

/** 记一次事实门的**配额放行**（连续未收敛拒绝达上限后的出口）。 */
export function noteQuotaRelease(): void {
  quotaReleases += 1;
}

/** 把一张 `Map<string, number>` 折成普通对象（JSON 值的要求）。 */
const recordOf = (table: Map<string, number>): Record<string, number> => Object.fromEntries(table);

/** 快照。**每趟现读**（设置卡那侧每次打开/刷新都该看到当下的数），不做缓存：
 *  表都是个位数量级的键，折一遍比维护一层失效便宜。 */
export function statsSnapshot(): StatsSnapshot {
  return {
    calls: recordOf(callsByFace),
    slow: recordOf(slowByFace),
    hits: recordOf(hitsByKey),
    asks: recordOf(askByKey),
    allowed: recordOf(allowedByKey),
    allowedByMode: recordOf(allowedByMode),
    skipped: recordOf(skippedByKey),
    quotaReleases,
    slowMs: SLOW_JUDGE_MS,
    window: STATS_WINDOW_CALLS,
  };
}
