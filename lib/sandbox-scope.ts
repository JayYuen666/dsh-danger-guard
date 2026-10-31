// lib/sandbox-scope.ts —— **宿主沙箱管辖面**：哪些灾难目标该让给宿主去拦。
//
// 为什么单列（而不是留在 host.ts 的判定链里）：host.ts 顶到 `eslint/max-lines` 的 2000 行
// 预算（本仓既有的搬迁理由），而这一段是**自成一体的一个判断**：读宿主的两个能力面
// （`ctx.shell` 自报的沙箱模式 + `ctx.sandboxPolicy` 解析出的逐调用策略），
// 再决定这次的目标包不包得住可写的东西。
//
// ⚠ 本模块不 import `node:fs`（本仓纪律）：把"路径折成规范形"这一步由**宿主注入**
//（`Canonicalize`），因为本机 `realpathSync` 是同步判定链唯一付得起的那种解析，
// 而它住在 host.ts。`node:os` 可以用（`lib/danger-rules.ts` 已在用，它不触盘）。
//
// ⚠ 本模块**不是执行侧的清单**：可写根只用来做包含性测试。真正的允许清单归官方
// `writableRoots`，而那是值导入（会被 rolldown 内联、在本包里多出一份官方函数体，
// 本仓明令禁止）—— 这里按它的**语义**复现，并复用它的失败口径。

import path from "node:path";
import { asOsPath } from "./path-format.ts";
import type { OsPath, PathApi } from "./path-format.ts";
import type { BashDenialKey } from "./danger-rules.ts";
import { SANDBOX_COVERED, disasterTargetPathOf } from "./danger-rules.ts";
import type { Fix } from "./fix.ts";
import { knownGuardModeOf } from "./mode-policy.ts";
import type { PolicyFacts } from "./mode-policy.ts";

/** 规范形折法：宿主用自己的同步解析实现注入。解析不出来交回 `undefined`。 */
export type Canonicalize = (absolutePath: string) => string | undefined;

/** `ctx.shell` 的读取面：本包只探**执行器自报的沙箱模式**这一位。
 *  取不到即当"这个执行器不沙箱"——方向保守（见 `sandboxDropsOf`）。 */
interface ShellFace {
  readonly sandboxMode?: unknown;
}

/** `ctx.sandboxPolicy` 的读取面：本包只调 `resolve` 一位。 */
interface SandboxPolicyFace {
  resolve: (request?: { session?: unknown }) => unknown;
}

/** `ctx.shell` 形状守卫。**不探 `sandboxMode` 的具体取值**（本包只问"它有没有报"）。 */
const isShellFace = (value: unknown): value is ShellFace =>
  typeof value === "object" &&
  value !== null &&
  ((value as { sandboxMode?: unknown }).sandboxMode === undefined ||
    typeof (value as { sandboxMode?: unknown }).sandboxMode === "string");

/** `ctx.sandboxPolicy` 形状守卫。 */
const isSandboxPolicyFace = (value: unknown): value is SandboxPolicyFace =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { resolve?: unknown }).resolve === "function";

/** 沙箱**确实在拦文件效应**的两种 mode（`danger-full-access` 绕开限制，故不在列）。
 *  只认这两枚字面量：宿主将来加 mode 时这里取不到 ⇒ 不让路 ⇒ 保守。 */
const CONFINING_MODES: ReadonlySet<string> = new Set(["read-only", "workspace-write"]);

/** 判据用得着的全部部署事实。`undefined` = 这次不让路（我们兜底）。 */
export interface SandboxScope {
  readonly mode: string;
  /** 可写根（**规范形**，已去重）。标成 `OsPath`：它们与目标必须是同一个路径世界。 */
  readonly roots: readonly OsPath[];
}

