// 设置卡契约测试（happy-dom + react-dom/act）。
// 真实契约（0.1.7 的 dsh-client-ui-settings ConfigForm，installed
// lib/types/client/config-form-types.d.ts:36-74 + ConfigFormSnapshot:6-32）——本文件的
// 表单桩件**直接 import 官方那两个类型**（type-only，不引运行时代码），所以宿主改字段名
// 或取值域时桩件这里先编译失败，而不是像原先的本地 mirror 一样静默漂移：
//   snapshot 7 位全必选：status: 'loading' | 'ready' | 'unavailable'（:12）、
//   value: T | undefined（:14，首个快照受理前才是 undefined）、base/user/revision/mode
//   snapshot.writable: boolean（恒存在，独立于 status 的可写位，:29）
//   表单五位在位：getSnapshot/subscribe/**mutate**/set/unset；后两者回
//   Promise<boolean>（:65/:73 受理位，只有传输失败才 reject）
//   契约里**没有** dispose —— 表单归 provider 持有（config-form.d.ts:138-142）
// 卡片侧本地 iface 仍是 Promise<void>（apply 的 payload 把受理位 await 后即弃，此次迁移
// 只换入口不改行为），入口从 ctx.settingsScope.bind({namespace}) 换成
// ctx.configForms.get(条目 id)。
// 要求：
//   1) status!=='ready' 或 writable=false 时开关 disabled（两者都满足才让写）；
//   2) 保存条模式：控件只暂存草稿，点「保存」才写差异字段；
//   3) 外部值变化时输入框回同步；
//   4) 本地 iface set/unset 返回 Promise<void>；
//   5) 绊线：mock 表单上的 dispose 一旦被调用即抛（把 scope.dispose() 写回 disposer = 红）。
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
// 假件的入参面按 `apply` 的官方 ClientCtx 投影来 checked（`Parameters<typeof …>[0]`）：
// type-only，不给本文件加运行时依赖（卡片仍是下面按需 dynamic import 的，happy-dom 全局
// 得先就位）。
import type { apply as clientApply } from "../src/client-entry.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { LocaleNs, Translate } from "../src/ui-messages.ts";

/** 本包目录 + package.json 的 name（slot key 的唯一合法取值来源）。 */
const PKG_DIR = path.resolve(import.meta.dirname, "..");

/** 卡片 DOM 定位选择器（测试侧的**期望形状**：展开靠 header、开关靠 role、保存靠 data-field）。
 *  三条都散在十来个用例里，改一处不改其余就是"用例照绿、点的已不是那个元素"。 */
const HEADER_SELECTOR = ".dgc-header";
const SWITCH_SELECTOR = 'button[role="switch"]';
const SAVE_BUTTON_SELECTOR = '[data-field="save"]';

/** React 挂在元素上的 props 键前缀（取它才能直接驱动 onChange）。 */
const REACT_PROPS_KEY_PREFIX = "__reactProps$";
/** 取到上述键之后的断言消息（三处同一句话）。 */
const REACT_PROPS_FOUND_MESSAGE = "拿到 React props";

/** bulkhead 的**拦截条目** id（locale 命名空间用它，槽 key 绝不该退回它）。 */
const GUARD_ENTRY_ID = "danger-guard";
/** bulkhead 的**设置条目** id：卡片 `configForms.get(条目 id)` 取的就是这一行。
 *  ⚠ 刻意不 import lib/settings-schema.ts 的 SETTINGS_NS —— 本用例钉的是"卡片实际取的 id
 *  == cordis.patch.yml 里的行 id"，引生产常量来断言就退化成同值复读。 */
const SETTINGS_ENTRY_ID = "danger-guard-settings";

/** cordis.patch.yml 的一行：条目 id 与它装载的模块名。 */
interface PatchRow {
  id: string;
  name: string;
}

/**
 * 解析本包 cordis.patch.yml 的 `id` + `name` 对（bulkhead 有两行：拦截行与设置行）。
 * 用解析代替在测试里抄 id/name，才能同时钉住「设置命名空间 = 设置行 id」与
 * 「slot key = bundle 行包名」这两条不同的规则。
 */
async function patchRows(): Promise<PatchRow[]> {
  const patch = await readFile(
    fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)),
    "utf8",
  );
  const rows: PatchRow[] = [];
  for (const match of patch.matchAll(
    /-\s+id:\s*(?<id>\S+)\s*\n\s*name:\s*"?(?<name>[^\s"]+)"?\s*$/gmu,
  )) {
    const id = match.groups?.["id"];
    const name = match.groups?.["name"];
    if (typeof id === "string" && typeof name === "string") {
      rows.push({ id, name });
    }
  }
  return rows;
}

/**
 * 宿主 profile（`~/.dsh/profiles/web/package.json`）的 `dsh.profile.bundles` 里本包那一条，
 * 也就是 `plugins.bundle.config` 唯一能命中的 key。
 *
 * 解析而非硬抄：key 写成裸条目 id（`danger-guard`）时，抄同一串的测试一直绿，而插件页面上
 * 那张卡**根本没渲染**（宿主派发 `entryKey: pkg.name`，installed
 * dsh-client-ui-plugin-manager/lib/client.js:1821、:2698；slot-contract.d.ts:96-100
 * 「keyed by the bundle's package name」；dsh-client-ui-renderer/lib/client.js:1154 逐字相等）。
 * 同时钉住清单里恰有一条、且 profile 的 link 目标就是本目录（避免比到残留副本）。
 */
