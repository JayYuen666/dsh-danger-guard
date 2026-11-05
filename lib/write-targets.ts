// lib/write-targets.ts —— 写调用的目标清单、风险事实与档位。
//
// 从 host.ts 抽出：`apply_patch` 是多目标补丁，目标解析与逐目标口径已经自成一体；
// 把它们和 `riskFactsOf`/`tierOf` 放在同一处，host 只保留调用与判定接线。

import { applyPatchTargetsOf } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { editTargetPath } from "./danger-rules.ts";

/** 触及导出面/签名的关键字：改动文本含这些词 → 波及面大概率超出文件自身，升档。 */
const SIG_KEYWORD_RE =
  /\b(?:export|default|declare|pub|fn|func|def|class|interface|type|enum|struct|trait|impl|public|protected)\b/u;

/** 高风险路径：manifest / lockfile / 构建配置 / CI / cordis 装配——改一个字符也能全局波及。 */
const RISKY_PATH_RE =
  /(?:^|[/\\])(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|bun\.lockb?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|uv\.lock|requirements\.txt|setup\.py|tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?js|cordis\.(?:ya?ml|json)|Makefile|Dockerfile|docker-compose\.ya?ml|\.env(?:\.[\w-]+)?|schema\.sql)$/u;

/** 取证档位（定稿：按写面风险分档，配 strictMode 回到"每文件全探查"）。 */
export type FactTier = "low" | "mid" | "high";

interface RiskFacts {
  /** 本次调用能否创建文件（write / str_replace_editor create / apply_patch Add）。 */
  creatable: boolean;
  /** 高风险路径（manifest/lockfile/CI/装配）。 */
  riskyPath: boolean;
  /** 改动文本是否触及导出面/签名关键字。 */
  sigChanged: boolean;
  /** 写面字符数；**取不到**（write 整文件覆盖、str_replace_editor edits 数组、apply_patch）。 */
  contentChars: number | undefined;
  strictMode: boolean;
  smallChars: number;
  bigChars: number;
}

/**
 * 定档。缺信息一律**升档**：宁可多要一次探查，不可少要。
 *   high：新建 / 大段重写 / 触及导出签名 / 高风险路径（manifest·lockfile·装配）/ strictMode
 *   low ：小改且不触及签名且非高风险路径（只要 read）
 *   mid ：其余（read + 项目级引用探查）
 */
export function tierOf(facts: RiskFacts): FactTier {
  if (facts.strictMode || facts.creatable) {
    return "high";
  }
  if (facts.sigChanged) {
    return "high";
  }
  // 取不到写面大小 → 保守升档
  if (facts.contentChars === undefined) {
    return "high";
  }
  if (facts.contentChars > facts.bigChars) {
    return "high";
  }
  // 改一个版本号也能全局波及：size 是最差的代理
  if (facts.riskyPath) {
    return "high";
  }
  if (facts.contentChars <= facts.smallChars) {
    return "low";
  }
  return "mid";
}

/**
 * 从一次写调用提取风险事实。缺信息一律留 undefined → tierOf 保守升档。
 * `creatableOverride` 只由 `apply_patch` 的逐操作目标传入；其余工具仍从参数现算。
 */
export function riskFactsOf(
  name: string,
  args: Record<string, unknown>,
  target: string,
  creatableOverride?: boolean,
): Pick<RiskFacts, "creatable" | "riskyPath" | "sigChanged" | "contentChars"> {
  let contentChars: number | undefined;
  let sigChanged = false;
  if (name === "edit") {
    const oldS = typeof args["old_string"] === "string" ? args["old_string"] : undefined;
    const newS = typeof args["new_string"] === "string" ? args["new_string"] : undefined;
    if (oldS !== undefined && newS !== undefined) {
      contentChars = oldS.length + newS.length;
    }
    sigChanged = SIG_KEYWORD_RE.test(newS ?? "") || SIG_KEYWORD_RE.test(oldS ?? "");
  }
  return {
    creatable:
      creatableOverride ??
      (name === "write" || (name === "str_replace_editor" && args["command"] === "create")),
    riskyPath: RISKY_PATH_RE.test(target),
    sigChanged,
    contentChars,
  };
}

/** `apply_patch` 的逐目标检查上限：一条补丁跨上百个文件时，事实门逐目标取证的成本会把
 *  同步 guard 拖成一条长尾；超过上限按无法完整核对处理，交回用户改用 edit/write。 */
export const APPLY_PATCH_TARGET_LIMIT = 128;

/** 一次写调用要过事实门的目标；`creatable` 按补丁操作而非常量给。 */
export interface WriteTarget {
  readonly path: string;
  readonly creatable: boolean;
}

export interface WriteTargetScan {
  readonly targets: readonly WriteTarget[];
  readonly overflow: boolean;
}

/** 同一路径在补丁里出现多次时按最保守的一侧收口：只要有一次是更新/删除，就不是新文件。 */
export function dedupeWriteTargets(targets: readonly WriteTarget[]): readonly WriteTarget[] {
  const byPath = new Map<string, boolean>();
  for (const target of targets) {
    if (target.path.length > 0) {
      const previous = byPath.get(target.path);
      byPath.set(target.path, previous === false ? false : target.creatable);
    }
  }
  return Array.from(byPath, ([filePath, creatable]) => ({ path: filePath, creatable }));
}

/**
 * 一次写调用的目标清单。普通编辑器仍走 `editTargetPath`；`apply_patch` 走补丁操作，
 * 并把 move 的源路径与目的路径都算进来——源路径被删除，目的路径被创建，两个文件效应
 * 都要过凭据面与事实门。补丁解析失败时交回空表，调用方按工具名 fail-closed。
 */
export function writeTargetsOf(name: string, args: Record<string, unknown>): WriteTargetScan {
  if (name === "apply_patch") {
    const raw: WriteTarget[] = [];
    for (const operation of applyPatchTargetsOf(args)) {
      raw.push({ path: operation.path, creatable: operation.kind === "add" });
      if (operation.kind === "update" && operation.moveTo !== undefined) {
        raw.push({ path: operation.moveTo, creatable: true });
      }
    }
    return {
      targets: dedupeWriteTargets(raw),
      overflow: raw.length > APPLY_PATCH_TARGET_LIMIT,
    };
  }
  const target = editTargetPath(name, args);
  return {
    targets:
      target === null
        ? []
        : [{ path: target, creatable: riskFactsOf(name, args, target).creatable }],
    overflow: false,
  };
}
