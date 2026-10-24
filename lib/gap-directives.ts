// lib/gap-directives.ts —— 把缺项翻成**可照做的行动指令**：`need × why` 全表 + 缺项的规范顺序。
//
// 为什么从 lib/fact-gate.ts 拆出来：状态机那一半决定"还缺哪几项、要不要放行"，这一半决定
// "那几项分别该做什么"，两半的读者并不相同——host 只喂结构、渲染在 guard 调用点现做，而
// `renderDenyMessage` 与 `needsKey` 各自要用的是这里的一个出口。此前两半同住一个文件，
// 只有状态机内部用到的那两枚符号就只剩测试在取用，`fallow --production` 把它们判成
// 「只被测试养着的导出面」。
//
// NEED_ORDER 与指令表是同一枚枚举的两个面：表由 `Record<FactNeed, …>` 在编译期要求补齐，
// 顺序表只能靠运行时的自检用例钉住"覆盖全部字面量"（漏一项 = `needsKey` 的收敛比对静默丢项，
// 模型补了也不收敛）。放在一起，新增 need 时才看得见彼此。
//
// 文案不在本文件：中英两份单源在 lib/messages.ts，渲染函数把消息表当**参数**收——宿主在
// guard 调用点传 `messagesFor(MESSAGES, locale)` 的结果。于是这一层既不读设置、也不自带某
// 一种语言，测试只需喂一份字典；键齐全由 tsc 保证（`Messages[key]` 取值类型），覆盖率不添
// 不可达分支。

import { fillTemplate } from "./messages.ts";
import type { DangerGuardMessages, MessageSlots } from "./messages.ts";
import { DEFAULT_REF_SEARCH_POLICY } from "./ref-search-policy.ts";
import type { RefSearchCriterion, RefSearchPolicy } from "./ref-search-policy.ts";
import type { FactGap, FactGapContext, FactNeed, NeedWhy } from "./fact-gate.ts";

/** 缺项的规范顺序（固定枚举，不依赖 Array#sort/toSorted——后者需 ES2024 lib）。
 *  消费方是 lib/fact-gate.ts 的 `needsKey`（收敛键归一）；它须覆盖 `FactNeed` 全部字面量，
 *  否则收敛键会静默丢项——这一条由下面的编译期闸门与自检用例双保险。 */
const NEED_ORDER_TUPLE = [
  "read",
  "refs",
  "test",
  "e2e",
  "docs",
] as const satisfies readonly FactNeed[];
/** 编译期闸门：新增 `FactNeed` 字面量而不补进 `NEED_ORDER_TUPLE` 时，本类型不再是
 *  `true`、赋值当场红——漏项 = `needsKey` 的收敛比对静默丢项，模型补了也不收敛。 */
export type NeedOrderCoversFactNeed = [
  Exclude<FactNeed, (typeof NEED_ORDER_TUPLE)[number]>,
] extends [never]
  ? true
  : never;
/** 编译期闸门的落点：新增 `FactNeed` 字面量而不补进 `NEED_ORDER_TUPLE` 时，上面的条件
 *  类型不再是 `true`、这一行赋值当场红。导出是为了不留"未使用声明"的 lint 债。 */
export const NEED_ORDER_COMPLETE: NeedOrderCoversFactNeed = true;
export const NEED_ORDER: readonly FactNeed[] = NEED_ORDER_TUPLE;

/** 按判据口径分区的工具名（从 `criteria` 单源派生，不用 `patternTools`/`strictTools` 两份
 *  数组——`RefSearchPolicy` 是可手写的导出接口，两份数据一旦不一致，never 指令说
 *  "没有任何计入取证的检索工具"、narrow 指令却点名具体工具。Map 的键序 = 插入序
 *  （`refSearchPolicyOf` 按配置序插入），派生顺序与那两份数组一致）。 */
const toolsByCriterion = (policy: RefSearchPolicy): Record<RefSearchCriterion, string[]> => {
  const out: Record<RefSearchCriterion, string[]> = { pattern: [], "strict-relative": [] };
  for (const [name, criterion] of policy.criteria) {
    out[criterion].push(name);
  }
  return out;
};

/** 每种口径一句"用什么工具、起点参数叫什么、签名放什么"——与实际记账判据同形。 */
const probeClauses = (
  policy: RefSearchPolicy,
  name: string,
  root: string,
  messages: DangerGuardMessages,
): string[] => {
  const names = toolsByCriterion(policy);
  const clauses: string[] = [];
  if (names["pattern"].length > 0) {
    clauses.push(
      fillTemplate(messages.probePattern, {
        tools: names["pattern"].join(messages.listSeparator),
        root,
        name,
      }),
    );
  }
  if (names["strict-relative"].length > 0) {
    clauses.push(
      fillTemplate(messages.probeStrict, {
        tools: names["strict-relative"].join(messages.listSeparator),
        root,
        name,
      }),
    );
  }
  return clauses;
};

