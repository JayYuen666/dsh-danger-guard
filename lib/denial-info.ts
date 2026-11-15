// lib/denial-info.ts —— 拒绝结果的结构化身份（官方 `ToolErrorInfo`）。
//
// 只给 `tools/pre-execute` 的 deny 用：rc.2 的流水线读 `decision.info`。
// **guard 仍返回字符串**（rc.2 的 `checkGuards` 会把它包成 `{ reason }`）：结构化身份
// 只挂在预检拒绝上，guard 这一路不带 `info`。

import type { ToolErrorInfo } from "@deepseek-ai/dsh-tools";

/** 本插件在失败工具结果上记录的 error name。 */
export const DANGER_GUARD_ERROR_NAME = "DangerGuardError";

/** B 面预检（首次编辑事实门）拒绝的结构化身份。 */
export const FACT_GATE_DENIAL_INFO: ToolErrorInfo = Object.freeze({
  name: DANGER_GUARD_ERROR_NAME,
  code: "factGate",
});
