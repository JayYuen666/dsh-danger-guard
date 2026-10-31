// host 契约补充测试（审计补齐）：
// 从「对外行为契约」出发验证守卫热路径的降级语义与新增接线，不依赖实现细节：
//   1. lessonLoop 总线缺失/抛错时，守卫照常返回拒绝理由（fire-and-forget 降级）；
//   2. pass 信号抛错时，fact-gate 放行路径不受影响；
//   3. session/disposed 释放该会话的 fact-gate 分片（新接线）：会话销毁后
//      同 id 重建会从「首拒」重新开始，且不影响其它会话的分片；
//   4. 总线正常时 report 载荷契约（category/signature/evidence 对齐 lesson-loop）；
//   5. bash 闸的两种结论（已确认危险 / `-c` 体未被检查）在上报侧可分辨。
//   6. 总线 report/pass 异步落库（返回 rejected Promise）时失败同样可见——
//      旧代码只有同步 catch，异步失败既不留日志又给进程留一枚未处理拒绝。
//   7. 会话**当前**工作目录取自官方 `ctx.workingDirectory`（宿主 0.2.1-alpha.2 起
//      `SessionHeader.cwd` 只剩创建期快照）：密钥面、事实门、上报三处都跟到 `cd` 之后；
//      服务缺席或交出坏形状时退回 header.cwd——可选读面缺失绝不使拦截面下线。
import { describe, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile, utimes } from "node:fs/promises";
import { realpathSync } from "node:fs";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import plugin, { BUILTIN_BASE, noteJudgeCost } from "../host.ts";
import type { Config } from "../host.ts";
import { statsSnapshot } from "../lib/judge-stats.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
import { MESSAGES } from "../lib/messages.ts";
import { BLAST_COMMANDS } from "../lib/blast-radius.ts";
// 会话日志出自官方 SessionEvent 夹具构造器（信封必填位与 ToolCallId/MessageId/SessionSeq
// 品牌都在夹具里补一次）；fx 前缀避开与本文件里 `const result = …` 之类局部量的遮蔽。
import { call as fxCall, result as fxResult } from "./fixtures/events.ts";
// 事件类型与生产面（host.ts）同源：官方判别联合由 shared 具名 re-export。
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import type { Events } from "@deepseek-ai/cordis";

/** `tools/pre-execute` 的返回域（与 host.ts 里那枚读法同一条：`Awaited<ReturnType<next>>`）。 */
type PreDecision = Awaited<ReturnType<Parameters<Events["tools/pre-execute"]>[1]>>;

/**
 * 走一次 `tools/pre-execute` 瀑布。本文件的 mock 把监听器**按事件名**收在
 * `disposedHandlers` 里（真实 cordis 的 emit 语义），所以这里按键取出来驱动一次。
 * `next()` 一律回 `allow`：本组用例测的是"下游本来会放行时，本插件把它换成什么"。
 * 入参收 `unknown`（驱动替身，形状由各用例按自己的道具给）。
 */
async function runPreExecute(ctx: MockCtx, exec: unknown): Promise<PreDecision> {
  const listeners = ctx.disposedHandlers.get("tools/pre-execute") ?? [];
  assert.equal(listeners.length, 1, "pre-execute 监听器已注册（apply 之后才该调用）");
  const listener = listeners.at(0) as unknown as (
    exec: unknown,
    next: () => Promise<PreDecision>,
  ) => Promise<PreDecision>;
  return listener(exec, () => Promise.resolve({ kind: "allow" }));
}

/** 从一次 pre-execute 的结论里取出 `ask` 臂（官方 `PreToolDecision` 是判别联合：
 *  不显式收窄就取不到 `reason`/`displayReason` —— 这正是"形状钉在官方声明上"的体现）。 */
function askArmOf(decision: PreDecision): Extract<PreDecision, { kind: "ask" }> {
  if (decision.kind !== "ask") {
    assert.fail(`预期走审批通道，实际结论是 ${decision.kind}`);
  }
  return decision;
}

/** locale 命名空间未注册（本文件的 mock 默认）→ 宿主按中文渲染拒绝理由，
 *  期望值即中文文案表的对应条目：断言看的是"回给模型的那句话"，与迁移前逐字相同。 */
const INDETERMINATE_MESSAGE = MESSAGES.zh.indeterminate;
const RMRF_MESSAGE = MESSAGES.zh.rmrf;
const NESTED_SHELL_UNDETERMINED_MESSAGE = MESSAGES.zh.nestedShellUnconfirmed;

/** 夹具根：宿主**绝对**路径（Windows 上 `/w/proj` 没有盘符，会被当相对路径再解析一遍）。 */
const FIXTURE_ROOT = path.resolve(path.parse(process.cwd()).root, "w", "proj");

/** 另一棵树（`workingDirectory` 服务交出的"当前目录"）：与 `FIXTURE_ROOT` 平级、互不包含。 */
const LIVE_ROOT = path.resolve(path.parse(process.cwd()).root, "w", "live");

/** 取证夹具的目标文件：五种 exec 形状（有/无事件流、有/无证据、零证据）都指向同一份路径，
 *  散着写字面量改一处就漏（断言的是夹具自己造的目标，不是生产面的常量）。 */
const EDIT_TARGET_PATH = path.join(FIXTURE_ROOT, "src", "cfg.ts");
/** 临时项目里那份最简单的 TypeScript 源码（多处夹具共用，避免重复字面量）。 */
const SIMPLE_TS_SOURCE = "export const a = 1;\n";

/** 危险 bash 命中后上报教训总线的分类（report 载荷契约的期望值）。 */
const BASH_DENIAL_CATEGORY = "dangerous-bash";

interface GuardCall {
  fn: (exec: {
    name?: string;
    arguments?: unknown;
    agent?: {
      session?: {
        id?: unknown;
        header?: { cwd?: unknown };
        snapshotEvents?: () => readonly SessionEvent[];
      };
    };
  }) => string | undefined;
}

interface LessonLoopSpy {
  report?: (input: unknown) => unknown;
  pass?: (input: unknown) => unknown;
}

/** report 载荷的断言形状（与 lesson-loop LessonLoopReporter.report 入参对齐）。
 *  `evidence` 在这里是**必填**：入参类型把它标成可选是总线侧的宽容，而生产面
 *  `lib/lesson-report.ts` 的 `reportDeny` 把它列成必填形参并原样带上（唯一一处 `bus.report` 调用），
 *  所以断言侧按"发出必带"读——读它就不必再写 `?.`（那条守卫在类型面是空转）。 */
interface ReportPayload {
  source: string;
  category: string;
  cwd: unknown;
  sessionId: unknown;
  signature: string;
  detail: string;
  evidence: Record<string, unknown>;
}

interface MockCtx {
  tools: {
    guard: (fn: GuardCall["fn"]) => () => void;
    /** 官方的按名查询（installed dsh-tools index.d.ts:164）。本包只用它探测
     *  「这条工具名在不在」，缺席/抛错都按"在"处理——见下面的在位探测一组。 */
    get?: (name: string) => unknown;
  };
  /** 0.1.7 settings 面：拦截半只调 describe()（locale 偏好）；configure 归设置条目。 */
  settings: {
    describe: () => { ns: string; value: unknown; revision: number }[];
  };
  /** 设置面读数（bulkhead 后由**设置条目**的读数口提供，见 get）。 */
  value: Config;
  /** cordis 的可选服务读法：SETTINGS_READER = 设置条目读数口，lessonLoop = 教训总线，
   *  workingDirectory = 官方工作目录服务（宿主 0.2.1-alpha.2 起「会话当前目录」的唯一出处）。
   *  形状不校验（本字段就是拿来交坏形状的），缺省 = 宿主没装那个 bundle。 */
  workingDirectory?: unknown;
  /** cordis 的可选服务读法：SETTINGS_READER = 设置条目读数口，lessonLoop = 教训总线。 */
  get?: (name: string) => unknown;
  on?: (event: string, listener: (session: { id?: unknown }) => void) => () => void;
  effect: (fn: () => (() => void) | undefined) => void;
  bus: LessonLoopSpy;
  guardInstalled: GuardCall | null;
  /** 服务注册路径（`TypertRemoteService` 构造时会走它）。本包的替身只探它可调用。 */
  reflect: { provide: (name: string, value?: unknown) => () => void };
  effects: (() => void)[];
  disposedHandlers: Map<string, ((session: { id?: unknown }) => void)[]>;
  /** 除设置读数口/log 之外的可选服务面（`shell` 等）。缺省空表 = 未装配。 */
  extraServices: Record<string, unknown>;
}

