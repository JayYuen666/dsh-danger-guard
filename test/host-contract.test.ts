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
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import plugin, { BUILTIN_BASE } from "../host.ts";
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
  };
  /** 0.1.7 settings 面：拦截半只调 describe()（locale 偏好）；configure 归设置条目。 */
  settings: {
    describe: () => { ns: string; value: unknown; revision: number }[];
  };
  /** 设置面读数（bulkhead 后由**设置条目**的读数口提供，见 get）。 */
  value: Config;
  /** cordis 的可选服务读法：SETTINGS_READER = 设置条目读数口，lessonLoop = 教训总线。 */
  get?: (name: string) => unknown;
  on?: (event: string, listener: (session: { id?: unknown }) => void) => () => void;
  effect: (fn: () => (() => void) | undefined) => void;
  bus: LessonLoopSpy;
  guardInstalled: GuardCall | null;
  effects: (() => void)[];
  disposedHandlers: ((session: { id?: unknown }) => void)[];
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
    disposedHandlers: [],
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
  // 一个 get 同时供两件事：设置读数口（bulkhead 的值面通道）与教训总线。
  ctx.get = (name: string): unknown => {
    if (name === SETTINGS_READER) {
      return { read: (): Config => ctx.value };
    }
    return name === "lessonLoop" ? ctx.bus : undefined;
  };
  ctx.on = (_event, listener) => {
    ctx.disposedHandlers.push(listener);
    return () => {
      const i = ctx.disposedHandlers.indexOf(listener);
      if (i !== -1) {
        ctx.disposedHandlers.splice(i, 1);
      }
    };
  };
  return ctx;
}

function applyPlugin(ctx: MockCtx): void {
  plugin.apply(ctx as never);
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

  it("pass 抛错 → fact-gate 拒绝/放行路径不受影响", () => {
    const ctx = createMockCtx({
      pass: () => {
        throw new Error("pass bus down");
      },
    });
    applyPlugin(ctx);
    // 有事件流（空日志）→ 证据可判定 → 走正常配额/收敛路径，不被 pass 抛错干扰。
    assert.doesNotThrow(() => {
      const first = ctx.guardInstalled!.fn(editExecWithEvents("s-pass"));
      assert.equal(typeof first, "string");
    });
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

  it("`-c` 体未被检查 → 同一通道上报，换成类别级稳定签名并标记需确认", () => {
    const { ctx, reports } = reportSpy();
    applyPlugin(ctx);
    // 守卫仍返回字符串（= 物理拒绝，模型不会静默跑到没检查过的命令）
    assert.equal(ctx.guardInstalled!.fn(bashUnconfirmedExec), NESTED_SHELL_UNDETERMINED_MESSAGE);
    assert.equal(reports.length, 1, "需确认同样进教训总线");
    const rep = reports[0] as ReportPayload;
    assert.equal(rep.source, "danger-guard");
    assert.equal(rep.category, BASH_DENIAL_CATEGORY);
    assert.equal(rep.sessionId, "s-1");
    // 命令原文当签名会把这条通用教训按套娃形态碎成无数张卡（每次输入都不重样）
    assert.equal(rep.signature, "bash-nested-shell-unconfirmed");
    assert.equal(rep.detail, NESTED_SHELL_UNDETERMINED_MESSAGE);
    assert.equal(rep.evidence["tool"], "bash");
    assert.equal(rep.evidence["needsUserConfirmation"], true);
    assert.notEqual(rep.detail, RMRF_MESSAGE, "两种结论的文案不同源，模型可分辨");
  });
});

describe("session/disposed 释放 fact-gate 会话分片（2026-09-18 接线）", () => {
  it("会话销毁后同 id 重建 → 从首拒重新开始（分片已清）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    // 会话 s-a 首次编辑被拒（记录 denials=1）
    const result = ctx.guardInstalled!.fn(editExecWithEvents("s-a"));
    assert.equal(typeof result, "string");
    // 触发 session/disposed
    for (const handler of ctx.disposedHandlers) {
      handler({ id: "s-a" });
    }
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
    for (const handler of ctx.disposedHandlers) {
      handler({ id: "s-x" });
    }
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
    for (const handler of ctx.disposedHandlers) {
      handler({ id: "s-d" });
    }
    const rebuilt = ctx.guardInstalled!.fn(editExecNoEvents("s-d"));
    assert.equal(typeof rebuilt, "string");
    assert.notEqual(rebuilt, INDETERMINATE_MESSAGE);
  });

  it("重复 dispose 同 id 幂等（不抛错）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    assert.doesNotThrow(() => {
      for (const handler of ctx.disposedHandlers) {
        handler({ id: "s-c" });
      }
      for (const handler of ctx.disposedHandlers) {
        handler({ id: "s-c" });
      }
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

describe("设置面故障时闸门必须 fail closed（2026-09-19 审计 / 2026-09-23 bulkhead 重做）", () => {
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
    assert.equal(passes.length, 1, "放行 = 规则被遵守 → pass 信号");
    const payload = passes[0] as { category: string; signature: string; sessionId: unknown };
    assert.equal(payload.category, "factgate-deny");
    assert.equal(payload.signature, "edit-before-factgate");
    assert.equal(payload.sessionId, id);
    assert.equal(reports.length, 1, "首拒上报一次 deny");
  });

  it("pass 抛错 → 放行路径不受影响；配额放行不报 pass", () => {
    const passes: unknown[] = [];
    const ctx = createMockCtx({
      report: () => ({}),
      pass: () => {
        passes.push("called");
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
    assert.equal(passes.length, 1, "确实走到了 pass 调用");
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
    assert.equal(passes.length, 1, "配额放行不追加 pass 信号");
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
    assert.equal(passes.length, 1, "确实走到了 pass 调用");
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
