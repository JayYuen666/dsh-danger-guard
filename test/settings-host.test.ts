// settings-host.ts（**设置条目**）单元测试：值面读数口 + 页面策略 + 服务面守卫。
//
// 为什么单独一个文件：bulkhead-isolation.test.ts 用真实 cordis 跑通了「设置条目 provide、
// 拦截半 ctx.get」这条通路，但它只在**服务面完好**时跑；守卫的失败支路（非对象 ctx、
// 缺 effect/provide/fiber 形状不对、settings.configure 不在）只能在这里逐条打中。
// 那几条支路是本包的 fail-safe 说明：本条目抛错只让**设置页**没掉，闸门在另一个条目里。
//
// ⚠ 本包的覆盖率门禁是四项 100%（vitest.config.ts，公共面在 shared/config/vitest.base.ts）：安全闸门上"测不到的分支"就是
//    "没验证过的放行/拒绝路径"，所以这里不做任何豁免。
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import settingsPlugin from "../settings-host.ts";
import type { SettingsReader } from "../settings-host.ts";
import { BUILTIN_BASE, SETTINGS_READER } from "../lib/settings-schema.ts";
import type { Config, ConfigRefs } from "../lib/settings-schema.ts";

/** 一字段一枚 `Volatile` 引用：宿主交进 apply 的就是这个形状（cosmokit createVolatile 只有一个 get()）。 */
interface VolatileRef {
  get: () => unknown;
}

/** 由活值表造引用面：字段清单**从 BUILTIN_BASE 反推**，不在此手写名单。
 *  ⚠ 这里要的是 `ConfigRefs`（引用面），写成 `Config` 就是"apply 收到 plain 值"那个
 *  迁移期踩过的形状错——snapshot() 会当场炸在 `.get is not a function`。 */
function refsFrom(live: Record<string, unknown>): ConfigRefs {
  const refs: Record<string, VolatileRef> = {};
  for (const key of Object.keys(BUILTIN_BASE)) {
    refs[key] = { get: () => live[key] };
  }
  return refs as unknown as ConfigRefs;
}

interface MockCtx {
  settings: { configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void };
  effect: (factory: () => (() => void) | undefined, label?: string) => void;
  fiber: unknown;
  provide: (name: string, value: unknown) => () => void;
}

/** 记录三件事：provide 挂出了什么、configure 被谁以什么参数调用、effect 收下的 disposer。 */
function createSettingsCtx(): {
  ctx: MockCtx;
  provided: [string, unknown][];
  configured: { presentation: { auto?: boolean }; owner: unknown }[];
  disposers: (() => void)[];
} {
  const provided: [string, unknown][] = [];
  const configured: { presentation: { auto?: boolean }; owner: unknown }[] = [];
  const disposers: (() => void)[] = [];
  const ctx: MockCtx = {
    settings: {
      configure(presentation, owner) {
        configured.push({ presentation, owner: owner ?? {} });
        return (): void => {
          disposers.push(() => {
            configured.length = 0;
          });
        };
      },
    },
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === "function") {
        disposers.push(disposer);
      }
    },
    fiber: { id: "settings-fiber" },
    provide(name, value) {
      provided.push([name, value]);
      return (): void => {
        provided.length = 0;
      };
    },
  };
  return { ctx, provided, configured, disposers };
}

/** 形状守卫（与 test/bulkhead-isolation.test.ts 同一写法）：`ctx.get`/provide 交回的是 unknown，
 *  先过一遍谓词再取 read()——断言里不写 as 断言，读到的东西自己证明自己成形。 */
function isReader(value: unknown): value is SettingsReader {
  return (
    typeof value === "object" &&
    value !== null &&
    "read" in value &&
    typeof value.read === "function"
  );
}

