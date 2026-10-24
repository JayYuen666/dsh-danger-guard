// danger-guard host 半（**设置条目**，profile 条目 id `danger-guard-settings`）。
//
// 这一半只干两件事：持有那份**严格**的用户可编辑 schema，并把解析后的值面交给拦截半。
// 为什么必须与拦截半分家（bulkhead / 隔舱）：
//  - 0.1.7 的 cordis 在 `apply` **之前**校验条目自己的 Config
//    （vendor/cordis/src/fiber.ts:50 `resolveConfig`、:641-664 `_reload`）；越界值
//    （`maxDenies: 0`）直接让该条目 FAILED，apply 根本不跑。
//  - 那份 Config 挂在拦截半上 = 一行手改坏的 profile 就能让危险命令闸门整体下线；
//    0.1.6 不是这样（注册抛错被捕获、退回内置底座，闸门继续拦）。
//  - 两条目互不相干：本条目 FAILED 时不 `provide` 值面，拦截半 `ctx.get` 读到
//    undefined → 回落 BUILTIN_BASE → 闸门照常拦（host.ts 的 settingsConfig 钉住这条路径）。
//  拦截逻辑一行不在此处：见 host.ts。
//
// 本条目的 `config:` 层（用户层 / 组合包层）就是设置的存放处；写回由设置卡经
// `settings.update('danger-guard-settings', …)` 走 configEditor——同一次写回还会用本
// schema 再校验一遍（packages/boot/config-editor/src/index.ts:92 `resolveConfig`），
// 越界当场抛错，所以严格档仍在**写入边界**生效，不是"配了没生效"。

import type { Context, Fiber } from "@deepseek-ai/cordis";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
import {
  BUILTIN_BASE,
  ConfigSchema,
  SETTINGS_NS,
  SETTINGS_READER,
  snapshot,
} from "./lib/settings-schema.ts";
import type { Config, ConfigRefs } from "./lib/settings-schema.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 页面策略面：本包自带卡片页，关掉宿主的自动生成分页。签名整体取官方成员——
 *  手抄成 `owner?: unknown` 比官方（`configure(presentation, owner?: Fiber)`，
 *  dsh-settings index.d.ts:80-82）松，传错 owner 编译期抓不到。 */
type SettingsService = Pick<SettingsForms, "configure">;

/** 值面读数口（拦截半经 `ctx.get(SETTINGS_READER)` 取用）。 */
export interface SettingsReader {
  read: () => Config;
}

/** 设置条目的宿主服务面（只取类型，不值导入 @deepseek-ai/*：`import type` 会被完全
 *  擦除，产物里仍是裸说明符，由宿主提供实现）。 */
interface SettingsHostCtx {
  settings: SettingsService;
  /** 官方效应面（`interface Context extends Pick<Fiber, 'effect'>`，installed
   *  `@deepseek-ai/cordis/lib/types/fiber.d.ts:8`；返回域 `SyncEffect`/`Effect`
   *  **不受理 `undefined`**，见 host.ts 的 NOOP_DISPOSER 注释）。此前这里是手抄镜像
   *  `(factory: () => (() => void) | undefined, label?) => void`——比官方宽出 undefined
   *  一档，是 0.1.6→0.1.7 迁移的遗漏：host.ts 同期已改绑官方并记下同一处分歧，这里补齐。
   *  下面两支工厂都返回官方 `() => void` 形状的 disposer，运行时行为逐字不变。 */
  effect: Context["effect"];
  /** configure 的 owner 必须是**本条目**的 fiber；provide 挂在这里、由拦截半跨条目读。
   *  取官方 `Fiber` 而非 `unknown`：手抄成 unknown 时 :81 传什么都编译得过。 */
  fiber: Fiber;
  /** 官方 provide（installed `@deepseek-ai/cordis/lib/types/reflect.d.ts:41/:43`）：
   *  服务名在 Context 命名面之外时落 `(name: string, value?: any): () => void` 兜底臂，
   *  返回恰是撤册 disposer——与手抄版 `(name, value) => () => void` 逐字同形，按官方成员收。 */
  provide: Context["provide"];
}

/** 设置条目的服务面守卫：只探它真正调用的那几件（configure / provide / effect / fiber）。
 *  谓词只声明 `SettingsHostCtx`：真正证明的只有这几位，把值收窄成完整的
 *  `Context & SettingsHostCtx` 会替类型系统编造没验过的成员。
 *  ⚠ 缺项即抛：cordis 把**本条目**判 FAILED，设置页没了——但拦截半不受影响，
 *  它读不到读数口就落回内置默认底座（这正是分家的意义）。 */
function isSettingsHost(value: unknown): value is SettingsHostCtx {
  if (!isRecord(value)) {
    return false;
  }
  const { settings, effect, fiber, provide } = value;
  if (typeof effect !== "function" || typeof provide !== "function" || !isRecord(fiber)) {
    return false;
  }
  return isRecord(settings) && typeof settings["configure"] === "function";
}

/** 值面守卫：每个设置字段都必须是带 `get()` 的引用（`ConfigRefs` 的全部键）。
 *  宿主交来 plain 值（0.1.6→0.1.7 迁移期踩过的形状错）时，`snapshot(config)` 的
 *  `.get is not a function` 会拖到**拦截半第一次工具调用**才爆——那时 host 的读数口
 *  没有 try/catch，等于闸门每次调用都抛。在 apply 阶段就点名，本条目 FAILED、读数口
 *  不 provide，拦截半自然回落 BUILTIN_BASE（分家设计的既定路径）。 */
function isConfigRefs(value: unknown): value is ConfigRefs {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(BUILTIN_BASE).every((key) => {
    const ref: unknown = value[key];
    return isRecord(ref) && typeof ref["get"] === "function";
  });
}

/**
 * 装配设置条目：声明页面策略 + 挂出值面读数口。
 * @param ctx 宿主上下文
 * @param config cordis 按 ConfigSchema 校验并补默认后的值面（volatile 引用，现读即最新值）
 */
export function apply(ctx: Context, config: ConfigRefs): void {
  if (!isSettingsHost(ctx)) {
    throw new Error(
      "[danger-guard] settings entry: cordis service surface missing (settings.configure / provide / effect / fiber)",
    );
  }
  if (!isConfigRefs(config)) {
    throw new Error(
      "[danger-guard] settings entry: config value face is not a reference surface (every field must carry get())",
    );
  }
  const svc: SettingsHostCtx = ctx;
  const reader: SettingsReader = { read: () => snapshot(config) };
  // provide 与页面策略都走 effect：条目重载/卸载时随 fiber 回收，不留上一份读数的幽灵。
  // label 的条目 id 复用 SETTINGS_NS（单源在 lib/settings-schema.ts），不再手写字面量。
  svc.effect(() => svc.provide(SETTINGS_READER, reader), `${SETTINGS_NS}: value reader`);
  svc.effect(
    () => svc.settings.configure({ auto: false }, svc.fiber),
    `${SETTINGS_NS}: page policy`,
  );
}

// 设置面（schema / Config 形状）单源在 lib/settings-schema.ts；本条目持有它，也自用一次
// （default 导出的 Config 键），故 import 与 export 各写一次。
export { ConfigSchema } from "./lib/settings-schema.ts";
export type { Config } from "./lib/settings-schema.ts";

export default {
  inject: ["settings"],
  Config: ConfigSchema,
  apply,
};