/**
 * `path` 是否就是 `root` 或落在它之下（照官方 `workspace-changes/src/paths.ts` 的 `isInside`）。
 *
 * 为什么不拼前缀再 `startsWith`：那要自己判"末尾有没有分隔符"，而分隔符在 Windows 上是
 * `\\`、混形还合法——每漏一种写法就多一条恒假的判据。`path.relative` 由平台实现同时解决
 * 分隔符与 `..` 归一，这也是官方那边的做法。
 *
 * @param root      绝对目录。
 * @param candidate 待判的绝对路径。
 * @returns 自身与所有后代为 true。
 */

function isInside(pathApi: PathApi, root: string, candidate: string): boolean {
  // 包含性判据**吃注入的路径实现**，不读宿主平台：这条判据的失效方向是不安全的
  //（恒假 ⇒ "沙箱盖不住"恒假 ⇒ 把本该硬拒的灾难删除让给沙箱），所以它必须在两种
  // 路径规则下都成立。注入之后可以在 macOS 上用 `path.win32` 直接验。
  const rel = pathApi.relative(root, candidate);
  // ⚠ 判"是否上跳出根"必须比**路径组件边界**，不能只看 `rel.startsWith("..")`：
  // `relative()` 对根内名为 `..cache` 的目录返回 `..cache`，那个前缀判断会把它误判成
  // "跑到根外面" —— 方向是**放行**（"沙箱盖不住"为真 ⇒ 灾难删除让路给同样管不了它的沙箱）。
  return (
    rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel))
  );
}

/** `candidate` 是否为 `target` 的**祖先目录**（目标自身不算）。根目录与带尾斜杠的候选
 *  都由 `isInside` 的 `path.relative` 判据覆盖，不需要按前缀另开一条分支。 */
const isAncestorDirOf = (pathApi: PathApi, candidate: string, target: string): boolean =>
  candidate !== target && isInside(pathApi, candidate, target);

/**
 * 读宿主的沙箱管辖面。**任何一处读不到就交回 `undefined`**，调用方据此不让路。
 *
 * 入参形状照官方 `tool-bash` 自己的读法（`sandboxPolicy.resolve(exec.agent === undefined
 * ? {} : { session })`）：`ctx.shell.sandboxMode` 是**执行器的自报**（`undefined` 表示这个
 * 执行器不沙箱），而官方在"执行器自报在拦"时**要求** `ctx.sandboxPolicy` 在场
 * （否则 bash 工具加载期就抛），所以两枚一起读才是完备的判据。
 *
 * @param shellRaw   `ctx.get("shell")` 的**原始值**（形状由本模块判）。
 * @param policyRaw  `ctx.get("sandboxPolicy")` 的原始值。
 * @param session    会话（逐会话的 `sandbox/mode` 覆盖按它解析）；缺席则用部署默认。
 * @param canonicalize 规范形折法（宿主注入，见模块头）。
 * @param tempDir    平台临时目录（宿主给；lib 不 import `node:os` 也能算，但那会重复
 *                   一次 `os.tmpdir()` 的语义，故由调用方给）。
 */

/**
 * 执行器**自报**的、确实在拦的模式；自报不沙箱、读不到、或不是三种模式之一 ⇒ `undefined`。
 *
 * 只看策略那一侧时，一个自报"不沙箱"的执行器配上一条说自己在拦的策略就能骗到让路——
 * 而让路之后没人再兜底。
 */
function confiningShellModeOf(shellRaw: unknown): string | undefined {
  let out: string | undefined;
  if (isShellFace(shellRaw)) {
    const declared = shellRaw.sandboxMode;
    if (typeof declared === "string" && CONFINING_MODES.has(declared)) {
      out = declared;
    }
  }
  return out;
}

/**
 * 显式授予的额外可写根（`SandboxExecutionPolicy.additionalWritableRoots`）。
 *
 * **读不出来就整份不留 scope**，而不是丢掉那一枚：根表不完整时 `sandboxDropsOf` 会把
 * 落在被丢根之下的目标判成"谁都没包住"⇒ 沙箱完全覆盖 ⇒ 让路，而那段删除其实会真实
 * 执行完。缺席（旧宿主没有这一位）与"给了但读不出"是两个方向，前者按没有额外 grant 处理。
 *
 * @returns 可参与包含性判定的根；形状不可信时 `undefined`。
 */
