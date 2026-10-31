// lib/stats-shape.ts —— 判定统计快照的**形状**（零依赖叶子模块）。
//
// 为什么单列：产它的 `lib/judge-stats.ts` 导入 `lib/danger-rules.ts`（带 `node:os` /
// `node:path`），而**客户端**（设置卡的读数块）要读这份形状 —— 从 judge-stats 借类型会把
// 那张 node 依赖拖进客户端类型程序（实测 TS2591：`Cannot find name 'node:os'`）。
// 与 `lib/fix.ts` 是**同一条教训**：给客户端消费的形状必须住在没有运行期依赖的叶子上。
//
// 本模块只有类型，所以它对产物字节数的贡献是零。

/** 一份可读的判定统计快照：跨 Remote 边界只能是 JSON，键一律是字符串，值一律是数字。
 *  **生产侧必须只写有限非负整数**：`NaN`/`Infinity` 在类型上放得过、却不是合法 JSON
 *  数值，序列化会变 `null`。消费侧的守卫在 `src/stats-reader.ts` 的
 *  `STATS_SNAPSHOT_SCHEMA`（`z.number().int().nonnegative()`），计数面新增写入点时
 *  不要破坏这条约定。 */
export interface StatsSnapshot {
  /** 判定次数（按面：`bash` / `secret`；面名由调用点的 `JudgeCost` 给出）。 */
  readonly calls: Readonly<Record<string, number>>;
  /** 其中的慢判定次数（≥ `slowMs`，按面）。 */
  readonly slow: Readonly<Record<string, number>>;
  /** `deny` 档的规则键命中次数（按键）。 */
  readonly hits: Readonly<Record<string, number>>;
  /** `ask` 档的命中次数（按键）：这些是**问过用户**的，不是拒掉的。它不等于
   *  "用户被问过几次"——同一命令重复命中的那些次不算进来（见 `skipped`）。 */
  readonly asks: Readonly<Record<string, number>>;
  /** "看见了但没拦"的命中（按**规则键**；按档位汇总的是下一格）。这一格**不专指**
   *  完全权限档的零兜底：自动审查档交给 reviewer 的命中、已退役规则（长驻服务器）
   *  的命中同样计入——读它是「这一档总共放过多少」，不是「用户选了完全不拦」。 */
  readonly allowed: Readonly<Record<string, number>>;
  /** 上面那一格按档位汇总（键是 `GuardMode` 的名字）。 */
  readonly allowedByMode: Readonly<Record<string, number>>;
  /** 同一命令重复命中而未再上报的次数（按键）。被去重的那次**仍然会弹给用户**
   *  （判定照旧是 `ask`）——这一格表达的是"教训卡没有为同一条命令再炸一张"，
   *  不是"用户少被打扰一次"。 */
  readonly skipped: Readonly<Record<string, number>>;
  /** 事实门配额放行次数。 */
  readonly quotaReleases: number;
  /** 慢判定的告警线（ms）与成本采样的滚动窗口 —— 数字本身要说得出，用户才知道阈值在哪。 */
  readonly slowMs: number;
  readonly window: number;
}
