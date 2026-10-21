// test/stats-reader.test.ts —— 客户端**读面**（`src/stats-reader.ts`）的接线契约。
//
// 为什么单列一份：0.1.3 把这条读面接成 `ctx.remote`（未 inject）⇒ cordis 读即抛 ⇒ 整条 client
// 入口不激活、web boot 失败（页面卡在错误页）。修法走 `ctx.get`（显式读取，不受 inject 门禁），
// 而 `test/client-card.test.ts` 的 inject 门禁桩件只覆盖"入口不碰未声明服务"这一面；这一份补的是
// 读面自己的行为：**挂载一次**（幂等）、**命名空间按 `remote.<ns>` 键读**、失败如实抛出。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";

import { createStatsReader } from "../src/stats-reader.ts";
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
    // ——它是挂载后才出现的服务，严格读会在"还没挂上"的窗口里抛。
    assert.deepEqual(host.reads, [
      "remote:undefined",
      "remote.dangerGuardStats:false",
      "remote.dangerGuardStats:false",
    ]);
  });

  it("命名空间没挂上 → 抛出点明键名的错误（不是静默 undefined）", async () => {
    const host = fakeHost({ namespace: undefined });
    const read = createStatsReader(host.ctx);
    assert.ok(read !== undefined);
    await assert.rejects(read(), /remote\.dangerGuardStats 未提供/u);
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
});