/** guard 谓词的执行参数类型（抽取 `extends (exec: infer Exec)` 的推断，改名避开 id-length）。 */
type GuardExecParam = GuardCall["fn"] extends (exec: infer Exec) => unknown ? Exec : never;

/** 有事件流（空日志）的 edit 调用（会话可判定取证 → 走正常配额/收敛路径）。 */
const editExecWithEvents = (id: string): GuardExecParam => ({
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id, header: { cwd: FIXTURE_ROOT }, snapshotEvents: () => [] } },
});

/** 无事件流的 edit 调用（证据不可判定 → 首拒给行动清单、重试走 indeterminate）。 */
const editExecNoEvents = (id: string): Record<string, unknown> => ({
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id, header: { cwd: FIXTURE_ROOT } } },
});

/** 取证齐备（read + 项目级 grep 均成功回填）的会话日志。 */
function evidenceLog(): SessionEvent[] {
  // 官方 tool/call.arguments 是模型产出的原始 JSON 串；callId 由 tool/result.message
  // .source.callId 串联（成败都在这枚配对键上）。
  return [
    fxCall("r1", "read", JSON.stringify({ file_path: EDIT_TARGET_PATH })),
    fxResult("r1"),
    fxCall("g1", "grep", JSON.stringify({ path: FIXTURE_ROOT, pattern: "cfg.ts" })),
    fxResult("g1"),
  ];
}

/** 带完整取证证据的 edit 调用（放行路径）。 */
const editExecWithEvidence = (id: string): GuardExecParam => ({
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id, header: { cwd: FIXTURE_ROOT }, snapshotEvents: () => evidenceLog() } },
});

/** 只有 read 证据的会话日志：缺项只落在**上层探查** —— 决策 ④ 之后配额要免的正是那一半，
 *  所以"数配额轮次"的用例都得用它（缺 read 时配额会被扣下，见 test/fact-gate.test.ts）。 */
function readOnlyLog(): SessionEvent[] {
  return [fxCall("r1", "read", JSON.stringify({ file_path: EDIT_TARGET_PATH })), fxResult("r1")];
}

/** 只做过 read 的 edit 调用（配额路径）。 */
const editExecReadOnly = (id: string): GuardExecParam => ({
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id, header: { cwd: FIXTURE_ROOT }, snapshotEvents: () => readOnlyLog() } },
});

/** 零证据的 edit 调用（必拒路径）：降级用例用它数内置 maxDenies 的配额轮次。 */
const editWithoutEvidence = (id: string): GuardExecParam => ({
  name: "edit",
  arguments: { file_path: path.join(FIXTURE_ROOT, "src", "fallback.ts") },
  agent: { session: { id, header: { cwd: FIXTURE_ROOT }, snapshotEvents: () => [] } },
});

const DEFAULT_CTX_VALUE: Config = { ...BUILTIN_BASE, enabled: true, factGateEnabled: true };

function createMockCtx(bus: LessonLoopSpy = {}, value?: Partial<Config>): MockCtx {
  const ctx: MockCtx = {
    guardInstalled: null,
    effects: [],
    // 该条目现在会注册一枚 Typert Remote 服务（`ctx.reflect.provide` 是它的注册路径，见
    // lib/stats-remote.ts）。真宿主里 `reflect` 恒在，手写 mock 里补一枚最小替身就够 ——
    // 与下面 `effect` / `provide` 那几位的待遇一致。
    reflect: {
      provide: () => (): void => {
        void 0;
      },
    },
    disposedHandlers: new Map(),
    extraServices: {},
    value: { ...DEFAULT_CTX_VALUE, ...value },
    bus,
    tools: {
      guard(fn) {
        ctx.guardInstalled = { fn };
        return () => {
          ctx.guardInstalled = null;
        };
      },
    },
    settings: {
      // 官方语义：只有装配成功且带 volatile 字段的条目才出现在 describe() 里。
      // 本文件的 mock 没装 locale 插件 → 找不到描述符 → 宿主退回中文默认。
      describe: () => [],
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") {
        ctx.effects.push(disposer);
      }
    },
  };
  // 一个 get 同时供三件事：设置读数口（bulkhead 的值面通道）、教训总线、工作目录服务。
  ctx.get = (name: string): unknown => {
    if (name === SETTINGS_READER) {
      return { read: (): Config => ctx.value };
    }
    if (name === "workingDirectory") {
      return ctx.workingDirectory;
    }
    if (name === "lessonLoop") {
      return ctx.bus;
    }
    // 除这几枚之外的可选服务面（本包读的：`shell` —— 沙箱模式与爆炸半径预演）。
    // 缺省空表 = 未装配 ⇒ 与"没装执行器"同解（闸门照常拦，预演退回盲问）。
    return ctx.extraServices[name];
  };
  // 按事件名路由（真实 cordis 的 emit 语义）：此前把所有监听器塞进同一个数组，
  // "会话销毁"组用例会把 locale 失效监听器也一起喂到——今天无害，但 mock 的分发
  // 语义与真实链路不符，宿主将来对其他事件载荷做处理时这批用例测的就不是真实路由。
  ctx.on = (event, listener) => {
    const list = ctx.disposedHandlers.get(event) ?? [];
    list.push(listener);
    ctx.disposedHandlers.set(event, list);
    return () => {
      const current = ctx.disposedHandlers.get(event) ?? [];
      const i = current.indexOf(listener);
      if (i !== -1) {
        current.splice(i, 1);
      }
    };
  };
  return ctx;
}

function applyPlugin(ctx: MockCtx): void {
  plugin.apply(ctx as never);
}

/** 触发 session/disposed（按事件名路由，与真实 cordis 的 emit 语义一致）。 */
function emitDisposed(ctx: MockCtx, id: string): void {
  for (const handler of ctx.disposedHandlers.get("session/disposed") ?? []) {
    handler({ id });
  }
}

const bashExec: GuardExecParam = {
  name: "bash",
  arguments: { command: "rm -rf /" },
  agent: { session: { id: "s-1", header: { cwd: FIXTURE_ROOT } } },
};

/** `-c` 体引号未闭合：lib 侧给不出危险结论、也给不出安全结论 → 需用户确认。 */
const bashUnconfirmedExec: GuardExecParam = {
  name: "bash",
  arguments: { command: 'bash -c "rm -rf /' },
  agent: { session: { id: "s-1", header: { cwd: FIXTURE_ROOT } } },
};

const editExec = {
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id: "s-1", header: { cwd: FIXTURE_ROOT } } },
};

/**
 * 捕获 console.warn 的**全部**实参（本包的降级日志是「前缀 + 错误对象」两段式，
 * 只收首参就断言不到失败原因，等于没验）。
 */
function warnCapture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      console.warn = original;
    },
  };
}

/**
 * 未处理拒绝探针：装一枚 process 级监听，把漏网的 rejection 收进数组。
 * `stop` 必须在 finally 里调用——vitest 的 worker 进程被所有用例共用，
 * 残留监听会把别人的 rejection 也算到本用例头上（反之卸载后漏出的 rejection
 * 仍会被 vitest 自己的监听抓到，那是一条独立的失败信号）。
 */
function rejectionProbe(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const record = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", record);
  return {
    reasons,
    stop() {
      process.off("unhandledRejection", record);
    },
  };
}

