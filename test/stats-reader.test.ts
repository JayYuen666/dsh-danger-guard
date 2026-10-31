// test/stats-reader.test.ts —— 客户端**读面**（`src/stats-reader.ts`）的接线契约。
//
// 为什么单列一份：0.1.3 把这条读面接成 `ctx.remote`（未 inject）⇒ cordis 读即抛 ⇒ 整条 client
// 入口不激活、web boot 失败（页面卡在错误页）。修法走 `ctx.get`（显式读取，不受 inject 门禁），
// 而 `test/client-card.test.ts` 的 inject 门禁桩件只覆盖"入口不碰未声明服务"这一面；这一份补的是
// 读面自己的行为：**挂载一次**（幂等）、**命名空间按 `remote.<ns>` 键读**、失败如实抛出。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";

import { createStatsReader, topLines } from "../src/stats-reader.ts";
import type { StatsSnapshot } from "../lib/stats-shape.ts";

const SNAPSHOT: StatsSnapshot = {
  calls: { bash: 3 },
  slow: { bash: 1 },
  hits: { rmrf: 2 },
  asks: { gitForcePush: 1 },
  allowed: { nestedShellUnconfirmed: 4 },
  allowedByMode: { "danger-full-access": 4 },
  skipped: { gitCleanForce: 1 },
  quotaReleases: 0,
  slowMs: 100,
  window: 200,
};

/** 造一枚假远程面：记录 `$mount` 次数与命名空间读取用的键。 */
function fakeHost(options: { namespace?: unknown; mountRejects?: boolean } = {}): {
  ctx: { get?: (name: string, strict?: boolean) => unknown };
  mounts: () => number;
  reads: string[];
} {
  let mounts = 0;
  const reads: string[] = [];
  const ctx = {
    get(name: string, strict?: boolean): unknown {
      reads.push(`${name}:${String(strict)}`);
      if (name === "remote") {
        return {
          $mount: async (): Promise<void> => {
            mounts += 1;
            if (options.mountRejects === true) {
              throw new Error("mount failed");
            }
          },
        };
      }
      return options.namespace;
    },
  };
  return { ctx, mounts: () => mounts, reads };
}

/** 一枚只实现 `stats()` 的命名空间服务。 */
const namespaceOf = (result: unknown): unknown => ({ stats: async (): Promise<unknown> => result });

/** 造一台"命名空间交回给定值"的读取器（模块级：存在性断言在 helper 里收口，用例免写）。 */
const readerFor = (value: unknown): (() => Promise<StatsSnapshot>) => {
  const reader = createStatsReader(fakeHost({ namespace: namespaceOf({ ok: true, value }) }).ctx);
  assert.ok(reader !== undefined, "远程面在位：读取器必须成形");
  return reader;
};

