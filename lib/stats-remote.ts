// lib/stats-remote.ts —— 判定统计的**客户端读面**（官方 Typert Remote）。
//
// 为什么需要一条 Remote：设置卡跑在**浏览器**里，而统计是宿主进程的内存。设置面**没有**
// "宿主计算值"的口子（`ctx.settings` 只有 configure/describe/update/replace/mutate，没有
// 贡献只读描述符的 API），所以唯一的官方通道就是 Typert Remote —— 官方
// `permission-presets` 正是这么把进程级目录交给客户端 UI 的。
//
// 为什么**手写 descriptor 而不跑生成器**：`TypertCodec` 有一个 `{ mode: "src-json" }` 变体
// （源码模式），它既不需要 `typeSymbol` 也不需要 `create()` —— 而这两样正是生成器的产物。
// 本服务只有一个**无参、一元、JSON 结果**的方法，手写它的 descriptor 比引入一条构建期
// 代码生成链（外加生成物随包发布）便宜得多。
//
// ⚠ 值导入面：`TypertRemoteService` 是个**类**（要 `extends`），没有 type-only 的造法 ——
// 与 `dsh-brand` 的 `brandNumber` 同族。它因此落 `peerDependencies`（`dependencies` 是
// 禁区，由 `test/publish-manifest.test.ts` 钉着），产物里保持**裸说明符**（`build-host.mjs`
// 的外部化名单读 dependencies ∪ peerDependencies）。

import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

import { statsSnapshot } from "./judge-stats.ts";
import type { StatsSnapshot } from "./judge-stats.ts";

/** 客户端侧的**服务键 = 线上命名空间**（`TypertGatewayBindingOptions.namespace` 缺省取服务键，
 *  所以这里只能有一个串）。它与设置命名空间、卡片槽位键各不相干。
 *  `src/client-entry.ts` 的读取器与 `$mount` 的 descriptor 都引它，改这里两处一起走。 */
export const STATS_SERVICE_KEY = "dangerGuardStats";

/**
 * 判定统计的读面。挂在**拦截半**（`host.ts`）上而不是设置半：统计是模块级状态，而
 * `host.js` 与 `settings.js` 是两个**各自内联一份 `lib/`** 的产物 —— 挂在设置半上，
 * 它读到的是那个产物里**另一份**、永远是空的表。
 *
 * 服务在**构造时**注册（cordis `Service` 的契约：`ctx.reflect.provide`，随所属 fiber 卸载
 * 自动撤）。
 */
export class DangerGuardStatsService extends TypertRemoteService {
  public constructor(ctx: Context) {
    super(ctx, STATS_SERVICE_KEY);
  }

  /**
   * 一份判定统计快照。**无参、一元、JSON 结果** —— 手写 descriptor 之所以成立就是因为
   * 只有这一个形状（带参数或流式都要过生成器那套 codec）。
   */
  // ⚠ 这一枚**必须是实例方法**：`remoteMethods()` 读的是类**原型**上的描述符
  //（`Object.getOwnPropertyDescriptor(prototype, …)`），静态方法落不到那儿 —— 而它自己不碰
  //  `this`，所以 `class-methods-use-this` 会红（disable 压在那一行上，见下）。
  // oxlint-disable-next-line eslint/new-cap -- `@Remote(…)` 是装饰器工厂，不是大写开头的构造调用；lint 在装饰器语法上看不出这件事
  @Remote("stats")
  // oxlint-disable-next-line eslint/class-methods-use-this -- 理由见上（且注释不能挪到装饰器之上：disable 必须紧挨它压的那一行）
  public stats(): StatsSnapshot {
    return statsSnapshot();
  }
}

/** 这个上下文能注册服务吗（只探"可不可调"一位 —— 见 installStatsRemote 的说明）。 */
const hasServiceRegistry = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  const { reflect } = value;
  return isRecord(reflect) && typeof reflect["provide"] === "function";
};

/**
 * 把读面装到这个上下文上（构造即注册，见类文档；host 侧唯一该调的口）。
 *
 * 为什么是一枚函数而不是让调用方直接 `new`：这枚 `new` 的**全部意义在构造期的注册副作用**
 * 上 —— 实例由 cordis 的 fiber 持有（`Service` 基类把 `reflect.provide` 的 disposer 挂给
 * fiber），调用方拿到它没有任何用处。所以这里就地说明这一点，而不是在 `host.ts` 的 `apply`
 * 里留一枚"看起来漏了赋值"的 `new`。
 *
 * ⚠ 它是**可选读面**，所以本函数自己先探注册口（`ctx.reflect.provide`）：真宿主里 `reflect`
 * 恒在（cordis `Context` 的核心成员，context.d.ts:29），而替身/畸形上下文未必给 —— 少了它
 * 只该少一栏统计展示，绝不该让闸门下线。这与 `fs` / `sessionProjections` / `workingDirectory`
 * 那四处同一条口径：**拦截面绝不因读数面缺失而下线**（多探一项 = 多给闸门一条失败路径）。
 *
 * @param ctx - 宿主上下文
 * @returns 装上了没有（调用方不需要它 —— 返回它只是让这条路可断言；本包只作**可选**读面用）
 */
export function installStatsRemote(ctx: Context): boolean {
  if (!hasServiceRegistry(ctx)) {
    return false;
  }
  // oxlint-disable-next-line eslint/no-new -- 见函数文档：构造即注册，返回值无意义
  new DangerGuardStatsService(ctx);
  return true;
}
