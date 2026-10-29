/**
 * 投影读路径（danger-guard 侧）：取证台账的主取数从「每次被守的写调用都全量倒扫会话
 * 日志」换成 `ctx.sessionProjections` 上注册单元的同步水位读（lib/tool-ledger.ts）。
 *
 * 本块钉四件事：
 *   ① 注册表缺席（没装 dsh-session-projection 的 profile）⇒ 从不注册、判定走回退扫描
 *      ——本文件之外那批 host 用例正是那条路径的既有断言；
 *   ② 注册表在位 ⇒ 判定只读投影，**一次 `snapshotEvents` 都不发生**；
 *   ③ 同一份日志在两条读法下结论**逐字相同**（放行与必拒两侧都比）；
 *   ④ 投影交出不可采信的状态（key 未落地 / 坏形状 / 台账被窗口或跳号作废）⇒ 确实回退扫描，
 *      结论仍与迁移前相同，而不是拿半份台账当证据。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import plugin, { BUILTIN_BASE } from "../host.ts";
import type { Config } from "../host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
import { asLedger, LEDGER_KEY, toolLedgerProjection } from "../lib/tool-ledger.ts";
// 替身台账：沿单元自己的 init/apply 折（test/ledger-fold.ts），与官方 drive 同一条路。
import { foldLedger } from "./ledger-fold.ts";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { call as fxCall, result as fxResult } from "./fixtures/events.ts";

/** 夹具 cwd：按平台根拼（写死 `/w/proj` 在 Windows 上没有盘符）。 */
const FIXTURE_CWD = path.resolve(path.parse(process.cwd()).root, "w", "proj");

/** `ctx.sessionProjections` 替身：register 收下单元；stateOf 按用例交给它的 fold 现算。
 *  fold 由用例显式给出（而不是自己去读 session），"投影路径从不碰 snapshotEvents"才是可断言的。 */
interface MockProjections {
  registered: unknown[];
  reads: { session: unknown; key: string }[];
  /** 新版协议下 `handle.stateOf` 收到的会话面。 */
  handleReads: unknown[];
  /** 这一次注册被释放的次数（卸载判据）。 */
  released: number;
  fold: { value: ((session: unknown) => unknown) | undefined };
  /** 注册协议的替身：legacy = 同步交回 disposer；handle = 等待后交回 handle。 */
  protocol: { value: "legacy" | "handle" };
  /** 注册结果：reject = 异步拒绝（新版宿主才可能发生的那一档）。 */
  outcome: { value: "ok" | "reject" };
}

interface MockCtx {
  tools: { guard: (fn: (exec: Record<string, unknown>) => string | undefined) => () => void };
  settings: { describe: () => { ns: string; value: unknown; revision: number }[] };
  get: (name: string) => unknown;
  effect: (fn: () => (() => void) | undefined) => void;
  inject?: (deps: string[], activate: (child: { sessionProjections: unknown }) => void) => void;
  value: Config;
  guardInstalled: { fn: (exec: Record<string, unknown>) => string | undefined } | null;
  effects: (() => void)[];
  projections: MockProjections;
  /** 是否把投影注册表放进宿主服务表（false = 模拟没装 dsh-session-projection 的 profile）。 */
  provide: { value: boolean };
}

function createMockCtx(
  options: {
    provideProjections?: boolean;
    protocol?: "legacy" | "handle";
    outcome?: "ok" | "reject";
    /** 直接指定 register 交回什么（用来喂"第三种形状"）。 */
    rawResult?: unknown;
  } = {},
): MockCtx {
  const projections: MockProjections = {
    registered: [],
    reads: [],
    handleReads: [],
    released: 0,
    fold: { value: undefined },
    protocol: { value: options.protocol ?? "legacy" },
    outcome: { value: options.outcome ?? "ok" },
  };
  const registry = {
    register(definition: unknown): unknown {
      projections.registered.push(definition);
      if (projections.outcome.value === "reject") {
        return Promise.reject(new Error("projection register rejected"));
      }
      if (Object.hasOwn(options, "rawResult")) {
        return options.rawResult;
      }
      if (projections.protocol.value === "handle") {
        return Promise.resolve({
          stateOf: (session: unknown): unknown => {
            projections.handleReads.push(session);
            return projections.fold.value?.(session);
          },
          dispose: (): void => {
            projections.released += 1;
          },
        });
      }
      return (): void => {
        projections.registered.length = 0;
        projections.released += 1;
      };
    },
    stateOf(session: unknown, key: string): unknown {
      projections.reads.push({ session, key });
      return projections.fold.value?.(session);
    },
  };
  const ctx: MockCtx = {
    value: { ...BUILTIN_BASE, enabled: true, factGateEnabled: true },
    guardInstalled: null,
    effects: [],
    projections,
    provide: { value: options.provideProjections ?? true },
    tools: {
      guard(fn) {
        ctx.guardInstalled = { fn };
        return () => {
          ctx.guardInstalled = null;
        };
      },
    },
    settings: { describe: () => [] },
    get: (name: string): unknown =>
      name === SETTINGS_READER ? { read: (): Config => ctx.value } : undefined,
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") {
        ctx.effects.push(disposer);
      }
    },
    inject(deps, activate) {
      // cordis 语义：依赖到位才激活回调，缺席时整条路径不运行。
      if (deps.includes("sessionProjections") && ctx.provide.value) {
        activate({ sessionProjections: registry });
      }
    },
  };
  return ctx;
}

