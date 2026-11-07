// lib/write-gate.ts —— 写类调用的判定顺序：apply_patch 目标核对 → 密钥检查 → 事实门。
//
// host 只注入三个已装配好的判定函数；顺序与 fail-closed 规则留在这里，避免这段
// 分支写进 `apply` 的热路径回调里同时推高文件行数与认知复杂度。

import type { JudgeCost } from "./judge-stats.ts";
import type { WriteTarget, WriteTargetScan } from "./write-targets.ts";

interface SecretDecision {
  readonly reason: string | undefined;
  readonly cost: JudgeCost;
}

/** 事实门一次判定的入参：名称/参数与已经解析出的写目标。 */
export interface FactGateDenyInput {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly targets: readonly WriteTarget[];
}

/** host 侧注入的判定。`scan` 解析目标，`secret`/`fact` 是已经绑定会话与配置的函数。 */
export interface WriteGateHooks {
  readonly scan: (name: string, args: Record<string, unknown>) => WriteTargetScan;
  readonly secret: (name: string, args: Record<string, unknown>) => SecretDecision;
  readonly fact: (
    name: string,
    args: Record<string, unknown>,
    targets: readonly WriteTarget[],
  ) => string | undefined;
  /** 补丁目标无法完整核对时的拒绝文案。 */
  readonly opaque: string;
}

export interface WriteGateDecision {
  readonly deny: string | undefined;
  /** 密钥判定确实发生时交回成本样本；apply_patch 的空/超限 fail-closed 不产生样本。 */
  readonly secretCost: JudgeCost | undefined;
}

export function writeGateDecisionOf(
  hooks: WriteGateHooks,
  name: string,
  args: Record<string, unknown>,
): WriteGateDecision {
  const scan = hooks.scan(name, args);
  if (name === "apply_patch" && (scan.targets.length === 0 || scan.overflow)) {
    // 补丁为空/语法未被官方解析器接受/目标数超过事实门预算：无法核对凭据面与先读证据。
    // 这是本工具自己的 fail-closed，不受 `factGateEnabled` 影响。
    return { deny: hooks.opaque, secretCost: undefined };
  }
  const secret = hooks.secret(name, args);
  return {
    deny: secret.reason ?? hooks.fact(name, args, scan.targets),
    secretCost: secret.cost,
  };
}
