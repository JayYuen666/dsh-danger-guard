// test/ledger-fold.ts —— 台账折叠的**测试侧**替身：一串事件 → "日志就这么长"的当前态。
//
// 为什么不在 lib/tool-ledger.ts 里自带一份 fold：生产路径上没有任何一处需要一次折完整串——
// 官方 drive 按事件增量调单元的 `init`/`apply`，host 只读 `stateOf` 的结果（不可采信才回退
// 全量扫描）。此前 lib 里那份 fold 只有测试与 host 替身在调，`fallow --production` 把它判成
// 「只被测试养着的导出」。折叠这一步回到测试这边，并且**沿生产那两个口**驱动：用例拿到的
// 状态就是官方 drive 会交回的那一份，而不是与生产并行维护的第二套实现。
//
// 入参与 shared `scanToolEvents` 同形，等价用例因此能把**同一个数组**喂给两条读法；
// 夹具的 seq 递增器保证「事件位 = 数组下标」，那正是官方 `seq = log.length` 连号契约下的同一个值。

import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { toolLedgerProjection } from "../lib/tool-ledger.ts";
import type { ToolLedger } from "../lib/tool-ledger.ts";

/** 按序把一串已提交事件折进初态（等价官方 drive 折完之后的当前态）。
 *  `init` 的两个入参（header / fork 继承的前缀长度）本包不读，故按官方 drive 的调用形状给占位值。 */
export function foldLedger(events: readonly SessionEvent[]): ToolLedger {
  let state = toolLedgerProjection.init({} as never, 0 as never);
  for (const event of events) {
    state = toolLedgerProjection.apply(state, event);
  }
  return state;
}
