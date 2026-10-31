// host.ts「项目根回落」与「引用取证作用域判据」的**同一条不变式**接线测试。
//
// 背景（本用例钉住的缺陷）：`projectRootOf` 向上找不到 ROOT_MARKER 时原先回落成**会话 cwd**。
//   会话 cwd 与目标分处两棵树时（最典型的是 /tmp 下的草稿脚本：整条祖先链上没有任何
//   工程标记），这个回落值**不是目标的祖先目录**；而拒绝文案会把它当检索起点原样递给模型，
//   引用取证的判据（`isProjectScopeOf`）又只认「起点是目标的祖先」。两头一夹，模型
//   **照着拒绝理由做也拿不到凭证**，只能连拒到 maxDenies 换一次配额放行，外加一条
//   stderr 警告 —— 判定没错，路却走不通。
//
// 为什么经 guard 断言：`projectRootOf` / `isProjectScopeOf` 都是模块私有函数，外部唯一
//   可达路径就是 `tools.guard` 的返回值（同 test/host-tier-settings.test.ts 的理由）。
//
// 断言设计（可判定性，不比对文案措辞）：
//   1) 文案里给出的检索起点必须是目标的**祖先目录**；
//   2) 沿那个起点做一次检索，门禁必须放行 —— 这两条合起来就是「提示是可照做的」；
//   3) 对照支：会话 cwd 确实是祖先时，起点仍取 cwd（范围更大），不回退成目标父目录。
//   起点从文案的反引号路径里取（与语言无关）：文案改版只会让用例红，不会静默失效。
import { describe, it, afterAll, beforeAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin, { BUILTIN_BASE } from "../host.ts";
import type { Config } from "../host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
// 会话日志出自官方 SessionEvent 夹具构造器（信封必填位与品牌都在夹具里补一次）。
import { call as fxCall, result as fxResult } from "./fixtures/events.ts";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";

// ── 轻量宿主替身（同 test/host-tier-settings.test.ts 契约，只实现本用例用到的面）──
interface MockCtx {
  tools: {
    guard: (fn: (exec: { name?: string; arguments?: unknown }) => string | undefined) => () => void;
  };
  settings: { describe: () => { ns: string; value: unknown; revision: number }[] };
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
    value: { ...BUILTIN_BASE },
    tools: {
      guard(fn) {
        ctx.guardInstalled = { fn };
        return () => {
          ctx.guardInstalled = null;
        };
      },
    },
    // 本文件的用例只关心起点路径，与语言无关：不给 locale 描述符即走默认语言。
    settings: { describe: () => [] },
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

/**
 * 一次 guard 调用，工具面固定为 `write`：三处用例测的都是「新建文件」那条路
 * （新建免 read 由 `creatable` 决定，正是本次修复要覆盖的档位）。
 * `cwd` 走 `session.header.cwd` —— 本替身不挂 workingDirectory 服务，于是
 * `effectiveCwdOf` 正好落到 header 这条回退读上，会话在哪儿办公由用例指定。
 */
function fire(
  ctx: MockCtx,
  req: { target: string; sessionId: string; cwd: string; log?: readonly SessionEvent[] },
): string | undefined {
  return ctx.guardInstalled!.fn({
    name: "write",
    arguments: { file_path: req.target, content: "export const scratch = 1;\n" },
    agent: {
      session: {
        id: req.sessionId,
        header: { cwd: req.cwd },
        snapshotEvents: () => req.log ?? [],
      },
    },
  } as never);
}

/** 一次**成功**的检索事件对（callId 必须串上 result，缺 result 不算凭证）。 */
function searchEvents(searchPath: string, pattern: string): SessionEvent[] {
  return [fxCall("s1", "grep", JSON.stringify({ path: searchPath, pattern })), fxResult("s1")];
}

/** 与生产侧同一条不变式（此处独立重述：生产侧改语义时这里必须红，不能跟着一起漂）。
 *
 *  补的必须是**平台分隔符**：两枚入参都是宿主真实路径，Windows 上是 `\` 分隔。
 *  重述不等于可以抄错——写死 `/` 时这条断言在 Windows 上恒假，红的是测量而不是被测对象。 */
const isAncestorDir = (candidate: string, target: string): boolean =>
  candidate !== target &&
  target.startsWith(candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`);

/** 文案里出现的绝对路径（反引号包起来的那几枚），与语言、措辞无关。 */
const BACKTICKED = /`(?<token>[^`]+)`/gu;
function absolutePathsIn(message: string): string[] {
  const out: string[] = [];
  for (const match of message.matchAll(BACKTICKED)) {
    const { token } = match.groups ?? {};
    if (token !== undefined && path.isAbsolute(token)) {
      out.push(token);
    }
  }
  return out;
}

/** 文案里第一条绝对路径（= grep/glob 的 path 位置，与 zg 的 root 同值）。
 *  收窄责任放在这里：`fire` 交回 `string | undefined`，而 `assert.equal` 不收窄类型；
 *  两次失败都用 `assert.fail` 的 `never` 返回域收窄，而不是把 undefined 传下去。
 *  `undefined` 即"放行了"—— 本用例期望的是先给行动清单。 */
function firstRootOf(message: string | undefined, target?: string): string {
  if (message === undefined) {
    assert.fail("首次编辑必须先给行动清单（拒绝理由），而不是静默放行");
  }
  const paths = absolutePathsIn(message);
  // 给了 target 就按语义取："检索起点必须是目标的祖先"——不依赖文案里路径的先后。
  const first =
    target === undefined
      ? paths[0]
      : paths.find(
          (candidate) => target === candidate || target.startsWith(`${candidate}${path.sep}`),
        );
  if (first === undefined) {
    assert.fail(`拒绝理由必须点名目标的祖先目录作为检索起点，实际文案：${message}`);
  }
  return first;
}

let outsideRoot: string;
let cwdElsewhere: string;
let projectRoot: string;

describe("项目根回落与引用取证起点必须同源（提示可照做）", () => {
  beforeAll(async () => {
    // ① 项目外草稿目录：**故意不落任何 ROOT_MARKER**（本用例的主角）。
    outsideRoot = await mkdtemp(path.join(tmpdir(), "dg-outside-"));
    // ② 一个与目标无关的会话工作目录（旧实现会把它当检索起点）。
    cwdElsewhere = await mkdtemp(path.join(tmpdir(), "dg-cwd-"));
    // ③ 真实项目：根目录带 package.json（ROOT_MARKER）。
    projectRoot = await mkdtemp(path.join(tmpdir(), "dg-proj-"));
    await writeFile(path.join(projectRoot, "package.json"), "{}");
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
  });

  afterAll(async () => {
    await Promise.all(
      [outsideRoot, cwdElsewhere, projectRoot].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("项目外新建文件：检索起点是目标的祖先目录，且照该起点检索即放行", async () => {
    const ctx = createMockCtx();
    plugin.apply(ctx as never);
    const target = path.join(outsideRoot, "scratch.mjs");
    const sessionId = "outside";

    const denial = fire(ctx, { target, sessionId, cwd: cwdElsewhere });
    // 第一条绝对路径就是 grep/glob 的 path 位置（与 zg 的 root 同值）。
    const instructionRoot = firstRootOf(denial, target);
    assert.ok(
      isAncestorDir(instructionRoot, target),
      `门禁给出的检索起点必须是目标的祖先目录，否则模型照提示做也拿不到凭证；` +
        `起点=${instructionRoot}，目标=${target}`,
    );
    assert.ok(
      !isAncestorDir(cwdElsewhere, target),
      "夹具前提：会话 cwd 与目标分处两棵树（否则本用例测不到回落缺陷）",
    );

    // 沿**文案给出的那个起点**检索一次 —— 这正是模型会做的事。
    const log = searchEvents(instructionRoot, path.basename(target));
    const afterEvidence = fire(ctx, { target, sessionId, cwd: cwdElsewhere, log });
    assert.equal(
      afterEvidence,
      undefined,
      "照拒绝理由检索后必须放行（禁止出现「按提示做仍被拒」的死循环）",
    );
  });

  it("真实项目内：检索起点仍是最近的工程标记目录（回落修复不影响既有口径）", async () => {
    const ctx = createMockCtx();
    plugin.apply(ctx as never);
    const target = path.join(projectRoot, "src", "mod.ts");

    const denial = fire(ctx, { target, sessionId: "inside", cwd: cwdElsewhere });
    assert.equal(
      firstRootOf(denial, target),
      projectRoot,
      "项目内目标的起点必须是被 ROOT_MARKER 认出的项目根，而不是会话 cwd、也不是目标父目录",
    );
  });

  it("会话 cwd 确实是祖先时：起点取 cwd（范围更大），不回退成目标父目录", async () => {
    const ctx = createMockCtx();
    plugin.apply(ctx as never);
    // 无任何工程标记，但会话就在这棵树里办公 → cwd 是合法祖先，应被采用。
    const nested = path.join(outsideRoot, "nested");
    await mkdir(nested, { recursive: true });
    const target = path.join(nested, "deep.mjs");

    const denial = fire(ctx, { target, sessionId: "nested", cwd: outsideRoot });
    assert.equal(
      firstRootOf(denial, target),
      outsideRoot,
      "cwd 是目标祖先时应取 cwd（层探查范围更大），而不是目标自身的父目录",
    );
  });

  it("同一枚目标换会话目录：根缓存不许串味（键里必须带 cwd）", async () => {
    const ctx = createMockCtx();
    plugin.apply(ctx as never);
    // 整条祖先链上没有任何工程标记 ⇒ 根由"cwd 是不是祖先"这一步决定，正是键形的敏感点。
    const nested = path.join(outsideRoot, "two-cwd");
    await mkdir(nested, { recursive: true });
    const target = path.join(nested, "same.mjs");

    const insideDenial = fire(ctx, { target, sessionId: "two-cwd-inside", cwd: outsideRoot });
    assert.equal(firstRootOf(insideDenial, target), outsideRoot, "cwd 是祖先 ⇒ 起点取 cwd");

    // 同一枚目标，换到与它分处两棵树的会话目录：起点必须回落成目标父目录。
    // 只按 targetN 缓存时这里会吃到上一趟的根（= 别人的 cwd），起点错位而判定不报错。
    const outsideDenial = fire(ctx, { target, sessionId: "two-cwd-outside", cwd: cwdElsewhere });
    assert.equal(
      firstRootOf(outsideDenial, target),
      nested,
      "cwd 不是祖先 ⇒ 回落成目标父目录：根缓存不许跨会话目录串味",
    );
  });

  it("同一枚目标换项目根：层集合缓存不许串味（键里必须带 root）", async () => {
    const ctx = createMockCtx();
    plugin.apply(ctx as never);
    // 整条祖先链无工程标记 ⇒ 项目根由"cwd 是不是祖先"决定，root 因此随会话变；
    // 而层探查的上溯终点正是那个 root。
    const wide = path.join(outsideRoot, "layer-wide");
    const narrow = path.join(wide, "pkg");
    await mkdir(narrow, { recursive: true });
    // test/ 只在**宽根**这一级存在：窄根会话按自己的根看不到它。
    await mkdir(path.join(wide, "test"), { recursive: true });
    await writeFile(path.join(wide, "test", "x.test.ts"), "export const t = 1;\n");
    const target = path.join(narrow, "mod.mjs");

    // ① 窄根会话先评估：它的层集合里没有 test。
    const narrowDenial = fire(ctx, { target, sessionId: "layer-narrow", cwd: narrow });
    assert.ok(
      typeof narrowDenial === "string" && narrowDenial.length > 0,
      "窄根会话必须先给拒绝理由（否则下面的负向断言是空转）",
    );
    assert.ok(
      !narrowDenial.includes("test 层触达"),
      `窄根会话不该被要求一层它自己的根里不存在的 test 层，实际：${narrowDenial.slice(0, 200)}`,
    );
    // ② 同一枚目标、换成宽根会话：它的根**看得见** test/，因此必须把那一层算进缺项。
    //    缓存键少 root 这一位时，这里会吃到①写下的空层集合 ⇒ 这一层的要求被静默吃掉
    //    （方向是**放宽**门禁，正是最不该失守的那一侧）。
    const wideDenial = fire(ctx, { target, sessionId: "layer-wide", cwd: wide }) ?? "";
    assert.ok(
      wideDenial.includes("test 层触达"),
      `宽根会话必须要求 test 层，实际：${wideDenial.slice(0, 200)}`,
    );
  });
});