async function profileBundleName(): Promise<string> {
  const own = JSON.parse(await readFile(path.join(PKG_DIR, "package.json"), "utf8")) as unknown as {
    name?: unknown;
  };
  assert.equal(typeof own.name, "string", "本包 package.json 有 name");
  const pkgName = String(own.name);
  // 宿主派发插件页的 entryKey 就是被装 bundle 的包名（= 本包 package.json.name，与装法无关），
  // 核心判据不依赖 profile。profile 只在这台开发机上存在，装了才顺手钉两道机器侧针：
  // 清单里恰有一条、link 目标就是本目录（避免比到另一份残留副本）。
  // 本包 node/no-sync 不放行 existsSync，故直接读并按 ENOENT 判缺失（其余错误照抛）。
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  const profilePath =
    override === "" ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json") : override;
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return pkgName;
    }
    throw error;
  }
  const profile = JSON.parse(raw) as {
    dependencies?: Record<string, unknown>;
    dsh?: { profile?: { bundles?: unknown } };
  };
  const bundles: unknown = profile.dsh?.profile?.bundles;
  assert.ok(Array.isArray(bundles), `${profilePath} 的 dsh.profile.bundles 应是数组`);
  // link 指向的是"哪一份检出"：本机 profile 装的就是这一份时，才顺手钉"清单里恰有一条、
  // 且只指向本目录"这两道机器侧针（改名/残留副本没人拦就是真缺陷）。指向别处时（单包仓的
  // 暂存副本、消费者自己的检出）这条针不适用 —— 拿别的机器的安装状态判红等于把开发机
  // 状态写进包测试，故跳过而不是失败。
  const installedHere: unknown = profile.dependencies?.[pkgName];
  if (!(typeof installedHere === "string" && installedHere.includes(PKG_DIR))) {
    return pkgName;
  }
  assert.deepEqual(
    (bundles as unknown[]).filter((item) => item === pkgName),
    [pkgName],
    "本包在 profile 的 bundles 清单里，且只列一次",
  );
  const link: unknown = profile.dependencies?.[pkgName];
  assert.equal(typeof link, "string", "profile 的 dependencies 指向本包");
  assert.ok(
    typeof link === "string" && link.includes(PKG_DIR),
    `profile 的 link 目标应是本目录（实得 ${String(link)}）`,
  );
  return pkgName;
}

/** 官方 locale 的 `{name}` 插值（宿主同语义）：测试里自己实现，不引宿主内部实现。 */
function fillTemplate(text: string, params: Record<string, unknown>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    if (typeof value === "number") {
      return String(value);
    }
    return typeof value === "string" ? value : "";
  });
}

/**
 * 官方 locale 的取值语义（测试侧复刻）：本包字典命中即用，未命中回落**键名本身**
 * （官方 `LocaleRuntime.lookup` 在 active 语言与 fallback 链都 miss 后的行为）。
 * 表按 `Record<string, string>` 承载而不是 `UiMessages`：merge 进 `LocaleNamespaceMap`
 * 之后官方 `TranslateNS<NS>` 的键域是「本包键 ∪ `common` 命名空间键」（官方
 * `LocaleKeysOf`，installed `dsh-client-ui-slots/lib/types/index.d.ts:59`），按 `UiMessages`
 * 索引那条并集在编译期就红，而运行时真相是回落。展开成字面量是为了拿到隐式索引签名
 * （`UiMessages` 是 interface，本身给不出）。
 * ⚠ 本包改成官方 `Translate` 时实测到的红字就是这个形状：
 * `Element implicitly has an 'any' type because expression of type
 *  'LocaleKeysOf<"danger-guard">' can't be used to index type 'UiMessages'.
 *   Property 'back' does not exist on type 'UiMessages'`
 * ——`back` 属于官方 `common` 词表，说明原先手抄的 `(key: keyof UiMessages, …) => string`
 * 比官方面**窄**：卡面上的 `t` 其实受理那枚并集，只是本包字典不认领其中的 common 键。
 */
function localeText(
  dict: Record<string, string>,
  key: string,
  params: Record<string, unknown>,
): string {
  return fillTemplate(dict[key] ?? key, params);
}

const zhTable: Record<string, string> = { ...UI_MESSAGES.zh };
const enTable: Record<string, string> = { ...UI_MESSAGES.en };

/** 中文 translator：卡片断言里的中文串因此与 i18n 迁移前完全一致。 */
const tZh: Translate = (key, params) => localeText(zhTable, key, params ?? {});
/** 英文 translator：双语断言用（同一渲染路径、换一份字典）。 */
const tEn: Translate = (key, params) => localeText(enTable, key, params ?? {});
/** 模板里的 {占位符} 名字清单（不具名捕获组，避开 dot-notation 与 TS4111 的相互要求）。 */
function placeholders(template: string): Set<string> {
  return new Set(template.split(/[{}]/u).filter((piece) => /^\w+$/u.test(piece)));
}

/** 官方表单快照（installed config-form-types.d.ts:6-32）：**7 位全必选**
 *  （status 恒为三态之一、value 在首个快照受理前才是 undefined、base/user/revision/mode
 *  恒在位）。桩件交得出这个面，宿主改字段名/取值域时这里先编译失败。 */
type Snap = ConfigFormSnapshot<Record<string, unknown>>;

/** 造一份合法快照：只写要变的位，其余取官方允许的真实默认（ready / 可写 / host 模式）。 */
function snap(over: Partial<Snap> = {}): Snap {
  return {
    status: "ready",
    value: {},
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: "host",
    ...over,
  };
}

/** 卡片自己的渲染视模型（= src 的 CardSnapshot，官方快照的三面 + value 兜底）：
 *  status/writable 在官方快照上是**必选**位，故这里也不留可选。 */
interface CardView {
  status: Snap["status"];
  writable: boolean;
  value: Record<string, unknown>;
}

/** 0.1.7 的表单消费面：**直接绑官方 `ConfigForm<Record<string, unknown>>`**
 *  （installed config-form-types.d.ts:36-74：getSnapshot/subscribe/mutate/set/unset），
 *  set/unset 回**受理位** boolean（true 宿主受理 / false 拒绝或写入被跳过，只有传输失败
 *  才 reject）。契约里**没有 dispose**——本 mock 额外挂一个会抛的 dispose 纯作绊线
 *  （见 disposeTripwire）。 */
type ConfigFormMock = ConfigForm<Record<string, unknown>> & { dispose: () => never };

/** DgCard 的真实 props 形状（client-entry.ts DgCard，测试侧结构投影：
 *  不 import client-entry 导出，避免值依赖；泛型 selector 用宽松签名）。
 *  ⚠ set/unset 是**卡片本地 iface**（Promise<void>）：0.1.7 的表单本身回
 *  Promise<boolean>，apply 的 payload 把它 await 收成 void（受理位不消费）。 */
