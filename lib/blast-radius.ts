// lib/blast-radius.ts —— **量出爆炸半径**：把"这一步会改动什么"取成事实，写进审批请求。
//
// 为什么做这件事：本包原先的 `ask` 是**盲问** —— 用户只看到"这条命令会丢弃未提交改动"，
// 看不到**具体丢什么**。dsh 官方自带的示例 mod `Blast Radius`
//（`packages/experimental/claude-code-mods/examples/blast-radius/`）示范了另一条路：
// 先跑 `git status` / `git clean -n` / `du` 把清单量出来，再连同面板一起给用户看。
// 本模块采用它的一半（量证据），不采用另一半（自定义 UI 面板）—— 面板归宿主，
// 我们只把事实写进审批请求的文案里。
//
// ⚠ 这次改动**破了本包一条既有不变式**：原先「判定链没有任何 fs 写入、网络请求或子进程
// 调用」。现在判定链里多了**只读预演**这一趟子进程。边界钉死在下面三条：
//   1. 只在 **`ask` 档**跑（`deny` 档不跑：那时结论已定，量它不是用户要看的东西）；
//   2. 只在 **`ctx.shell` 在位**时跑（没装执行器的 profile 退化成盲问，不静默换命令）；
//   3. 预演命令是**写死的常量**，**不插值任何模型输入** —— 插值模型给的路径就是拿命令
//      原文拼 shell 串，那是注入面。所以 `gitRestoreDiscard` 量的是整个工作区
//      （`git status --porcelain`）而不是那条命令点名的那几个文件。
//   4. 量不出来（执行器缺席 / 非零退出 / 超时 / 取消）一律**退回盲问**，绝不因此改变
//      审批本身的结论 —— 量证据是增强，不是判据。
//
// 本模块只管**常量表与渲染**（纯函数，可脱离宿主单测）；跑子进程那一趟在 host.ts
//（它才拿得到 `ctx.shell` 与会话 cwd）。

import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

import type { BashDenialKey } from "./danger-rules.ts";
import type { AskRequest } from "./confirm.ts";
import { fillTemplate } from "./messages.ts";
import type { DangerGuardMessages } from "./messages.ts";

/** 三枚"丢弃工作区改动"的键共用同一条预演（它们量的是同一件事：工作区现在有什么）。 */
const GIT_STATUS = "git status --porcelain";

/**
 * 每枚规则键的**只读预演命令**。
 *
 * 全表都是读命令：`--porcelain` / `-n` / `list` / `-vv` 都不改任何东西
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

/** 预演的墙钟上限（与预检那 3 秒同一条理由：**工程上界**，不是产品策略，故不进设置面）。
 *  它同时是"平台不会放弃一枚挂起的 promise"那条纪律的兑现 —— 预演卡住不能把整次调用挂住。 */
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
 *  ⚠ `clipped` 必须按**我们真的丢没丢东西**算，不能拿原文 `trim()` 后比 —— porcelain 输出
 *  的**前导空格是有意义的**（` M a.ts` = 工作区已改），拿 trim 比会把"只是行首有空格"
 *  判成"被收紧了"，于是给用户添一句假话。 */
export function clipBlast(text: string): { text: string; clipped: boolean } {
  const lines = text.split("\n").filter((line) => line.length > 0);
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
 * 空输出**不是**"什么都没查到"：它恰恰是"这一刻没有任何待丢的东西"这条**结论** ——
 * 与预检那三句零命中文案同一条纪律（空列表不是结论，那句话才是）。
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
  resolve: (request: Record<string, unknown>) => unknown;
  execute: (spec: unknown) => Promise<unknown>;
}

/** 执行面形状守卫。**只探两位是不是函数** —— `execute` 交回的形状在读取处再验一次
 *（见 `blastTextOf`），因为"守卫比它声称的松"正是漂移的入口。 */
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

