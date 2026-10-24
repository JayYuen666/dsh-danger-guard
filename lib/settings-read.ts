// lib/settings-read.ts —— **设置值面的防御性读取**：把"用户可能手改坏"的那一层收口。
//
// 为什么单列：设置条目的 `Config` schema 是严格档，但值面的来源不止那一条路 ——
// 宿主组合层之外的形状变化（降级注册后的持久段、旧版本残留、profile 行 config 的
// 非法值）都可能把非数组、混类型的东西送到判定链上。这一层负责把它们折成
// "能用的就用、不能用的回落"，并且**出声**（静默丢弃等于让用户以为配上了）。
//
// 为什么它是 lib 而不是 host：`strArray` 与 `bashOptsOf` 此前长在 host.ts 里，
// 而 host.ts 顶着 `eslint/max-lines` 的 2000 行预算。搬到这儿之后 host 只 import，
// 两条判定入口（guard 与需确认档）仍共用**同一份** `bashOptsOf` —— 那正是它当初被
// 提成函数的原因（两处各写一遍会漂成"guard 拦得住、审批却看不见"）。

import type { BashDangerOptions } from "./danger-rules.ts";
import { DEFAULT_BIG_EDIT_CHARS, DEFAULT_SMALL_EDIT_CHARS } from "./fact-gate.ts";
import type { Config } from "./settings-schema.ts";

/** 数组字段的降级告警只出一次：逐次刷屏会把日志冲干净，反而盖掉真正的拦截记录。 */
let warned = false;

/**
 * settings 数组字段收窄：`unknown[]` → `string[]`（非数组 → `undefined`，由调用方回落 base）。
 * 低危可观测：数组里混入非字符串项会被丢弃 —— 一次性 warn，避免"配了没生效"无迹可循。
 */
export function strArray(value: unknown): string[] | undefined {
  let out: string[] | undefined;
  if (Array.isArray(value)) {
    const valid = value.filter((item): item is string => typeof item === "string");
    const kept = valid.length === value.length;
    if (!kept && !warned) {
      warned = true;
      console.warn(
        `[danger-guard] settings 数组含 ${value.length - valid.length} 个非字符串项，已忽略`,
      );
    }
    // 有项被丢掉、且一项都没留下 ⇒ 回落到"没配"（`undefined`），而不是当成显式清空。
    // 两者的语义在这份配置里是反的：`undefined` 让调用方用内置默认值（名单不缩、词表不空），
    // `[]` 是"一个都不要"（`refSearchTools: []` 就等于所有检索工具都不算引用证据）。
    // 把"配坏了"读成"配成空"会让闸门从收紧翻成放开，而这正是本函数要防的那一类。
    // 真的给了 `[]` 时 `kept` 为真，走的仍是 `[]`（显式清空）。
    out = kept || valid.length > 0 ? valid : undefined;
  }
  return out;
}

/**
 * 词表配置 → bash 判定选项。**单源**：guard 与需确认档共用一份 —— 两处各写一遍迟早会漂，
 * 而漂的表现是"guard 拦得住、审批却看不见"（或反过来），那种不一致没有任何运行期信号。
 *
 * 条件展开是因为"缺省 = 用内置词表"：送一个显式 `undefined` 与不送该键语义不同
 *（本仓开了 `exactOptionalPropertyTypes`，两者在类型上也是两回事）。
 */
export const bashOptsOf = (cfg: Config): BashDangerOptions => {
  const devServerWords = strArray(cfg.extraDevServerWords);
  const devRunArgs = strArray(cfg.extraDevRunArgs);
  return {
    ...(devServerWords === undefined ? {} : { extraDevServerWords: devServerWords }),
    ...(devRunArgs === undefined ? {} : { extraDevRunArgs: devRunArgs }),
  };
};

/** 写面阈值的降级告警：**只响一次**（与数组字段的降级告警同一条口径——坏设置在修复前
 *  每次判定都会命中，逐次刷屏反而盖掉真正的拦截记录）。 */
let thresholdWarned = false;

/**
 * 写面分档阈值，带**交叉校验**：`small ≥ big` 时 mid 档不可达（(big, small] 区间的写面
 * 在 host 的 tierOf 里全被升成 high），分档语义被静默改写。schema 只能逐字段校验数值
 * 范围，两条阈值的关系约束放不进声明式 schema——在消费边界收口：非法组合整对回落
 * 内置默认并告警。数值合法性（非法/缺省回落内置默认、绝不用 0 兜底）与 host 侧的
 * `numOf` 同一条口径。
 */
/** 数值型设置取值：非法/缺省回落内置默认，绝不用 0 兜底（0 等于关掉整道防线）。 */
function numOf(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function editThresholdsOf(cfg: Config): { smallChars: number; bigChars: number } {
  const small = numOf(cfg.smallEditChars, DEFAULT_SMALL_EDIT_CHARS);
  const big = numOf(cfg.bigEditChars, DEFAULT_BIG_EDIT_CHARS);
  if (small < big) {
    return { smallChars: small, bigChars: big };
  }
  if (!thresholdWarned) {
    thresholdWarned = true;
    console.warn(
      `[danger-guard] smallEditChars（${String(small)}）不小于 bigEditChars（${String(big)}），` +
        `mid 档不可达；本轮回落内置阈值（small=${String(DEFAULT_SMALL_EDIT_CHARS)}，` +
        `big=${String(DEFAULT_BIG_EDIT_CHARS)}）。`,
    );
  }
  return { smallChars: DEFAULT_SMALL_EDIT_CHARS, bigChars: DEFAULT_BIG_EDIT_CHARS };
}