interface DgCardHandlers {
  /** 取文案（apply 里 ctx.locale.bind 的结果，经 slots.register 的 payload 下发）。 */
  t: Translate;
  useCard: <Out>(selector: (snapshot: CardView) => Out) => Out;
  set: (field: string, value: unknown) => Promise<void>;
  unset: (field: string) => Promise<void>;
}

/** 造一个 useCard 替身（框架把注入的 hooks.card 映射成这个 prop）。 */
function useCardOf(view: CardView): <Out>(selector: (snapshot: CardView) => Out) => Out {
  return <Out>(selector: (snapshot: CardView) => Out): Out => selector(view);
}

/** 0.1.7 的 `ConfigForm` 契约里**没有** dispose（installed config-form-types.d.ts:36-74：
 *  只有 getSnapshot/subscribe/mutate/set/unset）。表单由 provider 持有并统一回收
 *  （installed lib/client.js:1289-1293）。这两个 mock 仍各留一根会抛的 dispose 绊线：
 *  把 `scope.dispose()` 写回 slot disposer 这类回退会立刻炸在这里（而不是像 0.1.6 那样
 *  静默让之后的每次保存都落空）。 */
function disposeTripwire(): never {
  throw new Error("configForms.get() 交回的是 provider 持有的共享表单，卡片不得 dispose");
}

/** 卡片写入口：表单的 Promise<boolean> → 卡片 iface 的 Promise<void>。
 *  与 src/client-entry.ts 里 payload 的包装同形（受理位 await 后即弃）。 */
function cardWrites(form: ConfigFormMock): {
  set: (field: string, value: unknown) => Promise<void>;
  unset: (field: string) => Promise<void>;
} {
  return {
    set: async (field: string, value: unknown): Promise<void> => {
      await form.set(field, value);
    },
    unset: async (field: string): Promise<void> => {
      await form.unset(field);
    },
  };
}

async function loadCard(): Promise<{
  DgCardForTest: React.ComponentType<DgCardHandlers>;
  makeScope: (
    initial: Snap,
    calls: { field: string; value: unknown }[],
  ) => ConfigFormMock & { push: (value: Snap) => void };
  /** apply 期间注册进官方 locale 的字典（命名空间 + 语言 + 该语字典），供双语断言。
   *  官方 `register` 的类型化重载是**一次交齐两语**的（installed
   *  `dsh-client-locale/lib/types/client/index.d.ts:199`），桩件在这里按语言摊平成逐语
   *  记录，好让下面的断言与「两语各注册一次」的旧形状逐字同形。字典面直接绑官方
   *  `LocaleDictOf<本包命名空间>`：本包少一个键、多一个键都先在桩件这里编译失败。 */
  locales: { ns: string; localeId: string; dict: LocaleDictOf<LocaleNs> }[];
  /** ctx.effect 的回收函数（样式 + locale 字典各一个）。 */
  effectDisposers: (() => void)[];
  /** apply 向 `ctx.configForms.get()` 要过哪些条目 id（0.1.7 里条目 id == 设置命名空间）。 */
  formEntryIds: string[];
  /** 落到 apply 那张共享表单（fakeForm）上的写入序列。 */
  formWrites: { field: string; value: unknown }[];
  /** slots.register 收到的 desc（name + key）。 */
  slotDescs: { name: string; key: string | undefined }[];
  /** 最后一次 register 的 payload（slots.inject 工厂产出，含 set/unset/hooks.card）。 */
  payload: Record<string, unknown> | null;
  /** slots.inject 工厂返回的 disposer 清单（loadCard 已就地各调用过一次）。 */
  slotCleanups: (() => void)[];
  /** 入口的 inject 清单（装配契约）。 */
  injectList: string[];
}> {
  const mod = await import("../src/client-entry.ts");
  const exported = mod as unknown as Record<string, unknown>;
  assert.ok(typeof exported["apply"] === "function", "apply 导出存在");
  assert.ok(Array.isArray(exported["inject"]), "inject 导出存在（装配契约）");
  // DgCard 不直接导出：经 slots.register 捕获 view。构造最小 ctx 捕获它。
  let capturedView: unknown = null;
  let capturedPayload: Record<string, unknown> | null = null;
  const locales: {
    ns: string;
    localeId: string;
    dict: LocaleDictOf<LocaleNs>;
  }[] = [];
  const effectDisposers: (() => void)[] = [];
  const formEntryIds: string[] = [];
  const formWrites: { field: string; value: unknown }[] = [];
  const slotDescs: { name: string; key: string | undefined }[] = [];
  const slotCleanups: (() => void)[] = [];
  const fakeForm: ConfigFormMock = {
    getSnapshot: () => snap(),
    subscribe: () => () => void 0,
    set: (field: string, value: unknown) => {
      formWrites.push({ field, value });
      return Promise.resolve(true);
    },
    unset: (field: string) => {
      formWrites.push({ field, value: undefined });
      return Promise.resolve(true);
    },
    // 官方 ConfigForm 的第五位（路径级原子写入）：本卡不走它，但类型面要求它在位。
    mutate: async () => true,
    dispose: disposeTripwire,
  };
  /**
   * 假件按 `apply` 的入参面构造：`effect` / `slots` 在 ClientCtx 里已是**官方**服务投影
   * （cordis `Context["effect"]` 与 `Pick<SlotRegistry, "inject" | "register">`），故签名
   * 一漂移就红在编译期，而不是跑到一半才崩。两处不得已的显式标注：
   *  - `effect`：官方是**两**个重载（`execute: () => SyncEffect` 回 `Disposable`，
   *    `execute: () => Effect` 回可 await 的 `AsyncDisposable`，installed
   *    `@deepseek-ai/cordis/lib/types/fiber.d.ts:157-159`），单个箭头签名满足不了两条
   *    （实测 TS2345：`Type 'SyncEffect<any>' is not assignable to type
   *    '(() => void) | undefined'` — 官方那一支还允许工厂交 `Iterable<Disposable>`），
   *    故一次性投影到官方面：假件只回收同步 disposer，那个返回面没人消费；
   *  - `register`：官方是**双重载**（`inject?: undefined` 与 `inject: (…) => I`），
   *    重载目标推不出上下文参数类型（TS7006），故按 `unknown` 收、在桩内一次性投影回
   *    本卡实际传的那一重载。
   */
  const fakeCtx: Parameters<typeof clientApply>[0] = {
    // effect 工厂**必须执行**：locale 字典的 register 就发生在这两个工厂里
    // （样式 effect + 字典 effect）；回收函数留下，别在渲染前就把样式摘掉。
    effect: ((factory: () => (() => void) | undefined): void => {
      const teardown = factory();
      if (typeof teardown === "function") {
        effectDisposers.push(teardown);
      }
    }) as Context["effect"],
    slots: {
      // 官方 `SlotRegistry.inject(key, …)`：key 的取值域就是合并后的 `SlotMap`，本卡的
      // `plugins.bundle.config` 能出现在这里靠的是 src 侧从属主包载入的那份 merge；它回的
      // 是一枚 idempotent disposer（旧手抄面写的是 `void`，把这一步藏掉了）。参数不叫
      // `callback`（那会撞 eslint `callback-return` / `prefer-await-to-callbacks`）。
      inject: (_key, install) => {
        // 官方 `SlotInjectionEffect` = 一枚 disposer 或一组 disposer（本卡是前者）。
        const cleanup = install();
        if (typeof cleanup === "function") {
          slotCleanups.push(cleanup);
          cleanup();
        }
        return (): void => void 0;
      },
      register: (options: unknown, component: unknown): (() => void) => {
        const desc = options as {
          name: string;
          key?: string;
          inject: () => Record<string, unknown>;
        };
        capturedView = component;
        slotDescs.push({ name: desc.name, key: desc.key });
        capturedPayload = desc.inject();
        return (): void => void 0;
      },
    },
    // 0.1.7：配置表单服务（取代已从宿主移除的 settingsScope；installed
    // config-form.d.ts:94-98 + :142）。
    configForms: {
      get: (entryId: string) => {
        formEntryIds.push(entryId);
        return fakeForm;
      },
    },
    locale: {
      // 官方**类型化**那条重载的形状（installed
      // `dsh-client-locale/lib/types/client/index.d.ts:199`：一次交齐 `BuiltInLocaleId`
      // 全量的字典、回**一枚** disposer）。旧写法是逐语三参 register + 两个 disposer，
      // 宿主侧走的正是同一个 `Object.entries(dicts)` 分支（lib/client.js:1379-1406），
      // 故这里按语言摊平记录即可，下面的断言逐字不改。
      register: (
        // `ns` 不写标注：上下文里它就是 src 的那枚 `typeof NS`，src 改命名空间这里即红。
        ns,
        dicts: Record<BuiltInLocaleId, LocaleDictOf<LocaleNs>>,
      ): (() => void) => {
        for (const [localeId, dict] of Object.entries(dicts)) {
          locales.push({ ns, localeId, dict });
        }
        return () => void 0;
      },
      // 卡片用例默认看中文（断言里的中文串与迁移前逐字相同）；英文侧另有对拍。
      bind: () => tZh,
    },
  };
  (exported["apply"] as (ctx: unknown) => void)(fakeCtx);
  assert.ok(capturedView !== null, "slots.register 捕获到卡片 view");
  return {
    DgCardForTest: capturedView as React.ComponentType<DgCardHandlers>,
    locales,
    effectDisposers,
    formEntryIds,
    formWrites,
    slotDescs,
    slotCleanups,
    payload: capturedPayload,
    injectList: exported["inject"] as string[],
    makeScope: (initial: Snap, calls: { field: string; value: unknown }[]) => {
      let current: Snap = initial;
      const listeners = new Set<() => void>();
      return {
        getSnapshot: () => current,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (field: string, value: unknown) => {
          calls.push({ field, value });
          return Promise.resolve(true);
        },
        unset: (field: string) => {
          calls.push({ field, value: undefined });
          return Promise.resolve(true);
        },
        mutate: async () => true,
        dispose: disposeTripwire,
        push: (value: Snap) => {
          current = value;
          for (const listener of listeners) {
            listener();
          }
        },
      };
    },
  };
}