function additionalRootsOf(value: unknown): readonly string[] | undefined {
  let out: readonly string[] | undefined;
  if (value === undefined) {
    out = [];
  } else if (Array.isArray(value)) {
    const readable = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    // 有项读不出来 ⇒ 整份不可信（理由见函数头）。真的给了 `[]` 时两侧长度相等，
    // 走的仍是 `[]`（显式没有额外 grant），与"没配"同义。
    out = readable.length === value.length ? readable : undefined;
  }
  return out;
}

/**
 * 该 mode 下的可写根（**规范形**、去重）。
 *
 * `workspace-write` = 工作区根 + 显式授予的额外目录 + `/tmp` + 平台临时区
 *（官方 `writableRoots` 的语义）。
 *
 * `workspaceRoot` 读不出（非字符串 / 空串）时交回 `undefined`：根表缺了工作区根，
 * 工作区里的目标会显得"谁都没包住"，于是被判成沙箱完全覆盖而让路——而那正是
 * `workspace-write` 允许真实删完的地方。`/tmp` 与平台临时区照常可算，但它们**不能**
 * 代替工作区根，所以这里不按"其余照常"处理（见 `additionalRootsOf` 的同一条口径）。
 *
 * 规范化失败的口径与官方一致：**解析不出来就不算可写**
 *（官方原话 "a missing root matches nothing until it exists — the conservative outcome"）。
 */
function writableRootsOf(
  workspaceRoot: unknown,
  additionalWritableRoots: readonly string[],
  canonicalize: Canonicalize,
  tempDir: string,
): OsPath[] | undefined {
  let roots: OsPath[] | undefined;
  if (typeof workspaceRoot === "string" && workspaceRoot.length > 0) {
    roots = [];
    for (const candidate of [workspaceRoot, ...additionalWritableRoots, "/tmp", tempDir]) {
      // 解析不出来时按 `path.resolve` 形保留，**不丢这一枚**：宿主的 `realpathOf` 在整条
      // 前缀都不存在时才回 `undefined`，而灾难目标那一侧同样出自 `path.resolve` 的世界，
      // 保留 resolve 形才让两侧同世界。丢掉这一枚的后果是**反方向**的：它底下的目标
      // 看起来"谁都没包住"，于是被判成沙箱覆盖而让路——实测 `rm -rf .` 会因此变成放行。
      const branded = asOsPath(canonicalize(candidate) ?? path.resolve(candidate));
      // 这里的每一枚都是宿主真实路径（工作区根、临时区、规范化后的形），
      // 标成 `OsPath` 让下游的包含性判据只能收同一个世界的东西。灾难目标那一侧必须
      // 同样折成规范形再比（见 `effective-disposition` 的 `canonicalFixOf`）：只在这一侧
      // 登记词法形会同时改变「目标落在根之内」的判定，工作区里的删除会被误判成可让路。
      if (!roots.includes(branded)) {
        roots.push(branded);
      }
    }
  }
  return roots;
}

/**
 * 策略解析出来的管辖面；mode 不在拦、解析不全、根表不可信、或一枚可写根都拿不到时
 * `undefined`。
 *
 * 入参形状照官方 `tool-bash` 自己的读法（`sandboxPolicy.resolve(exec.agent === undefined
 * ? {} : { session })`）：官方在"执行器自报在拦"时**要求** `sandboxPolicy` 在场
 *（否则 bash 工具加载期就抛），所以两枚一起读才是完备的判据。
 */
