// host.ts 三档分级 + 四个新设置字段的**运行路径**接线测试。
//
// 为什么单独一个文件、且必须经 guard 断言：
//   `tierOf` / `existingLayersOf` 是模块私有函数，外部唯一可达路径就是 tools.guard 的
//   返回值。tsc 能证明字段"被读了"，证明不了"读了会改变行为"——四个字段此前在
//   test/host.test.ts 里 0 处断言，正是"接线测试抓不到语义"的盲区（同一坑在
//   riskFactsOf 的 `'' 兜底` 上已被抓到过一次）。
//
// 断言设计原则（可判定性）：
//   同一份取证证据 + 只改一个设置值 → 门禁结果必须翻转。翻转即证明该值真的进了
//   tierOf/existingLayersOf，而不是被 Schema 收下后没人用。
//
// 为什么用临时真实目录：`existingLayersOf` 用 fs 探测层存在性，若目标是不存在的路径
//   （如 /w/proj/…，现有测试都用它）层集合恒空，"层要求"相关断言会退化成空断言。
import { describe, it, afterAll, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin, { BUILTIN_BASE } from "../host.ts";
import type { Config } from "../host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
import { DEFAULT_BIG_EDIT_CHARS, DEFAULT_SMALL_EDIT_CHARS } from "../lib/fact-gate.ts";
// 会话日志一律出自官方 SessionEvent 夹具构造器（信封必填位与 ToolCallId/MessageId/
// SessionSeq 品牌都在夹具里补一次）；fx 前缀避开与 makeEvents() 交出的局部 `call` 遮蔽。
// 官方形状里写不出的坏契约（无 callId 的极旧事件）显式走 fxBadEvent()。
import { badEvent as fxBadEvent, call as fxCall, result as fxResult } from "./fixtures/events.ts";
// 事件类型与生产面（host.ts）同源：官方判别联合由 shared 具名 re-export。
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";

// ── 轻量宿主替身（同 test/host.test.ts 契约，只实现本用例用到的面）──────────
interface MockCtx {
  tools: {
    guard: (fn: (exec: { name?: string; arguments?: unknown }) => string | undefined) => () => void;
  };
  /** 0.1.7 的 settings 面：拦截半只调 describe()（locale 偏好读面）。 */
  settings: {
    describe: () => { ns: string; value: unknown; revision: number }[];
  };
  /** cordis 可选服务读法：只给设置条目挂出的值面读数口。 */
  get: (name: string) => unknown;
  guardInstalled: {
    fn: (exec: { name?: string; arguments?: unknown }) => string | undefined;
  } | null;
  effects: (() => void)[];
  effect: (fn: () => (() => void) | undefined) => void;
  value: Config;
}

function createMockCtx(): MockCtx {
  const ctx: MockCtx = {
    guardInstalled: null,
    effects: [],
    // 内置默认底座 + 本文件关心的开关（与迁移前 register 的 base 同一份单源）
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

const apply = (ctx: MockCtx): void => {
  plugin.apply(ctx as never);
};

/** 一次 guard 调用的载荷：合成会话日志即法定证据源（与真实事件契约同型）。 */
const fire = (
  ctx: MockCtx,
  target: string,
  sessionId: string,
  log: readonly SessionEvent[],
  args: Record<string, unknown> = {},
): string | undefined =>
  ctx.guardInstalled!.fn({
    name: "edit",
    arguments: { file_path: target, ...args },
    agent: { session: { id: sessionId, snapshotEvents: () => log } },
  } as never);

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

// ── 临时项目夹具 ────────────────────────────────────────────────────────────
// 七位路径全部由下面 `beforeAll` 落地，这里只声明形状：模块级的"赋值式初始化"
// （`let x = ""`）正是 `require-hook` 判的 setup 形态，而不带初始化的声明说的正是
// 「本文件不自己造值，一切从钩子来」——用例读到 undefined 就是夹具没跑起来。
let root: string;
let targetA: string;
let stdTestDir: string;
let root2: string;
let targetB: string;
let extraDir: string;
/** 第三套夹具：同一 need 在**两级**目录都存在（monorepo 常见形态）。 */
let root3: string;

/** 三套夹具共用的落地名字：`package.json` 是 projectRootOf 认的 ROOT_MARKER（缺它就没有
 *  项目根），另两枚是第二/第三套夹具的目标文件名（路径与检索 pattern 都指同一枚）。 */
const ROOT_MANIFEST_NAME = "package.json";
const OTHER_MOD_BASENAME = "other-mod.ts";
const DEEP_MOD_BASENAME = "deep-mod.ts";
/** 非标准测试层目录名（`extraTestDirs` 的设定值，也是 root2 里落地的目录名）。 */
const EXTRA_TEST_DIR_NAME = "extra-tests";

/** 缓存失效那条用例的会话 id：同会话连打三次（声明层→撤声明→再打），三次必须同一枚，
 *  换 id 就变成"新会话没有历史位"、测不到缓存键失效这条判据。 */
const CACHE_INVALIDATION_SESSION = "cache-inval";

/** 夹具源文本的两态：`VALUE_LINE_*` 是 SMALL 的 old/new，也是内容自证拿去 `includes` 比对的
 *  那段文本；`FILE_CONTENT_*` 是落进文件的那一份（同一行 + 换行）。四者同源，改一处即全套
 *  一致 —— 字面量散在九处时漏改一处就是"用例还在跑、判据已经不是那件事"。 */
const VALUE_LINE_BEFORE = "const value = 1";
const VALUE_LINE_AFTER = "const value = 2";
const FILE_CONTENT_BEFORE = `${VALUE_LINE_BEFORE}\n`;
const FILE_CONTENT_AFTER = `${VALUE_LINE_AFTER}\n`;

/** 小改：30 字符、不含签名关键字、非高风险路径 → 默认为 low 档。 */
const SMALL = { old_string: VALUE_LINE_BEFORE, new_string: VALUE_LINE_AFTER };
/** 大改：合计 3000 字符 > 默认 big(2000) → 默认升 high。 */
const LARGE = { old_string: "x".repeat(1500), new_string: "y".repeat(1500) };

// ── fs 事实面：存在性三态 / 外部改动归因 / 内容自证 ──────────────────────────
/** 显式的时间点（不依赖 fs 时间戳粒度：clone/touch 下 mtime 不稳定）。 */
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-02-01T00:00:00.000Z");

/** 目标文件的取证日志（read + 项目级 grep，均成功回填）。 */
function evidenceFor(file: string): SessionEvent[] {
  // 起点=目标的父目录、签名=文件名（项目级引用的最小形态）。先取名再入参，
  // 免得 slice/lastIndexOf 嵌进 JSON.stringify 里读不动（也过不了 max-nested-calls）。
  const cut = file.lastIndexOf("/");
  const parentDir = file.slice(0, cut);
  const fileName = file.slice(cut + 1);
  return [
    fxCall("r1", "read", JSON.stringify({ file_path: file })),
    fxResult("r1"),
    fxCall("g1", "grep", JSON.stringify({ path: parentDir, pattern: fileName })),
    fxResult("g1"),
  ];
}

/** 一次"成功的写"事件（结果回填 + 写入文本，供内容自证）。 */
function ownEdit(file: string, newText: string): SessionEvent[] {
  return [
    fxCall("e1", "edit", JSON.stringify({ file_path: file, new_string: newText })),
    fxResult("e1"),
  ];
}

const fireWith = (
  ctx: MockCtx,
  name: string,
  args: Record<string, unknown>,
  log: readonly SessionEvent[],
  id: string,
): string | undefined =>
  ctx.guardInstalled!.fn({
    name,
    arguments: args,
    agent: { session: { id, snapshotEvents: () => log } },
  } as never);

/** 极旧契约的 tool/call：**没有 callId**（官方 `tool/call.data.callId` 必选，类型面写不出
 *  缺位）→ 显式 badEvent。这类事件的记账键退化成 `nc:<下标>`，按文档承诺保守计成功。 */
const callNoId = (name: string, args: Record<string, unknown>): SessionEvent =>
  fxBadEvent({ type: "tool/call", data: { name, arguments: args } });

describe("host 运行路径接线（三档分级、层要求与外部改动归因）", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dg-tier-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    stdTestDir = path.join(root, "test");
    await mkdir(stdTestDir, { recursive: true });
    // projectRootOf 的 ROOT_MARKER
    await writeFile(path.join(root, ROOT_MANIFEST_NAME), "{}");
    targetA = path.join(root, "src", "target-mod.ts");
    await writeFile(targetA, FILE_CONTENT_BEFORE);

    // 第二套夹具：故意**没有**任何标准层目录，只有一个非标准名目录，
    // 用来证明 extraTestDirs 能把该目录变成被要求的层。
    root2 = await mkdtemp(path.join(tmpdir(), "dg-tier2-"));
    await mkdir(path.join(root2, "src"), { recursive: true });
    extraDir = path.join(root2, EXTRA_TEST_DIR_NAME);
    await mkdir(extraDir, { recursive: true });
    await writeFile(path.join(root2, ROOT_MANIFEST_NAME), "{}");
    targetB = path.join(root2, "src", OTHER_MOD_BASENAME);
    await writeFile(targetB, FILE_CONTENT_BEFORE);

    // 第三套：`src/tests/` 与根级 `test/` **同时**存在（monorepo 里包内测试层才是该文件
    // 的真实测试层）。旧实现在这里会一路把每层都再找一遍——本用例钉住"同一 need 只取
    // 离目标最近的一层，外层不再重复计入"。
    root3 = await mkdtemp(path.join(tmpdir(), "dg-tier3-"));
    await mkdir(path.join(root3, "src", "tests"), { recursive: true });
    await mkdir(path.join(root3, "test"), { recursive: true });
    await writeFile(path.join(root3, ROOT_MANIFEST_NAME), "{}");
    await writeFile(path.join(root3, "src", DEEP_MOD_BASENAME), FILE_CONTENT_BEFORE);
  });

  afterAll(async () => {
    await Promise.all(
      [root, root2, root3].map((dir) =>
        rm(dir, { recursive: true, force: true }).catch(() => null),
      ),
    );
  });

  describe("三档分级设置字段的运行路径接线", () => {
    it("bUILTIN_BASE 四个新字段存在，且阈值默认值来自 lib 单源（防三处漂移）", () => {
      const ctx = createMockCtx();
      apply(ctx);
      // 0.1.7 不再有 register 的 base 参数：底座就是拦截半读不到设置值面时回落的那一份
      // （BUILTIN_BASE 与 ConfigSchema 的 .default(...) 同源，见 lib/settings-schema.ts）。
      assert.equal(BUILTIN_BASE.strictMode, false, "strictMode 默认关");
      assert.equal(BUILTIN_BASE.smallEditChars, DEFAULT_SMALL_EDIT_CHARS, "small 默认取 lib 常量");
      assert.equal(BUILTIN_BASE.bigEditChars, DEFAULT_BIG_EDIT_CHARS, "big 默认取 lib 常量");
      assert.deepEqual(BUILTIN_BASE.extraTestDirs, [], "extraTestDirs 默认空");
      // 而且这份底座真的进了判定链：默认阈值下 30 字符改动属 low 档（只要 read）
      const { call, ok } = makeEvents();
      assert.equal(
        fire(ctx, targetA, "base-low", [call("read", { file_path: targetA }), ok()], SMALL),
        undefined,
        "默认底座值确实在驱动档位判定",
      );
    });

    it("smallEditChars：同一份证据，阈值由 200 降到 10 即从 low 升 mid（要求引用探查）", () => {
      const ctx = createMockCtx();
      apply(ctx);
      const { call, ok } = makeEvents();
      // 只 read、不 grep：low 档该放行；mid 档必须拒（缺 refs）。
      const log = [call("read", { file_path: targetA }), ok()];

      assert.equal(
        fire(ctx, targetA, "th-low", log, SMALL),
        undefined,
        "默认 small=200：30 字符属小改 → low，只要 read",
      );

      ctx.value.smallEditChars = 10;
      const denied = fire(ctx, targetA, "th-mid", log, SMALL);
      assert.ok(denied !== undefined, "small 降到 10 后同一改动不再是小改 → 升档要求引用探查");
      assert.match(denied, /引用|grep|zg_search/u, "拒绝理由是缺引用探查（档位确实变了）");
    });

    it("bigEditChars：同一份证据（read + src 级 grep），big 2000→100000 使 high 降为 mid 并放行", () => {
      const ctx = createMockCtx();
      apply(ctx);
      const { call, ok } = makeEvents();
      // grep 落在 src（是 target 的祖先目录 → refs 成立；但不覆盖 test 层目录）。
      const log = [
        call("read", { file_path: targetA }),
        ok(),
        call("grep", { path: path.join(root, "src"), pattern: "target-mod.ts" }),
        ok(),
      ];

      const denied = fire(ctx, targetA, "big-high", log, LARGE);
      assert.ok(denied !== undefined, "3000 字符 > 默认 big(2000) → high，仍要求层探查");
      assert.match(denied, /层目录/u, "拒绝文案点名缺失的层目录（不是泛泛模板）");
      assert.ok(
        denied.includes(stdTestDir) || denied.includes("test"),
        "点名的正是真实存在的 test 层",
      );

      ctx.value.bigEditChars = 100_000;
      assert.equal(
        fire(ctx, targetA, "big-mid", log, LARGE),
        undefined,
        "big 抬高后同一改动降为 mid，read+refs 即放行",
      );
    });

    it("extraTestDirs：非标准目录名默认不算层；声明后才成为被要求的层", () => {
      const ctx = createMockCtx();
      apply(ctx);
      const { call, ok } = makeEvents();
      const log = [
        call("read", { file_path: targetB }),
        ok(),
        call("grep", { path: path.join(root2, "src"), pattern: OTHER_MOD_BASENAME }),
        ok(),
      ];
      // strictMode 强制 high，以便在无标准层目录时只由 extraTestDirs 决定"要不要层要求"。
      ctx.value.strictMode = true;

      assert.equal(
        fire(ctx, targetB, "ex-off", log, SMALL),
        undefined,
        "未声明时 extra-tests 不是层 → high 档也无层要求，放行",
      );

      ctx.value.extraTestDirs = [EXTRA_TEST_DIR_NAME];
      const denied = fire(ctx, targetB, "ex-on", log, SMALL);
      assert.ok(denied !== undefined, "声明后 extra-tests 成为 test 层 → 缺该层探查应拒");
      assert.match(
        denied,
        /extra-tests/u,
        "拒绝文案点名新增层目录（证明参数进了 existingLayersOf）",
      );

      // 层证据只认**项目级作用域**的检索（path 是目标祖先且覆盖该层目录）：
      // 只钻进层目录搜不算——那是"兄弟目录"，看不到引用面，蹭不到证据（round 9 定稿）。
      const layerOnly = [
        ...log,
        call("grep", { path: extraDir, pattern: OTHER_MOD_BASENAME }),
        ok(),
      ];
      assert.ok(
        fire(ctx, targetB, "ex-narrow", layerOnly, SMALL) !== undefined,
        "只在层目录内搜不构成层证据（防蹭证据）",
      );

      // 项目根级检索顺带覆盖该层 → 放行
      const log2 = [
        call("read", { file_path: targetB }),
        ok(),
        call("grep", { path: root2, pattern: OTHER_MOD_BASENAME }),
        ok(),
      ];
      assert.equal(
        fire(ctx, targetB, "ex-cover", log2, SMALL),
        undefined,
        "覆盖该层的项目级检索即同时满足 refs 与层证据",
      );
    });

    it("strictMode：小改本属 low（只要 read），开启后升 high 并要求引用 + 层", () => {
      const ctx = createMockCtx();
      apply(ctx);
      const { call, ok } = makeEvents();
      const log = [call("read", { file_path: targetA }), ok()];

      assert.equal(
        fire(ctx, targetA, "strict-off", log, SMALL),
        undefined,
        "默认关：小改只需 read",
      );

      ctx.value.strictMode = true;
      const denied = fire(ctx, targetA, "strict-on", log, SMALL);
      assert.ok(denied !== undefined, "开启后同一小改必须补引用与层探查");
      assert.match(denied, /引用|grep|zg_search/u, "要求 refs");
      assert.match(denied, /层目录/u, "要求真实存在的 test 层");
    });

    it("缺字段一律升档（原则③）：write 整文件覆盖取不到 diff 尺寸 → 绝不落 low", () => {
      const ctx = createMockCtx();
      apply(ctx);
      const { call, ok } = makeEvents();
      // 只 read，且用 write（contentChars 取不到）：即便内容极小也必须升 high。
      const log = [call("read", { file_path: targetA }), ok()];
      const denied = ctx.guardInstalled!.fn({
        name: "write",
        arguments: { file_path: targetA, content: FILE_CONTENT_BEFORE },
        agent: { session: { id: "write-up", snapshotEvents: () => log } },
      } as never);
      assert.ok(denied !== undefined, "write 取不到写面大小 → 保守升档，不放行");
      assert.match(denied, /引用|grep|zg_search/u, "升档后要求引用探查");
    });
  });

  describe("存在性三态：只有 ENOENT 才算新文件", () => {
    it("stat 因 ENOTDIR 失败（路径中间是文件）→ 不给新建豁免，仍要求 read", () => {
      const ctx = createMockCtx();
      apply(ctx);
      // targetA 是**文件**：往它"下面"写 → fs 报 ENOTDIR，不是"文件不存在"
      const viaFile = path.join(targetA, "sneaky-new.ts");
      const denied = fireWith(
        ctx,
        "write",
        { file_path: viaFile, content: "export const x = 1;\n" },
        [],
        "enotdir",
      );
      assert.ok(denied !== undefined, "取不到存在性就不免检（旧实现把任何 stat 失败当新文件）");
      assert.doesNotMatch(denied, /新建文件免 read/u);
      assert.match(denied, /read/u);
    });

    it("确凿 ENOENT + write（有能力创建）→ 才给新建豁免", () => {
      const ctx = createMockCtx();
      apply(ctx);
      const brandNew = path.join(root, "src", "truly-new-mod.ts");
      const denied = fireWith(
        ctx,
        "write",
        { file_path: brandNew, content: "export const x = 1;\n" },
        [],
        "enoent",
      );
      assert.ok(denied !== undefined, "新建仍要探引用面");
      assert.match(denied, /新建文件免 read/u);
    });
  });

  describe("外部改动归因：mtime 跳变 + 内容自证", () => {
    it("自己成功改过且写进去的文本还在 → 不作废证据（不反复过门）", async () => {
      const file = path.join(root, "src", "self-keep.ts");
      await writeFile(file, FILE_CONTENT_BEFORE);
      await utimes(file, T0, T0);
      const ctx = createMockCtx();
      apply(ctx);
      // 第 1 轮：取证齐备 → 放行（此刻记下日志长度作为"上次评估位置"）
      assert.equal(
        fireWith(ctx, "edit", { file_path: file, ...SMALL }, evidenceFor(file), "self-keep"),
        undefined,
      );
      // 编辑落地：文件内容变了（mtime 前进），日志里多出那次成功的 edit 调用
      await writeFile(file, FILE_CONTENT_AFTER);
      await utimes(file, T1, T1);
      assert.equal(
        fireWith(
          ctx,
          "edit",
          { file_path: file, ...SMALL },
          [...evidenceFor(file), ...ownEdit(file, VALUE_LINE_AFTER)],
          "self-keep",
        ),
        undefined,
        "mtime 跳变能被自己的编辑 + 内容自证解释 → 不再反复过门",
      );
    });

    it("自己改过但那份已被覆盖（内容自证失败）→ 判外部改动，要求重读并提示冲突", async () => {
      const file = path.join(root, "src", "self-lost.ts");
      await writeFile(file, FILE_CONTENT_BEFORE);
      await utimes(file, T0, T0);
      const ctx = createMockCtx();
      apply(ctx);
      assert.equal(
        fireWith(ctx, "edit", { file_path: file, ...SMALL }, evidenceFor(file), "self-lost"),
        undefined,
      );
      await writeFile(file, FILE_CONTENT_AFTER);
      await utimes(file, T1, T1);
      const ownLog = [...evidenceFor(file), ...ownEdit(file, VALUE_LINE_AFTER)];
      assert.equal(
        fireWith(ctx, "edit", { file_path: file, ...SMALL }, ownLog, "self-lost"),
        undefined,
      );
      // 另一会话/外部工具又覆盖了整个文件：自己那段文本不在了
      await writeFile(file, "const value = 999 // 别人重写\n");
      await utimes(
        file,
        new Date("2026-03-01T00:00:00.000Z"),
        new Date("2026-03-01T00:00:00.000Z"),
      );
      const denied = fireWith(ctx, "edit", { file_path: file, ...SMALL }, ownLog, "self-lost");
      assert.ok(denied !== undefined);
      assert.match(denied, /本会话之外/u, "成因是 external，不是泛泛的「没读过」");
    });

    it("目标被删（内容读不到）→ 内容自证按失败处理（保守判外部）", async () => {
      const file = path.join(root, "src", "self-gone.ts");
      await writeFile(file, FILE_CONTENT_BEFORE);
      await utimes(file, T0, T0);
      const ctx = createMockCtx();
      apply(ctx);
      assert.equal(
        fireWith(ctx, "edit", { file_path: file, ...SMALL }, evidenceFor(file), "gone"),
        undefined,
      );
      await writeFile(file, FILE_CONTENT_AFTER);
      await utimes(file, T1, T1);
      const ownLog = [...evidenceFor(file), ...ownEdit(file, VALUE_LINE_AFTER)];
      assert.equal(fireWith(ctx, "edit", { file_path: file, ...SMALL }, ownLog, "gone"), undefined);
      // 目标被删：内容自证**读不到**（catch 路径）→ 不认自证；但 mtime 也无法前进，
      // 于是既不判外部改动、也不免检 read——真正的失败由随后的 edit 自己暴露。
      await rm(file);
      const after = fireWith(ctx, "edit", { file_path: file, ...SMALL }, ownLog, "gone");
      assert.equal(after, undefined, "文件已不存在：不把 -1 的 mtime 当外部跳变");
    });

    it("本会话没评估过该文件（只有全局 mtime 兜底）→ 保守判需重读，下一轮自愈", async () => {
      const file = path.join(root, "src", "cross-session.ts");
      await writeFile(file, FILE_CONTENT_BEFORE);
      await utimes(file, T0, T0);
      const ctx = createMockCtx();
      apply(ctx);
      // 会话 A 先看一眼（把全局 mtime 记成 T0）
      assert.equal(
        fireWith(ctx, "edit", { file_path: file, ...SMALL }, evidenceFor(file), "sess-a"),
        undefined,
      );
      await writeFile(file, FILE_CONTENT_AFTER);
      await utimes(file, T1, T1);
      // 会话 B 首次评估：本会话没有历史位 → 外部改动基准取当前日志末尾（自愈）
      const deniedB = fireWith(
        ctx,
        "edit",
        { file_path: file, ...SMALL },
        evidenceFor(file),
        "sess-b",
      );
      assert.ok(deniedB !== undefined, "B 会话带的是改动前的 read 证据 → 必须重读");
      assert.match(deniedB, /本会话之外/u);
      // B 重读之后（日志多了一条更晚的 read）→ 放行
      const logB = [...evidenceFor(file), ...ownEdit(file, "const value = 3")];
      assert.equal(
        fireWith(ctx, "edit", { file_path: file, ...SMALL }, logB, "sess-b"),
        undefined,
        "重读后凭更大下标通过",
      );
    });
  });

  describe("层台账与容量：无 callId 的检索也能覆盖层；extraTestDirs 变更使缓存失效", () => {
    it("nc: 键的检索覆盖到层目录 → 层证据同样记上", () => {
      const ctx = createMockCtx();
      apply(ctx);
      ctx.value.extraTestDirs = [EXTRA_TEST_DIR_NAME];
      ctx.value.strictMode = true;
      const log = [
        callNoId("read", { file_path: targetB }),
        callNoId("grep", { path: root2, pattern: OTHER_MOD_BASENAME }),
      ];
      assert.equal(
        fire(ctx, targetB, "nc-layer", log, SMALL),
        undefined,
        "旧契约事件按成功计，且顺带覆盖 test 层",
      );
    });

    it("同一目标：extraTestDirs 改回空 → 旧缓存作废，层要求随之消失", () => {
      const ctx = createMockCtx();
      apply(ctx);
      // strictMode 强制 high 档：层要求只由"该层是否被词表声明"决定
      ctx.value.strictMode = true;
      // grep 落在 src（是目标祖先 → refs 成立；但不覆盖 extra-tests 层）
      const log = [
        callNoId("read", { file_path: targetB }),
        callNoId("grep", { path: path.join(root2, "src"), pattern: OTHER_MOD_BASENAME }),
      ];
      ctx.value.extraTestDirs = [EXTRA_TEST_DIR_NAME];
      assert.ok(
        fire(ctx, targetB, CACHE_INVALIDATION_SESSION, log, SMALL) !== undefined,
        "声明后 extra-tests 成为层 → 缺该层探查应拒",
      );
      ctx.value.extraTestDirs = [];
      assert.equal(
        fire(ctx, targetB, CACHE_INVALIDATION_SESSION, log, SMALL),
        undefined,
        "撤掉声明即失效（缓存键含词表，不能沿用旧层集合）",
      );
      // 再打一次：命中缓存，结论稳定
      assert.equal(fire(ctx, targetB, CACHE_INVALIDATION_SESSION, log, SMALL), undefined);
    });

    it("同一 need 有两级候选目录：只要求离目标最近的那一层", () => {
      const ctx = createMockCtx();
      apply(ctx);
      ctx.value.strictMode = true;
      const targetC = path.join(root3, "src", DEEP_MOD_BASENAME);
      const innerLayer = path.join(root3, "src", "tests");
      const outerLayer = path.join(root3, "test");
      const { call, ok } = makeEvents();
      // 只钻根级 test/：目标最近的那一层（src/tests）没被任何检索覆盖 → 仍缺层证据。
      const onlyOuter = [
        call("read", { file_path: targetC }),
        ok(),
        call("grep", { path: outerLayer, pattern: DEEP_MOD_BASENAME }),
        ok(),
      ];
      const denied = fire(ctx, targetC, "two-layers", onlyOuter, SMALL);
      assert.ok(denied !== undefined, "根级 test/ 顶替不了包内 src/tests");
      assert.ok(denied.includes(innerLayer), `拒绝理由点名的层应是 ${innerLayer}`);
      // 覆盖最近层的**项目级**检索：一次同时满足 refs 与层证据
      const coverInner = [
        call("read", { file_path: targetC }),
        ok(),
        call("grep", { path: path.join(root3, "src"), pattern: DEEP_MOD_BASENAME }),
        ok(),
      ];
      assert.equal(
        fire(ctx, targetC, "two-layers", coverInner, SMALL),
        undefined,
        "内层被覆盖即齐备（外层不再另要一次）",
      );
    });
  });
});
