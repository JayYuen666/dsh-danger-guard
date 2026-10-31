// lib/blast-radius.ts —— **量出操作前状态**：把可确定的那部分取成事实，写进审批请求。
//
// 为什么做这件事：本包原先的 `ask` 是**盲问** —— 用户只看到"这条命令会丢弃未提交改动"，
// 看不到**具体丢什么**。dsh 官方自带的示例 mod `Blast Radius`
//（`packages/experimental/claude-code-mods/examples/blast-radius/`）示范了另一条路：
// 先跑 `git status` / `git clean -n` / `du` 把清单量出来，再连同面板一起给用户看。
// 本模块采用它的一半（量证据），不采用另一半（自定义 UI 面板）—— 面板归宿主，
// 我们只把事实写进审批请求的文案里。
//
// ⚠ 这次改动**破了本包一条既有不变式**：原先「判定链没有任何 fs 写入、网络请求或子进程
// 调用」。现在判定链里多了**只读预演**这一趟子进程。边界钉死在下面四条：
//   1. 只在 **`ask` 档**跑（`deny` 档不跑：那时结论已定，量它不是用户要看的东西）；
//   2. 只在 **`ctx.shell` 在位**时跑（没装执行器的 profile 退化成盲问，不静默换命令）；
//   3. 预演命令是**写死的常量**，**不插值任何模型输入** —— 插值模型给的路径就是拿命令
//      原文拼 shell 串，那是注入面。所以 `gitRestoreDiscard` 量的是整个工作区
//      （`git status --porcelain`）而不是那条命令点名的那几个文件。原命令只用于三项
//      **跳过**判据（仓库覆盖选项、策略是否可取、`git clean -x/-X` 时预演清单会偏小），
//      绝不参与命令拼接。
//   4. 量不出来（执行器缺席 / 仓库目标不确定 / 策略解析失败 / 非零退出 / 超时 / 取消 /
//      宿主截断输出）一律**退回盲问**，绝不因此改变审批本身的结论 —— 量证据是增强，
//      不是判据。
//
// 本模块只管**常量表、渲染与是否可量**（纯函数，可脱离宿主单测）；跑子进程那一趟在
// host.ts（它才拿得到 `ctx.shell` 与会话 cwd）。

import { once } from "node:events";
import path from "node:path";

import { resolveLocale } from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

import { lexTokens, splitTopLevel } from "./command-segments.ts";

import type { BashDenialKey } from "./danger-rules.ts";
import type { AskRequest } from "./confirm.ts";
import { fillTemplate, MESSAGES } from "./messages.ts";
import type { DangerGuardMessages } from "./messages.ts";

/** 三枚"丢弃工作区改动"的键共用同一条预演（它们量的是同一件事：工作区现在有什么）。
 *  `--no-optional-locks` 抑制 `git status` 的可选锁与索引刷新；这是"只读"里最容易被
 *  忽略的一笔写，但它不能替代沙箱策略。 */
const GIT_STATUS = "git --no-optional-locks status --porcelain";

/**
 * 每枚规则键的**只读预演命令**。
 *
 * 全表都是读命令：`--porcelain` / `-n` / `list` / `-vv` / `log` 都不执行原操作
 *（`git clean -nd` 是 dry-run，`git status --porcelain` 只打印）。
 * 没有对应预演命令的键（比如 `tfDestroy` 要连云、`dbMigrate` 各工具旗标不一）**不在表里** ——
 * 那就盲问，与做这件事之前的行为一致。
 */
export const BLAST_COMMANDS: Readonly<Partial<Record<BashDenialKey, string>>> = {
  gitResetHard: GIT_STATUS,
  gitCheckoutDiscard: GIT_STATUS,
  gitRestoreDiscard: GIT_STATUS,
  gitCleanForce: "git clean -nd",
  gitStashDrop: "git stash list",
  gitBranchDelete: "git branch -vv",
  gitForcePush: "git log --oneline -n 10",
};