function applyPlugin(ctx: MockCtx): void {
  plugin.apply(ctx as never);
}

/** 注册结果在 `await` 之后才发布读口（新旧两版的原始返回值都是函数，判别只能发生在 await
 *  之后），所以测试要等一拍再判定；不等就等于在测「还没挂上」那一态。 */
const settle = (): Promise<undefined> => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setImmediate(() => {
    resolve(undefined);
  });
  return promise;
};

/** 一次被守的 edit 调用：session 的 snapshotEvents 带计数，用来钉"有没有走回退扫描"。 */
function guardExec(id: string, log: readonly SessionEvent[], scans: { value: number }): unknown {
  return {
    name: "edit",
    arguments: { file_path: path.join(FIXTURE_CWD, "src", "cfg.ts") },
    agent: {
      session: {
        id,
        header: { cwd: FIXTURE_CWD },
        snapshotEvents: () => {
          scans.value += 1;
          return log;
        },
      },
    },
  };
}

/** 取证齐备的日志：read 目标 + 项目级 grep 命中，均成功回填。 */
function evidenceLog(): SessionEvent[] {
  return [
    fxCall("r1", "read", JSON.stringify({ file_path: path.join(FIXTURE_CWD, "src", "cfg.ts") })),
    fxResult("r1"),
    fxCall("g1", "grep", JSON.stringify({ path: FIXTURE_CWD, pattern: "cfg.ts" })),
    fxResult("g1"),
  ];
}

/** 把 fold 装成"按这份日志折叠出的可信台账"（等价于真注册表增量折完之后的当前态）。 */
function foldOf(log: readonly SessionEvent[]): (session: unknown) => unknown {
  return () => foldLedger(log);
}

function denyOf(ctx: MockCtx, exec: unknown): string | undefined {
  return ctx.guardInstalled?.fn(exec as never);
}

describe("w5 投影注册与回退", () => {
  it("注册表在位 → 注册本包单元（同一个对象引用）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    assert.deepEqual(ctx.projections.registered, [toolLedgerProjection]);
  });

  it("注册表缺席 → 从不注册，判定沿用回退扫描", () => {
    const ctx = createMockCtx({ provideProjections: false });
    applyPlugin(ctx);
    assert.deepEqual(ctx.projections.registered, []);
    const scans = { value: 0 };
    const first = denyOf(ctx, guardExec("s1", evidenceLog(), scans));
    assert.ok(scans.value > 0, "没有投影就没有水位读，只能全量扫");
    assert.equal(ctx.projections.reads.length, 0, "读口从未装上 ⇒ 从不走 stateOf");
    // 判定形态只有两种：字符串 = 拒绝理由，undefined = 放行。这串证据是齐备的（read 目标 +
    // 项目级 grep），回退读法下必须放行——旧写法是 `typeof first === "string" || first === undefined`
    // 的恒真式（类型面上也 exhaustive，`no-unnecessary-condition` 报的就是它），等于什么都没钉。
    assert.equal(first, undefined, "注册表缺席时取证齐备照样放行（回退扫描的结论）");
  });
});

