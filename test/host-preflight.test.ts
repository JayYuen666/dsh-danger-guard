// host.ts「编辑前预检」的运行路径接线测试。
//
// 为什么经监听器 + guard 两个入口断言：预检的两面各自挂在一条官方瀑布上——
//   A 面 `ctx.on("tools/post-execute")`（引用面随读取结果出去），
//   B 面 `ctx.on("tools/pre-execute")`（盲改被带证据的拒绝拦下），
//   随后同步的 `ctx.tools.guard` 谓词凭**投递水位**放行。
// I/O 与渲染本体在 lib/preflight-scan.ts（那边的预算/截断/二进制判据由
//   test/preflight-scan.test.ts 直接钉），本文件只管接线与水位：tsc 能证明"字段被读了"，
//   证明不了"读了真的改变放行结果"——本文件按后者写。
//
// 四条命题（对应改造的四条硬要求）：
//   ① 不抢决定：两条瀑布都先 `await next()`，下游已经 deny/cancel/ask/block 就原样交回；
//   ② 证据真前置：A 面的引用块挂在**读取结果**上（下一次编辑之前就看得见），
//      B 面的正文写进**这一次**调用的拒绝理由（不是下一步）；
//   ③ 有界且诚实：预算截断的扫描可以说、但不记凭证；正文定长读（大文件截断并点明）；
//   ④ 水位可判且可回收：随会话销毁回收、不顶外部改动；密钥面与配额放行态一律让路。
//
// 为什么用真实临时目录：引用扫描与目标读取全靠 fs（`projectRootOf` 认工程标记、二进制靠
//   NUL 字节、`isFile()` 判目录），替身路径探不出任何东西；`/w/proj/...` 那类假路径会让
//   "扫到了什么"整段退化成空断言。
import { describe, it, afterAll, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin, { BUILTIN_BASE } from "../host.ts";
import type { Config } from "../host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
import { MESSAGES, fillTemplate } from "../lib/messages.ts";
// 扫描的两枚上限从 lib 取（用例不许重抄数字：改了上限用例要跟着走，而不是先红）。
import { PREFLIGHT_MAX_FILES, PREFLIGHT_MAX_FINDINGS } from "../lib/preflight-scan.ts";
// 会话日志出自官方 SessionEvent 夹具构造器（信封必填位与品牌都在夹具里补一次）。
import { call as fxCall, result as fxResult } from "./fixtures/events.ts";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
// 两条瀑布的**官方面**：本文件的替身载荷一律按 `Events` 的投影 checked，不再手抄形状。
// 手抄的风险很具体——`{kind:"allow"}` 拼错、结果少一枚必填位、decision 换了臂，用例照样绿，
// 而真宿主根本不是那样调的；把形状钉到官方声明上，漂移就变成编译错误。
import type { Events } from "@deepseek-ai/cordis";
import type { ContentBlock, ToolCallId, UserMessage } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { brandString } from "@deepseek-ai/dsh-brand";
// 预检的取证 I/O 走宿主 fs 面；单元层装不了真后端，用同一份官方五位的本地实现
//（真后端那份由 test/host-integration.test.ts / test/agent-loop-e2e.test.ts 覆盖）。
import type { PreflightFs } from "../lib/preflight-scan.ts";
import { localFsFace } from "./fixtures/local-fs-face.ts";

// ── 文案标记：一律从消息表单源取，不在用例里重抄文案 ─────────────────────────
/** 模板的首段（到第一个空格）：`[引用探查] …` → `[引用探查]`。文案改版只会让用例红。
 *  ⚠ 只对**带独占标签**的模板成立：`[fact-gate] ` 那 12 个字符是行动清单 / 递证据 / 随读取
 *  附上三种口径**共用**的前缀，拿它当标记会让两条互斥的断言同时为真。所以下面
 *  ATTACH_HEAD/HANDOFF_HEAD 取整句，两处 `slice(0, 20)` 也必须切过前缀才有判别力
 *  （真 spine 那两层用的是 host-spine.ts 的 gateMarkOf）。 */
const markOf = (template: string): string => template.slice(0, template.indexOf(" "));
const REFS_MARK = markOf(MESSAGES.zh.preflightRefsHead);
const READ_MARK = markOf(MESSAGES.zh.preflightReadHead);
const ATTACH_HEAD = MESSAGES.zh.preflightAttach;
const HANDOFF_HEAD = MESSAGES.zh.preflightHandoff;
const TRUNCATED_MARK = markOf(MESSAGES.zh.preflightReadTruncated);
/** 两行完成度说明（遍历截断 / 命中达上限）按整句比对——前缀相同，只有内容不同。 */
const partialLine = (limit: number, root: string): string =>
  fillTemplate(MESSAGES.zh.preflightRefsPartial, { limit: String(limit), root });
const cappedLine = (limit: number): string =>
  fillTemplate(MESSAGES.zh.preflightRefsCapped, { limit: String(limit) });
/** 命中行的前缀（`· {file}:{line}: {text}` → `· `）：列表断言只看"哪些文件进了引用块"。 */
const REF_LINE_PREFIX = MESSAGES.zh.preflightRefsLine.slice(
  0,
  MESSAGES.zh.preflightRefsLine.indexOf("{file}"),
);

// ── 轻量宿主替身：guard 谓词 + 两条瀑布监听器 + 会话销毁钩子 ─────────────────
/**
 * 两条瀑布的官方面（`Parameters<>` 剥掉 `this`，与 host.ts 里那两枚读法同一条）：
 *  - `'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>)`（installed dsh-tools :47）
 *  - `'tools/post-execute'(exec, result: Readonly<ToolExecutionResult>, next)`（:70）
 * 本文件的每一枚替身载荷都按这几位 checked：`kind` 拼错、结果少一枚必填位、decision 换臂，
 *  都会在这里变成编译错误，而不是留下一条"测试绿、宿主不这样调"的假用例。
 */
type PreExecuteArgs = Parameters<Events["tools/pre-execute"]>;
type PostExecuteArgs = Parameters<Events["tools/post-execute"]>;
/** 官方执行面（两条瀑布的第一实参同一枚 `ToolExecution`）。 */
type OfficialExec = PreExecuteArgs[0];
/** 官方结果面（success 带 `value`、failure 带 `error` 的判别联合）。 */
type OfficialResult = PostExecuteArgs[1];
/** 两条瀑布的返回域（allow/deny/cancel/ask 与 accept/block）。 */
type PreOutcome = Awaited<ReturnType<PreExecuteArgs[1]>>;
type PostOutcome = Awaited<ReturnType<PostExecuteArgs[2]>>;
type PreExecuteFn = (...args: PreExecuteArgs) => Promise<PreOutcome>;
type PostExecuteFn = (...args: PostExecuteArgs) => Promise<PostOutcome>;
/** 官方 `ToolGuard` 面（:732 `(execution: Readonly<ToolExecution>) => string | undefined`）。 */
type GuardFn = (execution: Readonly<OfficialExec>) => string | undefined;

/** 官方品牌的集中补一处（同 test/fixtures/events.ts 补信封的理由）：`callId`/`rootCallId`
 *  是 `ToolCallId` 幻影品牌串，`token` 是 `symbol & {…}` 的不透明身份。真宿主三枚一定带，
 *  替身不给就是抄近路——本插件不读它们，但**下一个读它们的改动**必须能在编译期站住。 */
const CALL_ID = brandString<ToolCallId>("dg-preflight-call");
const EXEC_TOKEN: OfficialExec["token"] = Symbol("dg-preflight-token") as never;

/** 决定面上的四个臂（用例里的字面量都换成这四枚，拼错的可能性交给编译器）。 */
const ALLOW: PreOutcome = { kind: "allow" };
const DENY_BY_OTHER: PreOutcome = { kind: "deny", reason: "别的插件拦的" };
const ACCEPT: PostOutcome = { kind: "accept" };

/** 一次成功的读取结果 / 一次失败的读取结果（A 面只读 `isError`，但整枚形状按官方面给）。 */
const OK_RESULT: OfficialResult = {
  isError: false,
  content: [{ type: "text", text: "读到的一行正文" }],
  value: null,
};
const FAILED_RESULT: OfficialResult = {
  isError: true,
  content: [{ type: "text", text: "读取失败" }],
  error: { message: "读取失败" },
};

interface MockCtx {
  tools: { guard: (fn: GuardFn) => () => void };
  /** 官方可选注入面：预检要的 `fs` 从这里交出去（与真宿主的 `ctx.inject(["fs"], …)` 同形）。
   *  置 `fsFace = undefined` 就是"这个 profile 没装 fs 后端"那一支。 */
  inject: (deps: readonly string[], activate: (child: Record<string, unknown>) => void) => void;
  /** 交给预检的 fs 读法（本地盘实现，见 test/fixtures/local-fs-face.ts 的理由）。 */
  fsFace: PreflightFs | undefined;
  /** settings 面：拦截半只调 describe()（locale 偏好读面）。 */
  settings: { describe: () => { ns: string; value: unknown; revision: number }[] };
  /** cordis 可选服务读法：只给设置条目挂出的值面读数口。 */
  get: (name: string) => unknown;
  /** 事件注册：本文件要抓两条瀑布、session/disposed（水位回收）与 fs/observed（官方真实路径）。 */
  on: (event: string, listener: unknown) => unknown;
  effect: (fn: () => (() => void) | undefined) => void;
  value: Config;
  guardInstalled: { fn: GuardFn } | null;
  /** 服务注册路径（`TypertRemoteService` 构造时会走它）。本包的替身只探它可调用。 */
  reflect: { provide: (name: string, value?: unknown) => () => void };
  preExecute: { fn: PreExecuteFn } | null;
  postExecute: { fn: PostExecuteFn } | null;
  disposed: ((session: unknown) => unknown) | null;
  /** `fs/observed` 的监听器：后端每观察一枚目标就报一次，本包据此记下官方那一形真实路径。
   *  载荷按 unknown 收——用例要送的正是"后端交来的 target"，而 `targetKey` 是 opaque 品牌位，
   *  测试里没必要（也不该）造一枚合法品牌值：本包只读 `displayPath`。 */
  observed: ((target: unknown) => unknown) | null;
}

function createMockCtx(): MockCtx {
  const ctx: MockCtx = {
    guardInstalled: null,
    fsFace: localFsFace(),
    // 该条目现在会注册一枚 Typert Remote 服务（`ctx.reflect.provide` 是它的注册路径，见
    // lib/stats-remote.ts）。真宿主里 `reflect` 恒在，手写 mock 里补一枚最小替身就够 ——
    // 与下面 `effect` / `provide` 那几位的待遇一致。
    reflect: {
      provide: () => (): void => {
        void 0;
      },
    },
    inject(deps, activate) {
      if (deps.includes("fs") && ctx.fsFace !== undefined) {
        activate({ fs: ctx.fsFace });
      }
    },
    preExecute: null,
    postExecute: null,
    disposed: null,
    observed: null,
    value: { ...BUILTIN_BASE },
    tools: {
      guard(fn) {
        ctx.guardInstalled = { fn };
        return () => {
          ctx.guardInstalled = null;
        };
      },
    },
    // 本文件的用例都测中文（默认语言），故 locale 条目一律"不在组合里"→ 无描述符。
    settings: { describe: () => [] },
    get: (name: string): unknown =>
      name === SETTINGS_READER ? { read: (): Config => ctx.value } : undefined,
    on(event, listener) {
      if (event === "tools/pre-execute") {
        ctx.preExecute = { fn: listener as PreExecuteFn };
      }
      if (event === "tools/post-execute") {
        ctx.postExecute = { fn: listener as PostExecuteFn };
      }
      if (event === "session/disposed") {
        ctx.disposed = listener as (session: unknown) => unknown;
      }
      if (event === "fs/observed") {
        ctx.observed = listener as (target: unknown) => unknown;
      }
    },
    effect(fn) {
      fn();
    },
  };
  return ctx;
}

/** 装配（同其余 host 用例：拦截条目没有 Config，值面经 SETTINGS_READER 现读）。 */
const apply = (ctx: MockCtx): void => {
  plugin.apply(ctx as never);
};

/** 假会话：`snapshotEvents` 可以**不给**（那是"证据不可判定"那条路）。 */
const fakeSession = (
  id: string,
  log?: readonly SessionEvent[],
): { id: string; snapshotEvents?: () => readonly SessionEvent[] } =>
  log === undefined ? { id } : { id, snapshotEvents: () => log };

/** 假 agent：预检只用 `session` 这一位（旧形态的 `inject` 已撤，理由写在 host.ts 那一段）。
 *  官方 `Agent` 面就是 `{ readonly id: SessionId }`（@deepseek-ai/dsh-agent 的 types.d.ts:11），
 *  所以替身**给得出**合法 id；`session` 不在官方面上，是本包自己的读取投影
 *  （`isPreflightAgent` 那条运行时判据守的就是它）。
 *  ⚠ 这一位过去是 `unknown`：当时 dsh-agent 不在依赖里，`ToolExecution.agent` 的类型面解析不到
 *  而塌成 `any`，于是形状全靠自觉。装上官方件之后编译器开始管这件事（同一轮里
 *  `signal`/`arguments` 的宽处也一起现形），所以这里改回有名有形的构造。 */
const fakeAgent = (session: unknown, id = "dg-session"): unknown => ({
  id: brandString<SessionId>(id),
  session,
});

/** 一次调用面（signal / agent 都可缺位，用于测坏形状与取消）。 */
interface ExecFace {
  name: string;
  arguments?: unknown;
  signal?: AbortSignal;
  /** 好形状走 `fakeAgent`（带合法 SessionId）；坏形状用例送的正是"官方面不允许的东西"
   *  ——那一档在类型面上没有合法构造口，所以整位收在 unknown，由 execOf 单点宽化。 */
  agent?: unknown;
}

/** 补成官方执行面：品牌位集中在这里给，用例只写它关心的那几位。 */
const execOf = (exec: ExecFace): OfficialExec => ({
  callId: CALL_ID,
  rootCallId: CALL_ID,
  token: EXEC_TOKEN,
  name: exec.name,
  arguments: exec.arguments,
  // never 是安全向断言（no-unsafe-type-assertion 放行，与本文件 EXEC_TOKEN / apply 同一手法）：
  // 坏 agent 形状要测的就是"宿主送来不像 Agent 的东西"，而本包必须不崩、只让路。
  agent: exec.agent as never,
  signal: exec.signal ?? new AbortController().signal,
});

/** B 面：走一次 pre-execute 监听器。`downstream` 是 `next()` 的回给（缺省 ALLOW）。
 *  缺省值不收对象字面量（unicorn/no-object-as-default-parameter：每趟都要新建一份），
 *  所以在函数体里回落。 */
async function preflightOf(
  ctx: MockCtx,
  exec: ExecFace,
  downstream?: PreOutcome,
): Promise<PreOutcome> {
  assert.ok(ctx.preExecute, "pre-execute 监听器已注册（apply 之后才该调用）");
  return ctx.preExecute.fn(execOf(exec), () => Promise.resolve(downstream ?? ALLOW));
}

/** A 面：走一次 post-execute 监听器。`downstream` 是 `next()` 的回给（缺省 ACCEPT）。 */
async function postFlightOf(
  ctx: MockCtx,
  exec: ExecFace,
  result?: OfficialResult,
  downstream?: PostOutcome,
): Promise<PostOutcome> {
  assert.ok(ctx.postExecute, "post-execute 监听器已注册（apply 之后才该调用）");
  return ctx.postExecute.fn(execOf(exec), result ?? OK_RESULT, () =>
    Promise.resolve(downstream ?? ACCEPT),
  );
}

/** 决定里的拒绝理由（判别式收窄，不是 `as` 断言）。 */
const denyReason = (decision: PreOutcome): string | undefined =>
  decision.kind === "deny" ? decision.reason : undefined;

/** 断言"这一趟被拦下"并交出理由文本（用例随后都在它身上找文案，不必每处再判一次 undefined）。 */
function mustDeny(reason: string | undefined, label: string): string {
  assert.ok(reason !== undefined, `${label}：应当被拦下`);
  return reason;
}

/** 决定上附着的上下文清单（accept 与 block 三种臂都带得上这一位）。 */
/** 决定里的拒绝理由（没拦就回空串）：上面那组用例只关心"给模型的那句长什么样"。 */
const denyText = (decision: PreOutcome): string => denyReason(decision) ?? "";

const contextsOf = (decision: PostOutcome): readonly UserMessage[] =>
  decision.additionalContexts ?? [];

/** 第 n 条附加上下文（不存在即红）。断言与取值走同一枚函数，用例里就不必再判 undefined。 */
function contextAt(decision: PostOutcome, index = 0): UserMessage {
  const message = contextsOf(decision)[index];
  assert.ok(message !== undefined, `第 ${index} 条附加上下文存在`);
  return message;
}

/** 第 n 条附加上下文的正文（官方 ContentBlock 是判别联合，先认 text 那一臂）。 */
function contextText(decision: PostOutcome, index = 0): string {
  const [block] = contextAt(decision, index).content;
  assert.ok(block?.type === "text", "附加块是文本块");
  return block.text;
}

/** 下游先附上的一条上下文：**用官方构造器**造（自己拼 `{role:"user"…}` 会绕开官方的
 *  id 铸造与深冻结，而 A 面要做的正是"并进去、不覆盖它"——替身必须是真的那枚形状）。 */
const otherContext: UserMessage = createUserMessage({
  content: [{ type: "text", text: "下游先附的一条" }],
  source: {
    kind: "dangerguard-preflight",
    form: "notice",
    summary: "占位：下游那条不许被覆盖",
  },
});

/** 随后同步跑的那道 guard 谓词：载荷与两条瀑布同一枚官方面（`execOf` 补品牌位）。
 *  官方契约里 guard 收到的正是 `Readonly<ToolExecution>`，这里不另抄一份窄形状。 */
const guardOf = (
  ctx: MockCtx,
  req: { name: string; args: Record<string, unknown>; session: unknown },
): string | undefined => {
  assert.ok(ctx.guardInstalled, "guard 谓词已挂载");
  return ctx.guardInstalled.fn(
    execOf({ name: req.name, arguments: req.args, agent: fakeAgent(req.session) }),
  );
};

/** 一条编辑调用（30 字符、不含签名关键字：`smallEditChars` 调到 10 即 mid 档 → read+refs）。 */
const editArgs = (target: string): Record<string, unknown> => ({
  file_path: target,
  old_string: "const value = 1",
  new_string: "const value = 2",
});

/** B 面走一次"编辑这枚目标"，只回拒绝理由。
 *  收成一处不是省事：`mustDeny(denyReason(await preflightOf(ctx, {agent: fakeAgent(fakeSession(…))})))`
 *  是五层嵌套调用（unicorn/max-nested-calls 的上限是 3），而"编辑某目标 → 拿理由"是本文件
 *  每条用例的形状——把它压成一枚助手，用例里剩下的都是断言。
 *  参数（args）由调用方自己 `editArgs(target)` 再取一次：同一路径同一形状，取两次是纯字符串
 *  构造，比把可变状态塞进返回值更直白。 */
async function editDenyOf(
  ctx: MockCtx,
  target: string,
  session: unknown,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const decision = await preflightOf(ctx, {
    name: "edit",
    arguments: editArgs(target),
    agent: fakeAgent(session),
    ...(signal === undefined ? {} : { signal }),
  });
  return denyReason(decision);
}

/** 一次**成功**的 read（callId 必须串上 result，缺 result 不算证据）。 */
const readEvents = (target: string, id = "r1"): SessionEvent[] => [
  fxCall(id, "read", JSON.stringify({ file_path: target })),
  fxResult(id),
];

/** 一次**成功**的项目级检索（起点是目标祖先、签名含文件名 ⇒ refs 证据）。 */
const refEvents = (root: string, name: string, id = "g1"): SessionEvent[] => [
  fxCall(id, "grep", JSON.stringify({ path: root, pattern: name })),
  fxResult(id),
];

// ── 夹具（全部真实目录；beforeAll 里落地）──────────────────────────────────
/** 主夹具：`src/ref-mod.ts`（目标）+ 引用者 `src/user-a.ts`；**没有** test/e2e/docs 层，
 *  这样 mid 档的缺项就是 read+refs 两项，不会被层要求干扰。 */
let rootMain: string;
let targetMain: string;
/** 主夹具里的大目标（> 单文件字节上限 ⇒ 正文块截断）。 */
let bigTarget: string;
/** 主夹具里**不存在**的目标（读不出正文 ⇒ B 面不拦）。 */
let missingTarget: string;
/** 主夹具里的密钥面目标（`.env`）：正文永不出域，引用面照给。 */
let secretTarget: string;
const SECRET_SENTINEL = "hunter2";
/** 主夹具里再一枚目标：专测水位的两条生命周期。 */
let disposeTarget: string;
/** 引用扫描的边界夹具：命中条数上限 + 二进制/超限/软链/黑名单目录。 */
let rootCaps: string;
let targetCaps: string;
/** 文件数上限夹具（300 个无命中文件 ⇒ 遍历截断 + 零命中）。 */
let rootFiles: string;
let targetFiles: string;
/** 遍历截断 + 有命中：`hits.ts` 在根层，BFS 一定先读完所有根层文件才展开 bulk。 */
let rootPartial: string;
let targetPartial: string;
/** **目录**预算夹具：300 层空目录 + 根下一枚目标 ⇒ 一个文件都没读就撞上目录预算，
 *  于是截断的成因是 `dirs` 而不是 `files`（`scanned` 如实报 0）。 */
let rootDirs: string;
let targetDirs: string;
/** 层夹具：真实存在 `test/` 层 ⇒ high 档的缺项里多出"层"这一项（B 面从同一次扫描派生它的结论）。 */
let rootLayer: string;
let targetLayer: string;
/** 层夹具②：`test` 是一枚**软链**（指向树内真实目录）。门禁的层探查走 `isDir`（statSync，跟链）
 *  ⇒ 认它存在并要层证据；而扫描按官方 lstat 口径**不跟软链** ⇒ 那层永远进不了 `dirs`。
 *  于是"扫描跑完了、但这一层没被走到"有了独立夹具——与"预算截断"那条不同源，
 *  两者都必须让路（半份「这层我探过了」最糟）。 */
let rootLinked: string;
let targetLinked: string;
/** 缓存新鲜度的夹具。 */
let rootRescan: string;
let targetRescan: string;
/** 小而确定的夹具（3 枚文件）：零命中的全称那句要按**填好的整句**比对，文件数必须是定值。 */
let rootClean: string;
let targetClean: string;
/** 缓存**作废后重扫**的夹具：先撞文件预算（条目进缓存但未记凭证），清空项目 + 目标 mtime
 *  前进之后再判一次 ⇒ 走"条目存在但 mtime 不同"那支，重扫并给出全称结论。 */
let rootInvalidate: string;
let targetInvalidate: string;
/** 官方通道夹具（第 4 项）：普通源文件群。"它在执行世界里其实是凭据面"这件事只由假后端的
 *  `processPath` 说出来——本机 `realpathSync` 看它无害，而非本地后端（sandbox/ssh/e2b）下
 *  只有官方那一形说的是同一份盘。**一枚用例一枚目标**：`officialPaths` 是模块级缓存，
 *  共用目标会让上一条用例记下的那一形漏进下一条的判定。 */
let rootOfficial: string;
const officialTargets: Record<string, string> = {};
/** 这一群夹具里的用例名（同时也是文件名后缀）。 */
const OFFICIAL_CASES = [
  "secret",
  "observed",
  "relative",
  "nopath",
  "noresolve",
  "nobackend",
  "malformed",
  "reuse",
] as const;

/** 后端眼里的"真实路径"：落在凭据目录里，而本机 `realpathSync` 看这枚目标无害。
 *  这就是非本地执行世界（fs-sandbox / ssh / e2b）下唯一能露形的那一形。 */
const SANDBOX_SECRET = "/sandbox/home/x/.ssh/config";

/** 非本地执行世界的那一份读法：本机盘照旧（扫描与正文都真读得到），只有 `processPath`
 *  换成后端交出的进程路径。 */
const sandboxFace = (): PreflightFs => ({
  ...localFsFace(),
  processPath: (): string => SANDBOX_SECRET,
});

/** 取 `fs/observed` 的监听器（没挂上就红在这里，比三处各判一次 null 好读，也少一份重复文案）。 */
function observedOf(ctx: MockCtx): (target: unknown) => unknown {
  const { observed } = ctx;
  assert.ok(observed !== null, "fs/observed 已注册");
  return observed;
}

/** 取官方通道夹具里那枚**用例专属**目标（缺席即夹具没铺好：红在这里比红在断言里好读）。 */
function officialTarget(name: (typeof OFFICIAL_CASES)[number]): string {
  const file = officialTargets[name];
  assert.ok(file !== undefined, `夹具里应当有 official-${name}.ts`);
  return file;
}

/** 两个**显式**时间点：mtime 判据只比相等，用固定值就不依赖 fs 时间戳粒度（同
 *  test/host-tier-settings.test.ts 的 T0/T1 取舍）。 */
const T_EARLIER = new Date("2026-01-01T00:00:00.000Z");
const T_LATER = new Date("2026-02-01T00:00:00.000Z");

/** 大文件正文长度（> 64_000 的单文件上限；末尾那枚哨兵用来证明"只给了开头"）。 */
const BIG_CHARS = 70_000;
const BIG_TAIL = "TAIL-SENTINEL";
/** 文件数上限夹具里的文件数（> lib 的 256 上限）。 */
const BULK_FILES = 300;
/** 目录预算夹具里的目录数（> lib 的 256 上限）。 */
const SIDE_DIRS = 300;
/** 命中条数上限夹具里单文件的命中行数（> lib 的 40 上限）。 */
const HIT_LINES = 50;

/** 工程标记文件名（`projectRootOf` 认它，四处夹具都要放一枚）。 */
const PROJECT_MARKER = "package.json";

/** 铺 BULK_FILES 个无命中文件（两处"遍历截断"夹具共用同一形状）。 */
const bulkFiles = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: BULK_FILES }, (_unused, index) =>
      writeFile(path.join(dir, `f${index}.txt`), "no needle here\n"),
    ),
  );
};