describe("客户端读面：ctx.get 取远程面、挂载一次、按 remote.<ns> 读命名空间", () => {
  it("没有远程面（或 ctx 没有 get）→ 返回 undefined（卡片显示「读不到」，入口照常）", () => {
    assert.equal(createStatsReader({}), undefined);
    assert.equal(
      createStatsReader({
        get: (): void => {
          void 0;
        },
      }),
      undefined,
    );
    // 有服务但不是我们要的形状（别的实现/版本）→ 同样当作没有，而不是晚一步崩。
    assert.equal(createStatsReader({ get: () => ({}) }), undefined);
    assert.equal(createStatsReader({ get: () => ({ $mount: 1 }) }), undefined);
  });

  it("正常一路：挂载幂等（刷新多次只挂一次）、命名空间按 remote.dangerGuardStats 读、返回快照", async () => {
    const host = fakeHost({ namespace: namespaceOf({ ok: true, value: SNAPSHOT }) });
    const read = createStatsReader(host.ctx);
    assert.ok(read !== undefined);
    const first = await read();
    const second = await read();
    assert.deepEqual(first, SNAPSHOT);
    assert.deepEqual(second, SNAPSHOT, "重复读取仍走同一次挂载");
    assert.equal(host.mounts(), 1, "$mount 幂等：刷新不该反复挂载");
    // 命名空间服务的键就是 `remote.<namespace>`（gateway 的 remoteServiceKey），且用**非严格**读
    // ——它是挂载后才出现的服务，严格读会在"还没挂上"的窗口里抛。可选读显式传 false
    // （与 createStatsReader 取远程面那一处同形），"没装远程面要降级、不要抛"在代码上自证。
    // 语义断言而不是整组快照：远程面取一次（可选读）；每次刷新都要重读命名空间服务。
    assert.equal(host.reads[0], "remote:false", "远程面按可选读取一次");
    const namespaceReads = host.reads.slice(1);
    assert.ok(namespaceReads.length >= 2, "两次刷新至少重读命名空间两次");
    assert.deepEqual(
      [...new Set(namespaceReads)],
      ["remote.dangerGuardStats:false"],
      "命名空间按 remote.<ns> 且同为可选读",
    );
  });

  it("远程面晚到：读取器在创建时就取定，不做二次解析（已知限制，卡片刷新才恢复）", () => {
    // 与 src/client-entry.ts 的 apply 期创建一致：remote 不 inject，晚于本插件激活时
    // 当时读到 undefined，读取器就是 undefined。这里把限制显式钉住；若将来改成延迟解析，
    // 这条用例会红，提醒同时更新卡片侧的降级语义。
    const remote: { value: unknown } = { value: undefined };
    const ctx = {
      get: (name: string): unknown => (name === "remote" ? remote.value : undefined),
    };
    assert.equal(createStatsReader(ctx), undefined, "创建时缺席 ⇒ 没有读取器");
    remote.value = { $mount: () => Promise.resolve() };
    assert.notEqual(createStatsReader(ctx), undefined, "晚到后重新创建才拿得到读取器");
  });

  it("命名空间没挂上 → 抛出点明键名的错误（不是静默 undefined）", async () => {
    const host = fakeHost({ namespace: undefined });
    const read = createStatsReader(host.ctx);
    assert.ok(read !== undefined);
    await assert.rejects(read(), /remote\.dangerGuardStats 未提供/u);
  });

  it("挂载失败不缓存拒绝：下一次读取重新挂载，网关恢复后照常读数", async () => {
    let mounts = 0;
    let healthy = false;
    const read = createStatsReader({
      get: (name: string) => {
        if (name === "remote") {
          return {
            $mount: async (): Promise<void> => {
              mounts += 1;
              if (!healthy) {
                throw new Error("mount failed");
              }
            },
          };
        }
        return healthy ? namespaceOf({ ok: true, value: SNAPSHOT }) : undefined;
      },
    });
    assert.ok(read !== undefined);
    await assert.rejects(read(), /mount failed/u);
    await assert.rejects(read(), /mount failed/u, "仍不可用时如实再抛");
    assert.equal(mounts, 2, "拒绝的那枚 promise 不被缓存：每次读取都重新挂");
    healthy = true;
    assert.deepEqual(await read(), SNAPSHOT, "网关恢复后不再撞同一个旧错误");
    assert.equal(mounts, 3);
  });

  it("挂载失败 / 远端返回失败码 → 如实抛出（卡片那段显示错误，不假装「还没有判定」）", async () => {
    const broken = fakeHost({ mountRejects: true });
    const readBroken = createStatsReader(broken.ctx);
    assert.ok(readBroken !== undefined);
    await assert.rejects(readBroken(), /mount failed/u);
    const failed = fakeHost({
      namespace: namespaceOf({ ok: false, error: { code: "unknown-namespace", message: "nope" } }),
    });
    const readFailed = createStatsReader(failed.ctx);
    assert.ok(readFailed !== undefined);
    await assert.rejects(readFailed(), /unknown-namespace: nope/u);
  });

  it("失败响应缺 error 对象 → 抛可读的降级文案，不是 TypeError", async () => {
    const host = fakeHost({ namespace: namespaceOf({ ok: false }) });
    const read = createStatsReader(host.ctx);
    assert.ok(read !== undefined);
    await assert.rejects(read(), /未附完整错误详情/u);
  });

  it("失败响应的 error 字段类型漂移 → 退回中性文案，不渲染 [object Object]", async () => {
    const host = fakeHost({
      namespace: namespaceOf({ ok: false, error: { code: 7, message: null } }),
    });
    const read = createStatsReader(host.ctx);
    assert.ok(read !== undefined);
    await assert.rejects(read(), /未附完整错误详情/u);
  });

  it("快照形状不符 → 按读取失败抛出（不把垃圾交给渲染期炸）", async () => {
    const garbage: unknown[] = [
      undefined,
      7,
      {},
      { calls: "no" },
      { calls: { bash: Number.NaN } },
      // 非有限数（Infinity）与 null 都必须是形状不符：`z.number().int().nonnegative()`
      // 是跨进程边界的最后一道，放过去就会在渲染期变成 null/NaN。
      { window: Number.POSITIVE_INFINITY },
      { window: null },
      { calls: { bash: null } },
    ];
    // 不在循环里 await：一口气发出去再逐个收（断言的形状与逐条 await 相同）。
    await Promise.all(
      garbage.map((value, index) =>
        assert.rejects(readerFor(value)(), /形状不符/u, `garbage case ${String(index)}`),
      ),
    );
  });
});

describe("topLines：排序与裁剪", () => {
  it("limit 只收正整数：非正/NaN 交回空表，而不是 slice 的错位语义", () => {
    const counts = { alpha: 1, beta: 2 };
    assert.deepEqual(topLines(counts, 0), []);
    assert.deepEqual(topLines(counts, -1), []);
    assert.deepEqual(topLines(counts, Number.NaN), []);
    assert.deepEqual(topLines(counts, 2.5), [], "非整数按 0 处理");
  });

  it("并列时按键码点序（不随宿主 locale 变），次数降序在前", () => {
    const counts = { beta: 2, alpha: 2, gamma: 1 };
    assert.deepEqual(topLines(counts, 3), [
      { label: "alpha", count: 2 },
      { label: "beta", count: 2 },
      { label: "gamma", count: 1 },
    ]);
  });
});
