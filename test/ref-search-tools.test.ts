// host.ts：引用取证「可计入的检索工具」名单 + 判据口径改为设置项的运行路径接线测试。
//
// 背景：门禁的取证记账原先把工具名写死成 grep/glob/zg_search（zg_search 是**另一包**
//   zvec-grep 注册的工具名），第三方提供的检索工具（rg_search / semgrep_scan…）无论怎么
//   搜都不被计入 → 门禁持续以"没检索过"拒绝，拒绝理由与模型可执行的路径彻底脱节。
//   这不是硬依赖（没装 zvec-grep 时那条分支只是永不命中），真正的缺陷是**排他**。
//
// 为什么单独一个文件、且必须经 guard 断言（同 test/host-tier-settings.test.ts 的理由）：
//   applyToolCall/applySearchCall 是模块私有函数，外部唯一可达路径就是 tools.guard 的返回值。
//   tsc 能证明名单"被读了"，证明不了"读了会改变行为"。
//
// 断言设计原则（可判定性）：
//   1) 同一份取证证据 + 只改一个设置值 → 门禁结果必须翻转；
//   2) 拒绝文案点名的工具名必须与生效名单一致（新名字出现、被移除的名字不出现）；
//   3) 默认名单下逐条复现修复前的判定（含 zg_search 的严格相对路径口径）。
import { describe, it, afterAll, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin, { BUILTIN_BASE } from "../host.ts";
import type { Config } from "../host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
// 口径面（名单 → 判据映射）单源在 lib/ref-search-policy.ts。
import {
  DEFAULT_REF_SEARCH_STRICT_TOOLS,
  DEFAULT_REF_SEARCH_TOOLS,
  refSearchPolicyOf,
} from "../lib/ref-search-policy.ts";
import type { RefSearchPolicy } from "../lib/ref-search-policy.ts";
// 会话日志出自官方 SessionEvent 夹具构造器（信封必填位与 ToolCallId/MessageId/SessionSeq
// 品牌都在夹具里补一次）；fx 前缀避开与 makeEvents() 交出的局部 `call` 遮蔽。
import { call as fxCall, result as fxResult } from "./fixtures/events.ts";
// 事件类型与生产面（host.ts）同源：官方判别联合由 shared 具名 re-export。
import type { SessionEvent } from "@jayyuen666/dsh-plugin-shared/lib/tool-events";

// ── 轻量宿主替身（同 test/host-tier-settings.test.ts 契约）────────────────────
interface MockCtx {
  tools: {
    guard: (fn: (exec: Record<string, unknown>) => string | undefined) => () => void;
  };
  /** 0.1.7 的 settings 面：拦截半只调 describe()（locale 偏好读面）。 */
  settings: {
    describe: () => { ns: string; value: unknown; revision: number }[];
  };
  /** cordis 可选服务读法：只给设置条目挂出的值面读数口。 */
  get: (name: string) => unknown;
  guardInstalled: { fn: (exec: Record<string, unknown>) => string | undefined } | null;
  effects: (() => void)[];
  effect: (fn: () => (() => void) | undefined) => void;
  value: Config;
}

function createMockCtx(): MockCtx {
  const ctx: MockCtx = {
    guardInstalled: null,
    effects: [],
    // 内置默认底座（名单默认值 = lib/ref-search-policy.ts 单源常量），用例再逐项覆写名单。
    value: { ...BUILTIN_BASE },
    tools: {
      guard(fn) {
        ctx.guardInstalled = { fn };
        return () => {
          ctx.guardInstalled = null;
        };
      },
    },
    settings: {
      // 本文件的用例都测中文（默认语言），故 locale 条目一律"不在组合里"→ 无描述符。
      describe: () => [],
    },
    get: (name: string): unknown =>
      name === SETTINGS_READER ? { read: (): Config => ctx.value } : undefined,
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") {
        ctx.effects.push(disposer);
      }
    },
  };
  return ctx;
}

const applyPlugin = (ctx: MockCtx): void => {
  plugin.apply(ctx as never);
};

/**
 * 把值面写成**不合 Config 型**的形状（0.1.7 里 schema 会先拒这些值，所以正常通道写不进来；
 *  这里要证的仍是"运行路径自己收敛"）。经 Object.assign 走 unknown 通道：用例照旧断言，
 *  但不靠 `as never` 把 Config 的类型关掉。
 */
