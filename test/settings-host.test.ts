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
import { reportRejectedSecretPatterns } from "../lib/secret-pattern-report.ts";
import { loggedText } from "./setup-logs.ts";
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
        const entry = { presentation, owner: owner ?? {} };
        configured.push(entry);
        // 真实 disposer 只撤自己那一条：整表清空会让「撤错条目」的实现也显绿。
        return (): void => {
          const index = configured.indexOf(entry);
          if (index !== -1) {
            configured.splice(index, 1);
          }
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
      const entry: [string, unknown] = [name, value];
      provided.push(entry);
      return (): void => {
        const index = provided.indexOf(entry);
        if (index !== -1) {
          provided.splice(index, 1);
        }
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
    // 遍历前记长度、遍历后断言不变：disposer 的调用不得再往册子里追加（否则
    // "清理"就是靠遍历语义的巧合兑现的——替身违约时这条断言当场红）。
    const disposerCount = harness.disposers.length;
    for (const disposer of harness.disposers) {
      disposer();
    }
    assert.equal(harness.disposers.length, disposerCount, "disposer 调用不得追加新条目");
    assert.equal(harness.provided.length, 0, "不留上一份读数的幽灵");
    assert.equal(harness.configured.length, 0, "页面策略随 fiber 回收");
  });

  it("服务面守卫：非对象 ctx（null / 字符串 / 数组）一律抛，不装半个设置面", () => {
    for (const bad of [null, "ctx", [1, 2]]) {
      assert.throws(
        () => {
          settingsPlugin.apply(bad as never, refsFrom(live));
        },
        (error: unknown): boolean =>
          error instanceof Error && error.message.startsWith("[danger-guard] settings entry:"),
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

  it("值面守卫：plain 值 / 缺字段 / 字段不是引用 → apply 阶段即抛，不拖到第一次 read", () => {
    const { ctx } = createSettingsCtx();
    // 0.1.6→0.1.7 迁移期踩过的形状错：plain 值面会让 snapshot() 的 `.get is not a function`
    // 拖到拦截半第一次工具调用才爆——host 的读数口没有 try/catch，等于闸门每次调用都抛。
    assert.throws(
      () => {
        settingsPlugin.apply(ctx as never, { ...BUILTIN_BASE } as never);
      },
      /reference surface/u,
      "plain 值面（值不是引用）当场点名",
    );
    for (const bad of [undefined, null, 7, "config"]) {
      assert.throws(
        () => {
          settingsPlugin.apply(ctx as never, bad as never);
        },
        /reference surface/u,
        `非对象的值面（${String(bad)}）同样当场点名`,
      );
    }
    const partial = refsFrom(live) as unknown as Record<string, unknown>;
    delete partial["refSearchTools"];
    assert.throws(
      () => {
        settingsPlugin.apply(ctx as never, partial as never);
      },
      /reference surface/u,
      "缺字段同样过不了值面守卫",
    );
    const brokenField = refsFrom(live) as unknown as Record<string, unknown>;
    brokenField["maxDenies"] = 3;
    assert.throws(
      () => {
        settingsPlugin.apply(ctx as never, brokenField as never);
      },
      /reference surface/u,
      "字段是裸值而不是带 get() 的引用同样判不过",
    );
    // 守卫抛错 = cordis 判本条目 FAILED、读数口不 provide：拦截半 ctx.get 落空即回落
    // BUILTIN_BASE——那条回落路径由 test/host.test.ts 与 bulkhead-isolation.test.ts 钉。
  });

  it("值面形状齐但 get() 抛错 ⇒ apply 阶段点名，不拖到第一次工具调用", () => {
    const { ctx } = createSettingsCtx();
    const refs = refsFrom(live) as unknown as Record<string, { get: () => unknown }>;
    refs["maxDenies"] = {
      get: (): unknown => {
        throw new Error("value face drifted");
      },
    };
    assert.throws(() => {
      settingsPlugin.apply(ctx as never, refs as never);
    }, /config values unreadable/u);
  });

  it("运行期值面漂移时读数口回落底座，闸门不因一次坏设置抛错", () => {
    const { ctx, provided } = createSettingsCtx();
    settingsPlugin.apply(ctx as never, refsFrom(live));
    const entry = provided.find(([name]) => name === SETTINGS_READER);
    assert.ok(entry !== undefined && isReader(entry[1]), "读数口已挂出");
    live["extraTestDirs"] = undefined;
    const read = entry[1].read();
    assert.deepEqual(read.extraTestDirs, BUILTIN_BASE.extraTestDirs);
    assert.equal(read.enabled, BUILTIN_BASE.enabled);
  });

  it("bUILTIN_BASE 是冻结的：降级路径把它直接交给下游，就地改写当场暴露而不是静默生效", () => {
    assert.equal(Object.isFrozen(BUILTIN_BASE), true, "对象本体冻结");
    for (const value of Object.values(BUILTIN_BASE)) {
      if (Array.isArray(value)) {
        assert.equal(Object.isFrozen(value), true, "数组字段同样冻结");
      }
    }
  });

  it("config 键在本条目上：设置条目 FAILED 只影响设置面", () => {
    assert.equal(typeof settingsPlugin.apply, "function");
    assert.equal(settingsPlugin.inject.join(","), "settings");
    assert.equal(Object.hasOwn(settingsPlugin, "Config"), true, "严格 schema 挂在设置条目上");
  });
});

describe("设置条目 apply 时就点名非法密钥模式（#22）", () => {
  it("坏模式在装配这一刻出声，合法的那条不被牵连", () => {
    const { ctx } = createSettingsCtx();
    const live = { ...BUILTIN_BASE, extraSecretPatterns: ["[unclosed", "^ok-secret$"] };
    settingsPlugin.apply(ctx as never, refsFrom(live));
    const text = loggedText();
    assert.match(text, /extraSecretPatterns 无效，本条未生效: \[unclosed/u);
    assert.doesNotMatch(text, /ok-secret/u, "合法模式不该被点名");
  });

  it("同一串只响一次：装配报过之后判定链的补报不重复", () => {
    const { ctx } = createSettingsCtx();
    const bad = "(a";
    const live = { ...BUILTIN_BASE, extraSecretPatterns: [bad] };
    settingsPlugin.apply(ctx as never, refsFrom(live));
    reportRejectedSecretPatterns([bad]);
    const hits = loggedText().split("本条未生效").length - 1;
    assert.equal(hits, 1, "去重表由两处调用点共用");
  });

  it("全合法时一声不响", () => {
    const { ctx } = createSettingsCtx();
    const live = { ...BUILTIN_BASE, extraSecretPatterns: ["^token$", "^secret/"] };
    settingsPlugin.apply(ctx as never, refsFrom(live));
    assert.equal(loggedText().includes("本条未生效"), false);
  });
});