/** 预演的**终止截止时间**（与预检那 3 秒同一条理由：**工程上界**，不是产品策略，故不进设置面）。
 *  到点由执行器杀进程；本模块同时用同一枚取消信号结束等待，所以审批不会被一枚挂起的执行器
 *  promise 永久挂住。进程关闭本身可能还要等宿主的 grace，它不是"函数在 3 秒内返回"的硬上界。 */
export const BLAST_TIMEOUT_MS = 3000;
/** 预演输出的字符上限（写进模型的文案里，长了只是噪音）。 */
export const BLAST_MAX_CHARS = 1200;
/** 预演输出的行数上限。 */
export const BLAST_MAX_LINES = 20;

/** 一次预演的读取结果（宿主侧跑完子进程后交进来）。 */
export interface BlastReading {
  /** 实际跑的那条命令（写进文案，让用户知道证据是哪来的）。 */
  command: string;
  /** 命令的 stdout（原始，未截断）。 */
  text: string;
}

/** 按行数与字符数两道上限收紧预演输出。
 *
 *  只去掉**尾部空行**（换行符的残余），保留内部空行：内部空行也是一行，不能借
 *  `filter` 把它静默吃掉而不计进 `clipped`。`clipped` 只表示触发了行数或字符数上限。
 *
 *  ⚠ 不能拿原文 `trim()` 后比 —— porcelain 输出的**前导空格是有意义的**
 *（` M a.ts` = 工作区已改），拿 trim 比会把"只是行首有空格"判成"被收紧了"，
 *  于是给用户添一句假话。 */
export function clipBlast(text: string): { text: string; clipped: boolean } {
  const lines = text.split("\n");
  while (lines.at(-1) === "") {
    lines.pop();
  }
  const droppedLines = lines.length > BLAST_MAX_LINES;
  const joined = lines.slice(0, BLAST_MAX_LINES).join("\n");
  const droppedChars = joined.length > BLAST_MAX_CHARS;
  return {
    text: droppedChars ? joined.slice(0, BLAST_MAX_CHARS) : joined,
    clipped: droppedLines || droppedChars,
  };
}

/**
 * 把一次预演渲染成一段（接在 `ask` 的 `reason` 之后）。
 *
 * 空输出**不是**结论：它只说明这条探针此刻没有可打印的内容，不能证明原操作不会改动
 * 任何东西（`git reset --hard HEAD~1` 在干净工作区上同样没有输出，却会移动分支）。
 * 文案必须把这个区别说出来，否则审批证据本身就在骗用户。
 */
export function renderBlast(reading: BlastReading, messages: DangerGuardMessages): string {
  const { text, clipped } = clipBlast(reading.text);
  const { command } = reading;
  if (text.length === 0) {
    return fillTemplate(messages.blastEmpty, { command });
  }
  const body = clipped
    ? `${text}\n${fillTemplate(messages.blastClip, {
        chars: String(BLAST_MAX_CHARS),
        lines: String(BLAST_MAX_LINES),
      })}`
    : text;
  return fillTemplate(messages.blastHead, { command, body });
}

/** `ctx.shell` 的**执行面**（预演专用）：本包只调 `resolve` 与 `execute` 两位。
 *  与 `lib/sandbox-scope.ts` 里那个只探 `sandboxMode` 的面**刻意分开**：两处读的是同一个
 *  服务的两位，但关心的东西无关（缺 `sandboxMode` 不该让预演停摆，反之亦然）。 */
interface ShellRunFace {
  /** 执行器自报的沙箱模式；`undefined` = 这个执行器不沙箱。 */
  readonly sandboxMode?: unknown;
  resolve: (request: Record<string, unknown>) => unknown;
  /** 返回域写 `unknown`：守卫只验"可调用"，`await` 对非 promise 是恒等的
   *（与 `ShellHandle.result` 同一条纪律）。 */
  execute: (spec: unknown) => unknown;
}

/** 执行面形状守卫。**只探两位是不是函数** —— `execute` 交回的形状在读取处再验一次
 *（见 `isShellHandle` 与 `readingOf`），因为"守卫比它声称的松"正是漂移的入口。 */
