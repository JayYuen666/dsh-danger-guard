// lib/denial-info.ts —— 拒绝结果的结构化身份（官方 `ToolErrorInfo`）。
//
// 只给 `tools/pre-execute` 的 deny 用：rc.1 与 rc.2 的流水线都读 `decision.info`，
// 这条通道在支持窗口的两端都成立。**guard 不返回结构化对象**——rc.1 的
// `ToolsService.checkGuards` 只接受字符串，返回 `{ reason, info }` 会把它当拒绝理由
// 插值成 `[object Object]`；要保住 `^0.2.2-rc.1` 窗口，guard 必须继续交字符串。

import type { ToolErrorInfo } from "@deepseek-ai/dsh-tools";

/** 本插件在失败工具结果上记录的 error name。 */
export const DANGER_GUARD_ERROR_NAME = "DangerGuardError";

/** B 面预检（首次编辑事实门）拒绝的结构化身份。 */
export const FACT_GATE_DENIAL_INFO: ToolErrorInfo = Object.freeze({
  name: DANGER_GUARD_ERROR_NAME,
  code: "factGate",
});
