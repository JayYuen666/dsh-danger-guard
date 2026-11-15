// lib/instance-guard.ts —— 拦截半的单实例判据（market 热挂 + bundle 层双路径）。
//
// 为什么需要它：dshmarket 在运行期热装插件时，会在 `<profile>/.dsh-market/` 下造一棵 market
// 自己的 Include 子树（条目 id 形如 `mkt-<包>`），把**同一份 host.js** 再挂一次；而 profile 的
// `dsh.profile.bundles` 那条 bundle 行仍会被宿主按 patch 重新组装。两条层条目解析到同一个模块
// 实例，却各起一个 fiber、各跑一次 `apply`。
//
// 本包的失败形态与「工具重名直接抛」那几仓不同：`tools.guard` 是 `append`（不去重、不抛），
// 事件监听也是各挂一份，所以第二遍**不会报错**——它只是让同一个判定被执行两遍、上报翻倍。
// 静默的重复比「启动失败」更难发现，因此这里同样让后到的那一份整份让路：功能由先到的那一份
// 提供，两份的装配参数来自同一份配置，让路不丢任何能力。
//
// 判据本体是 shared 的 `claimInstance`（`@jayyuen66/dsh-plugin-shared/lib/instance-lock`）；
// 本文件只负责「本包的键 + 让路日志 + 上下文取法」，把这三样挡在 `host.ts` 之外也是必要的：
// 那一份正卡在 `eslint/max-lines`（2000）与 `max-lines-per-function`（120）两道门的余量边缘。

import { claimInstance } from "@jayyuen66/dsh-plugin-shared/lib/instance-lock";

/** 单实例锁的键：只有本包会用这个名字，不带随机后缀——它就是这把锁的身份。 */
export const INSTANCE_LOCK_KEY = "@jayyuen66/dsh-danger-guard/instance";

/** 抢锁所需的上下文面：读服务的 `get` 与注册口 `reflect`，两位都可选。 */
export interface InstanceGuardContext {
  readonly get?: ((name: string) => unknown) | undefined;
  readonly reflect?:
    | { readonly provide?: ((name: string, value?: unknown) => unknown) | undefined }
    | undefined;
}

/**
 * 本次装配是否该继续。
 *
 * @param ctx - 宿主上下文（只用到 `get` 与 `reflect`）
 * @returns true = 本作用域里还没有本包（继续装配）；false = 已有一份在册（本次让路）
 */
export function claimSingleInstance(ctx: InstanceGuardContext): boolean {
  // `get` 缺席 = 这个上下文不提供读服务的能力（替身上下文、精简宿主）。此时无从判断重复，
  // 按「能力缺席不拦功能」放行——与 `claimInstance` 对缺注册口的处理同一档。
  const readOf = ctx.get;
  const claimed = claimInstance(
    {
      get: readOf === undefined ? (): unknown => undefined : (name: string) => readOf(name),
      reflect: ctx.reflect,
    },
    INSTANCE_LOCK_KEY,
  );
  if (!claimed) {
    console.warn(
      "[danger-guard] 检测到本插件已在同一作用域内装载：本次装配让路，拦截与统计由在册的那一份提供。",
    );
  }
  return claimed;
}