const isShellRunFace = (value: unknown): value is ShellRunFace =>
  isRecord(value) &&
  typeof value["resolve"] === "function" &&
  typeof value["execute"] === "function";

/** `execute` 交回的执行句柄：本包只调 `result()` 一位。
 *  返回域写 `unknown` 而不是 `Promise<unknown>`：守卫验的只是"它可调用"，
 *  而 `await` 对非 promise 的值是恒等的 —— 声称它会返回 promise 就是守卫在说它没验过的话。 */
interface ShellHandle {
  result: () => unknown;
}

const isShellHandle = (value: unknown): value is ShellHandle =>
  isRecord(value) && typeof value["result"] === "function";

/** 只把**明确未发生**当作可用的输出：`true` 或任何非布尔真值都按形状不符退回盲问。
 *  宿主交回 `truncated: 1` / `aborted: "true"` 时，`!== true` 会把它当成未发生。 */
const explicitlyInactive = (value: unknown): boolean => value === undefined || value === false;

/** 一次预演结果 → 读取结果。**非零退出 / 超时 / 取消 / 宿主截断 / 形状不符一律
 *  `undefined`**。`stdout.truncated` 是宿主侧的收集上限：截断后的 `text` 是**尾部**，
 *  拿它当完整清单会静默丢掉开头，所以宁可盲问。 */
function readingOf(result: unknown, command: string): BlastReading | undefined {
  let reading: BlastReading | undefined;
  if (isRecord(result)) {
    const { exitCode, timedOut, aborted, stdout } = result;
    const { text, truncated } = isRecord(stdout) ? stdout : {};
    if (
      exitCode === 0 &&
      explicitlyInactive(timedOut) &&
      explicitlyInactive(aborted) &&
      explicitlyInactive(truncated) &&
      typeof text === "string"
    ) {
      reading = { command, text };
    }
  }
  return reading;
}

/** `ctx.sandboxPolicy` 的读取面：与 `lib/sandbox-scope.ts` 同一形状。 */
interface PolicyFace {
  resolve: (request?: { session?: unknown }) => unknown;
}

const isPolicyFace = (value: unknown): value is PolicyFace =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { resolve?: unknown }).resolve === "function";

/** 策略解析结果：`ok: false` = 这趟不能安全开跑（退回盲问）。 */
type SandboxRequest =
  | { readonly ok: true; readonly request: { readonly sandboxPolicy?: unknown } }
  | { readonly ok: false };

/** 解析出来的策略是否**真的带着一个模式**。
 *
 *  只验 `typeof === "object" && !== null` 不够：数组、`Promise`、`{}` 空壳都过得了，而执行器
 *  拿到没有 `mode` 的策略会回落部署默认。这里不校验 mode 是不是那三枚已知字面量 —— 宿主
 *  将来加档位时，多认一枚也不会让我们误判（模式由执行器解释，本模块只要求"它给了"）。 */
const isResolvedPolicy = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { mode } = value as { mode?: unknown };
  return typeof mode === "string" && mode.length > 0;
};

/**
 * 预演要带的沙箱策略。
 *
 * 执行器自报**不沙箱**（`sandboxMode` 缺席）时，策略只是惰性字段，读不到也可以照跑；
 * 执行器自报**会沙箱**时，缺策略就不能跑 —— 不传策略会落回部署默认，而部署默认可能比
 * 会话当前档位宽松，甚至就是 `danger-full-access`。解析抛错或返回 `undefined` 同样按
 * "读不到"处理，退回盲问。
 *
 * 形状照官方 `tool-bash` 的读法：`resolve(exec.agent === undefined ? {} : { session })`。
 */