describe("danger-guard 设置条目（settings-host.ts）", () => {
  const live: Record<string, unknown> = { ...BUILTIN_BASE };
  let harness: ReturnType<typeof createSettingsCtx>;

  beforeEach(() => {
    Object.assign(live, BUILTIN_BASE);
    harness = createSettingsCtx();
  });

  it("挂出值面读数口：读到的就是宿主交进来的那份引用面", () => {
    settingsPlugin.apply(harness.ctx as never, refsFrom(live));
    const raw: unknown = harness.provided[0]?.[1];
    assert.ok(isReader(raw), "provide 挂出了带 read() 的读数口");
    assert.equal(harness.provided[0]?.[0], SETTINGS_READER, "服务名单源在 lib/settings-schema.ts");
    const initial: Config = raw.read();
    assert.deepEqual(initial, BUILTIN_BASE);
    // 现读语义：活值变了，下一次 read() 就是新值（设置卡改完不必重载任何条目）。
    live["maxDenies"] = 5;
    live["strictMode"] = true;
    assert.equal(raw.read().maxDenies, 5, "配额现读");
    assert.equal(raw.read().strictMode, true, "严格档现读");
    live["maxDenies"] = BUILTIN_BASE.maxDenies;
    live["strictMode"] = BUILTIN_BASE.strictMode;
  });

  it("数组字段每次读都复制：下游就地改写读数口返回值也污染不了活值", () => {
    settingsPlugin.apply(harness.ctx as never, refsFrom(live));
    const raw: unknown = harness.provided[0]?.[1];
    assert.ok(isReader(raw), "读数口成形");
    const first: Config = raw.read();
    first.refSearchTools.push("injected_tool");
    assert.deepEqual(
      raw.read().refSearchTools,
      BUILTIN_BASE.refSearchTools,
      "读数不被上一份快照改写",
    );
  });

  it("页面策略：以**本条目**的 fiber 为 owner 关掉自动分页", () => {
    settingsPlugin.apply(harness.ctx as never, refsFrom(live));
    assert.deepEqual(harness.configured, [
      { presentation: { auto: false }, owner: { id: "settings-fiber" } },
    ]);
  });

  it("effect 的 disposer 收全：卸载时撤读数口、也撤页面策略", () => {
    settingsPlugin.apply(harness.ctx as never, refsFrom(live));
    assert.equal(harness.disposers.length, 2, "读数口 + 页面策略两条 effect");
    for (const disposer of harness.disposers) {
      disposer();
    }
    assert.equal(harness.provided.length, 0, "不留上一份读数的幽灵");
    assert.equal(harness.configured.length, 0, "页面策略随 fiber 回收");
  });

  it("服务面守卫：非对象 ctx（null / 字符串 / 数组）一律抛，不装半个设置面", () => {
    for (const bad of [null, "ctx", [1, 2]]) {
      assert.throws(
        () => {
          settingsPlugin.apply(bad as never, refsFrom(live));
        },
        /settings entry/u,
        `坏 ctx 形状：${JSON.stringify(bad)}`,
      );
    }
  });

  it("服务面守卫：effect / provide 不是函数、fiber 不是对象 → 各自抛", () => {
    const cases: Record<string, unknown>[] = [
      { ...createSettingsCtx().ctx, effect: 1 },
      { ...createSettingsCtx().ctx, provide: undefined },
      { ...createSettingsCtx().ctx, fiber: "not-a-fiber" },
      { ...createSettingsCtx().ctx, settings: { configure: undefined } },
      { ...createSettingsCtx().ctx, settings: undefined },
    ];
    for (const bad of cases) {
      assert.throws(
        () => {
          settingsPlugin.apply(bad as never, refsFrom(live));
        },
        /settings entry/u,
        `缺项：${JSON.stringify(Object.keys(bad))}`,
      );
    }
  });

  it("config 键在本条目上：设置条目 FAILED 只影响设置面", () => {
    assert.equal(typeof settingsPlugin.apply, "function");
    assert.equal(settingsPlugin.inject.join(","), "settings");
    assert.equal(Object.hasOwn(settingsPlugin, "Config"), true, "严格 schema 挂在设置条目上");
  });
});