describe("host 预检（Phase 2）：A 面随读取附引用面，B 面盲改带证据拦", () => {
  beforeAll(async () => {
    // ① 主夹具。
    rootMain = await mkdtemp(path.join(tmpdir(), "dg-pf-main-"));
    await mkdir(path.join(rootMain, "src"), { recursive: true });
    await writeFile(path.join(rootMain, PROJECT_MARKER), "{}\n");
    targetMain = path.join(rootMain, "src", "ref-mod.ts");
    await writeFile(targetMain, "export const a = 1;\n");
    await writeFile(path.join(rootMain, "src", "user-a.ts"), 'import { a } from "./ref-mod";\n');
    bigTarget = path.join(rootMain, "src", "big-mod.ts");
    await writeFile(bigTarget, `${"x".repeat(BIG_CHARS)}${BIG_TAIL}\n`);
    missingTarget = path.join(rootMain, "src", "missing-mod.ts");
    secretTarget = path.join(rootMain, ".env");
    await writeFile(secretTarget, `DATABASE_URL=postgres://user:${SECRET_SENTINEL}@db/app\n`);
    disposeTarget = path.join(rootMain, "src", "dispose-mod.ts");
    await writeFile(disposeTarget, "// dispose-mod.ts\n");
    await utimes(disposeTarget, T_EARLIER, T_EARLIER);

    // ② 边界夹具：目标名带短尾词干（`pf.c.ts` 的词干是 `pf.c` 与 `pf`，后者 < MIN_STEM），
    //    命中条数上限靠 `hits.ts` 的 50 行；目标自身也提到自己（不许进结果）。
    rootCaps = await mkdtemp(path.join(tmpdir(), "dg-pf-caps-"));
    targetCaps = path.join(rootCaps, "pf.c.ts");
    await writeFile(targetCaps, "// pf.c.ts\n");
    await writeFile(
      path.join(rootCaps, "hits.ts"),
      Array.from({ length: HIT_LINES }, () => "uses pf.c here\n").join(""),
    );
    await writeFile(path.join(rootCaps, "ok.ts"), "import pf.c ok\n");
    await writeFile(path.join(rootCaps, "bin.dat"), Buffer.from("\u0000pf.c\n"));
    await writeFile(path.join(rootCaps, "big.ts"), `${"y".repeat(BIG_CHARS)}pf.c\n`);
    await mkdir(path.join(rootCaps, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(rootCaps, "node_modules", "pkg", "i.js"), "pf.c\n");
    await mkdir(path.join(rootCaps, ".git"), { recursive: true });
    await writeFile(path.join(rootCaps, ".git", "config"), "pf.c\n");
    await symlink(path.join(rootCaps, "ok.ts"), path.join(rootCaps, "link.ts"));

    // ③ 文件数上限夹具（无 package.json：项目根回落成目标父目录，扫描起点即本目录）。
    rootFiles = await mkdtemp(path.join(tmpdir(), "dg-pf-files-"));
    targetFiles = path.join(rootFiles, "cap-a.ts");
    await writeFile(targetFiles, "// cap-a.ts\n");
    await bulkFiles(path.join(rootFiles, "bulk"));

    // ④ 遍历截断但有命中（见上：BFS 保证根层文件先读完）。
    rootPartial = await mkdtemp(path.join(tmpdir(), "dg-pf-partial-"));
    targetPartial = path.join(rootPartial, "cap-b.ts");
    await writeFile(targetPartial, "// cap-b.ts\n");
    await writeFile(path.join(rootPartial, "hits.ts"), 'import "./cap-b";\n');
    await bulkFiles(path.join(rootPartial, "bulk"));

    // ④b 目录预算夹具：300 枚**空**目录（一个文件都没有），根上只放目标本身。
    rootDirs = await mkdtemp(path.join(tmpdir(), "dg-pf-dirs-"));
    targetDirs = path.join(rootDirs, "cap-c.ts");
    await writeFile(targetDirs, "// cap-c.ts\n");
    await Promise.all(
      Array.from({ length: SIDE_DIRS }, (_unused, index) =>
        mkdir(path.join(rootDirs, `d${index}`), { recursive: true }),
      ),
    );

    // ⑤ 层夹具：真实存在 test/ 层。
    rootLayer = await mkdtemp(path.join(tmpdir(), "dg-pf-layer-"));
    await mkdir(path.join(rootLayer, "test"), { recursive: true });
    await writeFile(path.join(rootLayer, PROJECT_MARKER), "{}\n");
    targetLayer = path.join(rootLayer, "lib-mod.ts");
    await writeFile(targetLayer, "export const d = 1;\n");
    await writeFile(path.join(rootLayer, "test", "lib-mod.test.ts"), 'import "./lib-mod";\n');

    // ⑤b 层软链夹具：`test` 是软链，真实目录叫 test-real（在树内，扫描会走它、不会走 test）。
    rootLinked = await mkdtemp(path.join(tmpdir(), "dg-pf-linked-"));
    await writeFile(path.join(rootLinked, PROJECT_MARKER), "{}\n");
    targetLinked = path.join(rootLinked, "link-mod.ts");
    await writeFile(targetLinked, "export const f = 1;\n");
    await mkdir(path.join(rootLinked, "test-real"), { recursive: true });
    await writeFile(
      path.join(rootLinked, "test-real", "link-mod.test.ts"),
      'import "./link-mod";\n',
    );
    await symlink(path.join(rootLinked, "test-real"), path.join(rootLinked, "test"));

    // ⑥ 缓存复用/过期夹具。
    rootRescan = await mkdtemp(path.join(tmpdir(), "dg-pf-rescan-"));
    await mkdir(path.join(rootRescan, "src"), { recursive: true });
    await writeFile(path.join(rootRescan, PROJECT_MARKER), "{}\n");
    targetRescan = path.join(rootRescan, "src", "rescan-mod.ts");
    await writeFile(targetRescan, "export const b = 1;\n");

    // ⑦ 小而确定的夹具：目标 + 一枚无关文件 + package.json ⇒ 扫过 2 个文件、零命中、扫得完。
    rootClean = await mkdtemp(path.join(tmpdir(), "dg-pf-clean-"));
    await writeFile(path.join(rootClean, PROJECT_MARKER), "{}\n");
    targetClean = path.join(rootClean, "lonely.ts");
    await writeFile(targetClean, "export const only = 1;\n");
    await writeFile(path.join(rootClean, "other.ts"), "export const unrelated = 1;\n");

    // ⑧ 缓存作废夹具：一开始撞文件预算，随后项目被清空 ⇒ 第二趟扫得完。
    rootInvalidate = await mkdtemp(path.join(tmpdir(), "dg-pf-invalidate-"));
    targetInvalidate = path.join(rootInvalidate, "inv-mod.ts");
    await writeFile(targetInvalidate, "export const e = 1;\n");
    await utimes(targetInvalidate, T_EARLIER, T_EARLIER);
    await bulkFiles(path.join(rootInvalidate, "bulk"));

    // ⑨ 官方通道夹具：每枚用例一枚目标（正文都含 editArgs 的 old_string），外加一枚引用者。
    rootOfficial = await mkdtemp(path.join(tmpdir(), "dg-pf-official-"));
    await mkdir(path.join(rootOfficial, "src"), { recursive: true });
    await writeFile(path.join(rootOfficial, PROJECT_MARKER), "{}\n");
    await Promise.all(
      OFFICIAL_CASES.map((name) => {
        const file = path.join(rootOfficial, "src", `official-${name}.ts`);
        officialTargets[name] = file;
        return writeFile(file, "export const value = 1;\n");
      }),
    );
    await writeFile(
      path.join(rootOfficial, "src", "official-user.ts"),
      'import { value } from "./official-secret";\nconsole.log(value);\n',
    );
  });

  afterAll(async () => {
    await Promise.all(
      [
        rootMain,
        rootCaps,
        rootFiles,
        rootPartial,
        rootDirs,
        rootLayer,
        rootLinked,
        rootRescan,
        rootInvalidate,
        rootClean,
        rootOfficial,
      ].map((dir) => rm(dir, { recursive: true, force: true }).catch(() => null)),
    );
  });

  describe("预检 A 面：引用面挂在读取结果上（于是下一次编辑之前就看得见）", () => {
    it("read / view / str_replace_editor view 三种只读检视各附一块引用块，正文不重复给", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      const cases = [
        { name: "read", arguments: { file_path: targetMain } },
        { name: "view", arguments: { file_path: targetMain } },
        { name: "str_replace_editor", arguments: { command: "view", path: targetMain } },
      ];
      // 各用**独立会话**：附加一次就记水位，同会话第二次本就不该再附（那是下一条用例）。
      // 三趟互不相干 ⇒ 并发跑（顺序 await 只是为了断言而串行，用例不需要那个保证）。
      const decisions = await Promise.all(
        cases.map((exec, index) =>
          postFlightOf(ctx, { ...exec, agent: fakeAgent(fakeSession(`s-inspect-${index}`, [])) }),
        ),
      );
      for (const decision of decisions) {
        assert.equal(contextsOf(decision).length, 1, "各附一条");
        const message = contextAt(decision);
        assert.equal(message.source.kind, "dangerguard-preflight", "本包声明的生产者名");
        assert.equal(message.source.form, "notice", "一次性发生的事走 notice 形");
        assert.equal(message.source.summary, MESSAGES.zh.preflightSummary, "notice 必带一行说明");
        const text = contextText(decision);
        assert.ok(text.startsWith(ATTACH_HEAD), "头一句点明这是随读取附上的引用面");
        assert.ok(text.includes(REFS_MARK), "带引用块");
        assert.ok(text.includes("user-a.ts"), "引用列表点名了真实引用者");
        assert.ok(!text.includes(READ_MARK), "目标正文不在这里给（模型这次就在读它）");
      }
    });

    it("同会话同目标再读一次 ⇒ 水位已记，不重复附加（上下文不许被刷满）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      // 会话日志里已经有**成功的 read**：A 面要补的就只有 refs 一项，读第二趟时它已被水位满足。
      const session = fakeSession("s-once", readEvents(targetMain));
      const agent = fakeAgent(session);
      const first = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetMain },
        agent,
      });
      assert.equal(contextsOf(first).length, 1, "第一次附了");
      const second = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetMain },
        agent,
      });
      assert.equal(contextsOf(second).length, 0, "门禁已被水位满足 ⇒ 不再重复");
      // 紧接着的编辑因此零摩擦：B 面不拦、guard 直接放行。
      const args = editArgs(targetMain);
      assert.equal(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })),
        undefined,
        "B 面不必再拦",
      );
      assert.equal(
        guardOf(ctx, { name: "edit", args, session }),
        undefined,
        "引用面真在编辑前到了",
      );
    });

    it("写类调用不经 A 面；读取失败也不附", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const asWrite = await postFlightOf(ctx, {
        name: "edit",
        arguments: editArgs(targetMain),
        agent: fakeAgent(fakeSession("s-post-write", [])),
      });
      assert.equal(contextsOf(asWrite).length, 0, "A 面只认只读检视面");
      const asFailed = await postFlightOf(
        ctx,
        {
          name: "read",
          arguments: { file_path: targetMain },
          agent: fakeAgent(fakeSession("s-read-fail", [])),
        },
        FAILED_RESULT,
      );
      assert.equal(contextsOf(asFailed).length, 0, "模型没读到内容时，'不必再检索'是错的指示");
    });

    it("下游 block 也附：feedback 原样保留，引用块并进 additionalContexts", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      const feedback: ContentBlock[] = [{ type: "text", text: "被别的策略改判" }];
      const decision = await postFlightOf(
        ctx,
        {
          name: "read",
          arguments: { file_path: targetMain },
          agent: fakeAgent(fakeSession("s-block-merge", [])),
        },
        OK_RESULT,
        { kind: "block", feedback },
      );
      // 判别式收窄（assert.ok 带 asserts 签名）而不是 `as` 抄一份形状：官方 union 换臂就报错。
      assert.ok(decision.kind === "block", "block 不被换成 accept");
      assert.deepEqual(decision.feedback, feedback, "feedback 一字不改");
      assert.equal(decision.additionalContexts?.length, 1, "被改判的结果仍然带得上证据");
    });

    it("下游 accept 的 value / content / 已有上下文都不被覆盖", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      const withValue = await postFlightOf(
        ctx,
        {
          name: "read",
          arguments: { file_path: targetMain },
          agent: fakeAgent(fakeSession("s-merge-value", [])),
        },
        OK_RESULT,
        { kind: "accept", value: { ok: 1 }, additionalContexts: [otherContext] },
      );
      assert.ok(withValue.kind === "accept", "accept 仍是 accept");
      assert.ok("value" in withValue, "value 形没被换成 content 形");
      assert.deepEqual(withValue.value, { ok: 1 }, "value 形 accept 保留 value");
      const merged = contextsOf(withValue);
      assert.equal(merged.length, 2, "本次附加排在前面，下游那条保留");
      assert.equal(merged[1], otherContext, "下游那条一字不动");

      const withContent = await postFlightOf(
        ctx,
        {
          name: "read",
          arguments: { file_path: targetMain },
          agent: fakeAgent(fakeSession("s-merge-content", [])),
        },
        OK_RESULT,
        { kind: "accept", content: [{ type: "text", text: "读取结果正文" }] },
      );
      assert.ok(withContent.kind === "accept");
      assert.equal(withContent.content?.length, 1, "content 形 accept 保留 content");
      assert.equal(withContent.value, undefined, "两个臂不同时出现");
      assert.equal(contextsOf(withContent).length, 1);
    });

    it("扫描被预算截断 ⇒ 不附（换不到凭证的半份不占这次读取的上下文）", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      const decision = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetFiles },
        agent: fakeAgent(fakeSession("s-partial-a", [])),
      });
      assert.equal(contextsOf(decision).length, 0, "capped ⇒ 不附");
    });

    it("零命中且扫完 ⇒ 明说'没有任何引用者'（空列表本身不是结论）", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      // 夹具里只有 package.json + other.ts 两枚会被读，都不提 lonely.ts ⇒ 零命中、遍历扫得完。
      const decision = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetClean },
        agent: fakeAgent(fakeSession("s-none", [])),
      });
      assert.ok(
        contextText(decision).includes(
          fillTemplate(MESSAGES.zh.preflightRefsNone, { root: rootClean, scanned: "2" }),
        ),
        `给的是全称那句，实际：${contextText(decision).slice(0, 200)}`,
      );
    });

    it("开关、目标形状与坏 agent：一律原样交回下游决定", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      const docTarget = path.join(rootMain, "README.md");
      await writeFile(docTarget, "# readme\n");
      const good = fakeAgent(fakeSession("s-skip-a", []));
      const cases: ExecFace[] = [
        { name: "bash", arguments: { command: "ls" }, agent: good },
        { name: "read", arguments: {}, agent: good },
        { name: "read", arguments: { file_path: docTarget }, agent: good },
        { name: "read", arguments: "not-a-record", agent: good },
        {
          name: "read",
          arguments: { file_path: targetMain },
          signal: AbortSignal.abort(),
          agent: good,
        },
        { name: "read", arguments: { file_path: targetMain } },
        {
          name: "read",
          arguments: { file_path: targetMain },
          agent: "not-an-agent",
        },
        {
          name: "read",
          arguments: { file_path: targetMain },
          agent: { session: "not-a-session" },
        },
      ];
      const decisions = await Promise.all(cases.map((exec) => postFlightOf(ctx, exec)));
      for (const [index, decision] of decisions.entries()) {
        assert.deepEqual(decision, ACCEPT, `第 ${index} 条跳过支路原样交回下游`);
      }
      // 三个开关各自关闭：A 面一声不出（关掉预检绝不减少判据——由下面 B 面那条同形用例钉）。
      // 这一族**必须顺序**跑：八趟共用同一枚 ctx.value，并发会让开关值落在读法之间漂移。
      for (const key of ["enabled", "factGateEnabled", "preflightEnabled"] as const) {
        ctx.value = { ...BUILTIN_BASE, [key]: false };
        // oxlint-disable-next-line eslint/no-await-in-loop -- 见上：开关要逐条生效再读
        const decision = await postFlightOf(ctx, {
          name: "read",
          arguments: { file_path: targetMain },
          agent: fakeAgent(fakeSession(`s-off-${key}`, [])),
        });
        assert.equal(contextsOf(decision).length, 0, `${key} 关闭时不附加`);
      }
    });
  });

  describe("预检 B 面：盲改被带证据的拒绝拦下，重试即凭水位放行", () => {
    it("read + refs 都缺 ⇒ deny 里同时给正文块与引用块，随后 guard 放行", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-main", []);
      const agent = fakeAgent(session);
      const args = editArgs(targetMain);
      const reason = denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent }));
      assert.ok(reason !== undefined, "没读就改：这一次被拦下（物理停止仍在 dispatch 之前）");
      assert.ok(reason.startsWith(HANDOFF_HEAD), "头部点明证据由插件当场取到、重试即可");
      assert.ok(reason.includes(READ_MARK), "带目标正文块");
      assert.ok(reason.includes(REFS_MARK), "带引用块");
      assert.ok(reason.includes("export const a = 1;"), "正文是文件的真内容");
      assert.ok(reason.includes("user-a.ts"), "引用面点名真实引用者");
      // 重试：预检不再拦（水位已在），同步 guard 也放行——"重试即通过"的整链。
      assert.equal(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })),
        undefined,
        "重试不再被拦",
      );
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "水位让 guard 放行");
    });

    it("只缺 read（low 档）⇒ deny 里只有正文块", async () => {
      const ctx = createMockCtx();
      // 缺省 smallEditChars=200 ⇒ 30 字符改动落 low 档（只要 read）
      apply(ctx);
      const session = fakeSession("s-read-only", []);
      const reason = mustDeny(await editDenyOf(ctx, targetMain, session), "low 档盲改");
      assert.ok(reason.includes(READ_MARK), "补了缺的 read");
      assert.ok(!reason.includes(REFS_MARK), "low 档不要求引用面");
      assert.equal(guardOf(ctx, { name: "edit", args: editArgs(targetMain), session }), undefined);
    });

    it("只缺 refs（日志里已有成功 read）⇒ deny 里只有引用块，正文不重复抄", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      // 会话日志里有一次**成功**的 read：read 由日志满足，B 面这趟要补的只有引用面。
      const session = fakeSession("s-refs-only", readEvents(targetMain));
      const args = editArgs(targetMain);
      const reason = mustDeny(await editDenyOf(ctx, targetMain, session), "只缺引用面");
      assert.ok(reason.includes(REFS_MARK), "补了缺的 refs");
      assert.ok(!reason.includes(READ_MARK), "read 已由日志满足 ⇒ 不重抄正文");
      assert.equal(await editDenyOf(ctx, targetMain, session), undefined, "重试不再被拦");
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "两项齐备 → 放行");
    });

    it("两项齐备 ⇒ 不拦；预检关掉则同一编辑重新被 guard 拒（判据一条不减）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const log = [...readEvents(targetMain), ...refEvents(rootMain, "ref-mod.ts")];
      const session = fakeSession("s-complete", log);
      const args = editArgs(targetMain);
      const decision = await preflightOf(ctx, {
        name: "edit",
        arguments: args,
        agent: fakeAgent(session),
      });
      assert.deepEqual(decision, ALLOW, "没有缺项就没有拒绝");
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "本就放行");

      // 同一形状但缺项：关掉预检 ⇒ 退回"先拒后补证"的老路径，拒绝文案照旧出。
      ctx.value.preflightEnabled = false;
      const offSession = fakeSession("s-off-preflight", []);
      const denied = guardOf(ctx, {
        name: "edit",
        args: editArgs(targetMain),
        session: offSession,
      });
      assert.ok(denied !== undefined, "判据一条不减，变的只是谁去取证");
    });

    it("目标内容超单文件上限 ⇒ 截断并点明，末尾哨兵不出现", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      const session = fakeSession("s-truncate", []);
      const reason = mustDeny(await editDenyOf(ctx, bigTarget, session), "大文件盲改");
      assert.ok(reason.includes(READ_MARK), "read 缺项被补");
      assert.ok(reason.includes(TRUNCATED_MARK), "截断必须点明，不许静默给半份");
      assert.ok(!reason.includes(BIG_TAIL), "只带了上限之内的开头");
    });

    it("读不出正文（目标不存在 / 目标是目录）⇒ 不拦：拦它只有拒绝、没有前置", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const cases = [missingTarget, rootMain].map((target, index) => ({
        index,
        args: editArgs(target),
        session: fakeSession(`s-unreadable-${index}`, []),
      }));
      const decisions = await Promise.all(
        cases.map((item) =>
          preflightOf(ctx, {
            name: "edit",
            arguments: item.args,
            agent: fakeAgent(item.session),
          }),
        ),
      );
      for (const [item, decision] of cases.map((one, i) => [one, decisions[i]] as const)) {
        assert.deepEqual(decision, ALLOW, `第 ${item.index} 支（不存在 / 目录）不拦`);
        assert.ok(
          guardOf(ctx, { name: "edit", args: item.args, session: item.session }) !== undefined,
          "编辑仍被门禁要求取证",
        );
      }
    });

    it("宿主没装 fs 后端 ⇒ 预检整趟不参与（闸门照旧，只是没人替它取证）", async () => {
      // 迁移到 ctx.fs 之后新增的一条让路：读不到工具实际用的那份盘，就一个字都不编。
      // 用 node:fs 的老实现不会有这一支——它会去读**宿主本地盘**并把它当成目标的当前正文。
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      ctx.fsFace = undefined;
      apply(ctx);
      const session = fakeSession("s-nofs", []);
      const decision = await preflightOf(ctx, {
        name: "edit",
        arguments: editArgs(targetMain),
        agent: fakeAgent(session),
      });
      assert.deepEqual(decision, ALLOW, "预检不拦（它给不出任何证据）");
      const deny = guardOf(ctx, { name: "edit", args: editArgs(targetMain), session });
      assert.ok(deny !== undefined, "事实门照旧要求取证");
      assert.ok(deny.includes(MESSAGES.zh.headFirst.slice(0, 20)), "走的是行动清单那一支");
    });

    it("密钥面（.env）⇒ 让路：不拦、正文不出现在任何模型可见文本里", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-secret", []);
      const agent = fakeAgent(session);
      const args = editArgs(secretTarget);
      // B 面不得抢在密钥闸前面把拒绝理由换成"请重试"，也不得把凭据读出来。
      const decision = await preflightOf(ctx, { name: "edit", arguments: args, agent });
      assert.deepEqual(decision, ALLOW, "密钥面整趟让路");
      const guardDeny = guardOf(ctx, { name: "edit", args, session });
      assert.ok(guardDeny !== undefined, "密钥闸照旧拒");
      assert.ok(
        guardDeny.includes(MESSAGES.zh.secretPath),
        `拦它的是密钥面那一句，实际：${guardDeny.slice(0, 120)}`,
      );
      assert.ok(!guardDeny.includes(SECRET_SENTINEL), "拒绝理由里不含凭据正文");
      // A 面（读密钥文件）仍可给引用面——扫描从不读目标自身——但同样不含正文。
      const attached = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: secretTarget },
        agent,
      });
      for (const [index, _unused] of contextsOf(attached).entries()) {
        assert.ok(
          !contextText(attached, index).includes(SECRET_SENTINEL),
          "附加文本里不含凭据正文",
        );
      }
    });

    it("引用扫描的凭据面隔离吃用户追加的词表；词表值面不是数组时按内置判据继续（不放宽也不报错）", async () => {
      // 一条用例两个臂：`extraSecretPatterns` 生效与"值面未经 schema 校验、不是数组"时的降级读取。
      // 后者必须**继续用内置词表**而不是整趟抛错，也绝不能因为读不到用户模式就把已隔离的东西放回来。
      const hitFile = path.join(rootMain, "src", "keep.ts");
      await writeFile(hitFile, 'import "./ref-mod"; // keep-leak-sentinel\n');
      const session = fakeSession("s-quarantine", []);
      const agent = fakeAgent(session);

      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      ctx.value.extraSecretPatterns = [String.raw`keep\.ts`];
      apply(ctx);
      const guarded = denyText(
        await preflightOf(ctx, {
          name: "edit",
          arguments: editArgs(targetMain),
          agent,
        }),
      );
      assert.ok(guarded.includes(MESSAGES.zh.preflightHandoff.slice(0, 20)), "B 面照旧拦并递证据");
      assert.ok(
        !guarded.includes("keep-leak-sentinel"),
        `用户点名的凭据形态不该被抄进引用命中，实际：${guarded.slice(0, 300)}`,
      );
      assert.match(guarded, /凭据面文件/u, "被隔离的份数要说出来");

      // 同一枚目标换一个会话（避开扫描缓存），把用户词表换成"不是数组"的形状
      const loose = fakeSession("s-quarantine-loose", []);
      // 不经 ConfigSchema 的值面（宿主组合层之外的形状变化正是这里要挡的）：
      // `as never` 是本文件喂"官方类型面上给不出的形状"的既有手法（同 EXEC_TOKEN 那枚品牌位）。
      const degraded = createMockCtx();
      degraded.value = {
        ...BUILTIN_BASE,
        smallEditChars: 10,
        extraSecretPatterns: "keep.ts" as never,
      };
      apply(degraded);
      const stillScans = denyText(
        await preflightOf(degraded, {
          name: "edit",
          arguments: editArgs(targetMain),
          agent: fakeAgent(loose),
        }),
      );
      assert.ok(stillScans.length > 0, "降级读取不影响拦截");
      assert.ok(
        stillScans.includes("keep-leak-sentinel"),
        `读不到用户模式时按内置词表继续（内置那几条一个字不放宽），实际：${stillScans.slice(0, 300)}`,
      );
    });

    it("层缺项（high 档 + 真实 test/ 层）⇒ 同一次扫描派生层结论，拦一轮、重试即放行", async () => {
      const ctx = createMockCtx();
      ctx.value.strictMode = true;
      apply(ctx);
      const session = fakeSession("s-layer", []);
      const args = editArgs(targetLayer);
      const reason = denyReason(
        await preflightOf(ctx, { name: "edit", arguments: args, agent: fakeAgent(session) }),
      );
      assert.ok(
        reason !== undefined,
        `high 档现在也由 B 面带证据拦（层结论不再是让路项），实际：${reason?.slice(0, 320)}`,
      );
      assert.ok(
        reason.includes(markOf(MESSAGES.zh.preflightLayerLine)),
        `层结论要随行，实际：${reason.slice(0, 320)}`,
      );
      assert.ok(
        reason.includes("test"),
        "点名真实存在的那层目录（与门禁算缺项同一个 existingLayersOf）",
      );
      // 层证据进投递水位 ⇒ guard 那三项全部记 done：这一趟不该再要一遍。
      assert.equal(
        guardOf(ctx, { name: "edit", args, session }),
        undefined,
        "read / refs / test 层都凭水位计入 ⇒ 原样重试放行",
      );
    });

    it("有一层不在扫描覆盖里（遍历被预算截断）⇒ 整趟让路，不拿半份证据拦人", async () => {
      const ctx = createMockCtx();
      ctx.value.strictMode = true;
      apply(ctx);
      const session = fakeSession("s-layer-capped", []);
      // 这台夹具本来只有 300 层空目录（用来把遍历预算吃光）。再补一个真实 test/ 层，
      // 缺项里才有"层"这一项——而它恰好落在被截断的那部分扫描范围里。
      await mkdir(path.join(rootDirs, "test"), { recursive: true });
      await writeFile(path.join(rootDirs, "test", "cap-c.test.ts"), 'import "./cap-c";\n');
      const args = editArgs(targetDirs);
      const decision = await preflightOf(ctx, {
        name: "edit",
        arguments: args,
        agent: fakeAgent(session),
      });
      assert.deepEqual(decision, ALLOW, "层没覆盖到就不投递：半份「这层我探过了」最糟");
      const denied = guardOf(ctx, { name: "edit", args, session });
      assert.ok(denied !== undefined, "guard 照旧要求取证");
      assert.ok(denied.includes("test"), `拒绝理由里点名层目录，实际：${denied.slice(0, 200)}`);
    });

    it("扫描跑得完、但门禁要的那层是软链（扫描不跟）⇒ 同样整趟让路", async () => {
      const ctx = createMockCtx();
      ctx.value.strictMode = true;
      apply(ctx);
      const session = fakeSession("s-layer-linked", []);
      const args = editArgs(targetLinked);
      const decision = await preflightOf(ctx, {
        name: "edit",
        arguments: args,
        agent: fakeAgent(session),
      });
      // 与上一条不同的成因：这里 `complete` 为真（树很小），是"门禁认得那层、扫描走不到那层"。
      // 门禁的层探查跟软链（statSync），扫描按官方 lstat 口径不跟——两边口径不同源时，
      // 唯一安全的去向就是让路，而不是替模型宣称"这层我探过了、零命中"。
      assert.deepEqual(decision, ALLOW, "那一层没被走到 ⇒ 不拿半份证据拦人");
      const denied = guardOf(ctx, { name: "edit", args, session });
      assert.ok(denied !== undefined, "guard 照旧要求取证");
      assert.ok(denied.includes("test"), `拒绝理由里点名层目录，实际：${denied.slice(0, 200)}`);
    });

    it("配额放行态 ⇒ 预检让路（防死锁承诺优先于预检的便利）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      ctx.value.maxDenies = 1;
      // 先把目标熬到配额放行：这一阶段关掉预检，让 guard 的计数正常累积。
      ctx.value.preflightEnabled = false;
      apply(ctx);
      // 决策 ④：配额只免**上层探查**、不免 read ⇒ 这里得让 read 已是证据、缺的只是引用面
      // （所以会话日志里放一次成功的 read，且把编辑升到"触及导出面"那一档——低档只要求 read，
      //  read 一满足就直接放行了，根本走不到配额）。
      const session = fakeSession("s-quota", readEvents(disposeTarget));
      const args = { ...editArgs(disposeTarget), new_string: "export const value = 2" };
      assert.ok(guardOf(ctx, { name: "edit", args, session }) !== undefined, "首拒给清单");
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "达上限 → 配额放行");
      // 重开预检：免检中的目标不能再被停一次。
      ctx.value.preflightEnabled = true;
      const decision = await preflightOf(ctx, {
        name: "edit",
        arguments: args,
        agent: fakeAgent(session),
      });
      assert.deepEqual(decision, ALLOW, "已配额放行的目标不被预检重新拦下");
    });

    it("非写类目标（bash / 无路径 / 参数不是记录 / 文档扩展名）：B 面一律不参与", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-b-skip", []);
      const agent = fakeAgent(session);
      const docTarget = path.join(rootMain, "README.md");
      const shapes: ExecFace[] = [
        { name: "bash", arguments: { command: "ls" }, agent },
        { name: "edit", arguments: {}, agent },
        { name: "edit", arguments: "not-a-record", agent },
        { name: "edit", arguments: editArgs(docTarget), agent },
      ];
      const decisions = await Promise.all(shapes.map((exec) => preflightOf(ctx, exec)));
      for (const [index, decision] of decisions.entries()) {
        // 直接 assert（不借 assertAllowed）：vitest/expect-expect 只认用例体里的断言。
        assert.deepEqual(decision, ALLOW, `第 ${index} 种形状不参与 B 面`);
      }
    });

    it("下游 pre-execute 已经 deny ⇒ 原样交回，不换成插件的决定", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const decision = await preflightOf(
        ctx,
        {
          name: "edit",
          arguments: editArgs(targetMain),
          agent: fakeAgent(fakeSession("s-downstream-deny", [])),
        },
        DENY_BY_OTHER,
      );
      assert.deepEqual(decision, DENY_BY_OTHER, "预检不去抢别人做过的决定");
    });

    it("坏 agent 形状：绝不拦，只把决定权交回下游", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      // 三位：没有 agent / agent 不是记录 / session 不是记录。`{ session: {id} }` 不在其列——
      // 它是**合法**形状（会话只是没有日志），那条路归"会话历史不可得"的用例测。
      const badAgents: unknown[] = [undefined, "not-an-agent", { session: "not-a-session" }];
      const decisions = await Promise.all(
        badAgents.map((agent) =>
          preflightOf(ctx, { name: "edit", arguments: editArgs(targetMain), agent }),
        ),
      );
      for (const decision of decisions) {
        assert.deepEqual(decision, ALLOW, "形状不对也绝不拒绝");
      }
    });

    it("认定链抛错（会话面炸）⇒ 兜底吞掉：不拦、不改决定，只留一条告警", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const boom = {
        id: "s-boom",
        snapshotEvents: () => {
          throw new Error("会话面炸了");
        },
      };
      const agent = fakeAgent(boom);
      assert.deepEqual(
        await preflightOf(ctx, { name: "edit", arguments: editArgs(targetMain), agent }),
        ALLOW,
        "B 面抛错也只是退回拒绝路径，绝不能让这次编辑消失",
      );
      assert.deepEqual(
        await postFlightOf(ctx, { name: "read", arguments: { file_path: targetMain }, agent }),
        ACCEPT,
        "A 面抛错也不吞掉这次读取的结果",
      );
    });
  });

  describe("引用扫描的两档完成度（经两条瀑布的真实出口观察）", () => {
    it("命中条数到顶就收手；二进制/超限/软链/黑名单目录/目标自身都不进结果", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-caps", []);
      const reason = mustDeny(await editDenyOf(ctx, targetCaps, session), "缺 read+refs 的盲改");
      const hitLine = `${REF_LINE_PREFIX}hits.ts:1: `;
      const hitsClaim = `${PREFLIGHT_MAX_FINDINGS} 处命中`;
      assert.ok(reason.includes(hitLine), "命中的普通文件在列");
      assert.ok(reason.includes(cappedLine(PREFLIGHT_MAX_FINDINGS)), "命中达上限要说明");
      assert.ok(reason.includes(hitsClaim), `命中数如实报 ${PREFLIGHT_MAX_FINDINGS}`);
      assert.ok(
        !reason.includes(partialLine(PREFLIGHT_MAX_FILES, rootCaps)),
        "遍历本身扫完了，不该说未扫完",
      );
      for (const skipped of ["bin.dat", "big.ts", "link.ts", "node_modules", ".git", "pf.c.ts"]) {
        assert.ok(
          !reason.includes(`${REF_LINE_PREFIX}${skipped}`),
          `${skipped} 不该进引用列表（二进制/超限/软链/黑名单目录/目标自身）`,
        );
      }
    });

    it("文件数到上限即停：零命中不再写成'没有任何引用者'，refs 凭证也不给", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-filecap", []);
      const agent = fakeAgent(session);
      const args = editArgs(targetFiles);
      const reason = mustDeny(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })),
        "read 挣到了 ⇒ 拦一次并给正文",
      );
      const expected = fillTemplate(MESSAGES.zh.preflightRefsNonePartial, {
        root: rootFiles,
        scanned: String(PREFLIGHT_MAX_FILES),
        limit: String(PREFLIGHT_MAX_FILES),
      });
      assert.ok(
        reason.includes(expected),
        `未扫完的零命中必须降级表述，实际：${reason.slice(0, 260)}`,
      );
      // 全称那句按**整句**比对：markOf 取到的 `[引用探查]` 两句共有，按前缀判会永远为真。
      const fullClaim = fillTemplate(MESSAGES.zh.preflightRefsNone, {
        root: rootFiles,
        scanned: String(PREFLIGHT_MAX_FILES),
      });
      assert.ok(!reason.includes(fullClaim), "全称结论不许出现");
      // 未扫完 ⇒ refs 没挣到凭证：重试这趟 B 面不再拦（read 已补），但 guard 仍按 refs 缺项拒。
      assert.equal(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })),
        undefined,
        "read 已补上 ⇒ B 面不再拦",
      );
      assert.ok(
        guardOf(ctx, { name: "edit", args, session }) !== undefined,
        "半份扫描不顶替探过引用面",
      );
    });

    it("遍历截断但**找到了引用** ⇒ 凭证照给（实证就是实证，而门禁对模型的标准也不是穷尽）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-partial", []);
      const args = editArgs(targetPartial);
      const reason = mustDeny(
        await editDenyOf(ctx, targetPartial, session),
        "截断扫描也要递出正文",
      );
      assert.ok(reason.includes(`${REF_LINE_PREFIX}hits.ts`), "近邻的命中先被读到");
      assert.ok(reason.includes(partialLine(PREFLIGHT_MAX_FILES, rootPartial)), "未扫完必须点名");
      // 判据变了（见 host.ts 的 refsCreditable）：门禁认可模型自己那次**作用域正确**的检索
      // 当凭证，而那次检索也不是穷尽的 —— 要求我们这趟扫描穷尽比那还严，代价落在最需要预检的
      // 大仓上（遍历必然被截断 ⇒ 凭证永远给不出 ⇒ 预检白做）。
      // 找到了引用就是**实证**：模型已经看见了"谁在用"。而"零命中 + 被截断"仍然不给凭证 ——
      // 假阴性全部住在那一种里（见下一条用例）。
      assert.equal(
        guardOf(ctx, { name: "edit", args, session }),
        undefined,
        "有命中的半份扫描算探过引用面：模型已经看见谁在用它",
      );
    });

    it("目录预算先到也算未扫完：一个文件都没读就收手，scanned 如实报 0", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-dircap", []);
      const args = editArgs(targetDirs);
      const reason = mustDeny(await editDenyOf(ctx, targetDirs, session), "目录预算下的盲改");
      const scannedZero = fillTemplate(MESSAGES.zh.preflightRefsNonePartial, {
        root: rootDirs,
        scanned: "0",
        limit: String(PREFLIGHT_MAX_FILES),
      });
      assert.ok(
        reason.includes(scannedZero),
        `扫过 0 个文件要说得出口，实际：${reason.slice(0, 260)}`,
      );
      assert.ok(
        guardOf(ctx, { name: "edit", args, session }) !== undefined,
        "未扫完 ⇒ 不记 refs 凭证",
      );
    });

    it("扫描被取消 ⇒ 整趟作罢：B 面不拦、A 面不附，guard 照旧拒绝", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const editSession = fakeSession("s-abort-b", []);
      const editArgsFace = editArgs(targetMain);
      const editDecision = await preflightOf(ctx, {
        name: "edit",
        arguments: editArgsFace,
        signal: AbortSignal.abort(),
        agent: fakeAgent(editSession),
      });
      assert.deepEqual(editDecision, ALLOW, "取消也绝不拦");
      assert.ok(
        guardOf(ctx, { name: "edit", args: editArgsFace, session: editSession }) !== undefined,
        "退回拒绝路径",
      );

      const readDecision = await postFlightOf(
        ctx,
        {
          name: "read",
          arguments: { file_path: targetMain },
          signal: AbortSignal.abort(),
          agent: fakeAgent(fakeSession("s-abort-a", [])),
        },
        OK_RESULT,
      );
      assert.deepEqual(readDecision, ACCEPT, "A 面同样原样交回");
      assert.equal(contextsOf(readDecision).length, 0, "取消 ⇒ 不附半份");
    });
  });

  describe("缓存与水位的生命周期", () => {
    it("目标 mtime 未变 ⇒ 复用上一趟的扫描（新出现的引用者看不到）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-reuse", []);
      const agent = fakeAgent(session);
      // 第一趟（读取）附引用面，此时项目里还没有新引用者。
      await postFlightOf(ctx, { name: "read", arguments: { file_path: targetRescan }, agent });
      await writeFile(path.join(rootRescan, "src", "new-ref.ts"), 'import "./rescan-mod";\n');
      const reason = mustDeny(await editDenyOf(ctx, targetRescan, session), "编辑这趟");
      assert.ok(reason.includes(READ_MARK), "缺的 read 当场补上");
      assert.ok(!reason.includes("new-ref.ts"), "缓存未过期 ⇒ 不做第二次扫描");
      assert.ok(!reason.includes(REFS_MARK), "refs 已由上一趟的水位满足");
    });

    it("目标 mtime 前进 ⇒ 缓存条目作废、重扫并回填（这回给得出全称结论）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-invalidate", []);
      const agent = fakeAgent(session);
      const args = editArgs(targetInvalidate);
      // 第一趟：300 个文件撞满预算 ⇒ 截断扫描进缓存、不记凭证，零命中只说"已扫范围内"。
      const first = mustDeny(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })),
        "缺 read+refs 的盲改",
      );
      const partialNone = fillTemplate(MESSAGES.zh.preflightRefsNonePartial, {
        root: rootInvalidate,
        scanned: String(PREFLIGHT_MAX_FILES),
        limit: String(PREFLIGHT_MAX_FILES),
      });
      assert.ok(first.includes(partialNone), `实际：${first.slice(0, 260)}`);
      // 项目被清空（工作树真的变了）+ 目标 mtime 前进 ⇒ 条目过期。
      await rm(path.join(rootInvalidate, "bulk"), { recursive: true, force: true });
      await utimes(targetInvalidate, T_LATER, T_LATER);
      // 第二趟：项目变小（1 个文件、1 处命中）⇒ 遍历扫得完 ⇒ 给的是命中清单而不是"未扫完"，
      // 于是 refs 挣到凭证——这一趟补的是引用面，所以还会拦一次。
      await writeFile(path.join(rootInvalidate, "ref.ts"), 'import "./inv-mod";\n');
      const second = mustDeny(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })),
        "缺 refs 的第二趟",
      );
      const rescanned = fillTemplate(MESSAGES.zh.preflightRefsHead, {
        root: rootInvalidate,
        scanned: "1",
        hits: "1",
      });
      assert.ok(
        second.includes(rescanned),
        `重扫后的清单要如实到个位数，实际：${second.slice(0, 260)}`,
      );
      assert.ok(
        second.includes(`${REF_LINE_PREFIX}ref.ts`),
        "新出现的引用者进列表 ⇒ 条目确实作废了",
      );
      assert.ok(
        !second.includes(partialLine(PREFLIGHT_MAX_FILES, rootInvalidate)),
        "这回不给'未扫完'那句",
      );
      // 两项都挣到了 ⇒ 第三趟不再拦，guard 凭水位放行。
      assert.equal(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })),
        undefined,
        "缺项已齐 ⇒ 不拦",
      );
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "水位在位 → 放行");
    });

    it("会话历史不可得（没有 snapshotEvents）⇒ 按最保守缺项拦一次并回落 logSeq", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-no-log");
      const args = editArgs(targetMain);
      const reason = denyReason(
        await preflightOf(ctx, {
          name: "edit",
          arguments: args,
          agent: fakeAgent(session),
        }),
      );
      assert.ok(reason !== undefined, "缺项按最保守形态给（read+refs），不静默跳过");
      assert.ok(reason.includes(REFS_MARK) && reason.includes(READ_MARK));
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "水位在位 → 放行");
    });

    it("会话销毁回收水位：同一目标的下一次编辑重新过门", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-dispose", []);
      const agent = fakeAgent(session);
      const args = editArgs(disposeTarget);
      assert.ok(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })) !== undefined,
      );
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "水位在位 → 放行");
      assert.ok(ctx.disposed, "session/disposed 已注册");
      ctx.disposed(session);
      assert.ok(
        guardOf(ctx, { name: "edit", args, session }) !== undefined,
        "水位随会话回收 → 重新过门（不许旧水位当免检金牌）",
      );
    });

    it("旧水位不顶外部改动：预检关掉后目标被改，按 external 成因要求重读", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-stale-watermark", []);
      const agent = fakeAgent(session);
      const args = editArgs(disposeTarget);
      await preflightOf(ctx, { name: "edit", arguments: args, agent });
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "首轮凭水位放行");
      // 预检关掉（水位不再刷新），目标被会话外改动。
      ctx.value.preflightEnabled = false;
      await utimes(disposeTarget, T_LATER, T_LATER);
      const denied = guardOf(ctx, { name: "edit", args, session });
      assert.ok(denied !== undefined, "外部改动后旧水位作废");
      assert.ok(
        denied.includes("本会话之外"),
        `成因必须是 external，实际：${denied.slice(0, 120)}`,
      );
    });
  });

  describe("官方通道交出的真实路径形（第 4 项：fs/observed + 预检 B 面 → 同步 guard）", () => {
    it("预检 B 面先问官方那一形 ⇒ 落在凭据面时整趟让路，密钥闸照旧拦（本机形看不出来的那一类）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      ctx.fsFace = sandboxFace();
      apply(ctx);
      const target = officialTarget("secret");
      const session = fakeSession("s-official-secret", []);
      const args = editArgs(target);
      // 让路必须是**整趟**：一旦 B 面递了证据，那份"目标正文"就是后端执行世界里的凭据正文。
      const decision = await preflightOf(ctx, {
        name: "edit",
        arguments: args,
        agent: fakeAgent(session),
      });
      assert.deepEqual(decision, ALLOW, "官方那一形命中凭据面 ⇒ B 面不抢密钥闸的决定");
      const denied = guardOf(ctx, { name: "edit", args, session });
      assert.ok(denied !== undefined, "密钥闸照旧拒");
      assert.ok(
        denied.includes(MESSAGES.zh.secretPath),
        `拦它的是密钥面那一句，实际：${denied.slice(0, 120)}`,
      );
    });

    it("fs/observed 报过绝对 displayPath ⇒ 同步 guard 当场吃到官方那一形（预检没参与）", () => {
      const ctx = createMockCtx();
      ctx.fsFace = sandboxFace();
      apply(ctx);
      const observed = observedOf(ctx);
      const target = officialTarget("observed");
      // low 档 + 会话里已有成功读取 ⇒ 除了密钥面，这一趟没有别的缺项：
      // 于是"放行 → 拦"的翻转只可能来自那枚缓存。
      const session = fakeSession("s-official-observed", readEvents(target));
      const args = editArgs(target);
      assert.equal(
        guardOf(ctx, { name: "edit", args, session }),
        undefined,
        "报之前：本机形与声明形都无害 ⇒ 放行",
      );
      observed({ displayPath: target, targetKey: "opaque-never-parsed" });
      const denied = guardOf(ctx, { name: "edit", args, session });
      assert.ok(denied !== undefined, "报之后：官方那一形落在凭据面 ⇒ 拦");
      assert.ok(
        denied.includes(MESSAGES.zh.secretPath),
        `拦它的是密钥面那一句，实际：${denied.slice(0, 120)}`,
      );
    });

    it("fs/observed 报的是相对 displayPath ⇒ 不记（键形必须与读侧同源，猜一种归一等于造读不到的键）", () => {
      const ctx = createMockCtx();
      ctx.fsFace = sandboxFace();
      apply(ctx);
      const observed = observedOf(ctx);
      const target = officialTarget("relative");
      const session = fakeSession("s-official-relative", readEvents(target));
      observed({ displayPath: path.relative(rootOfficial, target), targetKey: "opaque" });
      assert.equal(
        guardOf(ctx, { name: "edit", args: editArgs(target), session }),
        undefined,
        "相对形没有被当成官方那一形（远端后端交 workspace 相对形与 URI，本包不替它猜 cwd）",
      );
    });

    it("后端拒绝交出 processPath ⇒ 官方那一形缺席，B 面照常递证据（拦截面一条不减）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      ctx.fsFace = localFsFace({ processPathThrows: "backend refuses processPath" });
      apply(ctx);
      const session = fakeSession("s-official-nopath", []);
      const reason = mustDeny(
        await editDenyOf(ctx, officialTarget("nopath"), session),
        "官方形缺席不影响递证据",
      );
      assert.ok(reason.includes(READ_MARK), "正文照给");
      assert.ok(reason.includes(REFS_MARK), "引用面照给");
    });

    it("后端 resolve 抛（远端往返失败）⇒ 那一形缺席，预检让路而 guard 照旧拦", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      ctx.fsFace = localFsFace({ resolveThrows: "backend unreachable" });
      apply(ctx);
      const target = officialTarget("noresolve");
      const session = fakeSession("s-official-noresolve", []);
      const args = editArgs(target);
      assert.deepEqual(
        await preflightOf(ctx, { name: "edit", arguments: args, agent: fakeAgent(session) }),
        ALLOW,
        "取不到证据就不拦——拦它只有拒绝、没有前置",
      );
      assert.ok(
        guardOf(ctx, { name: "edit", args, session }) !== undefined,
        "官方通道整条不可用也不动拦截面",
      );
    });

    it("没有 fs 后端 ⇒ fs/observed 报了也记不下（判定退回声明形 + 本机形，拦截面一条不减）", () => {
      const ctx = createMockCtx();
      // 这个 profile 没装 fs 后端：注入回调不激活、箱子是空的（预检整趟也不参与）。
      ctx.fsFace = undefined;
      apply(ctx);
      const { observed } = ctx;
      assert.ok(observed !== null, "监听器照旧挂上：事件名不依赖后端在不在");
      const target = officialTarget("nobackend");
      const session = fakeSession("s-official-nobackend", readEvents(target));
      observed({ displayPath: target, targetKey: "opaque-never-parsed" });
      assert.equal(
        guardOf(ctx, { name: "edit", args: editArgs(target), session }),
        undefined,
        "取不到官方那一形就少一形，不多拦也不放行别的什么",
      );
    });

    it("fs/observed 交来不像 FsTarget 的载荷 ⇒ 不抛（emit 模式下本包抛错会让别人的调用失败）", () => {
      const ctx = createMockCtx();
      ctx.fsFace = sandboxFace();
      apply(ctx);
      const observed = observedOf(ctx);
      const target = officialTarget("malformed");
      const session = fakeSession("s-official-malformed", readEvents(target));
      // 三种坏载荷：缺 displayPath、displayPath 不是串、整个载荷不是对象。
      for (const payload of [{}, { displayPath: 42 }, "not-a-target"]) {
        assert.doesNotThrow(() => observed(payload), "异常不许交回宿主");
      }
      assert.equal(
        guardOf(ctx, { name: "edit", args: editArgs(target), session }),
        undefined,
        "坏载荷一形都记不下：判定退回声明形与本机形（两形都无害 ⇒ 放行）",
      );
    });

    it("一次盲改对同一枚目标只问一次身份（正文与版本探针复用 B 面那一次 resolve）", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      const face = localFsFace();
      const asked: string[] = [];
      ctx.fsFace = {
        ...face,
        resolve: async (target, opts) => {
          asked.push(target);
          return face.resolve(target, opts);
        },
      };
      apply(ctx);
      const target = officialTarget("reuse");
      const reason = await editDenyOf(ctx, target, fakeSession("s-official-reuse", []));
      assert.ok(reason !== undefined, "这一趟确实走了 B 面递证据（否则探针数不到东西）");
      // 目标一枚 + 扫描起点一枚 + **每一层扫描起点一枚**（分层遍历要按层下钻，每层的起点
      // 都得先定身份；层数=目标到 root 的深度）。远端/沙箱后端下每一枚 resolve 可能是一次往返，
      // 所以这里既钉"同一枚目标只问一次"，也钉"多出来的那几枚是**层**的身份、不是目标的重复"：
      // 目标那一枚必须在最前且只出现一次。
      assert.equal(asked[0], target, "目标的身份必须先问、且只问一次");
      assert.equal(
        asked.filter((item) => item === target).length,
        1,
        `同一枚目标被问了不止一次，实际问的是：${asked.join(" , ")}`,
      );
      assert.deepEqual(
        asked.slice(1),
        [rootOfficial, path.dirname(target)],
        `层身份问询的形状变了，实际问的是：${asked.join(" , ")}`,
      );
    });

    it("没有声明目标的调用（bash / 缺路径键）⇒ 一枚 resolve 都不发（热路径不付无谓往返）", async () => {
      const ctx = createMockCtx();
      const face = localFsFace();
      let resolves = 0;
      ctx.fsFace = {
        ...face,
        resolve: async (target, opts) => {
          resolves += 1;
          return face.resolve(target, opts);
        },
      };
      apply(ctx);
      const decision = await preflightOf(ctx, {
        name: "bash",
        arguments: { command: "ls -la", description: "看一眼" },
        agent: fakeAgent(fakeSession("s-official-notarget", [])),
      });
      assert.deepEqual(decision, ALLOW, "非写类调用预检整趟不参与");
      assert.equal(resolves, 0, "没有目标就没有可问的真实路径");
    });
  });
});

