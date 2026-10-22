// lib/effective-disposition.ts —— 把**档位事实**与**逐命中事实**折成扫描层要的实际处置。
//
// 为什么单列：扫描层排序只看 `BashVerdict`，而 `rmrf` 的沙箱覆盖要读宿主的
// `shell` / `sandboxPolicy` 并做一次路径规范化。把这段留在 host.ts 会顶破它的行数预算；
// 放在这里之后，host 只负责注入原始服务面，判定逻辑仍可脱离宿主单测。
//
// 关键不变量：**扫描排序与最终收口必须用同一个 `dispositionOf`**。`sandboxCoveredFacts`
// 可能把 `rmrf` 从 deny 降成 allow；如果排序按未覆盖的 facts 走，这枚 rmrf 会先让扫描
// 收工，后段（`git push -f`、`--no-verify`）就没人看过。

import { SANDBOX_COVERED } from "./danger-rules.ts";
import type { BashDenialKey, BashVerdict, Fix } from "./danger-rules.ts";
import { decideRule } from "./mode-policy.ts";
import type { PolicyFacts, RuleVerdict } from "./mode-policy.ts";
import { sandboxCoveredFacts, sandboxScopeOf } from "./sandbox-scope.ts";
import type { Canonicalize, SandboxScope } from "./sandbox-scope.ts";
import { asOsPath } from "./path-format.ts";
import type { OsPath } from "./path-format.ts";

/** 宿主读好的原始面；两个 `*Raw` 是**惰性读法**，只有真要算沙箱覆盖时才调用。 */
export interface EffectiveDispositionInput {
  readonly facts: PolicyFacts;
  readonly session: unknown;
  readonly cwd: OsPath | undefined;
  readonly shellRaw: () => unknown;
  readonly policyRaw: () => unknown;
  readonly canonicalize: Canonicalize;
  readonly tempDir: string;
}

/** 扫描层排序与收口共用的两枚函数。 */
export interface EffectiveDisposition {
  readonly dispositionOf: (verdict: BashVerdict) => RuleVerdict;
  readonly coveredFactsOf: (key: BashDenialKey, fix: Fix | undefined) => PolicyFacts;
}

/** 宿主持有的稳定面；`shellRaw` / `policyRaw` 每趟现读（服务可能换代）。 */
export interface EffectiveDispositionHost {
  readonly shellRaw: () => unknown;
  readonly policyRaw: () => unknown;
  readonly canonicalize: Canonicalize;
  readonly tempDir: string;
}

/** 一次调用要变的三个输入（会话、cwd、档位事实）。 */
export type DispositionFactory = (
  session: unknown,
  cwd: string | undefined,
  facts: PolicyFacts,
) => EffectiveDisposition;

/**
 * 造一枚逐命中处置器。沙箱面**惰性读一次**：只有命令里真的出现 `SANDBOX_COVERED` 的命中
 * 才付这份解析；普通 bash 调用与不含 rmrf 的串不额外读盘。
 *
 * @param input 档位事实、cwd 与宿主原始服务面。
 * @returns 排序用的 `dispositionOf` 与收口用的 `coveredFactsOf`。
 */
export function effectiveDispositionOf(input: EffectiveDispositionInput): EffectiveDisposition {
  let scope: SandboxScope | undefined;
  let scopeComputed = false;
  const scopeOf = (): SandboxScope | undefined => {
    if (!scopeComputed) {
      scope = sandboxScopeOf(
        input.shellRaw(),
        input.policyRaw(),
        input.session,
        input.canonicalize,
        input.tempDir,
      );
      scopeComputed = true;
    }
    return scope;
  };
  const coveredFactsOf = (key: BashDenialKey, fix: Fix | undefined): PolicyFacts =>
    SANDBOX_COVERED.has(key)
      ? sandboxCoveredFacts(input.facts, key, fix, scopeOf(), input.cwd)
      : input.facts;
  return {
    dispositionOf: (verdict) => decideRule(coveredFactsOf(verdict.key, verdict.fix), verdict.key),
    coveredFactsOf,
  };
}

/**
 * 造一枚**按调用**求值的工厂：宿主在装配期建一次，guard 与审批通道各自拿它算同一份
 * 实际处置，于是"排序用一份、收口用另一份"在结构上不成立。
 *
 * @param host 稳定的宿主面（服务读法、路径规范化、临时目录）。
 * @returns 由 `(session, cwd, facts)` 得到处置器的工厂。
 */
export function effectiveDispositionFactory(host: EffectiveDispositionHost): DispositionFactory {
  return (session, cwd, facts) =>
    effectiveDispositionOf({
      facts,
      session,
      cwd: cwd === undefined ? undefined : asOsPath(cwd),
      shellRaw: host.shellRaw,
      policyRaw: host.policyRaw,
      canonicalize: host.canonicalize,
      tempDir: host.tempDir,
    });
}
