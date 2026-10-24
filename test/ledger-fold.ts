// test/ledger-fold.ts —— 台账折叠的**测试侧**替身：一串事件 → "日志就这么长"的当前态。
//
// 为什么不在 lib/tool-ledger.ts 里自带一份 fold：生产路径上没有任何一处需要一次折完整串——
// 官方 drive 按事件增量调单元的 `init`/`apply`，host 只读 `stateOf` 的结果（不可采信才回退
// 全量扫描）。此前 lib 里那份 fold 只有测试与 host 替身在调，`fallow --production` 把它们判成
// 「只被测试养着的导出」。折叠这一步回到测试这边，并且**沿生产那两个口**驱动：用例拿到的
// 状态就是官方 drive 会交回的那一份，而不是与生产并行维护的第二套实现。
//
// 入参与 shared `scanToolEvents` 同形，等价用例因此能把**同一个数组**喂给两条读法；
// 夹具的 seq 递增器保证「事件位 = 数组下标」，那正是官方 `seq = log.length` 连号契约下的同一个值。

import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import { toolLedgerProjection } from "../lib/tool-ledger.ts";
import type { ToolLedger } from "../lib/tool-ledger.ts";

/** init 的占位值：任一属性被读取即抛。替身最怕的不是折叠出错，而是**静默偏离**——
 *  单元若开始消费 header / fork 继承前缀，占位值被读到时这里当场红，而不是拿
 *  一份错值继续折出一套"看起来还绿"的对照。导出给直接驱动 `init` 的用例复用。 */
export const INIT_PLACEHOLDER = new Proxy(
  {},
  {
    get(_target, prop): never {
      throw new TypeError(
        `ledger-fold 占位值被读取：${String(prop)}（单元的 init 开始消费 header/inherited 了）`,
      );
    },
  },
) as never;

/** 按序把一串已提交事件折进初态（等价官方 drive **只做 init/apply 折叠**时的当前态——
 *  官方 drive 若还带状态版本校验、restore 前置判断或批次保护，不在本替身的覆盖面内）。
 *  事件位不得重复（重复 = 夹具的 seq 生成器出错，fold 出来的是一份行序错乱的台账，
 *  对照因此失效）；跳号允许——作废判据那条用例故意构造它。 */
export function foldLedger(events: readonly SessionEvent[]): ToolLedger {
  let state = toolLedgerProjection.init(INIT_PLACEHOLDER, INIT_PLACEHOLDER);
  const seenSeqs = new Set<number>();
  for (const event of events) {
    if (seenSeqs.has(event.seq)) {
      throw new Error(`夹具事件位重复：seq=${String(event.seq)} 已折过一次`);
    }
    seenSeqs.add(event.seq);
    state = toolLedgerProjection.apply(state, event);
  }
  return state;
}
