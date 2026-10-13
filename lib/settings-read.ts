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
    if (valid.length !== value.length && !warned) {
      warned = true;
      console.warn(
        `[danger-guard] settings 数组含 ${value.length - valid.length} 个非字符串项，已忽略`,
      );
    }
    out = valid;
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