/** 一次预演结果 → 渲染好的那一段。**非零退出 / 超时 / 取消 / 形状不符一律 `undefined`**。 */
function blastTextOf(
  result: unknown,
  command: string,
  messages: DangerGuardMessages,
): string | undefined {
  let rendered: string | undefined;
  if (isRecord(result)) {
    const { exitCode, timedOut, aborted, stdout } = result;
    const { text } = isRecord(stdout) ? stdout : {};
    if (exitCode === 0 && timedOut !== true && aborted !== true && typeof text === "string") {
      rendered = renderBlast({ command, text }, messages);
    }
  }
  return rendered;
}

/**
 * 跑一趟**只读预演**并把结果渲染好（`ask` 档专属）。
 *
 * 这是本包唯一一处子进程调用（原先的「判定链无子进程」不变式在这里有意放宽，
 * 边界钉在本文件头上）。**任何失败都退回盲问**：执行器缺席、非零退出、超时、取消、
 * 输出读不出、交回的形状不符 —— 一律 `undefined`，审批本身的结论一个字不变。
 *
 * @param shellRaw - `ctx.get("shell")` 的**原始值**（形状由本模块判）。
 * @param command  - 要跑的只读预演命令（缺席 ⇒ 这一族没有预演，直接盲问）。
 * @param cwd      - 会话工作目录（预演在那里跑）。
 * @param signal   - 已与墙钟合流的取消信号（由宿主给：见 host.ts 的 `preflightSignalOf`）。
 * @param messages - 当次语言的文案表。
 */
export async function measureBlastOf(
  shellRaw: unknown,
  command: string | undefined,
  cwd: string | undefined,
  signal: AbortSignal,
  messages: DangerGuardMessages,
): Promise<string | undefined> {
  let rendered: string | undefined;
  if (command !== undefined && isShellRunFace(shellRaw)) {
    try {
      // 入参形状照官方 `ShellExecRequest` 给：`onExpiry: "kill"` + `timeoutMs` 让执行器
      // 到点杀进程；`workdir` 缺席时由执行器用它自己的默认值（不替它猜一个目录）。
      const spec = shellRaw.resolve({
        command,
        timeoutMs: BLAST_TIMEOUT_MS,
        onExpiry: "kill",
        signal,
        ...(cwd === undefined ? {} : { workdir: cwd }),
      });
      const handle: unknown = await shellRaw.execute(spec);
      if (isShellHandle(handle)) {
        rendered = blastTextOf(await handle.result(), command, messages);
      }
    } catch {
      // 预演失败是**预期内**的事（不在 git 仓库里、执行器报错、超时）—— 它不是告警，
      // 只是"这次量不出来"。所以这里不出声，与预检那条"陷阱要留痕"不同。
      rendered = undefined;
    }
  }
  return rendered;
}

/**
 * 把预演那段接进 `ask` 的**每一处文案**：`reason`（模型侧）与 `displayReason` 的
 * **每一门语言**（用户侧）。
 *
 * 只接 `reason` 是不够的 —— 审批弹窗优先显示 `displayReason`，那样用户看不到证据，
 * 这次改动就白做了。逐语言接也**不是**洁癖：`displayReasonOf` 是按 `Locale` 泛化的，
 * 写死 `{en, zh}` 会让宿主新增的语言静默拿不到这段。
 */
export function withBlast(ask: AskRequest, blast: string | undefined): AskRequest {
  if (blast === undefined) {
    return ask;
  }
  // 先落 `en`（官方那一位的**必填**成员），再逐语言覆盖 —— 空字面量过不了必填那一格。
  const displayReason: { en: string; [locale: string]: string } = {
    en: ask.displayReason.en,
  };
  for (const [locale, text] of Object.entries(ask.displayReason)) {
    displayReason[locale] = `${text}\n${blast}`;
  }
  return { ...ask, reason: `${ask.reason}\n${blast}`, displayReason };
}
