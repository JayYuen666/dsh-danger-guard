// 设置面的单一来源：条目 schema + 内置默认底座 + 命名空间常量 + 值面快照。
//
// 为什么单独成文件（而不是留在 host.ts）：0.1.7 的 bulkhead 把「设置面」与「拦截面」拆成
// 两个 profile 条目（见 README「两个条目」与 cordis.patch.yml）。cordis 在 **apply 之前**
// 校验条目自己的 Config（vendor/cordis/src/fiber.ts:50 `resolveConfig`、:641-664 `_reload`），
// 越界值会让**该条目**FAILED。拦截半因此不能再挂 Config——它挂的就是这份严格 schema，
// 一行笔误就能让整道安全闸门下线。schema 归设置条目（settings-host.ts）持有，
// 两个产物各自内联本文件（仓内单源，产物各一份），谁也不 import 谁。
//
// ⚠ 依赖必须是宿主 fork `@deepseek-ai/schemastery`（quality-gate / ctx-observe 同款）：
//   1) 只有 fork 有原生 `.volatile()`（vendor/schemastery/src/index.ts:480-482 即
//      `extra('volatile', true)`，宿主投影只认这个键：packages/settings/settings/src/schema.ts:37-47）；
//   2) 公共 schemastery@3.18 与 fork 都往全局 `Schemastery` 命名空间里塞声明，混用时
//      `Schema.boolean()` 的返回类型是 fork 的三元 `Schema<S, T, Mode>`，喂不进公共包的
//      二元 `Schema<S, T>`（实测 TS2379 成片）。所以这里只用 fork，不留手写 meta 的中间层。
import Schema from "@deepseek-ai/schemastery";
import type { Volatile } from "@deepseek-ai/cordis";
import {
  DEFAULT_BIG_EDIT_CHARS,
  DEFAULT_MAX_DENIES,
  DEFAULT_SMALL_EDIT_CHARS,
} from "./fact-gate.ts";
// 检索取证默认名单：与指令文案兜底、client hint 兜底共用同一份（见 BUILTIN_BASE）。
import { DEFAULT_REF_SEARCH_STRICT_TOOLS, DEFAULT_REF_SEARCH_TOOLS } from "./ref-search-policy.ts";

/** 设置命名空间 == 持有本 schema 的那个 profile 条目 id。0.1.7 起没有 register：
 *  宿主从条目导出的 `Config` 隐式注册，命名直接取 `entry.options.id`
 *  （packages/settings/settings/src/index.ts:315 与 :326），写入侧也按同一个
 *  `options.id === ns` 找回条目（:382，找不到即抛 `No configurable plugin entry`）。
 *  卡片侧读/写用的是 `ctx.configForms.get(条目 id)`（见 src/client-entry.ts）——
 *  0.1.6 那套 `settingsScope.bind({ namespace })` 已随宿主移除，别再照这里写回去。 */
export const SETTINGS_NS = "danger-guard-settings";

/** 设置条目向拦截半暴露值面的服务名（`ctx.provide` / `ctx.get` 的官方可选读法：
 *  未提供时 `ctx.get(name)` 返回 undefined 而不抛错——拦截半据此判定"设置面不在"。
 *  刻意不叫 danger-guard：名字要说明它是**值面读数口**，不是闸门本身。 */
export const SETTINGS_READER = "dangerGuardSettings";

/** 内置默认底座：0.1.6 交给 `settings.register(ns, schema, { base })` 的那一份，
 *  0.1.7 逐字段落成下面 ConfigSchema 的 `.default(...)`（数组默认值必须是完整清单：
 *  数组整体替换、不做增量合并，settings/index.ts:175-185）。单源留在本处，
 *  schema 与降级读取（numOf/strArray）都引用它，防两处漂移。
 *  ⚠ 设置条目 FAILED / 不在组合里时，拦截半就落回这份——它必须永远是"闸门开着"那一组值。 */
export const BUILTIN_BASE: Config = {
  enabled: true,
  // 事实门独立开关：不想要首次编辑强制取证时关掉（默认开）。
  factGateEnabled: true,
  maxDenies: DEFAULT_MAX_DENIES,
  strictMode: false,
  smallEditChars: DEFAULT_SMALL_EDIT_CHARS,
  bigEditChars: DEFAULT_BIG_EDIT_CHARS,
  extraTestDirs: [],
  extraDevServerWords: [],
  extraDevRunArgs: [],
  extraSecretPatterns: [],
  // 检索取证默认名单（单源在 lib/ref-search-policy.ts，与指令文案兜底、client hint 兜底共用）。
  refSearchTools: [...DEFAULT_REF_SEARCH_TOOLS],
  refSearchStrictTools: [...DEFAULT_REF_SEARCH_STRICT_TOOLS],
};

/** 消费侧（拦截半与全部判定链）看到的配置形状：plain 值，不含宿主引用。 */
export interface Config {
  enabled: boolean;
  factGateEnabled: boolean;
  /** 连续无证据拒绝多少次后放行 + 警告（强校验防死锁；设置卡可调，默认 2）。 */
  maxDenies: number;
  /** 严格模式：忽略分档，每个代码文件首次编辑都走全探查（read+refs+所有存在层）。 */
  strictMode: boolean;
  /** 写面 ≤ 此字符数且不含签名关键字 → low 档（只要 read）。 */
  smallEditChars: number;
  /** 写面 > 此字符数 → high 档（大段重写，全探查）。 */
  bigEditChars: number;
  /** 追加的测试层目录名（并入内置层名词表）。 */
  extraTestDirs: string[];
  extraDevServerWords: string[];
  extraDevRunArgs: string[];
  extraSecretPatterns: string[];
  /**
   * 可作为**引用取证**凭证的检索工具名（默认 grep/glob/zg_search = 修复前的硬编码集合）。
   * 只有列在这里的名字才给凭证：第三方检索工具要计入取证，就把它的工具名加进来。
   */
  refSearchTools: string[];
  /** refSearchTools 里改走「严格相对路径」口径（root + query/fts/vector）的子集。 */
  refSearchStrictTools: string[];
}

