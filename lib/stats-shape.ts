// lib/stats-shape.ts —— 判定统计快照的**形状**（零依赖叶子模块）。
//
// 为什么单列：产它的 `lib/judge-stats.ts` 导入 `lib/danger-rules.ts`（带 `node:os` /
// `node:path`），而**客户端**（设置卡的读数块）要读这份形状 —— 从 judge-stats 借类型会把
// 那张 node 依赖拖进客户端类型程序（实测 TS2591：`Cannot find name 'node:os'`）。
// 与 `lib/fix.ts` 是**同一条教训**：给客户端消费的形状必须住在没有运行期依赖的叶子上。
//
// 本模块只有类型，所以它对产物字节数的贡献是零。

/** 一份可读的判定统计快照：纯 JSON 值（跨 Remote 边界只能是 JSON，见官方
 *  `isRemoteJsonValue`），键一律是字符串，值一律是数字或对象。 */
export interface StatsSnapshot {
  /** 判定次数（按面：`bash` / `secret` / `fact`）。 */
  readonly calls: Readonly<Record<string, number>>;
  /** 其中的慢判定次数（≥ `slowMs`，按面）。 */
  readonly slow: Readonly<Record<string, number>>;
  /** `deny` 档的规则键命中次数（按键）。 */
  readonly hits: Readonly<Record<string, number>>;
  /** `ask` 档的命中次数（按键）：这些是**问过用户**的，不是拒掉的。 */
  readonly asks: Readonly<Record<string, number>>;
  /** 事实门配额放行次数。 */
  readonly quotaReleases: number;
  /** 慢判定的告警线（ms）与成本采样的滚动窗口 —— 数字本身要说得出，用户才知道阈值在哪。 */
  readonly slowMs: number;
  readonly window: number;
}
