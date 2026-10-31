// lib/effective-disposition.ts —— 把**档位事实**与**逐命中事实**折成扫描层要的实际处置。
//
// 为什么单列：扫描层排序只看 `BashVerdict`，而 `rmrf` 的沙箱覆盖要读宿主的
// `shell` / `sandboxPolicy` 并做一次路径规范化。把这段留在 host.ts 会顶破它的行数预算；
// 放在这里之后，host 只负责注入原始服务面，判定逻辑仍可脱离宿主单测。
//
// 关键不变量：**扫描排序与最终收口必须用同一个 `dispositionOf`**。`sandboxCoveredFacts`
// 可能把 `rmrf` 从 deny 降成 allow；如果排序按未覆盖的 facts 走，这枚 rmrf 会先让扫描
// 收工，后段（`git push -f`、`--no-verify`）就没人看过。

import path from "node:path";
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

/** 收口侧一次要的两样：最终处置 + 覆盖后的事实（上报里要记是哪一档、沙箱有没有让路）。 */
export interface EffectiveOutcome {
  readonly verdict: RuleVerdict;
  readonly facts: PolicyFacts;
}

/** 扫描层排序与收口共用的两枚函数。 */
export interface EffectiveDisposition {
  readonly dispositionOf: (verdict: BashVerdict) => RuleVerdict;
  readonly coveredFactsOf: (key: BashDenialKey, fix: Fix | undefined) => PolicyFacts;
  /** 收口侧专用：按 (key, fix) 一次求出处置与覆盖后的事实。"排序与收口必须同一处置"
   *  这条不变量由**结构**保证——收口处手写 `decideRule(facts, key)`（漏掉覆盖）的写法
   *  没有这个成员可调，也就写不出来。 */
  readonly verdictOf: (key: BashDenialKey, fix: Fix | undefined) => EffectiveOutcome;
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
 * @returns 排序共用的 `dispositionOf` 与收口用的 `verdictOf`；`coveredFactsOf` 是两者共用的
 *   中间步，生产收口不直接调它。
 */
export function effectiveDispositionOf(input: EffectiveDispositionInput): EffectiveDisposition {
  let scope: SandboxScope | undefined;
  let scopeComputed = false;
  const scopeOf = (): SandboxScope | undefined => {
    if (!scopeComputed) {
      // 宿主服务面（shellRaw / policyRaw / 其 resolve）抛错不能中断扫描排序——dispositionOf
      // 在热路径上，异常会从排序阶段直接冒出、整趟判定中断。按"读不到就兜底"的既有口径
      // 交回 undefined：sandboxCoveredFacts 原样返回，rmrf 保持 deny（方向保守）。
      try {
        scope = sandboxScopeOf(
          input.shellRaw(),
          input.policyRaw(),
          input.session,
          input.canonicalize,
          input.tempDir,
        );
      } catch {
        scope = undefined;
      }
      scopeComputed = true;
    }
    return scope;
  };
  // 可写根登记的是规范形；灾难目标词面若带符号链接前缀（macOS `/tmp` → `/private/tmp`），
  // 直接拿去比会落在另一个路径世界里，`rm -rf /tmp/x` 会被判成「沙箱盖得住」而让路。
  // 这里把**绝对形**目标折成规范形再交给词法判据（相对形已按规范化的 cwd 归一）。
  const canonicalFixOf = (fix: Fix | undefined): Fix | undefined => {
    if (fix?.role !== "disasterTarget") {
      return fix;
    }
    return {
      ...fix,
      offending: fix.offending.map((word) =>
        path.isAbsolute(word) ? (input.canonicalize(word) ?? word) : word,
      ),
    };
  };
  const coveredFactsOf = (key: BashDenialKey, fix: Fix | undefined): PolicyFacts =>
    SANDBOX_COVERED.has(key)
      ? sandboxCoveredFacts(input.facts, key, canonicalFixOf(fix), scopeOf(), input.cwd)
      : input.facts;
  const verdictOf = (key: BashDenialKey, fix: Fix | undefined): EffectiveOutcome => {
    const covered = coveredFactsOf(key, fix);
    return { verdict: decideRule(covered, key), facts: covered };
  };
  return {
    dispositionOf: (verdict) => verdictOf(verdict.key, verdict.fix).verdict,
    coveredFactsOf,
    verdictOf,
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
      // 铸造边界校验绝对性：`asOsPath` 是纯声明，第三方 `workingDirectory` 服务给出相对
      // 路径时原样打 brand，灾难目标会按 `process.cwd()` 解析出与可写根无关的绝对形——
      // 一次真实的工作区删除可能被判成"沙箱已覆盖"而由 deny 降为 allow。不绝对就交回
      // undefined（不让路，方向保守）。
      // 先 canonicalize 再打 brand：可写根那边只登记规范形，目录基准也必须折到同一
      // 路径世界；只折词法形时符号链接工作区（macOS `/tmp` → `/private/tmp`）两侧
      // 对不上，`rm -rf .` 会被判成「沙箱盖得住」而由 deny 降为 allow。
      cwd:
        cwd === undefined || cwd.length === 0 || !path.isAbsolute(cwd)
          ? undefined
          : asOsPath(host.canonicalize(cwd) ?? cwd),
      shellRaw: host.shellRaw,
      policyRaw: host.policyRaw,
      canonicalize: host.canonicalize,
      tempDir: host.tempDir,
    });
}
