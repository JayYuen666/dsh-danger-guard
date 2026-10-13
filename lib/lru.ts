// lib/lru.ts —— 派生台账共用的**容量口径**与 LRU 写入。
//
// 为什么单列一枚模块：容量只该有一条口径（按插入序淘汰，防长驻进程无界增长），而用它的台账
// 分布在两处——host.ts 那几张会话键台账，与 lib/target-paths.ts 的官方真实路径表。各自实现
// 一份 eviction 就是"同一件事的两个读数"：一处收紧上限、另一处照旧无界，而两者都不会报错。

/** 台账容量（各台账共用；按插入序淘汰，防长驻进程无界增长）。 */
export const LEDGER_CAP = 200;

/** LRU 写入：先删后插刷新位次；超容量按最旧淘汰。
 *  淘汰用 for-of 而非 `keys().next()` + undefined 收窄——容量判定已保证表非空，
 *  那个"取不到键"的分支永远不可达（测不到的分支就是覆盖率与可读性的双份负债）。
 *  `cap` 可选：默认 `LEDGER_CAP` 适合"会话/目标"那几张（一次判定只碰几枚键），而写入频率
 *  由**外部事件**决定的表（如 `fs/observed`，会话每碰一枚文件就写一条）需要自己的上限——
 *  共用 200 会让它在大会话里被冲成一件摆设，而它记的是一枚短路径串，放大一千倍仍是定长。 */
export function lruPut<Value>(
  map: Map<string, Value>,
  key: string,
  value: Value,
  cap = LEDGER_CAP,
): void {
  map.delete(key);
  for (const oldest of map.keys()) {
    if (map.size < cap) {
      break;
    }
    map.delete(oldest);
  }
  map.set(key, value);
}