describe("w5 投影 ≡ 回退扫描（同一份日志两条读法）", () => {
  it("取证齐备：两条读法结论逐字相同，且投影路径不读 snapshotEvents", async () => {
    const log = evidenceLog();
    const scanCtx = createMockCtx({ provideProjections: false });
    applyPlugin(scanCtx);
    const scanned = denyOf(scanCtx, guardExec("s-scan", log, { value: 0 }));

    const projCtx = createMockCtx();
    applyPlugin(projCtx);
    projCtx.projections.fold.value = foldOf(log);
    await settle();
    const scans = { value: 0 };
    const projected = denyOf(projCtx, guardExec("s-proj", log, scans));

    assert.equal(projected, scanned, "放行/拒绝与拒绝理由必须逐字一致");
    assert.equal(scans.value, 0, "主路径一次都不读弃用面");
    assert.deepEqual(projCtx.projections.reads.at(-1)?.key, LEDGER_KEY);
  });

  it("零证据：两条读法同样拒（缺项清单也逐字相同）", async () => {
    const log: SessionEvent[] = [];
    const scanCtx = createMockCtx({ provideProjections: false });
    applyPlugin(scanCtx);
    const scanned = denyOf(scanCtx, guardExec("s-scan", log, { value: 0 }));

    const projCtx = createMockCtx();
    applyPlugin(projCtx);
    projCtx.projections.fold.value = foldOf(log);
    await settle();
    const scans = { value: 0 };
    const projected = denyOf(projCtx, guardExec("s-proj", log, scans));

    assert.ok(typeof projected === "string", "零证据必拒");
    assert.equal(projected, scanned);
    assert.equal(scans.value, 0);
  });

  it("会话状态被投影读回来（stateOf 收到的是本调用的那个 session 面）", async () => {
    const log = evidenceLog();
    const ctx = createMockCtx();
    applyPlugin(ctx);
    ctx.projections.fold.value = foldOf(log);
    await settle();
    const exec = guardExec("s-key", log, { value: 0 }) as { agent: { session: unknown } };
    denyOf(ctx, exec);
    assert.equal(ctx.projections.reads.at(-1)?.session, exec.agent.session);
  });
});

/** 回退侧的共同断言：结论与纯扫描一致，且这次确实读了全量日志。 */
/** 回退侧的共同断言：结论与纯扫描逐字相同，且这一次确实读了全量日志。
 *  `makeState` 交回 undefined = 模拟"key 未落地"（stateOf 拿不到单元）。
 *  交回本次的两条结论与扫描次数，供各用例再钉自己那一条"为什么不可采信"。 */
async function assertFallsBack(
  makeState: ((log: readonly SessionEvent[]) => unknown) | undefined,
): Promise<{
  projected: string | undefined;
  scanned: string | undefined;
  scans: { value: number };
}> {
  const log = evidenceLog();
  const scanCtx = createMockCtx({ provideProjections: false });
  applyPlugin(scanCtx);
  const scanned = denyOf(scanCtx, guardExec("s-scan", log, { value: 0 }));

  const ctx = createMockCtx();
  applyPlugin(ctx);
  ctx.projections.fold.value = makeState === undefined ? undefined : () => makeState(log);
  await settle();
  const scans = { value: 0 };
  const projected = denyOf(ctx, guardExec("s-proj", log, scans));

  assert.equal(projected, scanned, "回退之后判定与迁移前逐字相同");
  assert.ok(scans.value > 0, "不可采信 ⇒ 读全量日志，而不是拿半份台账下结论");
  return { projected, scanned, scans };
}

describe("w5 不可采信的状态一律回退扫描", () => {
  it("stateOf 交回 undefined（key 未落地）⇒ 回退", async () => {
    // 读侧对 undefined 本来就不给台账（不是"空台账"）：这是回退判据的第一条。
    assert.equal(asLedger(undefined), undefined, "注册表没这一项 ⇒ 没有可信台账");
    const { projected, scans } = await assertFallsBack(undefined);
    assert.equal(projected, undefined, "回退之后取证齐备的那串日志仍放行");
    assert.equal(scans.value, 1, "回退只补一次全量倒扫，没有第二种读法掺进来");
  });

  it("回填形状不符（宿主漂移/坏缓存）⇒ 回退", async () => {
    // schema 认不出的形状交回 undefined，与"空台账"（calls 为空数组）严格区分：
    // 后者是可信的零证据，前者根本不能拿来下结论。
    assert.equal(asLedger({ calls: "nope" }), undefined, "坏形状不可采信");
    assert.deepEqual(asLedger(foldLedger([]))?.calls, [], "空台账才是可信的零证据");
    const { projected } = await assertFallsBack(() => ({ calls: "nope" }));
    assert.equal(projected, undefined, "坏形状回退之后的结论与纯扫描一致（放行）");
  });

  it("台账被窗口或跳号作废（dropped）⇒ 回退", async () => {
    // 同一份内容：dropped 为假时可信、置真即不可采信 ⇒ 回退钉的是那一位，不是台账内容。
    const trusted = asLedger(foldLedger(evidenceLog()));
    assert.notEqual(trusted, undefined, "未作废的台账本来可信（本用例的对照组）");
    assert.equal(
      asLedger({ ...foldLedger([]), dropped: true }),
      undefined,
      "dropped ⇒ 不作废的读法不适用",
    );
    const { projected } = await assertFallsBack((log) => ({ ...foldLedger(log), dropped: true }));
    assert.equal(projected, undefined, "作废台账回退之后的结论与纯扫描一致");
  });

  it("投影与扫描的台账逐项同值时不会被上述门挡掉（自检）", async () => {
    const log = evidenceLog();
    const ctx = createMockCtx();
    applyPlugin(ctx);
    ctx.projections.fold.value = foldOf(log);
    await settle();
    const scans = { value: 0 };
    denyOf(ctx, guardExec("s-ok", log, scans));
    assert.equal(scans.value, 0);
    assert.notEqual(asLedger(foldLedger(log)), undefined);
  });
});