function scopeOfResolvedPolicy(
  policyRaw: SandboxPolicyFace,
  session: unknown,
  canonicalize: Canonicalize,
  tempDir: string,
): SandboxScope | undefined {
  let scope: SandboxScope | undefined;
  const resolved: unknown = policyRaw.resolve(session === undefined ? {} : { session });
  if (typeof resolved === "object" && resolved !== null) {
    const { mode, workspaceRoot, additionalWritableRoots } = resolved as {
      mode?: unknown;
      workspaceRoot?: unknown;
      additionalWritableRoots?: unknown;
    };
    if (typeof mode === "string" && CONFINING_MODES.has(mode)) {
      const additional = additionalRootsOf(additionalWritableRoots);
      const roots =
        additional === undefined
          ? undefined
          : writableRootsOf(workspaceRoot, additional, canonicalize, tempDir);
      // 两处读不全都按"这趟不让路"处理：半份根表推出来的"沙箱盖得住"是放行方向。
      if (roots !== undefined) {
        scope = { mode, roots };
      }
    }
  }
  return scope;
}

export function sandboxScopeOf(
  shellRaw: unknown,
  policyRaw: unknown,
  session: unknown,
  canonicalize: Canonicalize,
  tempDir: string,
): SandboxScope | undefined {
  let scope: SandboxScope | undefined;
  // 两道前提，缺一不让路：① 执行器**自报的默认模式**本身在拦（`danger-full-access`
  // 意味着它不拦文件效应，那种执行器给出的 `resolve()` 无论说什么都不该让我们让路）；
  // ② 策略确实能解析出在拦的 mode。只看 ② 时，一个自报"不沙箱"的执行器配上一条
  // 说自己在拦的策略就能骗到让路——而让路之后没人再兜底。
  if (confiningShellModeOf(shellRaw) !== undefined && isSandboxPolicyFace(policyRaw)) {
    // `resolve` 与 `canonicalize` 都是宿主注入的实现。这里兜住异常并按"读不到"处理：
    // 本函数的调用点一处在扫描排序的热路径上、一处在同步 guard 谓词里，一次抛错会中断
    // 整趟判定，而两种情况下正确的降级都是"不让路"。
    try {
      scope = scopeOfResolvedPolicy(policyRaw, session, canonicalize, tempDir);
    } catch {
      scope = undefined;
    }
  }
  return scope;
}

/**
 * 这些灾难目标是否**全都包不住任何可写根** —— 即沙箱会把它们整个拦下、不留残余。
 *
 * ⚠ 判据是"**包不住**"而不是直觉上的"在可写根之外"，两者不等价，而后者**不安全**：
 * `workspace-write` 的语义是**允许**修改工作区内的文件，于是 `rm -rf ~`（工作区在 `~` 下）
 * 会先删光工作区内容、再在边界外被拒 —— 沙箱是一条路径白名单，**不提供原子性**，
 * 已落下的删除不会回滚。所以"沙箱覆盖了这枚目标"必须严格到"它之下没有一丁点可写的东西"。
 * 这条纠正直接决定了可让路范围：`rm -rf ~`、`rm -rf /`、`rm -rf .` 一律**不让路**
 *（它们都包住工作区），只有 `rm -rf /etc/foo`、`rm -rf ~/Downloads` 这类才让路。
 *
 * ⚠ 包含性必须**双向**判：既排除"目标包住可写根"，也排除"目标落在可写根之内"。
 * 只判前一个方向时 `rm -rf ./src`（目标 `/work/src`、可写根 `/work`）会被判成"沙箱整体
 * 拦下"而让路，而 `workspace-write` 恰恰允许写工作区 —— 那条删除会真实执行完。
 * 目标自身可写，就不可能是"被完整覆盖"。
 *
 * `read-only` 是特例：**一切写都被禁**，所以任何目标都被完全覆盖（不存在"部分成功"）。
 *
 * @param scope    `sandboxScopeOf` 的产出。
 * @param targets  灾难目标的**绝对形**（`disasterTargetPathOf` 的产出；归一不出来的一律
 *                 由调用方先剔掉 ⇒ 这里收到 `undefined` 即整条不让路）。
 */
export function sandboxDropsOf(
  scope: SandboxScope,
  targets: readonly (OsPath | undefined)[],
  pathApi: PathApi = path,
): boolean {
  if (scope.mode === "read-only") {
    return true;
  }
  return targets.every(
    (target) =>
      target !== undefined &&
      scope.roots.every(
        (root) =>
          root !== target &&
          !isAncestorDirOf(pathApi, target, root) &&
          !isAncestorDirOf(pathApi, root, target),
      ),
  );
}