/** 设置条目 apply 收到的值面：全字段 volatile ⇒ 宿主一律以 `Volatile<T>` 引用交付
 *  （vendor/cosmokit/src/volatile.ts，fork 的 resolve 见 vendor/schemastery/src/index.ts:521-526）。
 *  引用即"现读"：设置卡改完，下一次 `.get()` 就是新值，不需要重载插件。
 *  官方同型声明见 packages/core/agent-default-model/src/index.ts:24-31。 */
export interface ConfigRefs {
  enabled: Volatile<boolean>;
  factGateEnabled: Volatile<boolean>;
  maxDenies: Volatile<number>;
  strictMode: Volatile<boolean>;
  smallEditChars: Volatile<number>;
  bigEditChars: Volatile<number>;
  extraTestDirs: Volatile<string[]>;
  extraDevServerWords: Volatile<string[]>;
  extraDevRunArgs: Volatile<string[]>;
  extraSecretPatterns: Volatile<string[]>;
  refSearchTools: Volatile<string[]>;
  refSearchStrictTools: Volatile<string[]>;
}

/** 把值面（引用）落成一次判定用的 plain Config：下游判定链因此一行不改、也不持有宿主引用。
 *  官方同款读法见 quality-gate/host.ts 的 `settingsOf(config)`（逐字段 `.get()`）。
 *  数组字段一律 `[...]` 复制：`Volatile<T>.get()` 对对象返回 `VolatileSnapshot<T>`
 *  （@deepseek-ai/cosmokit 的 volatile.d.ts:3-9 ⇒ `readonly string[]`），而消费侧要的是
 *  可变 `string[]`；复制顺带保证"每次调用现取"的快照不被下游就地改写。 */
export function snapshot(config: ConfigRefs): Config {
  return {
    enabled: config.enabled.get(),
    factGateEnabled: config.factGateEnabled.get(),
    maxDenies: config.maxDenies.get(),
    strictMode: config.strictMode.get(),
    smallEditChars: config.smallEditChars.get(),
    bigEditChars: config.bigEditChars.get(),
    extraTestDirs: [...config.extraTestDirs.get()],
    extraDevServerWords: [...config.extraDevServerWords.get()],
    extraDevRunArgs: [...config.extraDevRunArgs.get()],
    extraSecretPatterns: [...config.extraSecretPatterns.get()],
    refSearchTools: [...config.refSearchTools.get()],
    refSearchStrictTools: [...config.refSearchStrictTools.get()],
  };
}

/** 设置条目的 Config schema（= 设置命名空间的表单投影 + 行 config 的校验门槛）。
 *  约束一项不减：`maxDenies` 的 1..5、`smallEditChars ≥ 1`、`bigEditChars ≥ 2`
 *  既是行 config 的门槛，也是宿主写回前的校验门槛（settings/index.ts:399-409
 *  validatePaths → 完整 Config 校验；写回另有 config-editor 的 `resolveConfig` 一遍）。
 *  ⚠ 这份严格 schema 现在**只**挂在设置条目上：它校验失败只可能让设置面下线，
 *  拦危险命令的是另一个条目（host.ts），那条路上没有任何用户可编辑的 Config。 */
export const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(BUILTIN_BASE.enabled).volatile(),
  factGateEnabled: Schema.boolean().default(BUILTIN_BASE.factGateEnabled).volatile(),
  maxDenies: Schema.natural().min(1).max(5).default(BUILTIN_BASE.maxDenies).volatile(),
  strictMode: Schema.boolean().default(BUILTIN_BASE.strictMode).volatile(),
  smallEditChars: Schema.natural().min(1).default(BUILTIN_BASE.smallEditChars).volatile(),
  bigEditChars: Schema.natural().min(2).default(BUILTIN_BASE.bigEditChars).volatile(),
  extraTestDirs: Schema.array(String)
    .default([...BUILTIN_BASE.extraTestDirs])
    .volatile(),
  // v6 词表可配置化：用户可扩充危险面（默认空 = 只用内置词表）。
  extraDevServerWords: Schema.array(String)
    .default([...BUILTIN_BASE.extraDevServerWords])
    .volatile(),
  extraDevRunArgs: Schema.array(String)
    .default([...BUILTIN_BASE.extraDevRunArgs])
    .volatile(),
  extraSecretPatterns: Schema.array(String)
    .default([...BUILTIN_BASE.extraSecretPatterns])
    .volatile(),
  // 引用取证的凭证面：可计入的检索工具名 + 其中走严格相对路径口径的子集。
  // 默认值即修复前 host 里写死的那三个名字与那条 zg_search 分支（判定逐条不变）。
  refSearchTools: Schema.array(String)
    .default([...BUILTIN_BASE.refSearchTools])
    .volatile(),
  refSearchStrictTools: Schema.array(String)
    .default([...BUILTIN_BASE.refSearchStrictTools])
    .volatile(),
});