// ── C：分层预算扫描（修"大仓里 refs 凭证永远给不出"）───────────────────────────
//
// 修前的形状：从 `root` 做一趟纯广度优先 —— 大仓里预算恰好在最有用的文件**之前**耗尽
// （BFS 先把 `apps/a`、`apps/b`… 走完，才轮到目标那个深目录与它同级的 `test/` 层），
// 于是 `complete` 永远为 false、refs 凭证永远给不出，而预检恰恰在最需要它的仓库里等于没做。
//
// 现在分两层：**层级自下而上**（目标所在目录 → … → root），**层内广度优先**（同层文件先读完
// 再下钻）。这一组用"目标在深处、近邻有引用者、远处有 300 个无命中文件"的真实目录钉住它。
describe("分层预算扫描（C）：近邻优先，预算不再被远处的兄弟层吃光", () => {
  let rootDeep: string;
  let targetDeep: string;

  beforeAll(async () => {
    rootDeep = await mkdtemp(path.join(tmpdir(), "dg-pf-deep-"));
    await writeFile(path.join(rootDeep, PROJECT_MARKER), "{}\n");
    // 远处兄弟层：300 个无命中文件，足以吃光 256 的文件预算。
    await bulkFiles(path.join(rootDeep, "bulk"));
    // 目标在两层深处，**引用者就在它同级**（`test/` 是门禁认的层之一）。
    const dir = path.join(rootDeep, "deep", "mid");
    await mkdir(path.join(dir, "test"), { recursive: true });
    // 文件名要带**够长的词干**：匹配词是"全名 + ≥4 字符的词干"（host 的 MIN_STEM），
    // 而 `mod.ts` 的词干 `mod` 只有 3 字符 ⇒ `"../mod"` 匹配不上，那条夹具会测了个寂寞。
    targetDeep = path.join(dir, "deepmod.ts");
    await writeFile(targetDeep, "export const deep = 1;\n");
    await writeFile(
      path.join(dir, "test", "deepmod.test.ts"),
      'import { deep } from "../deepmod";\n',
    );
  });

  it("预算先买到近邻：深目标的引用者被读到，far 兄弟层没读也不影响", async () => {
    const ctx = createMockCtx();
    ctx.value.smallEditChars = 10;
    apply(ctx);
    const session = fakeSession("s-deep", []);
    const reason = mustDeny(await editDenyOf(ctx, targetDeep, session), "深目标的盲改");
    assert.ok(
      reason.includes(`${REF_LINE_PREFIX}deep/mid/test/deepmod.test.ts`),
      `近邻的引用者必须被读到（旧 BFS 在这里会先读光 bulk/）：${reason.slice(0, 300)}`,
    );
    // 遍历仍然被截断（300 个远处的文件读不完）—— 这恰恰是"分层"要证明的事：
    // 截断发生在**远处**，而不是在目标的近邻之前。
    assert.ok(reason.includes(partialLine(PREFLIGHT_MAX_FILES, rootDeep)), "未扫完照旧点名");
  });

  it("截断但找到了引用 ⇒ **凭证照给**：原样重试即放行（这就是那个 bug 的收口）", async () => {
    const ctx = createMockCtx();
    ctx.value.smallEditChars = 10;
    apply(ctx);
    const session = fakeSession("s-deep-credit", []);
    const args = editArgs(targetDeep);
    await editDenyOf(ctx, targetDeep, session);
    assert.equal(
      guardOf(ctx, { name: "edit", args, session }),
      undefined,
      "预检在大仓里给出凭证 —— 修前这里必然仍被拒（refs 永远凑不齐）",
    );
  });
});