describe("lessonLoop 总线降级（守卫热路径绝不因总线故障失败）", () => {
  it("总线缺失（get 返回 undefined）→ 危险命令照常被拒", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const result = ctx.guardInstalled!.fn(bashExec);
    assert.equal(typeof result, "string");
    assert.match(result!, /danger-guard/u);
  });

  it("report 抛错 → 守卫仍返回拒绝理由，且不向上抛", () => {
    const ctx = createMockCtx({
      report: () => {
        throw new Error("bus down");
      },
    });
    applyPlugin(ctx);
    const logs = warnCapture();
    let blocked: string | undefined;
    try {
      assert.doesNotThrow(() => {
        blocked = ctx.guardInstalled!.fn(bashExec);
        assert.equal(typeof blocked, "string");
      });
    } finally {
      logs.restore();
    }
    assert.match(blocked ?? "", /danger-guard/u, "同步抛错不得影响拦截");
    assert.ok(
      logs.lines.some(
        (line) => line.includes("lessonLoop report failed:") && line.includes("Error: bus down"),
      ),
      "同步抛错必须留下降级日志（老路径的日志面，异步化后不许退化）",
    );
  });

  it("report 返回 rejected Promise → 同一降级日志照记，且不产生未处理拒绝", async () => {
    const ctx = createMockCtx({
      report: (): Promise<never> => Promise.reject(new Error("bus async down")),
    });
    applyPlugin(ctx);
    const logs = warnCapture();
    const probe = rejectionProbe();
    try {
      assert.equal(typeof ctx.guardInstalled!.fn(bashExec), "string", "异步失败不得影响拦截");
      // 让 rejection 的微任务落地，再让 Node 跑一轮宏任务（unhandledRejection 在宏任务边界判定）。
      await sleep(0);
    } finally {
      logs.restore();
      probe.stop();
    }
    assert.ok(
      logs.lines.some(
        (line) =>
          line.includes("lessonLoop report failed:") && line.includes("Error: bus async down"),
      ),
      "异步失败必须与同步抛错落进同一条日志（否则被静默吞掉）",
    );
    assert.deepEqual(probe.reasons, [], "rejection 必须被接住：漏出去会污染整个宿主进程");
  });

  it("总线正常 → report 载荷契约（category/signature/evidence）", () => {
    const reports: unknown[] = [];
    const ctx = createMockCtx({
      report: (input) => {
        reports.push(input);
        return {};
      },
    });
    applyPlugin(ctx);
    ctx.guardInstalled!.fn(bashExec);
    assert.equal(reports.length, 1);
    const rep = reports[0] as ReportPayload;
    assert.equal(rep.source, "danger-guard");
    assert.equal(rep.category, BASH_DENIAL_CATEGORY);
    assert.equal(rep.cwd, FIXTURE_ROOT);
    assert.equal(rep.sessionId, "s-1");
    assert.equal(typeof rep.signature, "string");
    assert.equal(typeof rep.detail, "string");
    assert.equal(rep.evidence["tool"], "bash");
  });
});

/** 采集 report 载荷的 ctx（总线正常；载荷按 unknown 收，断言处再取形状）。 */
function reportSpy(): { ctx: MockCtx; reports: unknown[] } {
  const reports: unknown[] = [];
  const ctx = createMockCtx({
    report: (input) => {
      reports.push(input);
      return {};
    },
  });
  return { ctx, reports };
}

describe("bash 闸的两种结论在总线侧必须可分辨（硬拒 vs 需确认）", () => {
  it("命中危险模式 → 走 guard 硬拒，签名 = 命令原文，needsUserConfirmation=false", () => {
    const { ctx, reports } = reportSpy();
    applyPlugin(ctx);
    const denied = ctx.guardInstalled!.fn(bashExec);
    // 基础理由逐字是消息表那条；其后另起一行是**出路**（点名触发判据的目标）。
    // 两段合起来比一条会把出路那一行的存在与内容一起糊掉——而那正是"模型知道该改什么"。
    assert.ok(denied !== undefined, "预期被拦，实际放行");
    assert.ok(denied.startsWith(`${RMRF_MESSAGE}\n`), `拒绝理由结构变了：${denied}`);
    assert.ok(denied.includes("/"), "出路未点名触发判据的目标");
    assert.equal(reports.length, 1);
    const rep = reports[0] as ReportPayload;
    assert.equal(rep.category, BASH_DENIAL_CATEGORY);
    assert.equal(rep.signature, "rm -rf /");
    assert.equal(rep.evidence["needsUserConfirmation"], false);
  });

  it("`-c` 体未被检查 → 走 ask 通道（guard 不拒），同类别上报且标记需确认", async () => {
    const { ctx, reports } = reportSpy();
    applyPlugin(ctx);
    // 结论一：**guard 不再拒它**。这一档的收口在 `tools/pre-execute` 的宿主审批上
    //（`RULE_TIER.nestedShellUnconfirmed === "ask"`）—— 旧实现把一段"请贴给用户确认"
    // 的文案丢回给模型，而模型完全可以无视它直接重试；改档后模型绕不过去。
    assert.equal(
      ctx.guardInstalled!.fn(bashUnconfirmedExec),
      undefined,
      "ask 档不该由 guard 收口（两处都收口会让用户点了允许还是被拒）",
    );
    // 结论二：审批请求确实发出去了，并且把它翻成了宿主认的 `ask` 决定。
    const decision = askArmOf(await runPreExecute(ctx, bashUnconfirmedExec));
    // reason 现在 = 基础文案 + 档位说明（同一枚键在不同预设下成因不同，见 lib/mode-policy.ts）。
    assert.equal(decision.reason?.startsWith(NESTED_SHELL_UNDETERMINED_MESSAGE), true);
    assert.equal(
      decision.reason,
      `${NESTED_SHELL_UNDETERMINED_MESSAGE}\n${MESSAGES.zh.noteUnknown}`,
    );
    // `displayReason` 官方定成 `{ readonly en: string; readonly [locale: string]: string }`
    // —— 人读那一面（弹窗），与回给模型的 `reason` 同源同键。
    // 弹窗那面 = 规则本文 + 该档位的说明（只交规则本文会让用户看不到"这是哪一档"）。
    assert.deepEqual(decision.displayReason, {
      en: `${MESSAGES.en.nestedShellUnconfirmed}\n${MESSAGES.en.noteUnknown}`,
      zh: `${MESSAGES.zh.nestedShellUnconfirmed}\n${MESSAGES.zh.noteUnknown}`,
    });
    // 结论三：教训总线仍看得见它，且能与"已确认危险"区分开。
    assert.equal(reports.length, 1, "需确认同样进教训总线");
    const rep = reports[0] as ReportPayload;
    assert.equal(rep.source, "danger-guard");
    assert.equal(rep.category, BASH_DENIAL_CATEGORY);
    assert.equal(rep.sessionId, "s-1");
    // 签名用**命令原文**：类别级归并在 lesson-loop 侧（CATEGORY_SIGNATURES 的 dangerous-bash），
    // 原文因此落进 evidence.signature —— 卡片不再按套娃形态碎片化，人审也看得见是哪条命令。
    assert.equal(rep.signature, 'bash -c "rm -rf /');
    assert.equal(rep.evidence["needsUserConfirmation"], true);
    assert.notEqual(rep.detail, RMRF_MESSAGE, "两种结论的文案不同源，模型可分辨");
  });

  it("ask 档**压不过** deny 档：同一串里既有需确认段又有灾难段 → 整串按硬拒收口", async () => {
    const { ctx, reports } = reportSpy();
    applyPlugin(ctx);
    // 这是引入 ask 档带出来的漏拦面：`commandDanger` 原本"首命中即返回"，而 `ask` 档命中
    // 会让扫描提前收工 ⇒ 后一段的 `rm -rf /` **从未被判定**；用户点了允许之后 guard 跑起来
    // 看到的仍是 ask 结论（按 RULE_TIER 让路）⇒ 灾难执行。严重度择优把这条堵住。
    //
    // 输入要选**两段都判得出**的：`python3 -c "print(1)"` 是"非 shell 解释器的代码串"那一档
    //（opaque ⇒ `nestedShellUnconfirmed` ⇒ ask），而 `rm -rf /` 是 deny。
    // 不能用 `bash -c "…` 那种引号不闭合的写法——按定义它就取不出体，整串只该有一个 ask 结论，
    // 测不到"前 ask 后 deny"这个形状（第一版用例就是踩在这个前提上）。
    const command = 'python3 -c "print(1)" && rm -rf /';
    const denied = ctx.guardInstalled!.fn({ name: "bash", arguments: { command } });
    assert.ok(denied?.startsWith(`${RMRF_MESSAGE}\n`) === true, `整串应按 deny 收口：${denied}`);
    // 已按 deny 收口的串**不该再弹审批** —— 否则 `deny` 那一段会被一并批准
    //（审批是整次调用的放行，没有"只批准后半段"这种语义）。
    const preDecision = await runPreExecute(ctx, { name: "bash", arguments: { command } });
    assert.notEqual(preDecision.kind, "ask", "已按 deny 收口的串不该再弹审批");
    assert.equal(reports.length, 1);
    assert.equal((reports[0] as ReportPayload).evidence["needsUserConfirmation"], false);
  });
});