/**
 * 这次调用**实际处在哪个沙箱模式**（按权限档位分叉的判定要它，见 `lib/mode-policy.ts`）。
 *
 * 与 `sandboxScopeOf` 的分工：那个只回"沙箱**确实在拦**"的两档（`danger-full-access` 不在
 * 列，因为它绕开限制），用途是"该不该让路"；本函数回**原始模式**，用途是"该按哪一列处置"。
 * 两者读同一对服务面，前提也一致：执行器自报 `danger-full-access` 时它不拦文件效应，
 * 策略侧再解析出什么模式都不改变这一点——本函数据自报返回 `danger-full-access`，
 * 而不是返回一个与实际环境不符的受限档位。
 *
 * @param shellRaw  `ctx.get("shell")` 的原始值。
 * @param policyRaw `ctx.get("sandboxPolicy")` 的原始值。
 * @param session   会话（逐会话的 `sandbox/mode` 覆盖按它解析）。
 * @returns 三种模式之一；执行器不沙箱或形状不符时 `undefined`（调用方按 `unknown` 处理）。
 */
export function sandboxModeOf(
  shellRaw: unknown,
  policyRaw: unknown,
  session: unknown,
): string | undefined {
  // 执行器自报"不沙箱"（或读不到）⇒ 没有模式可读，和 `sandboxScopeOf` 同一条前提。
  const shellMode = isShellFace(shellRaw) ? knownGuardModeOf(shellRaw.sandboxMode) : undefined;
  let mode: string | undefined;
  if (shellMode === "danger-full-access") {
    // 自报完全权限：执行器自己说它不拦文件效应，策略侧的 mode 不再是实际所处环境，
    // 按自报返回（`sandboxScopeOf` 同样不会在这种组合下让路）。
    mode = shellMode;
  } else if (shellMode !== undefined && isSandboxPolicyFace(policyRaw) && session !== null) {
    try {
      const resolved: unknown = policyRaw.resolve(session === undefined ? {} : { session });
      if (typeof resolved === "object" && resolved !== null) {
        mode = knownGuardModeOf((resolved as { mode?: unknown }).mode);
      }
    } catch {
      // 宿主实现抛错按"读不到模式"处理（调用方落 `unknown` 保守列），
      // 不让异常穿进同步 guard 谓词。
      mode = undefined;
    }
  }
  return mode;
}

/**
 * 把"沙箱是否完全覆盖这次目标"补齐进档位事实（只有 `rmrf` 用到这一位）。
 *
 * 判据本体仍是本模块的 `sandboxDropsOf`（"目标包不住任何可写根"）；这里只做两件事：
 * 把灾难目标词面折成绝对路径、按 `SANDBOX_COVERED` 收窄规则键。空目标集合**明确不让路**——
 * 空数组会让 `every` 恒真，那是误放行。
 *
 * @param facts   已折好的档位事实。
 * @param key     命中的规则键。
 * @param fix     这次命中的结构化出路（灾难目标挂在 `offending` 上）。
 * @param scope   已折好的沙箱管辖面（`sandboxScopeOf` 的产出；`undefined` = 不让路）。
 * @param cwd     会话当前工作目录（相对目标按它归一）。
 * @returns 补齐 `sandboxCovers` 之后的事实（不让路时原样返回）。
 */
export function sandboxCoveredFacts(
  facts: PolicyFacts,
  key: BashDenialKey,
  fix: Fix | undefined,
  scope: SandboxScope | undefined,
  cwd: OsPath | undefined,
): PolicyFacts {
  const offending = fix?.role === "disasterTarget" ? fix.offending : [];
  const covered =
    scope !== undefined &&
    SANDBOX_COVERED.has(key) &&
    offending.length > 0 &&
    sandboxDropsOf(
      scope,
      offending.map((word) => disasterTargetPathOf(word, cwd)),
    );
  return covered ? { ...facts, sandboxCovers: true } : facts;
}