/** 计入取证的工具名清单（narrow 指令点名"该改哪一个工具的检索起点"）。
 *  空名单不是"没说"，而是"谁都不认"——必须讲明原因，否则模型会照着不存在的工具反复试。 */
const countedToolNames = (policy: RefSearchPolicy, messages: DangerGuardMessages): string =>
  policy.criteria.size === 0
    ? messages.countedToolsEmpty
    : [...policy.criteria.keys()].join(messages.listSeparator);

/** 引用探查行动指令：满足任一口径即计入（与 host 的引用取证判据一一对应）。 */
const refsNeverLine = (
  policy: RefSearchPolicy,
  name: string,
  root: string,
  messages: DangerGuardMessages,
): string => {
  const clauses = probeClauses(policy, name, root, messages);
  return clauses.length === 0
    ? fillTemplate(messages.gapRefsToolsEmpty, { name })
    : fillTemplate(messages.gapRefsNever, { clauses: clauses.join(messages.clauseSeparator) });
};

/** 全部 `need × why` 的行动指令文案表（惰性：只插值真正被取用的那一格）。
 *  **查表而不是 switch + default 兜底**：新增 `NeedWhy` 字面量会在编译期要求补齐
 *  每一格；兜底分支则是"永远不可达的运行时保险"——既测不到（覆盖率负债），
 *  又会在真正漏写时静默给出一条不相关的指令。
 *  每格是**工厂**而不是成品：`renderDenyMessage` 对每个缺项调一次 `gapLine`，
 *  成品表会让每次调用都插值 5×4 全部条目，实际只用到一格。 */
const gapLines = (
  name: string,
  root: string,
  hint: string,
  policy: RefSearchPolicy,
  messages: DangerGuardMessages,
): Record<FactNeed, Record<NeedWhy, () => string>> => {
  const slots: MessageSlots = { name, root, hint };
  const noHint: MessageSlots = { name, root };
  return {
    read: {
      never: () => fillTemplate(messages.gapReadNever, slots),
      external: () => fillTemplate(messages.gapReadExternal, slots),
      failed: () => fillTemplate(messages.gapReadFailed, slots),
      // read 的检索命中文件自身属正常取证，scope 不影响 read 指令 → 与默认文案同形
      narrow: () => fillTemplate(messages.gapReadNarrow, slots),
    },
    refs: {
      never: () => `${refsNeverLine(policy, name, root, messages)}${hint}`,
      narrow: () =>
        fillTemplate(messages.gapRefsNarrow, {
          ...slots,
          tools: countedToolNames(policy, messages),
        }),
      failed: () => fillTemplate(messages.gapRefsFailed, slots),
      // refs 的引用面不由本文件内容决定，外部改动不影响引用探查动作 → 与默认文案同形
      external: () => fillTemplate(messages.gapRefsExternal, slots),
    },
    test: {
      never: () => fillTemplate(messages.gapTestBase, slots),
      external: () => fillTemplate(messages.gapTestBase, slots),
      failed: () => fillTemplate(messages.gapTestBase, slots),
      // test 的 narrow 要指出"落点不对"（层探查类里唯一的例外），且不带 hint。
      narrow: () => fillTemplate(messages.gapTestNarrow, noHint),
    },
    // e2e / docs 的指令与成因基本无关（都是"去那层目录搜本文件"）。
    e2e: {
      never: () => fillTemplate(messages.gapE2e, slots),
      external: () => fillTemplate(messages.gapE2e, slots),
      failed: () => fillTemplate(messages.gapE2e, slots),
      narrow: () => fillTemplate(messages.gapE2e, slots),
    },
    docs: {
      never: () => fillTemplate(messages.gapDocs, slots),
      external: () => fillTemplate(messages.gapDocs, slots),
      failed: () => fillTemplate(messages.gapDocs, slots),
      narrow: () => fillTemplate(messages.gapDocs, slots),
    },
  };
};

/** 按 `need` + `why` 定制行动指令——只有"照做即可通过"的句子才有价值。
 *  渲染口由 lib/fact-gate.ts 的 `renderDenyMessage` 逐条调用；测试另枚举
 *  FactNeed×NeedWhy 全组合，断言每条都产出具操作性的文案，堵住"分支可达但永不产出
 *  （falsy/garbage）"的盲区。
 *  @param gap      缺项（含成因与 host 注入的具体补充）。
 *  @param ctx      host 现算的渲染上下文；缺省按"目标文件/项目根"占位。
 *  @param messages 当前语言的文案表（宿主在 guard 调用点取）。 */
export function gapLine(
  gap: FactGap,
  ctx: FactGapContext | undefined,
  messages: DangerGuardMessages,
): string {
  return gapLines(
    ctx?.targetName ?? messages.defaultTargetName,
    ctx?.searchPath ?? messages.defaultSearchPath,
    gap.hint === undefined ? "" : fillTemplate(messages.hintWrap, { hint: gap.hint }),
    ctx?.searchPolicy ?? DEFAULT_REF_SEARCH_POLICY,
    messages,
  )[gap.need][gap.why]();
}
