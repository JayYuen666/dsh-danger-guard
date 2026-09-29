// bulkhead 的隔离性证明 + 交付回归测试（**真实 cordis 运行时**，不是手写 mock）。
//
// 命题（本次改造的全部前提）：cordis 4.x / dsh 0.1.7 里，一个条目的 `Config` 校验失败
// 只杀**它自己**那条 fiber：
//  - 校验发生在 apply 之前：`_reload()` 里 `this.config = this._resolveConfig(this._config)`
//    （vendor/cordis/src/fiber.ts:641-664），`resolveConfig` 见 :48-60；
//  - 抛出的 ValidationError 被该 fiber 自己的 try/catch 吞下：`this._error = reason` +
//    `epoch = INACTIVE`，错误只在**有人 await 这条 fiber** 时才重新抛出（:705-715 `await()`）；
//  - 于是兄弟 fiber（同 root ctx 下的另一个条目）完全不受影响：它 provide 的服务、
//    它挂的 guard 都还在。
// 本文件用两个**兄弟** plugin fiber 复现 danger-guard 的 shipped 拓扑：
//  danger-guard（拦截半，无 Config）+ danger-guard-settings（设置半，严格 Config）。
//
// 版本核对：本包 node_modules/@deepseek-ai/cordis/src/fiber.ts 与发布树
// /Users/yuanjiang/Documents/development/deepseek-harness/vendor/cordis/src/fiber.ts
// （dsh-v0.1.7-alpha.2）逐字节相同（`diff` 无输出），所以这里跑出来的就是发布行为。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import plugin from "../host.ts";
import settingsPlugin from "../settings-host.ts";
import type { SettingsReader } from "../settings-host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";

/** FiberState 在 cordis 里是 `const enum`（运行时被擦除），只能按发布 d.ts 的数值比对：
 *  node_modules/@deepseek-ai/cordis/lib/types/fiber.d.ts:67-74。 */
const ST = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const;

/** 等一轮 fiber 生命周期：_reload 首行 `await Promise.resolve()`，装载是微任务级的。
 *  用 node:timers/promises 而不是手搓 `new Promise(setTimeout)`：宏任务边界同样成立，
 *  但少一处 promise 构造与 executor 返回值的坑。 */
const settle = (): Promise<void> => sleep(0);

/** 读数口形状守卫（类型谓词，不是断言）：`ctx.get` 给的是 unknown。 */
function isReader(value: unknown): value is SettingsReader {
  return (
    typeof value === "object" &&
    value !== null &&
    "read" in value &&
    typeof value.read === "function"
  );
}

/** 真实 tools 服务的最小替身：只接住 guard 谓词，判定逻辑用 host.ts 本尊。 */
interface ToolsProbe {
  predicate: ((exec: Record<string, unknown>) => string | undefined) | undefined;
}

/** 组装一个"像 dsh 那样"的 root ctx：tools + settings 两个服务，两个兄弟条目 fiber。 */
function harness(rowConfig: Record<string, unknown>): {
  ctx: Context;
  tools: ToolsProbe;
  guard: Fiber;
  settings: Fiber;
} {
  const ctx = new Context();
  const tools: ToolsProbe = { predicate: undefined };
  ctx.provide("tools", {
    guard(predicate: (exec: Record<string, unknown>) => string | undefined) {
      tools.predicate = predicate;
      return () => {
        tools.predicate = undefined;
      };
    },
  });
  ctx.provide("settings", {
    describe: () => [],
    configure: (): (() => void) => (): void => {
      void 0;
    },
  });
  // 拦截半：条目没有 Config ⇒ cordis 原样把行 config 交进来，永远不会校验失败。
  const guard = ctx.plugin({
    name: "danger-guard",
    inject: ["tools", "settings"],
    apply: plugin.apply,
  });
  // 设置半：严格 Config 挂在这里，行 config 越界只炸这一条 fiber。
  const settings = ctx.plugin(
    {
      name: "danger-guard-settings",
      inject: ["settings"],
      Config: settingsPlugin.Config,
      apply: settingsPlugin.apply,
    },
    rowConfig,
  );
  return { ctx, tools, guard, settings };
}

const rmrf = { name: "bash", arguments: { command: "rm -rf /" } };

describe("bulkhead 隔离性：坏 Config 只能杀设置面，杀不掉闸门", () => {
  it("对照实验：严格 Config 挂在拦截条目上时，越界值真的让闸门 FAILED（这就是被修掉的洞）", async () => {
    const ctx = new Context();
    ctx.provide("tools", {
      guard: (): (() => void) => (): void => {
        void 0;
      },
    });
    ctx.provide("settings", {
      describe: () => [],
      configure: (): (() => void) => (): void => {
        void 0;
      },
    });
    const armed = ctx.plugin(
      {
        name: "danger-guard-as-before",
        inject: ["tools", "settings"],
        Config: settingsPlugin.Config,
        apply: plugin.apply,
      },
      { maxDenies: 0 },
    );
    let thrown: unknown;
    try {
      await armed;
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, "装载期就抛 ValidationError（apply 从未运行）");
    assert.match(thrown.message, /maxDenies/u);
    assert.equal(armed.state, ST.FAILED);
    await ctx.fiber.dispose();
  });

  it("shipped 拓扑：设置行 config 越界 → 设置条目 FAILED、拦截条目 ACTIVE、rm -rf 照拦", async () => {
    const { ctx, tools, guard, settings } = harness({ maxDenies: 0 });
    await settle();
    assert.equal(guard.state, ST.ACTIVE, "拦截条目必须照常装配");
    assert.equal(settings.state, ST.FAILED, "坏 Config 只炸设置条目自己");
    assert.ok(tools.predicate, "guard 谓词已挂上");
    // 设置条目没 provide 读数口 ⇒ 拦截半读不到 ⇒ 回落 BUILTIN_BASE（maxDenies 仍是安全值）
    assert.equal(ctx.get(SETTINGS_READER, false), undefined);
    assert.equal(typeof tools.predicate(rmrf), "string", "降级路径下危险命令照拦");
    await ctx.fiber.dispose();
  });

  it("设置条目合法时挂出读数口，拦截半读到用户改的值（bulkhead 不是常态代价）", async () => {
    const { ctx, guard, settings } = harness({ maxDenies: 1, strictMode: true });
    await settle();
    assert.equal(guard.state, ST.ACTIVE);
    assert.equal(settings.state, ST.ACTIVE);
    const raw: unknown = ctx.get(SETTINGS_READER, false);
    assert.ok(isReader(raw), "设置条目挂出了值面读数口");
    // 现读语义：引用即最新值，改设置不需要重载拦截条目
    assert.equal(raw.read().maxDenies, 1);
    assert.equal(raw.read().strictMode, true);
    await ctx.fiber.dispose();
  });

  it("拦截条目 dispose 时设置条目独立存活（两条 fiber 无相互回收链）", async () => {
    const { ctx, guard, settings } = harness({ maxDenies: 3 });
    await settle();
    assert.equal(settings.state, ST.ACTIVE);
    await guard.dispose();
    assert.equal(guard.state, ST.DISPOSED);
    assert.equal(settings.state, ST.ACTIVE, "设置条目不受拦截条目卸载影响");
    await ctx.fiber.dispose();
  });
});