describe("w5 注册的两种协议与卸载", () => {
  it("新协议：等待后按 handle 读，已弃用的 stateOf 一次都不碰", async () => {
    const log = evidenceLog();
    const ctx = createMockCtx({ protocol: "handle" });
    applyPlugin(ctx);
    ctx.projections.fold.value = foldOf(log);
    await settle();
    const scans = { value: 0 };
    const projected = denyOf(ctx, guardExec("s-handle", log, scans));
    assert.equal(projected, undefined, "取证齐备 ⇒ 放行");
    assert.equal(scans.value, 0, "handle 读口可用时不该回退扫描");
    assert.equal(ctx.projections.reads.length, 0, "新版宿主上一次都不走已弃用的 stateOf");
    assert.equal(ctx.projections.handleReads.length, 1, "读数走 handle.stateOf");
  });

  it("注册拒绝 ⇒ 不发布读口，整条判定回退扫描", async () => {
    const log = evidenceLog();
    const ctx = createMockCtx({ outcome: "reject" });
    applyPlugin(ctx);
    ctx.projections.fold.value = foldOf(log);
    await settle();
    const scans = { value: 0 };
    const projected = denyOf(ctx, guardExec("s-reject", log, scans));
    assert.equal(projected, undefined, "注册失败与注册表缺席同档：回到扫描，结论不变");
    assert.equal(scans.value, 1, "确实读了全量日志");
    assert.equal(
      ctx.projections.handleReads.length + ctx.projections.reads.length,
      0,
      "失效的读口一条都不许发布",
    );
  });

  // 三种形状各挡一格：不是对象、缺 stateOf、缺 dispose。判据是"一份失效读口都不许发布"，
  // 而不是"抛没抛"——静默发布出去的读者比抛错更难查。
  it.each([
    ["不是对象", 42],
    ["缺 stateOf", {}],
    ["缺 dispose", { stateOf: (): number => 0 }],
  ] as const)("注册交回第三种形状（%s）⇒ 不发布读口，回退扫描", async (_label, raw) => {
    const ctx = createMockCtx({ rawResult: raw });
    applyPlugin(ctx);
    await settle();
    const scans = { value: 0 };
    denyOf(ctx, guardExec("s-weird", evidenceLog(), scans));
    assert.equal(ctx.projections.reads.length, 0, "不该走旧读口");
    assert.equal(ctx.projections.handleReads.length, 0, "不该走 handle");
    assert.ok(scans.value > 0, "应回退扫描");
  });

  it("卸载先撤对外读口再释放；释放后不再参与判定", async () => {
    const log = evidenceLog();
    const ctx = createMockCtx({ protocol: "handle" });
    applyPlugin(ctx);
    ctx.projections.fold.value = foldOf(log);
    await settle();
    denyOf(ctx, guardExec("s-pre", log, { value: 0 }));
    assert.equal(ctx.projections.handleReads.length, 1, "卸载前走 handle");
    // 只撤这一条读面的 effect：整包卸载会把 guard 一起摘掉，那样"回到扫描"就无从观察。
    const disposeReadFace = ctx.effects.at(-1);
    assert.ok(disposeReadFace !== undefined, "读面必须挂了一条 effect 才有卸载可言");
    disposeReadFace();
    assert.equal(ctx.projections.released, 1, "这一次注册被释放");
    const after = { value: 0 };
    denyOf(ctx, guardExec("s-post", log, after));
    assert.equal(ctx.projections.handleReads.length, 1, "卸载后不再走投影读口");
    assert.ok(after.value > 0, "回到扫描");
  });
});
