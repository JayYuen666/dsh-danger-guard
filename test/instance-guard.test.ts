// test/instance-guard.test.ts —— 拦截半的单实例判据（market 热挂 + bundle 层双路径）。
//
// 这一份单独钉 `lib/instance-guard.ts`：它是纯判据，不碰宿主、不碰 fs，于是可以逐条钉住
// 「同一作用域里第二份 apply 让路、且让路时把原因说出来」这件事。
//
// 为什么值得一条独立用例：本包的重复装载**不抛错**（`tools.guard` 是 append、事件监听各挂
// 一份），所以它只能靠这条判据挡住；判据坏掉的表现是"每个危险判定跑两遍、上报翻倍"，
// 而那在单测里看不见（两次 guard 调用各自都正常返回）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { claimSingleInstance, INSTANCE_LOCK_KEY } from "../lib/instance-guard.ts";

/** 一份最小上下文：`services` 就是 `get` 读的那张表，`provide` 写它（重复即抛，复刻 cordis）。 */
function makeCtx(options: { readonly occupied?: boolean } = {}): {
  ctx: Parameters<typeof claimSingleInstance>[0];
  services: Map<string, unknown>;
} {
  const services = new Map<string, unknown>();
  if (options.occupied === true) {
    services.set(INSTANCE_LOCK_KEY, { held: true });
  }
  const ctx = {
    get: (name: string): unknown => services.get(name),
    reflect: {
      provide: (name: string, value?: unknown): unknown => {
        if (services.has(name)) {
          throw new Error(`service "${name}" has been registered`);
        }
        services.set(name, value);
        return (): void => {
          services.delete(name);
        };
      },
    },
  };
  return { ctx, services };
}

describe("claimSingleInstance：同一作用域只让一份走注册面", () => {
  it("空作用域：抢到，且锁名落进服务表（后到者才读得到）", () => {
    const { ctx, services } = makeCtx();
    assert.equal(claimSingleInstance(ctx), true, "空作用域该抢到");
    assert.equal(services.has(INSTANCE_LOCK_KEY), true, "抢到的锁必须落进同一张服务表");
  });

  it("已有一份在册：让路返回 false，且不再尝试 provide", () => {
    const { ctx } = makeCtx({ occupied: true });
    assert.equal(claimSingleInstance(ctx), false, "已有一份时第二份必须让路");
  });

  it("抢锁失败与读到已有实例同解：provide 抛错也只让路，不外抛", () => {
    const services = new Map<string, unknown>();
    // `get` 恒空、但 `provide` 抛错 = 「读与写之间被抢走」那一档。
    const ctx = {
      get: (): unknown => undefined,
      reflect: {
        provide: (name: string): unknown => {
          throw new Error(`service "${name}" has been registered`);
        },
      },
    };
    assert.equal(claimSingleInstance(ctx), false, "抢不到锁就是让路，异常不该穿出去");
    assert.equal(services.size, 0);
  });

  it("没有 get 面：按能力缺席放行（拦下来等于把闸门关掉）", () => {
    const provided: string[] = [];
    const ctx = {
      reflect: {
        provide: (name: string): unknown => {
          provided.push(name);
          return (): void => {
            void 0;
          };
        },
      },
    };
    assert.equal(claimSingleInstance(ctx), true, "读不到服务表就不该判重复");
    assert.deepEqual(provided, [INSTANCE_LOCK_KEY], "但仍然要占住锁，好挡住后到的另一份");
  });

  it("没有 reflect 面：按能力缺席放行（替身 / 精简宿主）", () => {
    assert.equal(claimSingleInstance({ get: (): unknown => undefined }), true);
  });

  it("两份先后装配：第一份抢到、第二份让路（双路径的完整回执）", () => {
    const { ctx, services } = makeCtx();
    assert.equal(claimSingleInstance(ctx), true, "market 先到的那一份抢到");
    assert.equal(claimSingleInstance(ctx), false, "bundle 层后到的那一份让路");
    assert.equal(services.size, 1, "锁只有一把，不会因为第二份而变成两条记录");
  });
});