function sandboxRequestOf(
  policyRaw: unknown,
  session: unknown,
  shellRaw: ShellRunFace,
): SandboxRequest {
  const sandboxed = shellRaw.sandboxMode !== undefined;
  if (!isPolicyFace(policyRaw)) {
    return sandboxed ? { ok: false } : { ok: true, request: {} };
  }
  try {
    const sandboxPolicy = policyRaw.resolve(session === undefined ? {} : { session });
    // 判据要**读到 mode**，不是"解析结果是个对象"：数组、Promise、`{}` 这类没有 mode 的壳
    // 都会过 `typeof === "object"`，而执行器读到 `mode === undefined` 时是按**部署默认**跑的
    // ——那可能比会话当前档位宽松，甚至就是 `danger-full-access`。于是"带上策略"这件事本身
    // 会变成一句空话：命令照跑，沙箱却退了一档。同仓 `lib/sandbox-scope.ts` 的
    // `scopeOfResolvedPolicy` / `sandboxModeOf` 都是从 `resolved` 里解出 `mode` 再判字符串，
    // 这里照同一口径收口。
    return isResolvedPolicy(sandboxPolicy)
      ? { ok: true, request: { sandboxPolicy } }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** 这些 git 全局选项会把操作指向另一个仓库/工作树；预演固定在会话 cwd，量到的就不是
 *  原命令的目标。宁可盲问，也不拿另一份盘冒充证据。
 *
 *  `-C` 后面**不要求空白**：git 接受紧凑写法（`-Csub`、`-C/tmp/other`、`-C"/tmp/other"`，
 *  后两种是同一件事在 shell 去引号前后的样子）。`(?!-)` 只排掉 `-C-` 这类别的选项前缀，
 *  所以 `--config` 不会被误认成 `-C`。 */
const REPO_OVERRIDE_RE = /(?:^|[\s;&|()"'`])["']?(?:-C(?!-)|--git-dir|--work-tree)/u;

/** git 也认这两枚环境变量，效果与 `--git-dir` / `--work-tree` 等价，且可以前缀在命令上。 */
const GIT_REPO_ENV_RE = /(?:^|[\s;&|()"'`])(?:GIT_DIR|GIT_WORK_TREE)=/u;

/** `cd` 离开 cwd 子树（`..`/`~`/`$HOME`/绝对路径/盘符）后，后面的 git 命令量的就是另一棵树。
 *  留在子树里的 `cd src` 不算：那种情形下 cwd 仍能唯一确定仓库根。 */
const CD_ESCAPE_RE = /(?:^|[\s;&|()"'`])cd\s+(?:\.\.(?:[/\s;&|]|$)|[~/]|\$[A-Za-z_{(]|[A-Za-z]:)/u;

/** 目录切换内建：`cd` / `pushd` 改变当前目录，`popd` 回到目录栈里的上一项。 */
const DIRECTORY_COMMANDS: ReadonlySet<string> = new Set(["cd", "popd", "pushd"]);
/** `cd`/`pushd` 自身的选项：跳过它们后下一枚才是目标目录。 */
const DIRECTORY_FLAGS: ReadonlySet<string> = new Set(["-L", "-P", "-e", "-@", "-n", "--"]);

/** Windows 盘符形（`C:`）：词法形不是 POSIX 绝对路径。 */
const WINDOWS_DRIVE_SHAPE = /^[A-Za-z]:/u;

/** 目录目标是否离开 cwd 子树。词值已由 lexTokens 去过引号，所以 `cd "$HOME"` 与
 *  `cd $HOME` 在这里同形；Windows 分隔符按 `/` 归一后再判，避免 `cd ..\\other` 漏判。 */
function directoryTargetEscapes(target: string): boolean {
  if (target.length === 0 || target === "-") {
    return true;
  }
  if (target.includes("$") || target.startsWith("~") || path.posix.isAbsolute(target)) {
    return true;
  }
  if (WINDOWS_DRIVE_SHAPE.test(target)) {
    return true;
  }
  const normalized = path.posix.normalize(target.replaceAll("\\", "/"));
  return normalized === ".." || normalized.startsWith("../");
}

/** `env --chdir` 的取值同样换目录；相对值留在子树里，绝对值离开。
 *  `env -C` 的紧凑与空格写法都已被 `REPO_OVERRIDE_RE` 当作仓库覆盖位截住，
 *  这里不重复判。 */
function envChdirEscapes(tokens: readonly string[]): boolean {
  const envIndex = tokens.indexOf("env");
  if (envIndex === -1) {
    return false;
  }
  const after = tokens.slice(envIndex + 1);
  for (const [offset, token] of after.entries()) {
    if (token.startsWith("--chdir=")) {
      return directoryTargetEscapes(token.slice("--chdir=".length));
    }
    if (token === "--chdir") {
      const value = after[offset + 1];
      return value === undefined || directoryTargetEscapes(value);
    }
  }
  return false;
}

/** 跳过 `cd`/`pushd`/`popd` 自身的选项，交回目标目录所在下标。 */
function directoryTargetIndex(tokens: readonly string[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const candidate = tokens[index];
    if (candidate === undefined || !DIRECTORY_FLAGS.has(candidate)) {
      break;
    }
    index += 1;
  }
  return index;
}

/** 单段里的目录切换是否离开 cwd 子树。 */
function segmentEscapesCwd(segment: string): boolean {
  const lexed = lexTokens(segment);
  const tokens = lexed.map((token) => token.value);
  if (envChdirEscapes(tokens)) {
    return true;
  }
  for (let index = 0; index < lexed.length; index += 1) {
    const token = lexed[index];
    if (token !== undefined && DIRECTORY_COMMANDS.has(token.value)) {
      const target = lexed[directoryTargetIndex(tokens, index + 1)]?.raw;
      // `cd` / `pushd` / `popd` 无目标时分别回 HOME、交换栈顶、回栈内上一项，落点都不由 cwd 决定。
      if (target === undefined || directoryTargetEscapes(target)) {
        return true;
      }
    }
  }
  return false;
}

/** 任一段里的 `cd` / `pushd` / `popd` / `env --chdir` 是否离开 cwd 子树。 */
function directoryEscapeOf(command: string): boolean {
  return splitTopLevel(command).some((segment) => segmentEscapesCwd(segment));
}

/**
 * 原命令的仓库目标是否**无法用会话 cwd 唯一确定**。
 *
 * 宁可误判为不确定（多一次盲问），也不要展示另一仓库的干净状态 —— 虚假证据比没有证据更
 * 糟，因为它带着"我查过了"的权威。原命令只经过这几条跳过判据，绝不参与预演命令的拼接。
 */
export function blastTargetUncertainOf(command: string): boolean {
  return (
    REPO_OVERRIDE_RE.test(command) ||
    GIT_REPO_ENV_RE.test(command) ||
    CD_ESCAPE_RE.test(command) ||
    directoryEscapeOf(command)
  );
}

/** 读 `aborted` 的显式函数：TypeScript 会把前面 `!signal.aborted` 的判断带进闭包，
 *  把这里窄化成恒假；取消是异步发生的，必须在读取点重新取。 */
const abortedOf = (signal: AbortSignal): boolean => signal.aborted;

/**
 * 等待 `pending`，但**同一枚取消信号**一响就不再等。信号由宿主与墙钟合流（见 host.ts 的
 * `preflightSignalOf`），所以到点后审批不会被一枚挂起的执行器 promise 永久挂住。
 *
 * 子进程的终止仍由执行器按 `signal` / `timeoutMs` 完成；本函数只结束**等待**。
 */
async function boundedOf<Value>(
  pending: Promise<Value>,
  signal: AbortSignal,
): Promise<Value | undefined> {
  const stopWaiting = new AbortController();
  const aborted = (async (): Promise<undefined> => {
    if (abortedOf(signal)) {
      return undefined;
    }
    try {
      await once(signal, "abort", { signal: stopWaiting.signal });
    } catch {
      // 另一侧先结束；这是正常收尾，不是预演失败。
    }
    return undefined;
  })();
  // `Promise.race` 同时给 `pending` 挂上拒绝处理器：即使这里先被取消，
  // 迟到的执行器拒绝也不会变成未处理拒绝。
  try {
    const value = await Promise.race([pending, aborted]);
    return abortedOf(signal) ? undefined : value;
  } finally {
    stopWaiting.abort();
  }
}

/** `measureBlastOf` 的入参。收成对象是因为它有多位、且后几位常一起缺席——
 *  位置参数会让 `undefined, undefined` 串位，而这里每一位都影响一次真实子进程调用。 */
export interface MeasureBlastOptions {
  /** `ctx.get("shell")` 的**原始值**（形状由本模块判）。 */
  readonly shellRaw: unknown;
  /** `ctx.get("sandboxPolicy")` 的原始值；读不到时按执行器是否沙箱决定盲问。 */
  readonly policyRaw: unknown;
  /** 要跑的只读预演命令（缺席 ⇒ 这一族没有预演，直接盲问）。 */
  readonly command: string | undefined;
  /** 原命令；只用于判断仓库目标是否可确定，绝不参与命令拼接。 */
  readonly sourceCommand: string;
  /** 会话工作目录（预演在那里跑）；缺席即盲问，不替执行器猜目录。 */
  readonly cwd: string | undefined;
  /** 会话（逐会话的 sandbox 覆盖按它解析）；缺席用部署默认。 */
  readonly session: unknown;
  /** 已与墙钟合流的取消信号。 */
  readonly signal: AbortSignal;
}

/** 执行一趟已通过前置判据的预演。入参形状照官方 `ShellExecRequest` 给：
 *  `onExpiry: "kill"` + `timeoutMs` 让执行器到点杀进程；`sandboxPolicy` 与 `runGate`
 *  那条路同口径，避免回落到部署级默认。 */
async function runBlast(
  shellRaw: ShellRunFace,
  request: { readonly sandboxPolicy?: unknown },
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<BlastReading | undefined> {
  let reading: BlastReading | undefined;
  const spec = shellRaw.resolve({
    command,
    timeoutMs: BLAST_TIMEOUT_MS,
    onExpiry: "kill",
    signal,
    workdir: cwd,
    ...request,
  });
  if (!abortedOf(signal)) {
    const handle = await boundedOf(Promise.resolve(shellRaw.execute(spec)), signal);
    if (isShellHandle(handle)) {
      const result = await boundedOf(Promise.resolve(handle.result()), signal);
      reading = readingOf(result, command);
    }
  }
  return reading;
}

/**
 * 跑一趟**只读预演**并交回读取结果（`ask` 档专属）。
 *
 * 这是本包唯一一处子进程调用（原先的「判定链无子进程」不变式在这里有意放宽，
 * 边界钉在本文件头上）。**任何失败都退回盲问**：执行器缺席、仓库目标不确定、策略解析
 * 失败、非零退出、超时、取消、宿主截断输出、交回的形状不符 —— 一律 `undefined`，
 * 审批本身的结论一个字不变。
 *
 * @param shellRaw - `ctx.get("shell")` 的**原始值**（形状由本模块判）。
 * @param command  - 要跑的只读预演命令（缺席 ⇒ 这一族没有预演，直接盲问）。
 * @param sourceCommand - 原命令（只用于仓库目标判据）。
 * @param cwd      - 会话工作目录（预演在那里跑；缺席即盲问）。
 * @param signal   - 已与墙钟合流的取消信号（由宿主给：见 host.ts 的 `preflightSignalOf`）。
 */
export async function measureBlastOf(
  options: MeasureBlastOptions,
): Promise<BlastReading | undefined> {
  const { shellRaw, policyRaw, command, sourceCommand, cwd, session, signal } = options;
  let reading: BlastReading | undefined;
  if (
    command !== undefined &&
    cwd !== undefined &&
    !abortedOf(signal) &&
    !blastTargetUncertainOf(sourceCommand)
  ) {
    try {
      // 形状守卫也在 try 内：宿主服务的属性可能是带抛错的 getter，异常若逃出这里，
      // “任何失败都退回盲问”的边界就不成立。
      if (isShellRunFace(shellRaw)) {
        const policy = sandboxRequestOf(policyRaw, session, shellRaw);
        if (policy.ok) {
          reading = await runBlast(shellRaw, policy.request, command, cwd, signal);
        }
      }
    } catch {
      // 预演失败是**预期内**的事（不在 git 仓库里、执行器报错、超时）—— 它不是告警，
      // 只是"这次量不出来"。所以这里不出声，与预检那条"陷阱要留痕"不同。
      reading = undefined;
    }
  }
  return reading;
}

/**
 * 把预演那段接进 `ask` 的**每一处文案**：`reason`（模型侧）与 `displayReason` 的
 * **每一门语言**（用户侧）。
 *
 * 只接 `reason` 是不够的 —— 审批弹窗优先显示 `displayReason`，那样用户看不到证据，
 * 这次改动就白做了。逐语言接也**不是**洁癖：`displayReasonOf` 是按 `Locale` 泛化的，
 * 写死 `{en, zh}` 会让宿主新增的语言静默拿不到这段。预演文案本身也按每门语言现渲染，
 * 不能把宿主当次语言的那一份原样贴到其他语言上。
 */
export function withBlast(
  ask: AskRequest,
  reading: BlastReading | undefined,
  messages: DangerGuardMessages,
): AskRequest {
  if (reading === undefined) {
    return ask;
  }
  // 先落 `en`（官方那一位的**必填**成员），再逐语言覆盖 —— 空字面量过不了必填那一格。
  const displayReason: { en: string; [locale: string]: string } = {
    en: `${ask.displayReason.en}\n${renderBlast(reading, MESSAGES.en)}`,
  };
  for (const [locale, text] of Object.entries(ask.displayReason)) {
    displayReason[locale] = `${text}\n${renderBlast(reading, MESSAGES[resolveLocale(locale)])}`;
  }
  return { ...ask, reason: `${ask.reason}\n${renderBlast(reading, messages)}`, displayReason };
}

/** 空白串（命令词切分用；模块作用域常量，免得每次调用都重建正则）。 */
const WHITESPACE_RUN = /\s+/u;

/** 短旗标簇的词形（`-fdx`、`-fdX`）：单横线 + 全字母。 */
const SHORT_FLAG_WORD = /^-[A-Za-z]+$/u;
/** 短旗标里的 "x"：`-x`/`-X` 都算（用 `i` 旗标而不是字符组，免得被 `use-ignore-case` 报）。 */
const IGNORED_FLAG_CHAR = /x/iu;

/** 原命令里能不能看见「连 `.gitignore` 忽略的文件一起删」这一位的短旗标族。
 *  `-x` 与 `-X` 可与其他短旗标合写（`-fdx`、`-fdX`），所以按字符集匹配而不是整词匹配。
 *  逐词判而不是一条正则：`[A-Za-z]*[xX][A-Za-z]*` 两段可交换，正则引擎会因此被
 *  `regexp/no-super-linear-backtracking` 判成多项式回溯面。 */
const hasIgnoredFlag = (word: string): boolean =>
  SHORT_FLAG_WORD.test(word) && IGNORED_FLAG_CHAR.test(word);

/** 这枚键的预演清单会不会**系统性小于**原命令实际会删的东西（是则退回盲问）。
 *
 *  只有 `gitCleanForce` 一条：预演是 `git clean -nd`，**不列** `.gitignore` 忽略的文件；
 *  原命令带 `-x`（连 ignored 一起删）或 `-X`（只删 ignored）时，那份清单会小到误导用户 ——
 *  量出来的证据比不量更危险，所以这种情形**不跑预演**，退回盲问。其余键的预演与原命令
 *  量的是同一件事，没有这一位偏差。
 */
export function blastPreflightSkippedOf(key: BashDenialKey, command: string): boolean {
  return (
    key === "gitCleanForce" && command.split(WHITESPACE_RUN).some((word) => hasIgnoredFlag(word))
  );
}
