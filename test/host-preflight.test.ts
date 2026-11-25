// host.ts「编辑前预检」的运行路径接线测试。
//
// 为什么经监听器 + guard 两个入口断言：A 面挂在 `ctx.on("tools/post-execute")`
//  （引用面随读取结果出去），随后同步的 `ctx.tools.guard` 谓词凭发送水位/会话日志放行。
// `tools/pre-execute` 只剩需确认档，不再代读、不再代拦（本文件末尾那组钉住）。
// I/O 与渲染本体在 lib/preflight-scan.ts（那边的预算/截断/二进制判据由
//   test/preflight-scan.test.ts 直接钉），本文件只管接线与水位：tsc 能证明"字段被读了"，
//   证明不了"读了真的改变放行结果"——本文件按后者写。
//
// 四条命题：
//   ① 不抢决定：瀑布先 `await next()`，下游已经 deny/cancel/ask/block 就原样交回；
//   ② 证据真前置：A 面的引用块挂在**读取结果**上（下一次编辑之前就看得见）；
//   ③ 有界且诚实：预算截断的扫描可以说、但不记凭证；
//   ④ 水位可判且可回收：随会话销毁回收、不顶外部改动。
//
// 为什么用真实临时目录：引用扫描全靠 fs（`projectRootOf` 认工程标记、二进制靠
//   NUL 字节），替身路径探不出任何东西；`/w/proj/...` 那类假路径会让
//   "扫到了什么"整段退化成空断言。
import { describe, it, afterAll, beforeAll, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin, { BUILTIN_BASE } from "../host.ts";
import type { Config } from "../host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
import { MESSAGES, fillTemplate } from "../lib/messages.ts";
// 会话日志出自官方 SessionEvent夹具构造器（信封必填位与类型品牌都在夹具里补一次）。
import { call as fxCall, result as fxResult } from "./fixtures/events.ts";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
// 两条瀑布的**官方面**：本文件的替身载荷一律按 `Events` 的投影 checked，不再自己抄的形状。
// 自己抄的风险很具体——`{kind:"allow"}` 拼错、结果少一枚必填位、decision 换了分支，用例照样绿，
// 而真宿主根本不是那样调的；把形状对齐到官方声明上，漂移就变成编译错误。
import type { Events } from "@deepseek-ai/cordis";
import type { ContentBlock, ToolCallId, UserMessage } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { brandString } from "@deepseek-ai/dsh-brand";
// 预检的取证 I/O 走宿主 fs 面；单元层装不了真后端，用同一份官方五位的本地实现
//（真后端那份由 test/host-integration.test.ts / test/agent-loop-e2e.test.ts 覆盖）。
import type { PreflightFs } from "../lib/preflight-scan.ts";
import { localFsFace } from "./fixtures/local-fs-face.ts";
// ── 文案标记：一律从消息表唯一来源取，不在用例里重抄文案 ─────────────────────────
/** 模板的首段（到第一个空格）：`[引用探查] …` → `[引用探查]`。文案改版只会让用例红。 */
const markOf = (template: string): string => template.slice(0, template.indexOf(" "));
const REFS_MARK = markOf(MESSAGES.zh.preflightRefsHead);
const ATTACH_HEAD = MESSAGES.zh.preflightAttach;

// ── 轻量宿主替身：guard 谓词 + 两条瀑布监听器 + 会话销毁钩子 ─────────────────
/**
 * 两条瀑布的官方面（`Parameters<>` 剥掉 `this`，与 host.ts 里那两枚读法同一条）：
 *  - `'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>)`（installed dsh-tools :47）
 *  - `'tools/post-execute'(exec, result: Readonly<ToolExecutionResult>, next)`（:70）
 * 本文件的每一枚替身载荷都按这几位 checked：`kind` 拼错、结果少一枚必填位、decision 换分支，
 *  都会在这里变成编译错误，而不是留下一条"测试绿、宿主不这样调"的假用例。
 */
type PreExecuteArgs = Parameters<Events["tools/pre-execute"]>;
type PostExecuteArgs = Parameters<Events["tools/post-execute"]>;
/** 官方执行上下文（两条瀑布的第一实参同一枚 `ToolExecution`）。 */
type OfficialExec = PreExecuteArgs[0];
/** 官方结果的类型（success 带 `value`、failure 带 `error` 的判别联合）。 */
type OfficialResult = PostExecuteArgs[1];
/** 两条瀑布的返回域（allow/deny/cancel/ask 与 accept/block）。 */
type PreOutcome = Awaited<ReturnType<PreExecuteArgs[1]>>;
type PostOutcome = Awaited<ReturnType<PostExecuteArgs[2]>>;
type PreExecuteFn = (...args: PreExecuteArgs) => Promise<PreOutcome>;
type PostExecuteFn = (...args: PostExecuteArgs) => Promise<PostOutcome>;
/** 官方 `ToolGuard` 面（:732 `(execution: Readonly<ToolExecution>) => string | undefined`）。 */
type GuardFn = (execution: Readonly<OfficialExec>) => string | undefined;

/** 官方类型品牌的集中补一处（同 test/fixtures/events.ts 补信封的理由）：`callId`/`rootCallId`
 *  是只带 `ToolCallId` 类型品牌的幻影串，`token` 是 `symbol & {…}` 的不透明身份。真宿主三枚一定带，
 *  替身不给就是抄近路——本插件不读它们，但**下一个读它们的改动**必须能在编译期站住。 */
const CALL_ID = brandString<ToolCallId>("dg-preflight-call");
const EXEC_TOKEN: OfficialExec["token"] = Symbol("dg-preflight-token") as never;

/** 决定上的四个分支（用例里的字面量都换成这四枚，拼错的可能性交给编译器）。 */
const ALLOW: PreOutcome = { kind: "allow" };
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
  /** 官方可选注入：预检要的 `fs` 从这里交出去（与真宿主的 `ctx.inject(["fs"], …)` 同形）。
   *  置 `fsFace = undefined` 就是"这个 profile 没装 fs 后端"那一支。 */
  inject: (deps: readonly string[], activate: (child: Record<string, unknown>) => void) => void;
  /** 交给预检的 fs 读法（本地盘实现，见 test/fixtures/local-fs-face.ts 的理由）。 */
  fsFace: PreflightFs | undefined;
  /** settings 面：拦截半只调 describe()（locale 偏好读取接口）。 */
  settings: { describe: () => { ns: string; value: unknown; revision: number }[] };
  /** cordis 可选服务读法：只给设置条目挂出的值取值接口。 */
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
   *  载荷按 unknown 收——用例要送的正是"后端交来的 target"，而 `targetKey` 带 opaque 类型品牌，
   *  测试里没必要（也不该）造一枚合法值：本包只读 `displayPath`。 */
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
        // 生产 guard 现在可能交回 `{ reason, info }`；存量用例断言的是模型看到的文案，
        // 这里统一折回 `reason`。结构化身份的断言只在 host.test 的 raw 口上做。
        ctx.guardInstalled = {
          fn: (exec) => {
            const result = fn(exec);
            return typeof result === "string"
              ? result
              : (result as { reason?: string } | undefined)?.reason;
          },
        };
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

/** 装配（同其余 host 用例：拦截条目没有 Config，值经 SETTINGS_READER 现读）。 */
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
 *  ⚠ 这一位过去是 `unknown`：当时 dsh-agent 不在依赖里，`ToolExecution.agent` 的类型上解析不到
 *  而塌成 `any`，于是形状全靠自觉。装上官方件之后编译器开始管这件事（同一轮里
 *  `signal`/`arguments` 的宽处也一起现形），所以这里改回有名有形的构造。 */
const fakeAgent = (session: unknown, id = "dg-session"): unknown => ({
  id: brandString<SessionId>(id),
  session,
});

/** 一次调用点（signal / agent 都可缺位，用于测坏形状与取消）。 */
interface ExecFace {
  name: string;
  arguments?: unknown;
  signal?: AbortSignal;
  /** 好形状走 `fakeAgent`（带合法 SessionId）；坏形状用例送的正是"官方面不允许的东西"
   *  ——那一档在类型上没有合法构造口，所以整位收在 unknown，由 execOf 单点宽化。 */
  agent?: unknown;
}

/** 补成官方执行上下文：类型品牌集中在这里给，用例只写它关心的那几位。 */
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

/** 走一次 pre-execute 监听器（现在只剩需确认档；盲改不再在这里被拦）。
 *  `downstream` 是 `next()` 的回给（缺省 ALLOW）。
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

/** 决定上附着的上下文清单（accept 与 block 三种分支都带得上这一位）。 */
const contextsOf = (decision: PostOutcome): readonly UserMessage[] =>
  decision.additionalContexts ?? [];

/** 第 n 条附加上下文（不存在即红）。断言与取值走同一枚函数，用例里就不必再判 undefined。 */
function contextAt(decision: PostOutcome, index = 0): UserMessage {
  const message = contextsOf(decision)[index];
  assert.ok(message !== undefined, `第 ${index} 条附加上下文存在`);
  return message;
}

/** 第 n 条附加上下文的正文（官方 ContentBlock 是判别联合，先认 text 那一条分支）。 */
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

/** 随后同步跑的那道 guard 谓词：载荷与两条瀑布同一枚官方面（`execOf` 补类型品牌）。
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

/** 一次**成功**的 read（callId 必须串上 result，缺 result 不算证据）。 */
const readEvents = (target: string, id = "r1"): SessionEvent[] => [
  fxCall(id, "read", JSON.stringify({ file_path: target })),
  fxResult(id),
];

// ── 夹具（全部真实目录；beforeAll 里落地）──────────────────────────────────
/** 主夹具：`src/ref-mod.ts`（目标）+ 引用者 `src/user-a.ts`；**没有** test/e2e/docs 层，
 *  这样 mid 档的缺项就是 read+refs 两项，不会被层要求干扰。 */
let rootMain: string;
let targetMain: string;
/** 小而确定的夹具（2 枚文件）：零命中的全称那句要按**填好的整句**比对。 */
let rootClean: string;
let targetClean: string;
/** 文件数上限夹具（300 个无命中文件 ⇒ 遍历截断 + 零命中）。 */
let rootFiles: string;
let targetFiles: string;
const BULK_FILES = 300;
/** 工程标记文件名（`projectRootOf` 认它）。 */
const PROJECT_MARKER = "package.json";

describe("host 预检（Phase 2）：A 面随读取附引用面", () => {
  beforeAll(async () => {
    rootMain = await mkdtemp(path.join(tmpdir(), "dg-pf-main-"));
    await mkdir(path.join(rootMain, "src"), { recursive: true });
    await writeFile(path.join(rootMain, PROJECT_MARKER), "{}\n");
    targetMain = path.join(rootMain, "src", "ref-mod.ts");
    await writeFile(targetMain, "export const a = 1;\n");
    await writeFile(path.join(rootMain, "src", "user-a.ts"), 'import { a } from "./ref-mod";\n');

    rootClean = await mkdtemp(path.join(tmpdir(), "dg-pf-clean-"));
    await writeFile(path.join(rootClean, PROJECT_MARKER), "{}\n");
    targetClean = path.join(rootClean, "lonely.ts");
    await writeFile(targetClean, "export const only = 1;\n");
    await writeFile(path.join(rootClean, "other.ts"), "export const unrelated = 1;\n");

    rootFiles = await mkdtemp(path.join(tmpdir(), "dg-pf-files-"));
    targetFiles = path.join(rootFiles, "cap-a.ts");
    await writeFile(targetFiles, "// cap-a.ts\n");
    await mkdir(path.join(rootFiles, "bulk"), { recursive: true });
    await Promise.all(
      Array.from({ length: BULK_FILES }, (_unused, index) =>
        writeFile(path.join(rootFiles, "bulk", `f${index}.txt`), "no needle here\n"),
      ),
    );
  });

  afterAll(async () => {
    await Promise.all(
      [rootMain, rootClean, rootFiles].map((dir) =>
        rm(dir, { recursive: true, force: true }).catch(() => null),
      ),
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
      }
    });

    it("会话给了 seq ⇒ 发送位次直接取它，不为日志长度再折叠一遍台账", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      let snapshots = 0;
      const session = {
        id: "s-seq",
        seq: 9,
        snapshotEvents: (): readonly SessionEvent[] => {
          snapshots += 1;
          return [];
        },
      };
      const decision = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetMain },
        agent: fakeAgent(session),
      });
      assert.equal(contextsOf(decision).length, 1, "读取成功照常附引用面");
      assert.equal(snapshots, 1, "评估读一次；投递位次取 seq，不再为长度重读台账");
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
      // 紧接着的编辑因此零摩擦：pre-execute 只剩需确认档（不拦），guard 直接放行。
      const args = editArgs(targetMain);
      assert.equal(
        denyReason(await preflightOf(ctx, { name: "edit", arguments: args, agent })),
        undefined,
        "pre-execute 不再代读、不再拦",
      );
      assert.equal(
        guardOf(ctx, { name: "edit", args, session }),
        undefined,
        "read 已由会话日志计入、refs 由 A 面水位计入 ⇒ guard 放行",
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
      // 判别式收窄（assert.ok 带 asserts 签名）而不是 `as` 抄一份形状：官方 union 换分支就报错。
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

    it("扫描被预算截断 ⇒ 不附；同会话再读仍吃缓存（目标版本未变）", async () => {
      const ctx = createMockCtx();
      apply(ctx);
      const session = fakeSession("s-partial-a", []);
      const agent = fakeAgent(session);
      const first = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetFiles },
        agent,
      });
      assert.equal(contextsOf(first).length, 0, "capped ⇒ 不附");
      // 目标版本没变，缓存条目仍然有效：新出现的引用者不该被第二趟看见（否则就是重扫）。
      await writeFile(path.join(rootFiles, "late-ref.ts"), 'import "./cap-a";\n');
      const second = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetFiles },
        agent,
      });
      assert.equal(contextsOf(second).length, 0, "缓存命中 ⇒ 仍是那份截断扫描，不附");
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
      // 三个开关各自关闭：A 面一声不出。判据一条不减由 guard 那条路单测钉住。
      // 这一族**必须顺序**跑：多趟共用同一枚 ctx.value，并发会让开关值落在读法之间漂移。
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

  describe("盲改：pre-execute 不再代读，guard 给行动清单并要求 read", () => {
    it("盲改只得到 guard 的行动清单；read 缺项在，不会因预检而放行", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-blind-no-handoff", []);
      const agent = fakeAgent(session);
      const args = editArgs(targetMain);
      assert.deepEqual(
        await preflightOf(ctx, { name: "edit", arguments: args, agent }),
        ALLOW,
        "pre-execute 只剩需确认档：盲改不再被代读、代拦",
      );
      const reason = guardOf(ctx, { name: "edit", args, session });
      assert.ok(reason !== undefined, "盲改仍被事实门拒绝");
      assert.ok(reason.includes(MESSAGES.zh.headFirst.slice(0, 20)), "给的是行动清单");
      assert.ok(reason.includes("read "), "read 是必须项");
      // 再判一次也一样：没有插件代记的 read 水位。
      assert.ok(guardOf(ctx, { name: "edit", args, session }) !== undefined, "不会凭预检水位放行");
    });

    it("会话里成功 read 只补 read；refs 仍由 A 面随读取结果补上后才放行", async () => {
      const ctx = createMockCtx();
      ctx.value.smallEditChars = 10;
      apply(ctx);
      const session = fakeSession("s-blind-read", readEvents(targetMain));
      const args = editArgs(targetMain);
      const afterRead = guardOf(ctx, { name: "edit", args, session });
      assert.ok(afterRead !== undefined, "只有 read 还不够，refs 仍缺");
      assert.equal(afterRead.includes("read "), false, "read 已由会话日志计入，不再要求");
      assert.ok(afterRead.includes(MESSAGES.zh.gapRefsNever.slice(0, 2)), "缺的是引用探查");
      const attached = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetMain },
        agent: fakeAgent(session),
      });
      assert.equal(contextsOf(attached).length, 1, "A 面附上引用面并记 refs 水位");
      assert.equal(guardOf(ctx, { name: "edit", args, session }), undefined, "read+refs 齐 ⇒ 放行");
    });
  });
});