describe("session/disposed 释放 fact-gate 会话分片", () => {
  it("会话销毁后同 id 重建 → 从首拒重新开始（分片已清）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    // 用「只缺上层探查」的调用：它数得到配额（缺 read 的那一类会被扣下，永远进不了放行分支）。
    // 先连拒两次到配额边界，再销毁会话——分片若没清，第三次就会直接配额放行。
    assert.equal(typeof ctx.guardInstalled!.fn(editExecReadOnly("s-a")), "string", "首拒");
    assert.equal(typeof ctx.guardInstalled!.fn(editExecReadOnly("s-a")), "string", "二拒");
    emitDisposed(ctx, "s-a");
    const r3 = ctx.guardInstalled!.fn(editExecReadOnly("s-a"));
    assert.equal(typeof r3, "string", "分片已清 ⇒ 重新从首拒开始，而不是第三轮配额放行");
    assert.doesNotMatch(r3!, /配额/u);
  });

  it("会话销毁不影响其它会话的分片（隔离性）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    // 会话 s-b 两次"只缺上层"的拒绝（决策 ④：缺 read 时配额会被扣下，数不到放行）
    ctx.guardInstalled!.fn(editExecReadOnly("s-b"));
    ctx.guardInstalled!.fn(editExecReadOnly("s-b"));
    // 销毁其它会话 s-x
    emitDisposed(ctx, "s-x");
    // s-b 第三次 → 达配额放行（undefined；说明 s-b 分片仍计数到 3 > maxDenies=2）
    const res = ctx.guardInstalled!.fn(editExecReadOnly("s-b"));
    assert.equal(res, undefined);
  });

  it("无事件历史的会话：首拒→indeterminate；dispose 后重建回到首拒", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    // 无 snapshotEvents → 证据不可判定：首拒给行动清单
    const first = ctx.guardInstalled!.fn(editExecNoEvents("s-d"));
    assert.equal(typeof first, "string");
    // 第二次重试 → indeterminate（交互式确认，不消耗配额）
    const second = ctx.guardInstalled!.fn(editExecNoEvents("s-d"));
    assert.equal(second, INDETERMINATE_MESSAGE);
    // dispose 清分片 → 重建后从首拒重新开始（非 indeterminate、非配额）
    emitDisposed(ctx, "s-d");
    const rebuilt = ctx.guardInstalled!.fn(editExecNoEvents("s-d"));
    assert.equal(typeof rebuilt, "string");
    assert.notEqual(rebuilt, INDETERMINATE_MESSAGE);
  });

  it("重复 dispose 同 id 幂等（不抛错）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    assert.doesNotThrow(() => {
      emitDisposed(ctx, "s-c");
      emitDisposed(ctx, "s-c");
    });
  });
});

describe("enabled=false 时守卫完全静默（含总线与分片零副作用）", () => {
  it("不调 report、不建分片、不抛错", () => {
    const reports: unknown[] = [];
    const ctx = createMockCtx(
      {
        report: (i) => {
          reports.push(i);
          return {};
        },
      },
      { enabled: false, factGateEnabled: true },
    );
    applyPlugin(ctx);
    assert.equal(ctx.guardInstalled!.fn(bashExec), undefined);
    assert.equal(ctx.guardInstalled!.fn(editExec), undefined);
    assert.equal(reports.length, 0);
  });
});

describe("设置面故障时闸门必须 fail closed（bulkhead 隔舱后）", () => {
  // 0.1.6 的形态：settings.register 在注册期求值合并段，手改坏的持久段（maxDenies: 0）
  // 让它抛错；apply 捕获后以 BUILTIN_BASE 再注册一次，闸门继续拦。
  // 0.1.7 迁移第一版把这段删了，改成"严格 Config 挂在本条目上、由 cordis 校验"——结果
  // 越界值让**条目 fiber** 在 apply 之前就 FAILED（vendor/cordis/src/fiber.ts:50、:641-664），
  // 闸门整体下线：一行设置笔误 = 危险命令不再被拦。
  // 现在的形态（bulkhead）：严格 schema 搬去独立条目 danger-guard-settings，本条目读它
  // 挂出的读数口。读数口不在（设置条目 FAILED / 被禁用 / 没装）时，本测试钉住同一组结论：
  // 闸门照装、危险命令照拦、值面回到内置默认、并且**大声**告警。
  // 真实 fiber 级的隔离证据在 test/bulkhead-isolation.test.ts（真 cordis 运行时）。
  it("设置读数口缺失 → 闸门仍挂载、按内置默认拦、降级告警只响一次", () => {
    const warns: string[] = [];
    const ctx = createMockCtx();
    // 就地替换 get：模拟"设置条目 FAILED ⇒ 它没 provide 过读数口"。
    // 展开副本会让 guardInstalled 写到原对象上（断言就永远看不到闸门），所以逐字段改。
    ctx.get = (name: string): unknown => (name === "lessonLoop" ? ctx.bus : undefined);
    ctx.value = { ...ctx.value, maxDenies: 99 };
    const original = console.warn;
    console.warn = (first?: unknown): void => {
      if (typeof first === "string") {
        warns.push(first);
      }
    };
    let blocked: string | undefined;
    let second: string | undefined;
    try {
      applyPlugin(ctx);
      assert.ok(ctx.guardInstalled, "读数口缺失也必须挂上 guard");
      blocked = ctx.guardInstalled.fn(bashExec);
      assert.equal(typeof blocked, "string", "降级后闸门仍然拦危险命令");
      // 事实门配额走内置默认（maxDenies 99 是"用户写坏的那份"，绝不能被读到）
      assert.notEqual(ctx.guardInstalled.fn(editExecReadOnly("fb-1")), undefined, "缺上层探查首拒");
      second = ctx.guardInstalled.fn(editExecReadOnly("fb-1"));
      assert.equal(typeof second, "string", "内置 maxDenies=2 → 第二轮仍是拒绝（不是交互确认）");
      // 第 3 次达内置配额放行 ⇒ 读到的确实是内置 2，而不是用户写坏的 99
      assert.equal(
        ctx.guardInstalled.fn(editExecReadOnly("fb-1")),
        undefined,
        "第三轮按内置 maxDenies=2 配额放行（99 那份坏值没进判定链）",
      );
    } finally {
      console.warn = original;
    }
    // 一次性标志是模块级的：本文件里另一条降级形状若先跑会把首次告警消耗掉，所以这里
    // 钉的是「不随调用刷屏」（0 次 = 已由更早的用例报过；1 次 = 本条报的）。
    assert.ok(
      warns.filter((line) => line.includes("内置默认底座")).length <= 1,
      `回落告警不得重复，实际收到：${JSON.stringify(warns)}`,
    );
  });
});

/** 只取事实门那一类的 pass 信号：`judge-cost` 样本每次判定都发一条，不参与这几条契约。 */
function factgatePasses(passes: readonly unknown[]): unknown[] {
  return passes.filter((item) => (item as { category?: string }).category === "factgate-deny");
}