function poke(config: Config, field: keyof Config, dirty: unknown): void {
  Object.assign(config, { [field]: dirty });
}

// ── 临时真实目录（projectRootOf 认 package.json；不建 test/docs 层）────────────
// 两位路径都由下面 `beforeAll` 落地：模块级的"赋值式初始化"（`let x = ""`）正是
// `require-hook` 判的 setup 形态，不带初始化的声明才是在说「值只从钩子来」。
let root: string;
let target: string;

/** 目标文件名：既是落地的源文件名，也是各检索日志里指向它的 pattern/query。
 *  字面量散在十条用例里改一处就漏（`no-duplicate-string` 点的就是这种漂移面）。 */
const TARGET_BASENAME = "policy-mod.ts";

/** 一次 edit 调用：会话带 cwd（相对路径与"目标相对路径"判据都要它才成立）。 */
const fire = (
  ctx: MockCtx,
  sessionId: string,
  log: readonly SessionEvent[],
  args: Record<string, unknown> = {},
  file: string = target,
): string | undefined =>
  ctx.guardInstalled!.fn({
    name: "edit",
    arguments: { file_path: file, ...args },
    agent: { session: { id: sessionId, header: { cwd: root }, snapshotEvents: () => log } },
  });

/** 事件构造器：callId 串联 tool/call → tool/result（缺 result 不算证据）。
 *  形状出自官方夹具，本器只管 danger-guard 要的 callId 配对；arguments 官方是模型
 *  产出的原始 JSON 串，故统一 stringify。 */
function makeEvents(): {
  call: (name: string, args: Record<string, unknown>) => SessionEvent;
  ok: () => SessionEvent;
} {
  let seq = 0;
  return {
    call(name, args) {
      const callId = `c${seq}`;
      seq += 1;
      return fxCall(callId, name, JSON.stringify(args));
    },
    ok() {
      return fxResult(`c${seq - 1}`);
    },
  };
}

/** 只有成功 read 的日志：mid 档必缺引用探查 → 用来观察"什么动作才计入引用取证"。 */
function readLog(file: string = target): SessionEvent[] {
  const { call, ok } = makeEvents();
  return [call("read", { file_path: file }), ok()];
}

/** read + 一次成功检索的日志（同一 makeEvents 实例，callId 不撞车）。 */
function searchLog(tool: string, args: Record<string, unknown>): SessionEvent[] {
  const { call, ok } = makeEvents();
  return [call("read", { file_path: target }), ok(), call(tool, args), ok()];
}

/** mid 档改动：>small(200) 且 <big(2000)、不含签名关键字 → 要求 read + 引用探查。 */
const MID_ARGS = {
  old_string: "const value = 1\n".repeat(20),
  new_string: "const value = 2\n".repeat(20),
};
/** low 档改动：≤small(200) 且不触签名 → 只要 read（用于隔离"空名单只关引用面"）。 */
const SMALL_ARGS = { old_string: "const value = 1", new_string: "const value = 2" };