/** 底层 set 拒绝模拟（模块级：不捕获任何测试内变量）。 */
const failingSet = (): Promise<void> => Promise.reject(new Error("wire down"));

/** 取 React 19 挂在 DOM 节点上的真实 props（含 onChange），直调绕过 happy-dom 合成事件层。 */
const propsOf = (
  element: Element,
): { onChange: (event: { target: { value: string } }) => void } => {
  const key = Object.keys(element).find((keyName) => keyName.startsWith(REACT_PROPS_KEY_PREFIX));
  assert.ok(key !== undefined, REACT_PROPS_FOUND_MESSAGE);
  // noUncheckedIndexedAccess：record[key] 为 X | undefined，经断言后仍须非空断言
  return (
    element as unknown as Record<
      string,
      { onChange: (event: { target: { value: string } }) => void }
    >
  )[key]!;
};

describe("b11：danger-guard 设置卡", () => {
  let win: Window;
  let container: HTMLElement;
  let root: Root | null = null;
  beforeEach(() => {
    win = new Window();
    const globals = globalThis as unknown as Record<string, unknown>;
    // Node ≥22 的 globalThis.navigator 是 getter-only：用 defineProperty 覆盖。
    Object.defineProperty(globals, "window", { value: win, configurable: true, writable: true });
    Object.defineProperty(globals, "document", {
      value: win.document,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globals, "navigator", {
      value: win.navigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globals, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
      writable: true,
    });
    container = win.document.createElement("div") as unknown as HTMLElement;
    (win.document.body as unknown as { append: (child: unknown) => void }).append(container);
  });
  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    await win.happyDOM.close();
    const globals = globalThis as unknown as Record<string, unknown>;
    delete globals["window"];
    delete globals["document"];
    delete globals["navigator"];
    delete globals["IS_REACT_ACT_ENVIRONMENT"];
  });

  async function renderCard(ui: React.ReactElement): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(ui);
    });
  }

  /** 取某字段所在行的 hint 文案（说明文字与实际生效值是否同源，只能这样核对）。 */
  function hintTextOf(field: string): string {
    const control = container.querySelector<HTMLElement>(`[data-field="${field}"]`);
    assert.ok(control !== null, `${field} 控件已渲染`);
    const row = control.closest(".dgc-row");
    assert.ok(row !== null, `${field} 控件落在设置行内`);
    return row.querySelector(".dgc-hint")?.textContent ?? "";
  }

  it("快照 ready 前开关 disabled（loading 与 unavailable 均不可写）", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const calls: { field: string; value: unknown }[] = [];
    // 首个快照受理前 value 是 undefined（官方契约），cardStore 会把它落成 {}；
    // status 现在由官方类型交出，直接读即可（原先要 `as { status: string }` 再取）。
    const scope = makeScope(snap({ status: "loading", writable: false, value: undefined }), calls);
    const useCard = useCardOf({
      status: scope.getSnapshot().status,
      writable: false,
      value: {},
    });
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard,
        ...cardWrites(scope),
      }),
    );
    // 展开卡片
    const header = container.querySelector<HTMLElement>(HEADER_SELECTOR);
    assert.ok(header, "卡片 header 存在");
    await act(async () => {
      header.click();
    });
    const switches = [...container.querySelectorAll(SWITCH_SELECTOR)] as HTMLButtonElement[];
    assert.ok(switches.length >= 2, "两个开关渲染");
    for (const sw of switches) {
      assert.equal(sw.disabled, true, "loading 时开关 disabled");
    }
  });

  it("ready 后开关可用；点开关只暂存，点「保存」才写（set 返回 Promise<void>）", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const calls: { field: string; value: unknown }[] = [];
    const view: CardView = {
      status: "ready",
      writable: true,
      value: { enabled: true, factGateEnabled: true },
    };
    const scope = makeScope(snap(view), calls);
    let setResult: unknown = "unset";
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard: useCardOf(view),
        set: (field: string, value: unknown) => {
          // 0.1.7 的表单回 Promise<boolean>（受理位），卡片 iface 收成 Promise<void>
          //（cardWrites 与 client-entry 里 payload 的包装同形）——这里记下的正是 iface 那条。
          setResult = cardWrites(scope).set(field, value);
          return setResult as Promise<void>;
        },
        unset: (field: string) => cardWrites(scope).unset(field),
      }),
    );
    const header = container.querySelector<HTMLElement>(HEADER_SELECTOR);
    assert.ok(header);
    await act(async () => {
      header.click();
    });
    const sw = container.querySelector<HTMLButtonElement>(SWITCH_SELECTOR);
    assert.ok(sw, "开关存在");
    assert.equal(sw.disabled, false, "ready 后开关可用");
    // 点开关：只暂存草稿，不写
    await act(async () => {
      sw.click();
    });
    assert.equal(calls.length, 0, "开关点击不直写（保存条模式）");
    // 点「保存」：写差异字段
    const save = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.ok(save, "保存按钮存在");
    await act(async () => {
      save.click();
    });
    assert.ok(setResult instanceof Promise, "set 返回 Promise<void>");
    await setResult;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.field, "enabled");
    assert.equal(calls[0]!.value, false, "写入取反值");
  });

  it("listInputRow 外部值变化时回同步 + 输入暂存（保存一次性写入）", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const calls: { field: string; value: unknown }[] = [];
    let external: Record<string, unknown> = { extraDevServerWords: ["turbopack"] };
    const scope = makeScope(snap({ value: external }), calls);
    // 必须**惰性**取 external（下面会换掉它再 rerender）：故这里保留 lambda 而不是
    // useCardOf(...)——后者会把当时的 view 冻结进参数里。
    const useCard = <Out>(sel: (snapshot: CardView) => Out): Out =>
      sel({ status: "ready", writable: true, value: external });
    const rerender = async (): Promise<void> => {
      await act(async () => {
        root!.render(
          React.createElement(DgCardForTest, {
            t: tZh,
            useCard,
            ...cardWrites(scope),
          }),
        );
      });
    };
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard,
        ...cardWrites(scope),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });
    const at = (): HTMLInputElement | null =>
      container.querySelector<HTMLInputElement>('[data-field="extraDevServerWords"]');
    const input = at();
    assert.ok(input, "词表输入框存在");
    assert.match(input.value, /turbopack/u, "初始值来自外部快照");
    // 外部值变化 → 回同步
    external = { extraDevServerWords: ["remix"] };
    await rerender();
    assert.match(at()!.value, /remix/u, "外部值变化回同步");
    // 连续输入 → 防抖：只落一次写。
    // happy-dom 的合成事件到不了 React 19 的 root 监听器（已实证）——
    // 经 __reactProps 直调真实 onChange：state、防抖 timer、写通道全是真实链路，
    // 只绕过 DOM 事件传输层（那是 React/happy-dom 的事，不是本卡的逻辑）。
    const box = at()!;
    const propsKey = Object.keys(box).find((keyName) => keyName.startsWith(REACT_PROPS_KEY_PREFIX));
    assert.ok(propsKey !== undefined, REACT_PROPS_FOUND_MESSAGE);
    const { onChange } = (
      box as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>
    )[propsKey]!;
    const { onFocus } = (box as unknown as Record<string, { onFocus: () => void }>)[propsKey]!;
    await act(async () => {
      onFocus();
    });
    await act(async () => {
      onChange({ target: { value: "a" } });
    });
    await act(async () => {
      onChange({ target: { value: "ab" } });
    });
    await act(async () => {
      onChange({ target: { value: "abc" } });
    });
    assert.match(box.value, /abc/u, "三段输入都落到框里");
    assert.equal(calls.length, 0, "输入只暂存，不直写");
    // 点「保存」：以最终值写一次
    const save = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.ok(save, "保存按钮存在");
    await act(async () => {
      save.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const written = calls.filter((call) => call.field === "extraDevServerWords");
    assert.equal(written.length, 1, "保存只写一次");
    assert.deepEqual(written[0]!.value, ["abc"]);
  });

  it("本地 set/unset iface 返回 Promise<void>（即使底层抛错也 .catch 吞掉不炸渲染）", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const scope = makeScope(snap(), []);
    // 底层 set 拒绝：卡片不得产生 unhandled rejection 导致崩溃
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard: useCardOf({ status: "ready", writable: true, value: {} }),
        set: async (field: string, value: unknown) => {
          void failingSet().catch(() => void 0);
          await scope.set(field, value);
        },
        unset: (field: string) => cardWrites(scope).unset(field),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });
    const sw = container.querySelector<HTMLButtonElement>(SWITCH_SELECTOR);
    assert.ok(sw);
    await act(async () => {
      sw.click();
    });
  });

  it("ready 但 writable=false（workspace 级只读）→ 开关 disabled（status/writable 独立闸门）", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const calls: { field: string; value: unknown }[] = [];
    const scope = makeScope(snap({ writable: false, value: { enabled: true } }), calls);
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard: useCardOf({ status: "ready", writable: false, value: { enabled: true } }),
        ...cardWrites(scope),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });
    const switches = [...container.querySelectorAll(SWITCH_SELECTOR)] as HTMLButtonElement[];
    assert.ok(switches.length >= 2);
    for (const sw of switches) {
      assert.equal(sw.disabled, true, "writable=false 时开关 disabled");
    }
    const inputs = [...container.querySelectorAll(".dgc-input")] as HTMLInputElement[];
    for (const input of inputs) {
      assert.equal(input.disabled, true, "writable=false 时输入 disabled");
    }
  });

  it("额外密钥路径模式：textarea 多行输入，按行切分（含逗号的正则不被切碎）", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const calls: { field: string; value: unknown }[] = [];
    const scope = makeScope(snap(), calls);
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard: useCardOf({ status: "ready", writable: true, value: {} }),
        ...cardWrites(scope),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(".dgc-textarea");
    assert.ok(textarea, "密钥模式是 textarea（多行）");
    const propsKey = Object.keys(textarea).find((keyName) =>
      keyName.startsWith(REACT_PROPS_KEY_PREFIX),
    );
    assert.ok(propsKey !== undefined, REACT_PROPS_FOUND_MESSAGE);
    const record = textarea as unknown as Record<
      string,
      { onChange: (event: { target: { value: string } }) => void }
    >;
    await act(async () => {
      record[propsKey]!.onChange({ target: { value: "/id_dsa$|\\.p12$/i" } });
    });
    // 点「保存」落盘
    let save = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.ok(save, "保存按钮存在");
    await act(async () => {
      save!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const written = calls.find((call) => call.field === "extraSecretPatterns");
    assert.ok(written, "extraSecretPatterns 已写");
    assert.deepEqual(
      written.value,
      [String.raw`/id_dsa$|\.p12$/i`],
      "含逗号的正则保持单条（不被逗号切碎）",
    );
    // 两行输入 → 点保存 → 两条
    await act(async () => {
      record[propsKey]!.onChange({ target: { value: "/a{1,2}/\n/b/" } });
    });
    save = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    await act(async () => {
      save!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const secretCalls = calls.filter((call) => call.field === "extraSecretPatterns");
    const written2 = secretCalls.at(-1);
    assert.deepEqual(written2!.value, ["/a{1,2}/", "/b/"], "按行切分为两条");
  });

  it("四个强校验控件真实渲染（strictMode 开关 + 两个阈值数字框 + 层词表）并可写入正确字段", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const calls: { field: string; value: unknown }[] = [];
    const snapshot: CardView = {
      status: "ready",
      writable: true,
      value: {
        strictMode: true,
        smallEditChars: 120,
        bigEditChars: 3000,
        extraTestDirs: ["spec-cases"],
      },
    };
    const scope = makeScope(snap(snapshot), calls);
    const useCard = useCardOf(snapshot);
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard,
        ...cardWrites(scope),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });

    // 渲染存在性：一律按 data-field 锚点定位，不依赖行序与中文文案。
    const swStrict = container.querySelector<HTMLButtonElement>('[data-field="strictMode"]');
    assert.ok(swStrict, "strictMode 开关已渲染");
    assert.equal(swStrict.getAttribute("aria-checked"), "true", "快照 true → 开关呈开启态");
    const numSmall = container.querySelector<HTMLInputElement>('[data-field="smallEditChars"]');
    const numBig = container.querySelector<HTMLInputElement>('[data-field="bigEditChars"]');
    assert.ok(numSmall !== null && numBig !== null, "两个阈值数字框已渲染");
    assert.equal(numSmall.value, "120", "小改阈值回显快照值（而非 min 兜底）");
    assert.equal(numBig.value, "3000", "大改阈值回显快照值");
    const listExtra = container.querySelector<HTMLInputElement>('[data-field="extraTestDirs"]');
    assert.ok(listExtra !== null, "extraTestDirs 词表框已渲染");
    assert.match(listExtra.value, /spec-cases/u, "层词表回显数组内容");

    // 暂存①：点击开关 → 只暂存取反值（不直写）
    await act(async () => {
      swStrict.click();
    });
    assert.equal(calls.length, 0, "开关点击不直写（保存条模式）");

    // 暂存②：数字框经真实 onChange 链路入草稿（happy-dom 合成事件到不了 React 19
    // root 监听器，故直调 __reactProps 上的 onChange——见本文件上方说明）。
    await act(async () => {
      propsOf(numSmall).onChange({ target: { value: "80" } });
    });
    await act(async () => {
      propsOf(numBig).onChange({ target: { value: "9" } });
    });
    assert.equal(calls.length, 0, "数字输入不直写");

    // 越界不入草稿：min/max 是合法边界，不是兜底默认（写 0 < min=1 必须被拒）。
    await act(async () => {
      propsOf(numSmall).onChange({ target: { value: "0" } });
    });
    assert.equal(calls.length, 0, "低于 min 的值不暂存");

    // 点「保存」：三个暂存字段一次写入
    const save = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.ok(save, "保存按钮存在");
    await act(async () => {
      save.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(calls.find((call) => call.field === "strictMode")?.value, false, "开关写入取反值");
    assert.ok(
      calls.some((call) => call.field === "smallEditChars" && call.value === 80),
      "小改阈值写入 80",
    );
    assert.ok(
      calls.some((call) => call.field === "bigEditChars" && call.value === 9),
      "大改阈值写入 9",
    );
    assert.equal(calls.length, 3, "只写 3 个差异字段（extraTestDirs 未动）");
  });

  it("取证检索工具两行真实渲染，且事实门 hint 随生效名单派生", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const calls: { field: string; value: unknown }[] = [];
    const snapshot: CardView = {
      status: "ready",
      writable: true,
      value: { refSearchTools: ["grep", "rg_search"], refSearchStrictTools: ["rg_search"] },
    };
    const scope = makeScope(snap(snapshot), calls);
    const useCard = useCardOf(snapshot);
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard,
        ...cardWrites(scope),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });

    // 两个新字段各有控件（schema-coverage 只查"字段名出现过"，这里查真实回显）。
    const toolsBox = container.querySelector<HTMLInputElement>('[data-field="refSearchTools"]');
    const strictBox = container.querySelector<HTMLInputElement>(
      '[data-field="refSearchStrictTools"]',
    );
    assert.ok(toolsBox !== null && strictBox !== null, "检索工具两行已渲染");
    assert.match(toolsBox.value, /rg_search/u, "名单回显快照值");
    assert.match(strictBox.value, /rg_search/u, "严格子集回显快照值");

    // 事实门 hint 里的工具名来自同一份生效值——指令与门禁认的工具不能两张皮。
    const hint = hintTextOf("factGateEnabled");
    assert.match(hint, /rg_search/u, "hint 点名配置里的第三方检索工具");
    assert.doesNotMatch(hint, /glob|zg_search/u, "被移除的名字不再出现在 hint 里");
  });

  it("未配置检索工具名单时 hint 回落内置默认名单（与 host 判定同源）", async () => {
    const { DgCardForTest } = await loadCard();
    const useCard = useCardOf({ status: "ready", writable: true, value: {} });
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard,
        set: () => Promise.resolve(),
        unset: () => Promise.resolve(),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });
    const hint = hintTextOf("factGateEnabled");
    assert.match(hint, /grep/u);
    assert.match(hint, /glob/u);
    assert.match(hint, /zg_search/u, "默认名单含 zg_search（未装 zvec-grep 时也无害）");
  });

  // ── i18n：卡片文案取自官方 locale 字典（切语言 = 换 translator）──────────
  it("两语字典都注册到官方 locale，注册随 effect 回收", async () => {
    const { locales, effectDisposers } = await loadCard();
    assert.deepEqual(
      locales.map((row) => [row.ns, row.localeId]),
      [
        [GUARD_ENTRY_ID, "zh"],
        [GUARD_ENTRY_ID, "en"],
      ],
      "两语字典都注册到官方 locale",
    );
    assert.equal(locales[0]?.dict.cardTitle, UI_MESSAGES.zh.cardTitle);
    assert.equal(locales[1]?.dict.cardTitle, UI_MESSAGES.en.cardTitle);
    assert.equal(effectDisposers.length, 2, "样式 effect + locale 字典 effect 各一个");
    for (const dispose of effectDisposers) {
      dispose();
    }
    assert.equal(
      win.document.head.querySelector("#danger-guard-card-css"),
      null,
      "effect 回收后样式已摘掉",
    );
  });

  it("en translator 渲染整张卡片：标题/按钮是英文，且不残留汉字", async () => {
    const { DgCardForTest } = await loadCard();
    const useCard = useCardOf({ status: "ready", writable: true, value: {} });
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tEn,
        useCard,
        set: () => Promise.resolve(),
        unset: () => Promise.resolve(),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });
    const text = container.textContent;
    assert.match(text, /danger-guard danger block/u, "英文标题");
    assert.match(text, /Save/u, "英文保存按钮");
    assert.ok(!/\p{Script=Han}/u.test(text), "整卡不该混进汉字");
  });

  it("zh translator 渲染同一张卡片：中文标题在位（两语走同一渲染路径）", async () => {
    const { DgCardForTest } = await loadCard();
    const useCard = useCardOf({ status: "ready", writable: true, value: {} });
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard,
        set: () => Promise.resolve(),
        unset: () => Promise.resolve(),
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });
    assert.match(container.textContent, /危险拦截/u);
  });

  it("两语模板的 {占位符} 集合一致（翻译不会漏掉插值）", () => {
    for (const key of ["factGateHint", "smallHint", "bigHint", "refToolsHint"] as const) {
      assert.deepEqual(
        placeholders(UI_MESSAGES.en[key]),
        placeholders(UI_MESSAGES.zh[key]),
        `${key} 占位符不一致`,
      );
    }
  });

  // ── 0.1.7 装配契约：入口从 settingsScope 换成 ctx.configForms（迁移回归锚点）────
  it("0.1.7 装配：inject 列 configForms；表单按设置条目 id 取；payload 落到那张表单；disposer 不销毁表单", async () => {
    const { injectList, formEntryIds, formWrites, slotDescs, slotCleanups, payload } =
      await loadCard();
    // inject 清单就是装配契约：`settingsScope` 在 installed 0.1.7 全树零命中，留着它整条
    // client 入口挂不上（症状正是"设置卡静默消失"）。替代面 = configForms（installed
    // dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98 的 Context 增强、
    // :142 的 get<T>(entryId): ConfigForm<T>）。精确全等，不放宽为包含判定。
    assert.deepEqual(injectList, ["slots", "configForms", "locale"]);
    assert.ok(!injectList.includes("settingsScope"), "不得再索要已移除的 settingsScope 服务");
    // 只取一次，取的是 **bulkhead 里持有 Config 的那一行**（0.1.7 起命名空间 == 条目 id）。
    assert.deepEqual(formEntryIds, [SETTINGS_ENTRY_ID]);
    // 交叉核对装配文件：该 id 必须真是 cordis.patch.yml 里的一行，且**不是**拦截条目
    //（写到 `danger-guard` 上表单永远 unavailable，卡片变只读——命名空间一致性不能只靠注释）。
    const patch = await readFile(
      fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)),
      "utf8",
    );
    const entryIds = [...patch.matchAll(/^\s*(?:-\s+)?id:\s*(?<id>\S+)\s*$/gmu)].map(
      (row) => row.groups?.["id"] ?? "",
    );
    assert.ok(entryIds.includes(SETTINGS_ENTRY_ID), "cordis.patch.yml 里确有该设置条目");
    assert.notEqual(formEntryIds[0], GUARD_ENTRY_ID, "不得退回没有 Config 的拦截条目");
    // 槽 key = profile bundles 清单里本包那一条（从 ~/.dsh/profiles/web/package.json 解析，
    // 不在此硬抄）：installed dsh-client-ui-plugin-manager/lib/client.js:1821 派发
    // `entryKey: pkg.name`、:2698 `ledger.bundles.has(openPkg.name)`；
    // slot-contract.d.ts:96-100「keyed by the bundle's package name」；
    // dsh-client-ui-renderer/lib/client.js:1154 逐字相等匹配（错一个字符=卡片不渲染）。
    const bundlePkg = await profileBundleName();
    assert.deepEqual(slotDescs, [{ name: "plugins.bundle.config", key: bundlePkg }]);
    // 反向漂移钉：三条 bulkhead 串各归各位，谁也不许顶替谁。
    assert.equal(slotDescs.length, 1, "只登记一张 bundle 设置卡");
    assert.notEqual(
      slotDescs[0]?.key,
      GUARD_ENTRY_ID,
      "key 不得退回裸条目 id：0.1.7 迁移第一版正是这样，卡片在插件页面上根本不渲染",
    );
    assert.notEqual(slotDescs[0]?.key, SETTINGS_ENTRY_ID, "key 也不是设置条目 id");
    assert.ok(
      typeof slotDescs[0]?.key === "string" && !slotDescs[0].key.includes("#"),
      "bundle 槽的 key 不含 #（<pkg>#<rowId> 是 plugins.row.config 的写法）",
    );
    // 正反向同时钉住 bulkhead 的两行：设置命名空间 = **设置行**（name 为子路径导出）的 id，
    // slot key = **bundle 行**（name 恰为包名）的包名。两条规则不同源，正是本包的特殊处。
    const rows = await patchRows();
    const bundleRow = rows.find((row) => row.name === bundlePkg);
    const settingsRow = rows.find((row) => row.name === `${bundlePkg}/settings`);
    assert.ok(bundleRow !== undefined, "cordis.patch.yml 有 bundle 行（name = 包名）");
    assert.ok(settingsRow !== undefined, "cordis.patch.yml 有设置行（name = 包名/settings）");
    assert.deepEqual(
      formEntryIds,
      [settingsRow.id],
      "表单取的是设置行 id（bulkhead 里持有 Config 的那一行）",
    );
    assert.notEqual(bundleRow.id, settingsRow.id, "两行条目 id 不同：key 与命名空间不能混用");

    assert.ok(payload !== null, "slots.register 收到 payload");
    const write = payload as {
      hooks: { card: unknown };
      set: (field: string, value: unknown) => Promise<unknown>;
      unset: (field: string) => Promise<unknown>;
    };
    assert.notEqual(write.hooks.card, undefined, "hooks.card 仍在（框架映射成 useCard prop）");
    const setResult = write.set("maxDenies", 4);
    const unsetResult = write.unset("strictMode");
    assert.ok(setResult instanceof Promise && unsetResult instanceof Promise, "iface 交出 Promise");
    // 0.1.7 的受理位（Promise<boolean>）在 payload 处被 await 掉、**不外泄**给卡片：
    // 卡片沿用 0.1.6 的 Promise<void> 形状，此次迁移只换入口不改行为。
    assert.equal(await setResult, undefined, "payload.set 不外泄受理位");
    assert.equal(await unsetResult, undefined, "payload.unset 不外泄受理位");
    assert.deepEqual(
      formWrites,
      [
        { field: "maxDenies", value: 4 },
        { field: "strictMode", value: undefined },
      ],
      "payload 的写入必须落到 configForms.get() 交回的那张表单",
    );
    // slot disposer：只注销登记。`form.dispose` 是抛错绊线——loadCard 已就地调过一次
    //（没炸即证明 disposer 没销毁表单），这里再调一次确认幂等且不碰表单。
    assert.equal(slotCleanups.length, 1, "slots.inject 工厂产出一个 disposer");
    for (const cleanup of slotCleanups) {
      assert.doesNotThrow(() => {
        cleanup();
      }, "再次清理也不得销毁 provider 持有的共享表单（0.1.7 ConfigForm 无 dispose）");
    }
  });

  it("表单写入因传输失败 reject → 卡片显示保存失败并留住草稿（受理位之外的唯一失败面）", async () => {
    const { DgCardForTest, makeScope } = await loadCard();
    const scope = makeScope(snap({ value: { enabled: true } }), []);
    await renderCard(
      React.createElement(DgCardForTest, {
        t: tZh,
        useCard: useCardOf({ status: "ready", writable: true, value: { enabled: true } }),
        ...cardWrites(scope),
        // 传输失败（installed config-form-types.d.ts:63 的 reject 路径）：卡片必须把它
        // 呈现成可见错误，而不是"看起来已保存"。（写在 spread 之后才盖得住默认写入口。）
        set: async (): Promise<void> => {
          await failingSet();
        },
      }),
    );
    await act(async () => {
      container.querySelector<HTMLElement>(HEADER_SELECTOR)!.click();
    });
    const sw = container.querySelector<HTMLButtonElement>(SWITCH_SELECTOR);
    assert.ok(sw);
    await act(async () => {
      sw.click();
    });
    const save = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.ok(save, "保存按钮存在");
    await act(async () => {
      save.click();
    });
    const err = container.querySelector<HTMLElement>(".dgc-saveerr");
    assert.ok(err, "传输失败呈现为可见错误");
    assert.match(err.textContent, /保存失败/u, "错误文案取 saveFailed 键");
    assert.match(err.textContent, /wire down/u, "底层原因原样带出");
    assert.equal(
      container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR)?.disabled,
      false,
      "草稿留住：保存失败后仍可重试（touched 未被清空）",
    );
  });
});
