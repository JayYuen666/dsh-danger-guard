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
import { ConfigSchema, SETTINGS_READER, snapshot } from "./lib/settings-schema.ts";
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
  effect: (factory: () => (() => void) | undefined, label?: string) => void;
  /** configure 的 owner 必须是**本条目**的 fiber；provide 挂在这里、由拦截半跨条目读。
   *  取官方 `Fiber` 而非 `unknown`：手抄成 unknown 时 :81 传什么都编译得过。 */
  fiber: Fiber;
  provide: (name: string, value: unknown) => () => void;
}

/** 设置条目的服务面守卫：只探它真正调用的那几件（configure / provide / effect / fiber）。
 *  ⚠ 缺项即抛：cordis 把**本条目**判 FAILED，设置页没了——但拦截半不受影响，
 *  它读不到读数口就落回内置默认底座（这正是分家的意义）。 */
function isSettingsHost(value: unknown): value is Context & SettingsHostCtx {
  if (!isRecord(value)) {
    return false;
  }
  const { settings, effect, fiber, provide } = value;
  if (typeof effect !== "function" || typeof provide !== "function" || !isRecord(fiber)) {
    return false;
  }
  return isRecord(settings) && typeof settings["configure"] === "function";
}

/**
 * 装配设置条目：声明页面策略 + 挂出值面读数口。
 * @param ctx 宿主上下文
 * @param config cordis 按 ConfigSchema 校验并补默认后的值面（volatile 引用，现读即最新值）
 */
export function apply(ctx: Context, config: ConfigRefs): void {
  if (!isSettingsHost(ctx)) {
    throw new Error("[danger-guard] settings entry: settings.configure/provide surface missing");
  }
  const svc: SettingsHostCtx = ctx;
  const reader: SettingsReader = { read: () => snapshot(config) };
  // provide 与页面策略都走 effect：条目重载/卸载时随 fiber 回收，不留上一份读数的幽灵。
  svc.effect(() => svc.provide(SETTINGS_READER, reader), "danger-guard-settings: value reader");
  svc.effect(
    () => svc.settings.configure({ auto: false }, svc.fiber),
    "danger-guard-settings: page policy",
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