describe("引用取证的可计入检索工具名单与判据口径", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dg-refsearch-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), "{}");
    target = path.join(root, "src", TARGET_BASENAME);
    await writeFile(target, "const value = 1\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => null);
  });

  describe("默认名单逐条复现修复前的判定", () => {
    it("bUILTIN_BASE 的默认名单=内置单源常量（防三处漂移）", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      // 0.1.7 没有 register 的 base：底座就是拦截半读不到设置值面时回落的 BUILTIN_BASE，
      // 它与 ConfigSchema 的 .default(...) 同源（lib/settings-schema.ts）。
      assert.deepEqual(BUILTIN_BASE.refSearchTools, [...DEFAULT_REF_SEARCH_TOOLS]);
      assert.deepEqual(BUILTIN_BASE.refSearchStrictTools, [...DEFAULT_REF_SEARCH_STRICT_TOOLS]);
      assert.deepEqual([...DEFAULT_REF_SEARCH_TOOLS], ["grep", "glob", "zg_search"], "今天的集合");
      assert.deepEqual([...DEFAULT_REF_SEARCH_STRICT_TOOLS], ["zg_search"], "今天的严格分支");
    });

    it("grep 与 glob 的项目级检索各计入一次引用取证（pattern/include 口径）", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      for (const tool of ["grep", "glob"]) {
        const log = searchLog(tool, { path: root, pattern: TARGET_BASENAME });
        assert.equal(
          fire(ctx, `default-${tool}`, log, MID_ARGS),
          undefined,
          `${tool} 仍计入引用取证`,
        );
      }
    });

    it("zg_search 仍走严格口径：query/fts/vector + root 作用域，取错字段或无关词都不算", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      const byName = searchLog("zg_search", { query: [TARGET_BASENAME], root });
      assert.equal(
        fire(ctx, "default-zg-hit", byName, MID_ARGS),
        undefined,
        "query 数组含文件名即计入",
      );
      const byRelative = searchLog("zg_search", { fts: "src/policy-mod.ts", root });
      assert.equal(
        fire(ctx, "default-zg-rel", byRelative, MID_ARGS),
        undefined,
        "query 含目标相对路径片段同样计入",
      );
      const unrelated = searchLog("zg_search", { query: "unrelated", root });
      assert.ok(
        fire(ctx, "default-zg-miss", unrelated, MID_ARGS) !== undefined,
        "无关词不得顶包（修复前防 index.ts 撞名的判据不能丢）",
      );
      const patternOnly = searchLog("zg_search", { root, pattern: TARGET_BASENAME });
      assert.ok(
        fire(ctx, "default-zg-pattern-blind", patternOnly, MID_ARGS) !== undefined,
        "严格口径不读 pattern/include：签名取错字段就不算取证",
      );
    });

    it("名单之外的第三方检索工具（rg_search）今天不计入 → 仍拒（这就是要修的排他面）", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      const log = searchLog("rg_search", { path: root, pattern: TARGET_BASENAME });
      assert.ok(fire(ctx, "default-rg", log, MID_ARGS) !== undefined);
    });
  });

  describe("加入第三方检索工具名后它真的可计入取证", () => {
    it("refSearchTools 增列 rg_search：同一份证据从拒翻转为放行", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      const log = searchLog("rg_search", { path: root, pattern: TARGET_BASENAME });
      assert.ok(fire(ctx, "rg-before", log, MID_ARGS) !== undefined, "默认名单下不认");
      ctx.value.refSearchTools = ["grep", "glob", "rg_search"];
      assert.equal(
        fire(ctx, "rg-after", log, MID_ARGS),
        undefined,
        "列入名单后 pattern/path 口径即生效",
      );
    });

    it("拒绝文案与实际认的工具一致：新名字出现、被移除的名字不再出现", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      ctx.value.refSearchTools = ["grep", "rg_search"];
      ctx.value.refSearchStrictTools = [];
      const denied = fire(ctx, "text-sync", readLog(), MID_ARGS);
      assert.ok(denied !== undefined);
      assert.match(denied, /rg_search/u, "指令点名刚配置的第三方工具");
      assert.match(denied, /grep/u);
      assert.doesNotMatch(denied, /glob|zg_search/u, "已从名单移除的名字不得再出现在指令里");
      assert.match(denied, /path 指向/u, "pattern 口径 → 告诉模型起点参数是 path");
    });

    it("口径按工具名映射：同一工具声明为严格口径后 root/query 才算、pattern/path 不算", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      ctx.value.refSearchTools = ["rg_search"];
      ctx.value.refSearchStrictTools = ["rg_search"];
      const byPattern = searchLog("rg_search", { path: root, pattern: TARGET_BASENAME });
      assert.ok(
        fire(ctx, "strict-pattern-blind", byPattern, MID_ARGS) !== undefined,
        "声明为严格口径后不再读 pattern/include",
      );
      const byQuery = searchLog("rg_search", { query: TARGET_BASENAME, root });
      assert.equal(
        fire(ctx, "strict-query-hit", byQuery, MID_ARGS),
        undefined,
        "root + query 命中文件名 → 计入（严格口径随工具名走，不是 zg_search 专属分支）",
      );
    });

    it("写/读类工具名混进检索名单也不夺走 read 证据（读/写分组优先）", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      ctx.value.refSearchTools = ["read"];
      assert.equal(
        fire(ctx, "read-precedence", readLog(), SMALL_ARGS),
        undefined,
        "read 仍按读证据记账：low 档只需 read 即放行",
      );
    });

    it("运行时值不合型（值面绕过 schema 被写坏）→ 回落内置默认名单，既不静默收紧也不静默免检", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      poke(ctx.value, "refSearchTools", "grep");
      poke(ctx.value, "refSearchStrictTools", { nope: true });
      const log = searchLog("glob", { path: root, pattern: TARGET_BASENAME });
      assert.equal(
        fire(ctx, "degraded", log, MID_ARGS),
        undefined,
        "非数组值按未配置处理 → 默认名单仍认 glob",
      );
    });
  });

  describe("名单为空数组时的保守口径", () => {
    // 选择的口径：**显式空数组 = 任何检索都不计入引用取证**（与"字段未配置/值非法"回落默认
    // 严格区分）。理由：本包是安全拦截插件，引用取证面只能收紧不能放宽——把空数组当"未设置"
    // 去回落默认，等于让一次笔误的清空悄悄变回全量凭证；按空处理最坏只多拒几轮，且拒绝理由
    // 直说"名单为空"，模型与管理员都看得见该往哪儿补（maxDenies 配额仍是防死锁出口）。
    it("显式空名单：任何检索都不计入引用取证，且指令说明名单为空", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      ctx.value.refSearchTools = [];
      const grepLog = searchLog("grep", { path: root, pattern: TARGET_BASENAME });
      const denied = fire(ctx, "empty-list", grepLog, MID_ARGS);
      assert.ok(denied !== undefined, "空名单下 grep 不再成为凭证");
      assert.match(denied, /refSearchTools/u, "指令说明是名单为空（可行动的修复路径）");
      assert.match(denied, /已确认：read/u, "read 侧判定不受影响：只缺引用一项");
    });

    it("空名单只关引用面：low 档（只要 read）照常放行", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      ctx.value.refSearchTools = [];
      assert.equal(
        fire(ctx, "empty-low", readLog(), SMALL_ARGS),
        undefined,
        "小改属 low 档，不要求引用探查",
      );
    });

    it("空名单 + 配额上限仍是防死锁出口（不会无限拒下去）", () => {
      const ctx = createMockCtx();
      applyPlugin(ctx);
      ctx.value.refSearchTools = [];
      ctx.value.maxDenies = 1;
      // 同一会话（拒绝计数按会话分片）：首拒 → 第 2 次达配额 → 放行 + 警告。
      assert.ok(fire(ctx, "empty-quota", readLog(), MID_ARGS) !== undefined, "首拒");
      assert.equal(
        fire(ctx, "empty-quota", readLog(), MID_ARGS),
        undefined,
        "达 maxDenies → 配额放行（警告由 host 打出）",
      );
    });
  });

  describe("refSearchPolicyOf 的形状契约（映射由名单派生）", () => {
    it("默认策略：两份口径名单与 criteria 映射同序同集", () => {
      const policy: RefSearchPolicy = refSearchPolicyOf(
        DEFAULT_REF_SEARCH_TOOLS,
        DEFAULT_REF_SEARCH_STRICT_TOOLS,
      );
      assert.deepEqual([...policy.patternTools], ["grep", "glob"]);
      assert.deepEqual([...policy.strictTools], ["zg_search"]);
      assert.equal(policy.criteria.get("grep"), "pattern");
      assert.equal(policy.criteria.get("zg_search"), "strict-relative");
      assert.equal(policy.criteria.get("rg_search"), undefined, "名单之外不给口径");
    });

    it("严格名单里的陌生名字不授予凭证（只有 refSearchTools 决定计不计入）", () => {
      const policy = refSearchPolicyOf(["grep"], ["grep", "semgrep_scan"]);
      assert.equal(policy.criteria.size, 1, "semgrep_scan 未列入 refSearchTools → 不给凭证");
      assert.equal(policy.criteria.get("semgrep_scan"), undefined);
      assert.deepEqual([...policy.strictTools], ["grep"], "同时在严格名单里 → 口径随之切换");
      assert.deepEqual([...policy.patternTools], []);
    });
  });
});
