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
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, utimes } from "node:fs/promises";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import plugin, { BUILTIN_BASE, noteJudgeCost } from "../host.ts";
import type { Config } from "../host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
import { MESSAGES } from "../lib/messages.ts";
// 会话日志出自官方 SessionEvent 夹具构造器（信封必填位与 ToolCallId/MessageId/SessionSeq
// 品牌都在夹具里补一次）；fx 前缀避开与本文件里 `const result = …` 之类局部量的遮蔽。
import { call as fxCall, result as fxResult } from "./fixtures/events.ts";
// 事件类型与生产面（host.ts）同源：官方判别联合由 shared 具名 re-export。
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";

/** locale 命名空间未注册（本文件的 mock 默认）→ 宿主按中文渲染拒绝理由，
 *  期望值即中文文案表的对应条目：断言看的是"回给模型的那句话"，与迁移前逐字相同。 */
const INDETERMINATE_MESSAGE = MESSAGES.zh.indeterminate;
const RMRF_MESSAGE = MESSAGES.zh.rmrf;
const NESTED_SHELL_UNDETERMINED_MESSAGE = MESSAGES.zh.nestedShellUnconfirmed;

/** 取证夹具的目标文件：五种 exec 形状（有/无事件流、有/无证据、零证据）都指向同一份路径，
 *  散着写字面量改一处就漏（断言的是夹具自己造的目标，不是生产面的常量）。 */
const EDIT_TARGET_PATH = "/w/proj/src/cfg.ts";

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
 *  `host.ts` 的 `reportDeny` 把它列成必填形参并原样带上（唯一一处 `bus.report` 调用），
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
  effects: (() => void)[];
  disposedHandlers: Map<string, ((session: { id?: unknown }) => void)[]>;
}

/** guard 谓词的执行参数类型（抽取 `extends (exec: infer Exec)` 的推断，改名避开 id-length）。 */
type GuardExecParam = GuardCall["fn"] extends (exec: infer Exec) => unknown ? Exec : never;

/** 有事件流（空日志）的 edit 调用（会话可判定取证 → 走正常配额/收敛路径）。 */
const editExecWithEvents = (id: string): GuardExecParam => ({
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id, header: { cwd: "/w/proj" }, snapshotEvents: () => [] } },
});

/** 无事件流的 edit 调用（证据不可判定 → 首拒给行动清单、重试走 indeterminate）。 */
const editExecNoEvents = (id: string): Record<string, unknown> => ({
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id, header: { cwd: "/w/proj" } } },
});

/** 取证齐备（read + 项目级 grep 均成功回填）的会话日志。 */
function evidenceLog(): SessionEvent[] {
  // 官方 tool/call.arguments 是模型产出的原始 JSON 串；callId 由 tool/result.message
  // .source.callId 串联（成败都在这枚配对键上）。
  return [
    fxCall("r1", "read", JSON.stringify({ file_path: EDIT_TARGET_PATH })),
    fxResult("r1"),
    fxCall("g1", "grep", JSON.stringify({ path: "/w/proj", pattern: "cfg.ts" })),
    fxResult("g1"),
  ];
}

/** 带完整取证证据的 edit 调用（放行路径）。 */
const editExecWithEvidence = (id: string): GuardExecParam => ({
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id, header: { cwd: "/w/proj" }, snapshotEvents: () => evidenceLog() } },
});

/** 零证据的 edit 调用（必拒路径）：降级用例用它数内置 maxDenies 的配额轮次。 */
const editWithoutEvidence = (id: string): GuardExecParam => ({
  name: "edit",
  arguments: { file_path: "/w/proj/src/fallback.ts" },
  agent: { session: { id, header: { cwd: "/w/proj" }, snapshotEvents: () => [] } },
});

const DEFAULT_CTX_VALUE: Config = { ...BUILTIN_BASE, enabled: true, factGateEnabled: true };