describe("分层遍历的两条保守出口：中途取消 与 层起点解析不出来", () => {
  // ⚠ 自带夹具：这两条用例**不复用**外层套件的 `targetMain` —— 那是别人的 `beforeAll` 建的，
  // 而它的 `afterAll` 会把临时目录删掉；兄弟套件之间的这种依赖在单跑一条（`-t`）时会直接
  // 崩成"目标不存在"（实测踩过：目标为 undefined ⇒ 事实门根本不判 ⇒ 断言测了个寂寞）。
  let root: string;
  let target: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dg-pf-outlet-"));
    await writeFile(path.join(root, PROJECT_MARKER), "{}\n");
    await mkdir(path.join(root, "src"), { recursive: true });
    target = path.join(root, "src", "outletmod.ts");
    await writeFile(target, "export const outlet = 1;\n");
  });

  it("遍历**中途**被取消 ⇒ 该层就地收手、整趟作废（合流信号可以随时中断）", async () => {
    // `abortAfterLstat` 这枚夹具选项没有任何用例用过（一枚死夹具）——
    // 而它守的那处检查（`listChildren` 逐项查取消）正是"信号随时可能中断"的兑现：
    // 预检的信号是「调用方信号 ⊕ 3 秒墙钟」的合流，墙钟可以在任何一次 await 之后到点。
    const controller = new AbortController();
    const ctx = createMockCtx();
    ctx.value.smallEditChars = 10;
    ctx.fsFace = localFsFace({ abortAfterLstat: controller });
    apply(ctx);
    // `read` 先由会话满足：**正文读取自己也会 `lstat`**（判"是不是普通文件"那一趟），
    // 于是中止点在扫描之前就落到正文那一趟上，`listChildren` 里那处逐项检查根本走不到。
    // 这一条要钉的正是扫描里的那处，所以让 B 面跳过正文、直接进扫描。
    const session = fakeSession("s-abort-mid", readEvents(target));
    const args = editArgs(target);
    const decision = await preflightOf(ctx, {
      name: "edit",
      arguments: args,
      signal: controller.signal,
      agent: fakeAgent(session),
    });
    assert.deepEqual(decision, ALLOW, "扫描被取消 ⇒ 整趟作废，B 面不拦");
    assert.ok(
      guardOf(ctx, { name: "edit", args, session }) !== undefined,
      "整趟作罢 ⇒ 退回拒绝路径（而不是静默放行）",
    );
  });

  it("某一层起点解析不出来 ⇒ 遍历标成不完整（不是静默当它不存在），而 guard 照旧拒", async () => {
    const ctx = createMockCtx();
    ctx.value.smallEditChars = 10;
    // 目标所在目录那一层（level 0）解析失败：它的子树没被走过，所以这趟扫描不能算完整
    //（`capped` 必须被置位 —— 静默当它不存在就是让"零命中"冒充一条结论）。
    ctx.fsFace = localFsFace({ resolveThrows: path.dirname(target) });
    apply(ctx);
    const session = fakeSession("s-level-unresolvable", []);
    const args = editArgs(target);
    // ⚠ 这里**不能**断言 B 面拒：扫描被截断且零命中 = "什么都没挣到"，B 面那一趟本来就
    // 整趟让路（递一份"已扫范围内零命中"给模型的价值低于让它照旧走拒绝路径）。
    // 要钉的是**下游**：让路之后 guard 照旧拒，而不是静默放行。
    assert.deepEqual(
      await preflightOf(ctx, { name: "edit", arguments: args, agent: fakeAgent(session) }),
      ALLOW,
      "什么都没挣到 ⇒ B 面让路",
    );
    assert.ok(
      guardOf(ctx, { name: "edit", args, session }) !== undefined,
      "层起点解析不出来 ⇒ 退回拒绝路径（而不是静默放行）",
    );
  });
});