describe("pass 信号上报的完整契约（总线同时提供 report/pass）", () => {
  it("取证通过 → bus.pass 被调用一次，载荷含 category/signature", () => {
    const passes: unknown[] = [];
    const reports: unknown[] = [];
    const ctx = createMockCtx({
      report: (input) => {
        reports.push(input);
        return {};
      },
      pass: (input) => {
        passes.push(input);
        return {};
      },
    });
    applyPlugin(ctx);
    const id = "s-pass-ok";
    ctx.guardInstalled!.fn(editExecWithEvents(id));
    assert.equal(ctx.guardInstalled!.fn(editExecWithEvidence(id)), undefined, "取证齐备 → 放行");
    assert.equal(factgatePasses(passes).length, 1, "放行 = 规则被遵守 → pass 信号");
    const payload = factgatePasses(passes)[0] as {
      category: string;
      signature: string;
      sessionId: unknown;
    };
    assert.equal(payload.category, "factgate-deny");
    assert.equal(payload.signature, "edit-before-factgate");
    assert.equal(payload.sessionId, id);
    assert.equal(reports.length, 1, "首拒上报一次 deny");
  });

  it("pass 抛错 → 放行路径不受影响；配额放行不报 pass", () => {
    const passes: unknown[] = [];
    const ctx = createMockCtx({
      report: () => ({}),
      pass: (input) => {
        // 收载荷而不是收 "called"：`judge-cost` 样本也走这一条 pass 通道，
        // 按类别筛才判得清"事实门那一条 pass 到底发了没有"。
        passes.push(input);
        throw new Error("pass bus down");
      },
    });
    applyPlugin(ctx);
    const id = "s-pass-throw";
    ctx.guardInstalled!.fn(editExecWithEvents(id));
    const logs = warnCapture();
    // pass 抛错被吞掉：守卫仍正常返回"放行"，不因总线故障而失败
    try {
      assert.doesNotThrow(() => {
        assert.equal(ctx.guardInstalled!.fn(editExecWithEvidence(id)), undefined);
      });
    } finally {
      logs.restore();
    }
    assert.equal(factgatePasses(passes).length, 1, "确实走到了 pass 调用");
    assert.ok(
      logs.lines.some(
        (line) => line.includes("lessonLoop pass failed:") && line.includes("Error: pass bus down"),
      ),
      "pass 同步抛错也要留下降级日志（异步化后不许退化）",
    );
    // 配额放行（第 3 次"只缺上层"的拒绝）不报 pass——它不是"遵守规则"
    const other = "s-quota-nopass";
    ctx.guardInstalled!.fn(editExecReadOnly(other));
    ctx.guardInstalled!.fn(editExecReadOnly(other));
    assert.equal(ctx.guardInstalled!.fn(editExecReadOnly(other)), undefined, "达配额放行");
    assert.equal(factgatePasses(passes).length, 1, "配额放行不追加 pass 信号");
  });

  it("pass 返回 rejected Promise → 放行路径不受影响，且不产生未处理拒绝", async () => {
    const passes: unknown[] = [];
    const ctx = createMockCtx({
      report: () => ({}),
      pass: (input: unknown): Promise<never> => {
        passes.push(input);
        return Promise.reject(new Error("pass bus async down"));
      },
    });
    applyPlugin(ctx);
    const id = "s-pass-async";
    ctx.guardInstalled!.fn(editExecWithEvents(id));
    const logs = warnCapture();
    const probe = rejectionProbe();
    try {
      assert.equal(
        ctx.guardInstalled!.fn(editExecWithEvidence(id)),
        undefined,
        "异步失败不得把放行改成拒绝",
      );
      // 让 rejection 的微任务落地，再让 Node 跑一轮宏任务（unhandledRejection 在宏任务边界判定）。
      await sleep(0);
    } finally {
      logs.restore();
      probe.stop();
    }
    assert.equal(factgatePasses(passes).length, 1, "确实走到了 pass 调用");
    assert.ok(
      logs.lines.some(
        (line) =>
          line.includes("lessonLoop pass failed:") && line.includes("Error: pass bus async down"),
      ),
      "异步失败与同步抛错落进同一条 pass 降级日志",
    );
    assert.deepEqual(probe.reasons, [], "rejection 必须被接住：漏出去会污染整个宿主进程");
  });

  it("总线形状不合（get 返回 {}）→ 守卫照常工作", () => {
    const ctx = createMockCtx({});
    const originalGet = ctx.get;
    // 只让 lessonLoop 这一支形状不合；整表替换会让 SETTINGS_READER 一起消失，
    // 顺带触发一条与本用例无关的降级告警、并把一次性标志置真（污染顺序敏感断言）。
    ctx.get = (name: string): unknown => (name === "lessonLoop" ? {} : originalGet?.(name));
    applyPlugin(ctx);
    assert.equal(typeof ctx.guardInstalled!.fn(bashExec), "string");
  });
});