function createMockCtx(bus: LessonLoopSpy = {}, value?: Partial<Config>): MockCtx {
  const ctx: MockCtx = {
    guardInstalled: null,
    effects: [],
    disposedHandlers: new Map(),
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
    return name === "lessonLoop" ? ctx.bus : undefined;
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
  agent: { session: { id: "s-1", header: { cwd: "/w/proj" } } },
};

/** `-c` 体引号未闭合：lib 侧给不出危险结论、也给不出安全结论 → 需用户确认。 */
const bashUnconfirmedExec: GuardExecParam = {
  name: "bash",
  arguments: { command: 'bash -c "rm -rf /' },
  agent: { session: { id: "s-1", header: { cwd: "/w/proj" } } },
};

const editExec = {
  name: "edit",
  arguments: { file_path: EDIT_TARGET_PATH },
  agent: { session: { id: "s-1", header: { cwd: "/w/proj" } } },
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
    assert.equal(rep.cwd, "/w/proj");
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

describe("bash 闸的两种结论在总线侧必须可分辨（拦 vs 认不准）", () => {
  it("命中危险模式 → 签名 = 命令原文，needsUserConfirmation=false", () => {
    const { ctx, reports } = reportSpy();
    applyPlugin(ctx);
    assert.equal(ctx.guardInstalled!.fn(bashExec), RMRF_MESSAGE);
    assert.equal(reports.length, 1);
    const rep = reports[0] as ReportPayload;
    assert.equal(rep.category, BASH_DENIAL_CATEGORY);
    assert.equal(rep.signature, "rm -rf /");
    assert.equal(rep.evidence["needsUserConfirmation"], false);
  });

  it("`-c` 体未被检查 → 同一通道上报，签名用命令原文并标记需确认", () => {
    const { ctx, reports } = reportSpy();
    applyPlugin(ctx);
    // 守卫仍返回字符串（= 物理拒绝，模型不会静默跑到没检查过的命令）
    assert.equal(ctx.guardInstalled!.fn(bashUnconfirmedExec), NESTED_SHELL_UNDETERMINED_MESSAGE);
    assert.equal(reports.length, 1, "需确认同样进教训总线");
    const rep = reports[0] as ReportPayload;
    assert.equal(rep.source, "danger-guard");
    assert.equal(rep.category, BASH_DENIAL_CATEGORY);
    assert.equal(rep.sessionId, "s-1");
    // 签名用**命令原文**：类别级归并在 lesson-loop 侧（CATEGORY_SIGNATURES 的 dangerous-bash），
    // 原文因此落进 evidence.signature —— 卡片不再按套娃形态碎片化，人审也看得见是哪条命令。
    assert.equal(rep.signature, 'bash -c "rm -rf /');
    assert.equal(rep.detail, NESTED_SHELL_UNDETERMINED_MESSAGE);
    assert.equal(rep.evidence["tool"], "bash");
    assert.equal(rep.evidence["needsUserConfirmation"], true);
    assert.notEqual(rep.detail, RMRF_MESSAGE, "两种结论的文案不同源，模型可分辨");
  });
});

describe("session/disposed 释放 fact-gate 会话分片", () => {
  it("会话销毁后同 id 重建 → 从首拒重新开始（分片已清）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    // 会话 s-a 首次编辑被拒（记录 denials=1）
    const result = ctx.guardInstalled!.fn(editExecWithEvents("s-a"));
    assert.equal(typeof result, "string");
    // 触发 session/disposed（按事件名路由，只喂销毁监听器）
    emitDisposed(ctx, "s-a");
    // 同 id 重建：连续无证据拒绝应重新从 1 计数（而非直接配额放行）。
    // 契约：释放后第一次拒绝仍是普通拒绝（message 含「取证」），不是配额放行。
    const r2 = ctx.guardInstalled!.fn(editExecWithEvents("s-a"));
    assert.equal(typeof r2, "string");
    assert.doesNotMatch(r2!, /配额/u);
  });

  it("会话销毁不影响其它会话的分片（隔离性）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    // 会话 s-b 两次无证据拒绝
    ctx.guardInstalled!.fn(editExecWithEvents("s-b"));
    ctx.guardInstalled!.fn(editExecWithEvents("s-b"));
    // 销毁其它会话 s-x
    emitDisposed(ctx, "s-x");
    // s-b 第三次无证据拒绝 → 达配额放行（undefined；说明 s-b 分片仍计数到 3 > maxDenies=2）
    const res = ctx.guardInstalled!.fn(editExecWithEvents("s-b"));
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
      assert.notEqual(ctx.guardInstalled.fn(editWithoutEvidence("fb-1")), undefined, "无证据首拒");
      second = ctx.guardInstalled.fn(editWithoutEvidence("fb-1"));
      assert.equal(typeof second, "string", "内置 maxDenies=2 → 第二轮仍是拒绝（不是交互确认）");
      // 第 3 次达内置配额放行 ⇒ 读到的确实是内置 2，而不是用户写坏的 99
      assert.equal(
        ctx.guardInstalled.fn(editWithoutEvidence("fb-1")),
        undefined,
        "第三轮按内置 maxDenies=2 配额放行（99 那份坏值没进判定链）",
      );
    } finally {
      console.warn = original;
    }
    assert.ok(
      warns.some((line) => line.includes("内置默认底座")),
      `降级必须大声告警，实际收到：${JSON.stringify(warns)}`,
    );
    // 只响一次：守卫谓词每次工具调用都跑，刷屏会盖掉真正的拦截记录
    assert.equal(
      warns.filter((line) => line.includes("内置默认底座")).length,
      1,
      "回落告警一次性，不随调用刷屏",
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
    // 配额放行（第 3 次无证据拒绝）不报 pass——它不是"遵守规则"
    const other = "s-quota-nopass";
    ctx.guardInstalled!.fn(editExecWithEvents(other));
    ctx.guardInstalled!.fn(editExecWithEvents(other));
    assert.equal(ctx.guardInstalled!.fn(editExecWithEvents(other)), undefined, "达配额放行");
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
    ctx.get = () => ({});
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
      arguments: { file_path: "/w/proj/.ssh/id_rsa" },
      agent: { session: { id: "s-1", header: { cwd: "/w/proj" } } },
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
      const realDir = await realpath(dir);
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

  it("滚动摘要：攒满一窗才发一条，分档与最大值都在行里，发完清零", () => {
    const infos: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]): void => {
      infos.push(args.map(String).join(" "));
    };
    try {
      for (let i = 0; i < 199; i += 1) {
        noteJudgeCost({ face: "windowed", ms: i % 3, length: i * 10 });
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
  await symlink(ssh, path.join(live, "ssh"));
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
    ctx.workingDirectory = { get: () => "/w/live" };
    applyPlugin(ctx);
    assert.match(
      ctx.guardInstalled!.fn({
        name: "edit",
        // 声明形自己就带 .ssh：解析缺席也照拦（与「软链不再是出路」那组同一口径）。
        arguments: { file_path: "/w/live/real/.ssh/id_rsa" },
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
      await writeFile(file, "export const a = 1;\n");
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
    ctx.workingDirectory = { get: () => "/w/live" };
    applyPlugin(ctx);
    assert.equal(typeof ctx.guardInstalled!.fn(bashExec), "string", "bash 危险命令照拦");
    assert.equal(reports[0]?.cwd, "/w/live", "deny 上报的归因目录是当前目录");
    ctx.value = { ...ctx.value, judgeStats: true };
    ctx.guardInstalled!.fn(bashExec);
    assert.equal(passes[0]?.["cwd"], "/w/live", "pass 载荷同口径（不是第二份读法）");
    const legacyReports: ReportPayload[] = [];
    const legacy = createMockCtx({
      report: (input) => {
        legacyReports.push(input as ReportPayload);
        return {};
      },
    });
    applyPlugin(legacy);
    legacy.guardInstalled!.fn(bashExec);
    assert.equal(legacyReports[0]?.cwd, "/w/proj", "服务缺席 ⇒ 上报退回 header.cwd");
  });
});

describe("检索工具的在位探测：指令只点这台宿主上注册着的那几枚", () => {
  // 默认名单里 grep/glob 出自宿主 stock 目录，而 zg_search（连它的 root/query/fts/vector 参数面）
  // 出自**另一枚插件**（本仓同级包 @jayyuen66/dsh-zvec-grep）——装不装逐台不同。没装还点名它，
  // 就是"指令不可照做"：模型照着烧一次调用，然后被同一个缺项再拒一次。
  it("get 认得出的名字才进指令；认不出的一律不点", () => {
    const ctx = createMockCtx();
    ctx.tools.get = (name: string): unknown => (name === "grep" ? {} : undefined);
    applyPlugin(ctx);
    const message = ctx.guardInstalled!.fn(editWithoutEvidence("s-present"));
    assert.equal(typeof message, "string");
    assert.match(message!, /grep/u, "注册在位的照点");
    assert.doesNotMatch(message!, /glob|zg_search/u, "没注册的名字点了就是给模型一条走不通的路");
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
