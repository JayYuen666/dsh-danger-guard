// lib/policy-facts.ts —— 把宿主的三个只读服务面折成一张**档位事实**（`PolicyFacts`）。
//
// 为什么单列：`host.ts` 顶着 `max-lines` 的预算，而这段是**一个自成一体的读取**——
// 读宿主的能力面、折成 `lib/mode-policy.ts` 要的那四位事实。它不碰 fs、不碰写路径，
// 只做形状守卫与默认值，因此可以脱离宿主单测。
//
// 读法一律走**可选服务读法**（`get(name)` 返回 `undefined` 不抛错）：本包读的四家宿主服务
// （`shell` / `sandboxPolicy` / `approval` / `permissionPresets`）里只有前两家有沙箱时必在，
// 后两家随部署而变。把任何一家写进插件级 `inject` 都会让缺它的 profile 上**整个闸门不再激活**，
// 而闸门绝不能因为一条可选读面缺席而下线（本仓 bulkhead 口径）。

import type { GuardMode, PolicyFacts } from "./mode-policy.ts";

/** `ctx.approval` 的读取面：本包只读"当前策略"这一位。 */
interface ApprovalFace {
  readonly config?: { readonly policy?: unknown };
  overrideOf?: (session: unknown) => unknown;
}

/** 覆盖位的形状守卫：宿主形状漂移（该位不是函数）时按"缺席"处理，
 *  绝不在同步 guard 谓词里抛 TypeError——那会让整道闸门变成调用错误。 */
const isOverrideOf = (value: unknown): value is (session: unknown) => unknown =>
  typeof value === "function";

/** `ctx.permissionPresets` 的读取面：本包只读"当前预设名"这一位。 */
interface PermissionPresetsFace {
  current: (session: unknown) => unknown;
}

/** 一次判定要读的宿主事实与读法（原始值，形状由本模块判）。 */
export interface PolicyFactsInput {
  /** 可选服务读取（`ctx.get` 的投影：未提供的名字返回 `undefined`）。 */
  readonly get: ((name: string) => unknown) | undefined;
  /** 会话（逐会话的 `sandbox/mode` 与 `approval/policy` 覆盖按它解析）。 */
  readonly session: unknown;
  /** 这次 `rmrf` 的灾难目标是否完全落在沙箱管辖之内（宿主侧算好的事实）。 */
  readonly sandboxCovers: boolean;
  /** 沙箱模式的读法（`lib/sandbox-scope.ts` 的 `sandboxModeOf`，由宿主注入以免本模块碰 fs）。 */
  readonly sandboxMode: (
    shellRaw: unknown,
    policyRaw: unknown,
    session: unknown,
  ) => string | undefined;
}

const isApprovalFace = (value: unknown): value is ApprovalFace =>
  typeof value === "object" && value !== null;

const isPermissionPresetsFace = (value: unknown): value is PermissionPresetsFace =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { current?: unknown }).current === "function";

/**
 * 折一张档位事实。
 *
 * 三个事实各自的来源与缺席口径：
 *  - **模式**：执行器自报在拦 + 策略解析出的 `mode`。读不到 ⇒ `unknown`（保守列）。
 *  - **能否询问**：会话日志里最后一条 `approval/policy` 覆盖，回落到服务配置的默认值。
 *    **不调用** `approval.request()`——那会追加一对 `approval/asked` + `approval/decided`
 *    审计事件，等于为"判断能不能问"而先问一次。
 *
 *    只有策略确实是 `never` 才算"问不了"：那是宿主在**任何应答者之前**确定性返回
 *    `rejected` 并用自己的固定文案覆写理由的唯一一格。审批服务整个缺席是另一回事——那条
 *    降级路径是 fail-closed 拒绝但**保留我们交的 reason**，于是文案仍是我们那张带出路的说明。
 *    所以服务缺席按 `askable: true` 处理：判定与文案都不变，只是最终结论由宿主收口成拒绝。
 *  - **自动审查**：`permissionPresets.current(session) === "auto"`。这一位只影响
 *    "完全权限那一列要不要留两条硬拦"；读不到就是没装那个预设服务，也就不可能有 auto 档。
 *
 * @param input 四枚原始事实与沙箱模式的读法。
 * @returns 档位事实。
 */
export function policyFactsOf(input: PolicyFactsInput): PolicyFacts {
  const { get, session, sandboxCovers, sandboxMode } = input;
  const modeRaw = sandboxMode(get?.("shell"), get?.("sandboxPolicy"), session);
  const mode: GuardMode =
    modeRaw === "read-only" || modeRaw === "workspace-write" || modeRaw === "danger-full-access"
      ? modeRaw
      : "unknown";
  const approvalRaw: unknown = get?.("approval");
  // 默认"能问"：宿主 `ApprovalService` 的配置默认就是 `ask`，而服务缺席那条 fail-closed
  // 路径同样会带我们的 reason（见上面的口径）。
  let askable = true;
  if (isApprovalFace(approvalRaw)) {
    const { overrideOf } = approvalRaw;
    // `.call` 不是风格：真实 `ApprovalService.overrideOf` 的第一句是
    // `this.approvalStateOf(session)`。拆下来当裸函数调，`this` 就是 undefined，
    // 于是每一次工具判定的策略面都会抛 "Cannot read properties of undefined
    // (reading 'approvalStateOf')" —— 宿主里表现为所有工具全线失败。
    const overridden =
      session === undefined || !isOverrideOf(overrideOf)
        ? undefined
        : overrideOf.call(approvalRaw, session);
    askable = (overridden ?? approvalRaw.config?.policy) !== "never";
  }
  const presetsRaw: unknown = get?.("permissionPresets");
  const autoReview =
    isPermissionPresetsFace(presetsRaw) &&
    session !== undefined &&
    presetsRaw.current(session) === "auto";
  return { mode, askable, autoReview, sandboxCovers };
}