describe("预检接线：结算与请求装配各自抛错时只记一条告警", () => {
  it("读取基线结算抛错 ⇒ 只记一条告警，下游决定原样交回", async () => {
    const ctx = createMockCtx();
    apply(ctx);
    // `workingDirectory` 宿主服务换代：结算里那次 cwd 现取会抛，而这一趟仍必须走完。
    const boom = new Error("workingDirectory 服务换代");
    ctx.get = (name: string): unknown => {
      if (name === "workingDirectory") {
        throw boom;
      }
      return name === SETTINGS_READER ? { read: (): Config => ctx.value } : undefined;
    };
    // 静默：这一趟只数告警条数，别把整行日志刷进测试输出。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* 静默 */
    });
    try {
      const decision = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetMain },
        agent: fakeAgent(fakeSession("s-settle-throws", [])),
      });
      assert.equal(decision.kind, "accept", "结算抛错不打断这条读取");
      // 结算与随后的请求装配读的是同一枚宿主服务，所以这一趟两处各记一条；这里只要求
      // "结算那一处的异常被接住并带上原错误"，别把条数钉成实现细节。
      assert.ok(warn.mock.calls.length > 0, "结算那一处的异常被接住并出声");
      assert.equal(warn.mock.calls[0]?.[1], boom, "告警里带的是原错误（不是新编的一句）");
    } finally {
      warn.mockRestore();
    }
  });

  it("预检请求装配抛错 ⇒ 只是不附引用面，决定仍是下游", async () => {
    const ctx = createMockCtx();
    apply(ctx);
    // 设置面读法换代：`settingsConfig` 在请求装配里现读，抛错不能变成"整次工具调用成异常"。
    ctx.get = (name: string): unknown =>
      name === SETTINGS_READER
        ? {
            read: (): Config => {
              throw new Error("设置面换代");
            },
          }
        : undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* 静默 */
    });
    try {
      const decision = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetMain },
        agent: fakeAgent(fakeSession("s-req-throws", [])),
      });
      assert.equal(decision.kind, "accept", "请求装配抛错只丢引用面，不换决定");
      assert.equal(warn.mock.calls.length, 1, "请求那一处只记一条告警");
    } finally {
      warn.mockRestore();
    }
  });

  it("需确认档抛错 ⇒ 只记一条告警，下游 allow 原样交回", async () => {
    const ctx = createMockCtx();
    apply(ctx);
    // 设置面在 `confirmOf` 的第一站现读；抛错不能打断整条 pre-execute 瀑布。
    ctx.get = (name: string): unknown => {
      if (name === "dangerGuardSettings") {
        throw new Error("设置面换代");
      }
      return name === SETTINGS_READER ? { read: (): Config => ctx.value } : undefined;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* 静默 */
    });
    try {
      const decision = await preflightOf(ctx, {
        name: "read",
        arguments: { file_path: targetMain },
        agent: fakeAgent(fakeSession("s-confirm-throws", [])),
      });
      assert.deepEqual(decision, ALLOW, "抛错不改变下游的 allow");
      assert.ok(warn.mock.calls.length > 0, "异常被接住并出声");
    } finally {
      warn.mockRestore();
    }
  });

  it("取证抛错（A 面）⇒ 只记一条告警，下游决定原样交回", async () => {
    const ctx = createMockCtx();
    apply(ctx);
    const badSession = {
      id: "s-attach-throws",
      snapshotEvents: (): never => {
        throw new Error("会话读取炸");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* 静默 */
    });
    try {
      const decision = await postFlightOf(ctx, {
        name: "read",
        arguments: { file_path: targetMain },
        agent: fakeAgent(badSession),
      });
      assert.deepEqual(decision, ACCEPT, "取证抛错只是不附引用面");
      assert.ok(warn.mock.calls.length > 0, "异常被接住并出声");
    } finally {
      warn.mockRestore();
    }
  });

  it("fs/observed 记下的官方真实路径参与同步密钥判定；坏载荷不抛", () => {
    const ctx = createMockCtx();
    ctx.fsFace = {
      ...localFsFace(),
      processPath: (): string => "/sandbox/home/x/.ssh/config",
    };
    apply(ctx);
    const { observed } = ctx;
    assert.ok(observed !== null, "fs/observed 已注册");
    const target = path.join(rootMain, "src", "official-observed.ts");
    observed({ displayPath: target, targetKey: "opaque-never-parsed" });
    const session = fakeSession("s-official-observed", readEvents(target));
    const denied = guardOf(ctx, { name: "edit", args: editArgs(target), session });
    assert.ok(denied !== undefined, "官方那一形落在凭据面 ⇒ 拦");
    assert.ok(denied.includes(MESSAGES.zh.secretPath), "拦它的是密钥面那一句");
    for (const payload of [{}, { displayPath: 42 }, "not-a-target"]) {
      assert.doesNotThrow(() => observed(payload), "异常不许交回宿主");
    }
  });

  it("processPath 抛错 ⇒ 少一形而不是放行，fs/observed 也不抛", () => {
    const ctx = createMockCtx();
    ctx.fsFace = {
      ...localFsFace(),
      processPath: (): string => {
        throw new Error("backend refuses processPath");
      },
    };
    apply(ctx);
    const { observed } = ctx;
    assert.ok(observed !== null, "fs/observed 已注册");
    assert.doesNotThrow(() =>
      observed({ displayPath: path.join(rootMain, "src", "nopath.ts"), targetKey: "opaque" }),
    );
  });

  it("extraSecretPatterns 缺失 ⇒ 扫描隔离退回内置判据，不抛", async () => {
    const ctx = createMockCtx();
    // 运行时形状可能来自旧配置：`strArray` 读不到数组 ⇒ 走内置判据。
    ctx.value.extraSecretPatterns = undefined as never;
    apply(ctx);
    const decision = await postFlightOf(ctx, {
      name: "read",
      arguments: { file_path: targetMain },
      agent: fakeAgent(fakeSession("s-no-extra-secret", [])),
    });
    assert.equal(decision.kind, "accept", "扫描隔离退回内置判据，不抛、不改下游决定");
  });

  it("pre-execute 的 arguments 不是记录 ⇒ 需确认档按空参数走，不抛", async () => {
    const ctx = createMockCtx();
    apply(ctx);
    const decision = await preflightOf(ctx, {
      name: "read",
      arguments: [] as never,
      agent: fakeAgent(fakeSession("s-odd-args", [])),
    });
    assert.deepEqual(decision, ALLOW, "参数形状异常不改变下游 allow");
  });
});