describe("判定耗时与解析形随上报一起发（长度上限要按真实分布调）", () => {
  it("bash 拒绝载荷带 judgeMs / judgeLength", () => {
    const { ctx, reports } = reportSpy();
    applyPlugin(ctx);
    ctx.guardInstalled!.fn(bashExec);
    const rep = reports[0] as ReportPayload;
    assert.equal(typeof rep.evidence["judgeMs"], "number", "没有耗时就无法判断上限该不该调");
    assert.equal(rep.evidence["judgeLength"], "rm -rf /".length, "签名就是这条命令，长度要能对上");
  });

  it("密钥面载荷带 judgeMs；解析不出真实路径时不带 resolvedPaths", () => {
    const { ctx, reports } = reportSpy();
    applyPlugin(ctx);
    const reason = ctx.guardInstalled!.fn({
      name: "read",
      arguments: { file_path: path.join(FIXTURE_ROOT, ".ssh", "id_rsa") },
      agent: { session: { id: "s-1", header: { cwd: FIXTURE_ROOT } } },
    });
    assert.equal(typeof reason, "string", "键形口径下只读工具翻凭据也拦");
    const rep = reports[0] as ReportPayload;
    assert.equal(rep.category, "secret-path");
    assert.equal(typeof rep.evidence["judgeMs"], "number");
    assert.equal(rep.evidence["resolvedPaths"], undefined, "祖先全不存在 ⇒ 一形都没到手");
  });

  it("目标确实存在时解析形一起发出（看教训时要知道被拦的是哪棵树）", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dgc-contract-"));
    try {
      await mkdir(path.join(dir, ".ssh"), { recursive: true });
      const { ctx, reports } = reportSpy();
      applyPlugin(ctx);
      ctx.guardInstalled!.fn({
        name: "write",
        arguments: { file_path: path.join(dir, ".ssh", "id_rsa") },
        agent: { session: { id: "s-1", header: { cwd: dir } } },
      });
      const rep = reports[0] as ReportPayload;
      // 交的是**清单**：本机 realpath 那一形在这里，官方后端那一形要 fs 面在位才有
      //（这个桩没装 ⇒ 清单只有一枚；两形并列的判定面见 test/danger-rules.test.ts 与
      // test/host-preflight.test.ts 的官方通道那组用例）。
      // 期望值必须吃**产品所用的那一个** realpath 口径：产品走同步 `realpathSync`
      //（`host.ts` 的 realpathOf —— 同步判定链只有它付得起），而 Windows 上同步版会把
      // 8.3 短名（`RUNNER~1`）展开成长名；`node:fs/promises` 的 `realpath` 与它不保证逐字同形。
      // 拿另一个 API 的产物当期望，测的就不是产品行为。
      const realDir = realpathSync(dir);
      assert.deepEqual(rep.evidence["resolvedPaths"], [path.join(realDir, ".ssh", "id_rsa")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("慢判定：到线才出声（阈值撞墙钟，故直接喂数而不是造一条 100ms 的输入）", () => {
    const logs = warnCapture();
    try {
      noteJudgeCost({ face: "bash", ms: 99.9, length: 10 });
      assert.deepEqual(logs.lines, [], "未到线不出声，否则告警会淹掉真实分布");
      noteJudgeCost({ face: "edit", ms: 100, length: 4096 });
      const line = logs.lines.join("\n");
      assert.equal(logs.lines.length, 1);
      assert.ok(line.includes("slow judge"));
      assert.ok(line.includes("(edit)"), "出声要说是哪一面慢的");
      assert.ok(line.includes("4096"), "输入规模一起给，才知道上限该往哪调");
    } finally {
      logs.restore();
    }
  });

  it("未判定样本在 noteJudgeCost 入口就被拒收：零长度不污染 calls，显式 judged 置位优先", () => {
    const before = statsSnapshot().calls["contract-unjudged"] ?? 0;
    // 零长度且未显式判定 = "这一面没跑判定"：不发样本（calls 不涨、窗口不进）。
    noteJudgeCost({ face: "contract-unjudged", ms: 5, length: 0 });
    assert.equal(statsSnapshot().calls["contract-unjudged"] ?? 0, before, "零长度样本被拒收");
    // 判定真的发生过（哪怕输入为空）：host 以 judged 置位表态，样本照记。
    noteJudgeCost({ face: "contract-unjudged", ms: 5, length: 0, judged: true });
    assert.equal(
      statsSnapshot().calls["contract-unjudged"] ?? 0,
      before + 1,
      "judged 置位后零长度样本照记",
    );
  });

  it("滚动摘要：攒满一窗才发一条，分档与最大值都在行里，发完清零", () => {
    const infos: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]): void => {
      infos.push(args.map(String).join(" "));
    };
    try {
      for (let i = 0; i < 199; i += 1) {
        noteJudgeCost({ face: "windowed", ms: i % 3, length: i * 10 + 1 });
      }
      assert.deepEqual(infos, [], "不满一窗不发条，否则摘要本身就是噪声");
      noteJudgeCost({ face: "windowed", ms: 250, length: 300_000 });
      assert.equal(infos.length, 1);
      const line = infos.join("");
      assert.ok(line.includes("judge stats (windowed): calls=200"));
      assert.ok(line.includes(">=100ms=1"), "慢的那一条要落在末档");
      assert.ok(line.includes("<1ms=67"));
      assert.ok(line.includes("maxMs=250.0"));
      assert.ok(line.includes(">=262144=1"), "长度末档同样要有牙");
      assert.ok(line.includes("maxLen=300000"));
      noteJudgeCost({ face: "windowed", ms: 1, length: 1 });
      assert.equal(infos.length, 1, "清零后是滚动窗口，不是累计历史");
    } finally {
      console.info = original;
    }
  });

  it("judge-cost 的 pass 只在采集开时发，载荷里没有命令原文也没有路径", () => {
    const passes: unknown[] = [];
    const ctx = createMockCtx({
      report: () => ({}),
      pass: (input) => {
        passes.push(input);
        return {};
      },
    });
    applyPlugin(ctx);
    ctx.value = { ...ctx.value, judgeStats: true };
    ctx.guardInstalled!.fn(bashExec);
    const costs = passes.filter(
      (item) => (item as Record<string, unknown>)["category"] === "judge-cost",
    );
    assert.equal(costs.length, 1, "一次 bash 判定一条样本");
    const cost = costs[0] as Record<string, unknown>;
    assert.equal(cost["signature"], "bash", "签名是面名，不是命令");
    assert.equal(typeof cost["judgeMs"], "number");
    assert.equal(cost["judgeLength"], "rm -rf /".length);
    assert.ok(!JSON.stringify(cost).includes("rm -rf /"), "命令原文不出域");
    passes.length = 0;
    ctx.value = { ...ctx.value, judgeStats: false };
    ctx.guardInstalled!.fn(bashExec);
    assert.equal(
      passes.filter((item) => (item as Record<string, unknown>)["category"] === "judge-cost")
        .length,
      0,
      "关掉采集就一条都不出域（拦截本身不受影响）",
    );
    assert.equal(typeof ctx.guardInstalled!.fn(bashExec), "string", "关掉采集不改拦截结论");
  });

  it("判定放行时发一条 dangerous-bash 的 pass（armed 卡拿「被遵守」的唯一来源）", () => {
    // 没有这条 pass，`dangerous-bash` 那张 armed 卡的 suppressed 恒为 0、复发率分母为零，
    // 衰减裁决只能停在「不可判定」，而注入面照旧把「被遵守 0 次」说给模型听。
    const passes: unknown[] = [];
    const ctx = createMockCtx({
      report: () => ({}),
      pass: (input) => {
        passes.push(input);
        return {};
      },
    });
    // 只读档：执行器自报在拦、策略解得 read-only —— 这一档里 `devServer` 判放行。
    ctx.extraServices["shell"] = { sandboxMode: "read-only" };
    ctx.extraServices["sandboxPolicy"] = { resolve: () => ({ mode: "read-only" }) };
    applyPlugin(ctx);
    const verdict = ctx.guardInstalled!.fn({
      name: "bash",
      arguments: { command: "vite" },
      agent: { session: { id: "s-1", header: { cwd: FIXTURE_ROOT } } },
    });
    assert.equal(verdict, undefined, "这一档本该放行（否则测的不是放行支）");
    const rulePasses = passes.filter(
      (item) => (item as Record<string, unknown>)["category"] === BASH_DENIAL_CATEGORY,
    );
    assert.equal(rulePasses.length, 1, "一次放行判定发一条规则 pass");
    const payload = rulePasses[0] as Record<string, unknown>;
    assert.equal(payload["signature"], "vite", "签名是命令原文（与 deny 那条同口径）");
  });

  it("判定为 deny 时不发 dangerous-bash 的 pass", () => {
    const passes: unknown[] = [];
    const ctx = createMockCtx({
      report: () => ({}),
      pass: (input) => {
        passes.push(input);
        return {};
      },
    });
    // 缺省档位（读不到沙箱模式 ⇒ unknown 保守列）：`rm -rf /` 判 deny。
    applyPlugin(ctx);
    assert.equal(typeof ctx.guardInstalled!.fn(bashExec), "string", "deny 支应当拦下");
    assert.equal(
      passes.filter(
        (item) => (item as Record<string, unknown>)["category"] === BASH_DENIAL_CATEGORY,
      ).length,
      0,
      "被拦下的命令不得上报「被遵守」",
    );
  });
});

// ── 会话当前工作目录（宿主 0.2.1-alpha.2：`ctx.workingDirectory`）─────────────────
/** 「创建期目录 / 当前目录」成对夹具：
 *  - `stale`：会话创建时的目录——`SessionHeader.cwd` 从 alpha.2 起一直报它，里面是空的；
 *  - `live` ：`cd` 之后的当前目录，其中一条 `ssh` 软链把凭据树（`real/.ssh`）接出来。
 *  相对目标 `ssh/authorized_keys` 在两枚基准下落到不同绝对路径，于是**同一枚调用**就能分辨
 *  判据吃的是哪一枚目录：只读 header.cwd 的旧口径在 live 下判不到那棵树，是真实漏拦
 *  （宿主 bash 已改读服务，tool-bash src/index.ts:487）。 */
async function makeCwdPair(): Promise<{ root: string; stale: string; live: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dgc-workdir-"));
  const stale = path.join(root, "stale");
  const live = path.join(root, "live");
  const ssh = path.join(root, "real", ".ssh");
  await mkdir(stale, { recursive: true });
  await mkdir(live, { recursive: true });
  await mkdir(ssh, { recursive: true });
  // Windows 上目录符号链接需要开发者模式/管理员权限；junction 不需要。
  await symlink(ssh, path.join(live, "ssh"), process.platform === "win32" ? "junction" : "dir");
  return { root, stale, live };
}

/** 相对形态的编辑调用：会话只交出**创建期**目录，当前目录只能从服务读。 */
const relEditExec = (id: string, stale: string): GuardExecParam => ({
  name: "edit",
  arguments: { file_path: "ssh/authorized_keys", new_string: "x\n" },
  agent: { session: { id, header: { cwd: stale }, snapshotEvents: () => [] } },
});

describe("会话当前工作目录：判据跟到 cd 之后（ctx.workingDirectory）", () => {
  it("密钥面吃当前目录：服务在位时软链出的凭据树露形，旧口径同一枚调用判不到", async () => {
    const { root, stale, live } = await makeCwdPair();
    try {
      // 事实门关掉：本组这几条只看密钥面，别让配额轮次掺进结论。
      const legacy = createMockCtx({}, { factGateEnabled: false });
      applyPlugin(legacy);
      assert.equal(
        legacy.guardInstalled!.fn(relEditExec("wd-legacy", stale)),
        undefined,
        "创建期目录里没有凭据——这就是升级前那枚读法的漏拦面",
      );
      const ctx = createMockCtx({}, { factGateEnabled: false });
      ctx.workingDirectory = { get: () => live };
      applyPlugin(ctx);
      assert.match(
        ctx.guardInstalled!.fn(relEditExec("wd-live", stale)) ?? "",
        /密钥|凭据/u,
        "live/ssh 经 realpath 落到 .ssh 树内：与宿主 bash 用的是同一枚目录",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("服务缺席 ⇒ 退回创建期目录：没装 working-directory bundle 的宿主照判", async () => {
    const { root, live } = await makeCwdPair();
    try {
      const ctx = createMockCtx({}, { factGateEnabled: false });
      applyPlugin(ctx);
      assert.match(
        ctx.guardInstalled!.fn(relEditExec("wd-header", live)) ?? "",
        /密钥|凭据/u,
        "可选读面缺失只是少跟一次 cd，不是判据下线",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("服务交出坏形状一律退回创建期目录且不抛错：空串 / 非字符串 / 没有 get / get 不是函数", async () => {
    const { root, live } = await makeCwdPair();
    const shapes: [string, unknown][] = [
      ["空串", { get: () => "" }],
      ["非字符串", { get: () => 42 }],
      ["没有 get 成员", {}],
      ["get 不是函数", { get: "nope" }],
    ];
    try {
      for (const [index, [label, shape]] of shapes.entries()) {
        const ctx = createMockCtx({}, { factGateEnabled: false });
        ctx.workingDirectory = shape;
        applyPlugin(ctx);
        assert.match(
          ctx.guardInstalled!.fn(relEditExec(`wd-dirty-${index}`, live)) ?? "",
          /密钥|凭据/u,
          `服务交出${label}时退回 header.cwd，判据不跟着一起消失`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("会话不可得 ⇒ 不读服务也不炸：绝对路径的凭据形照判，相对 read 照常记账", () => {
    const ctx = createMockCtx({}, { factGateEnabled: false });
    ctx.workingDirectory = { get: () => LIVE_ROOT };
    applyPlugin(ctx);
    assert.match(
      ctx.guardInstalled!.fn({
        name: "edit",
        // 声明形自己就带 .ssh：解析缺席也照拦（与「软链不再是出路」那组同一口径）。
        arguments: { file_path: path.join(LIVE_ROOT, "real", ".ssh", "id_rsa") },
      }) ?? "",
      /密钥|凭据/u,
    );
    assert.equal(
      ctx.guardInstalled!.fn({ name: "read", arguments: { file_path: "a.ts" } }),
      undefined,
      "没有会话就没有目录基准，按 resolveTarget 的无 cwd 口径走，不抛错",
    );
  });

  it("事实门吃当前目录：cd 后读过的绝对路径与相对目标同键即放行，旧口径对不上键 ⇒ 照拒", async () => {
    const { root, stale, live } = await makeCwdPair();
    try {
      const src = path.join(live, "src");
      const file = path.join(src, "a.ts");
      await mkdir(src, { recursive: true });
      await writeFile(file, SIMPLE_TS_SOURCE);
      await utimes(file, 1_000_000_000, 1_000_000_000);
      const log: SessionEvent[] = [
        fxCall("r1", "read", JSON.stringify({ file_path: file })),
        fxResult("r1"),
        fxCall("g1", "grep", JSON.stringify({ path: src, pattern: "a.ts" })),
        fxResult("g1"),
      ];
      // 取证记的是**绝对**当前目录下的文件，编辑调用报的是**相对**形态——
      // 两侧必须落进同一枚键，否则模型照做也过不了门（多要一次无意义的重读）。
      const exec = (id: string): GuardExecParam => ({
        name: "edit",
        arguments: { file_path: "src/a.ts", new_string: "export const a = 2;\n" },
        agent: { session: { id, header: { cwd: stale }, snapshotEvents: () => log } },
      });
      const ctx = createMockCtx();
      ctx.workingDirectory = { get: () => live };
      applyPlugin(ctx);
      assert.equal(ctx.guardInstalled!.fn(exec("wd-fact")), undefined, "同一枚目录 ⇒ 取证成立");
      const legacy = createMockCtx();
      applyPlugin(legacy);
      assert.notEqual(
        legacy.guardInstalled!.fn(exec("wd-fact-legacy")),
        undefined,
        "旧口径把目标归一到创建期目录的另一条路径上 ⇒ 事实门仍要取证",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("事实门配额状态按归一化目标隔离：cd 后同名相对路径不得复用上一项目的放行", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dgc-factkey-"));
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    try {
      const firstSrc = path.join(first, "src");
      const secondSrc = path.join(second, "src");
      await mkdir(firstSrc, { recursive: true });
      await mkdir(secondSrc, { recursive: true });
      const firstFile = path.join(firstSrc, "a.ts");
      const secondFile = path.join(secondSrc, "a.ts");
      await writeFile(firstFile, SIMPLE_TS_SOURCE);
      await writeFile(secondFile, SIMPLE_TS_SOURCE);
      const log: SessionEvent[] = [
        fxCall("r1", "read", JSON.stringify({ file_path: firstFile })),
        fxResult("r1"),
      ];
      let cwd = first;
      const ctx = createMockCtx({}, { maxDenies: 1 });
      ctx.workingDirectory = { get: () => cwd };
      applyPlugin(ctx);
      const edit = (): GuardExecParam => ({
        name: "edit",
        arguments: { file_path: "src/a.ts" },
        agent: { session: { id: "s-fact-key", header: { cwd: first }, snapshotEvents: () => log } },
      });
      assert.equal(typeof ctx.guardInstalled!.fn(edit()), "string", "项目一：首拒");
      assert.equal(ctx.guardInstalled!.fn(edit()), undefined, "项目一：熬满配额放行");
      cwd = second;
      assert.equal(
        typeof ctx.guardInstalled!.fn(edit()),
        "string",
        "项目二同名相对路径必须重新取证，不能复用项目一的配额",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("上报载荷的 cwd 跟到当前目录；服务缺席时退回创建期目录", () => {
    const reports: ReportPayload[] = [];
    const passes: Record<string, unknown>[] = [];
    const ctx = createMockCtx({
      report: (input) => {
        reports.push(input as ReportPayload);
        return {};
      },
      pass: (input) => {
        passes.push(input as Record<string, unknown>);
        return {};
      },
    });
    ctx.workingDirectory = { get: () => LIVE_ROOT };
    applyPlugin(ctx);
    assert.equal(typeof ctx.guardInstalled!.fn(bashExec), "string", "bash 危险命令照拦");
    assert.equal(reports[0]?.cwd, LIVE_ROOT, "deny 上报的归因目录是当前目录");
    ctx.value = { ...ctx.value, judgeStats: true };
    ctx.guardInstalled!.fn(bashExec);
    assert.equal(passes[0]?.["cwd"], LIVE_ROOT, "pass 载荷同口径（不是第二份读法）");
    const legacyReports: ReportPayload[] = [];
    const legacy = createMockCtx({
      report: (input) => {
        legacyReports.push(input as ReportPayload);
        return {};
      },
    });
    applyPlugin(legacy);
    legacy.guardInstalled!.fn(bashExec);
    assert.equal(legacyReports[0]?.cwd, FIXTURE_ROOT, "服务缺席 ⇒ 上报退回 header.cwd");
  });
});

describe("检索工具的在位探测：指令只点这台宿主上注册着的那几枚", () => {
  // 默认名单里 grep/glob 出自宿主 stock 目录，而 zg_search（连它的 root/query/fts/vector 参数面）
  // 出自**另一枚插件**（本仓同级包 @jayyuen66/dsh-zvec-grep）——装不装逐台不同。没装还点名它，
  // 就是"指令不可照做"：模型照着烧一次调用，然后被同一个缺项再拒一次。
  it("stock 名字（grep/glob）免探一律点；插件工具按探测结果点", () => {
    const ctx = createMockCtx();
    ctx.tools.get = (name: string): unknown => (name === "grep" ? {} : undefined);
    applyPlugin(ctx);
    const message = ctx.guardInstalled!.fn(editWithoutEvidence("s-present"));
    assert.equal(typeof message, "string");
    assert.match(message!, /grep/u, "stock 名字照点");
    // 实测缺陷回归：program 模式下探测面看不见原生工具，早前这下会把 glob 一并摘掉 ⇒
    // 引用证据只剩 zg_search。stock 名字随宿主出厂，探测不到不等于不存在。
    assert.match(message!, /glob/u, "stock 名字免探，探不到也不该把门关上");
    assert.doesNotMatch(message!, /zg_search/u, "插件工具没注册就不点（探测口存在的意义）");
  });

  it("探测抛错 ⇒ 一律算「在」：宁可多点名一个名字，也不把模型要走的门关上", () => {
    const ctx = createMockCtx();
    ctx.tools.get = (): never => {
      throw new Error("宿主这枚成员在别的版本上没有");
    };
    applyPlugin(ctx);
    const message = ctx.guardInstalled!.fn(editWithoutEvidence("s-throw"));
    assert.equal(typeof message, "string", "探测失败不许影响判定，更不许抛进 guard 热路径");
    assert.match(message!, /grep|glob/u, "退化成不筛 ⇒ 名单原样给模型");
  });

  it("tools 面根本没有 get（老宿主/别的实现）⇒ 同样退化成不筛", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const message = ctx.guardInstalled!.fn(editWithoutEvidence("s-noget"));
    assert.match(message!, /grep/u, "探不到就不筛，判定面一条不减");
  });
});

// ── 爆炸半径预演：宿主侧那一趟（`ctx.shell` 的读法与接线）──────────────────────
//
// 量证据那一半的判据与渲染在 `lib/blast-radius.ts`（那边的专测逐条钉上限、渲染与失败面）；
// 这一组钉的是**宿主侧**：读哪个服务、跑的是哪条命令、`deny` 档不跑、缺席时不静默换命令。
/** 一台"记下入参、答给定输出"的假执行器（提到模块层：它不捕获任何外层变量，
 *  放 describe 体内每轮重建 —— lint 的 consistent-function-scoping 盯这个）。 */
const shellSpyOf = (text: string): { specs: unknown[]; shell: Record<string, unknown> } => {
  const specs: unknown[] = [];
  return {
    specs,
    shell: {
      resolve: (request: unknown) => request,
      execute: (spec: unknown) => {
        specs.push(spec);
        return Promise.resolve({
          result: () =>
            Promise.resolve({ exitCode: 0, timedOut: false, aborted: false, stdout: { text } }),
        });
      },
    },
  };
};

/** 装一台带假执行器的 spine（`extraServices` 是 mock 的可选服务面）。 */
const bootWithShell = (text: string): { ctx: MockCtx; specs: unknown[] } => {
  const { ctx } = reportSpy();
  const { specs, shell } = shellSpyOf(text);
  ctx.extraServices = { shell };
  applyPlugin(ctx);
  return { ctx, specs };
};

describe("ask 档的爆炸半径预演：宿主侧读法与接线", () => {
  /** 一次 `git reset --hard` 的 `ask` 命中（带 signal：真宿主必带，预演靠它取消）。 */
  const resetExec = {
    name: "bash",
    arguments: { command: "git reset --hard" },
    signal: new AbortController().signal,
    agent: { session: { id: "s-1", header: { cwd: FIXTURE_ROOT }, snapshotEvents: () => [] } },
  };

  it("`ask` 档会跑表里那条只读预演，结果接进 `reason` 与 `displayReason`", async () => {
    const { ctx, specs } = bootWithShell(" M src/a.ts\n?? scratch.txt");
    const decision = askArmOf(await runPreExecute(ctx, resetExec));
    assert.equal((specs[0] as { command?: unknown }).command, BLAST_COMMANDS.gitResetHard);
    assert.match(decision.reason ?? "", /scratch\.txt/u, "清单进了模型侧的理由");
    assert.match(
      decision.displayReason?.["zh"] ?? "",
      /scratch\.txt/u,
      "也进了弹窗那一面 —— 只接 reason 的话用户看不到证据",
    );
  });

  it("执行面没带 signal ⇒ 只留墙钟上限，预演照跑（可选位缺席不许变成异常）", async () => {
    const { ctx, specs } = bootWithShell(" M src/a.ts\n?? scratch.txt");
    // 官方 `ToolExecution` 把 `signal` 标成必填，但本包一律按形状收；这里送一枚缺席的，
    // 钉住"少一位可选读数"只退化成"只有墙钟上限"，而不是让 `AbortSignal.any` 拿到 undefined 抛错。
    const decision = askArmOf(await runPreExecute(ctx, { ...resetExec, signal: undefined }));
    assert.equal((specs[0] as { command?: unknown }).command, BLAST_COMMANDS.gitResetHard);
    assert.match(decision.reason ?? "", /scratch\.txt/u, "预演照跑，证据照给");
  });

  it("执行器缺席 ⇒ **盲问**：审批照旧问，只是没有证据（不静默换一条命令）", async () => {
    const { ctx } = reportSpy();
    applyPlugin(ctx);
    const decision = askArmOf(await runPreExecute(ctx, resetExec));
    // 没有预演时理由 = 基础文案 + 档位说明；预演那一块不出现。
    assert.equal(decision.reason, `${MESSAGES.zh.gitResetHard}\n${MESSAGES.zh.noteUnknown}`);
    assert.doesNotMatch(decision.reason ?? "", /\[预演\]/u);
  });

  it("`deny` 档**不跑预演**（结论已定，白烧一枚子进程没有意义）", async () => {
    const { ctx, specs } = bootWithShell("x");
    const denied = ctx.guardInstalled!.fn({
      name: "bash",
      arguments: { command: "rm -rf /" },
      agent: { session: { id: "s-1", header: { cwd: FIXTURE_ROOT }, snapshotEvents: () => [] } },
    });
    assert.ok(denied !== undefined, "deny 档照旧硬拒");
    assert.equal(specs.length, 0, "deny 档一枚子进程都不该起");
  });

  it("没有预演命令的键（如基础设施族）⇒ 不跑，盲问", async () => {
    const { ctx, specs } = bootWithShell("x");
    const exec = {
      name: "bash",
      arguments: { command: "terraform destroy" },
      signal: new AbortController().signal,
      agent: { session: { id: "s-1", header: { cwd: FIXTURE_ROOT }, snapshotEvents: () => [] } },
    };
    const decision = askArmOf(await runPreExecute(ctx, exec));
    assert.equal(specs.length, 0, "表里没有它的预演命令");
    assert.equal(decision.reason, `${MESSAGES.zh.tfDestroy}\n${MESSAGES.zh.noteUnknown}`);
  });

  it("预演交回的清单**为空**时只报告探针没输出，不冒充安全结论", async () => {
    const { ctx } = bootWithShell("");
    const decision = askArmOf(await runPreExecute(ctx, resetExec));
    assert.match(decision.reason ?? "", /没有任何输出/u);
    assert.match(decision.reason ?? "", /不能证明/u);
    assert.doesNotMatch(decision.reason ?? "", /此刻不会改动任何东西/u);
  });
});
