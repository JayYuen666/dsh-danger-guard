// lib/read-basis.ts —— 「模型读到的是哪一版」的记账单源。
//
// 为什么单独成模块：这一小组状态回答的是同一个问题（**当前文件版本下，模型看过的那份内容
// 还算不算数**），而它的三条不变式都属于"两处各写一遍就会静默失效"那一类：
//   1. 观测与判据必须**同一条记录**。把"看到了哪一版"（mtime）与"这一版还欠不欠一次重读"
//      （失效点）拆成两张表时，容量淘汰只作用于前者：一枚早已被挤出基线的目标仍背着一条
//      失效点，两张表对"还记不记得这个目标"给出不同答案。合成记录后淘汰要么都发生、要么
//      都不发生。
//   2. 观测基线**只在拿到成功结果之后**才提交。guard 跑在工具执行之前——读失败（路径打错、
//      无权限、被别的策略 block）时什么都没拿到，却已经把基线推到新版本，于是下一次编辑
//      判定再也看不出这中间发生过外部改动（实测：成功读 → 外部改 → 失败读 → 编辑放行）。
//   3. 失效点**写进取值**，不当轮算完就用完。mtime 差分只能报"这次看到它比上次新"，而那个
//      差分一算就把观测基线刷成新值；把结论只留在局部变量里，"外部改动"会在下一次评估时
//      凭空消失，旧 read 证据重新成立——而模型根本还没读过新内容。
//
// 生命周期与其余派生台账一致：模块级、容量由 lruPut 兜底、会话销毁时按键前缀回收、
// 插件卸载时整表清空。键形由调用方拼（host.ts 的 sessionTargetKeyOf），本模块不重复那一处
// 口径——拼接写两遍就会让两侧读到不同的键而**没有任何报错**。

import { lruPut } from "./lru.ts";

/** 一个会话对一枚目标的观测记录。 */
export interface ReadBasis {
  /** 上次看到的 mtime（毫秒）。 */
  readonly mtimeMs: number;
  /** 当前版本要求的证据失效点（事件下标）；-1 = 没有未了结的外部改动。 */
  readonly staleBase: number;
}

/** 全局兜底：目标 → 任一会话最近看到的 mtime。
 *  只服务"本会话还没评估过该文件"那一档（例：重启前另一会话看过）。它**不是**判据本体，
 *  按会话的那一份才是——只按路径共享会消费掉跳变信号（A 先评估就把值更新，B 随后就看不到
 *  任何变化，于是带着改动前的旧 read 盲改）。 */
const globalMtime = new Map<string, number>();

/** 会话|目标 → 该会话的观测记录（新鲜度与失效点同一条，理由见文件头第 1 条）。 */
const basis = new Map<string, ReadBasis>();

/** 会话|目标 → **尚未落地**的观测（guard 时点看到的那一版，理由见文件头第 2 条）。 */
const pending = new Map<string, { mtimeMs: number; targetN: string }>();

/** 暂存一次读取观测（guard 时点调用；此时这一趟还**没执行**）。 */
export function stageReadObservation(key: string, mtimeMs: number, targetN: string): void {
  lruPut(pending, key, { mtimeMs, targetN });
}

/**
 * 提交一次读取观测：调用方已确认**内容真的交付给模型了**。
 *
 * 提交同时解除失效点——"拿到了这一版"正是那条判据的解除条件，不必再在两处各比一次。
 * @param key       `会话|目标`
 * @param targetN   归一后的目标绝对路径（`pending` 缺席时的回落目标）
 * @param currentMtime 现读的 mtime（同样只在 `pending` 缺席时用）
 */
export function commitReadObservation(key: string, targetN: string, currentMtime: number): void {
  const staged = pending.get(key);
  pending.delete(key);
  // 没有暂存（执行面与 guard 时点的键不同源，例如中途 `cd`）时退回现读那一枚：
  // 调用方已确认内容交付了，记下"现在这一版"仍然是对的，方向保守。
  const observedN = staged?.targetN ?? targetN;
  const observedMtime = staged?.mtimeMs ?? currentMtime;
  lruPut(globalMtime, observedN, observedMtime);
  lruPut(basis, key, { mtimeMs: observedMtime, staleBase: -1 });
}

/**
 * 丢掉一次读取的暂存观测（读取失败）：基线**不动**——没拿到的内容不能替后来者证明
 * "这一版看过"；失效点同样原样留着（它不是"这次读失败"的结论，而是"还没看过这一版"）。
 */
export function discardReadObservation(key: string): void {
  pending.delete(key);
}

/**
 * 取观测基线并**写下本次观测**（评估侧调用）。
 *
 * 返回的两枚值分开用：`staleBase` 是**上一次**判定留下的失效点（-1 = 没有），
 * `mtimeJump` 说明这一趟是否看到 mtime 前进。刷新全局 mtime **只表示"这次看见了这一版"**，
 * 不表示"这一版下的证据已经作废或已补上"——那是 `staleBase` 的事（文件头第 3 条）。
 */
export function observeVersion(
  key: string,
  targetN: string,
  mtimeMs: number,
): { mtimeJump: boolean; staleBase: number } {
  const seen = basis.get(key);
  const seenMtime = seen?.mtimeMs ?? globalMtime.get(targetN);
  lruPut(globalMtime, targetN, mtimeMs);
  return {
    mtimeJump: seenMtime !== undefined && mtimeMs > seenMtime,
    staleBase: seen?.staleBase ?? -1,
  };
}

/** 落定本次评估的结论：观测到的版本 + 这一版还欠不欠一次重读（同一条记录）。 */
export function settleVersion(key: string, mtimeMs: number, staleBase: number): void {
  lruPut(basis, key, { mtimeMs, staleBase });
}

/** 归因的输入：本轮观测 + 本会话那条成功编辑的证据。 */
export interface AttributionInput {
  /** 本会话最近一次成功编辑的**结果事件位**（-1 = 从未）。 */
  readonly lastEditSeq: number;
  /** 那次编辑写进去的文本此刻是否仍在文件里；`undefined` = 取不到写入文本，无法自证。 */
  readonly selfTextPresent: boolean | undefined;
  /** 本次评估看到 mtime 前进了没有。 */
  readonly mtimeJump: boolean;
  /** 上一轮判定**已落定**的失效点（-1 = 没有）。 */
  readonly pendingStaleBase: number;
  /** mtime 跳变对应的事件位置（本轮判"需重读"时要记下的水位）。 */
  readonly jumpSeq: number;
}

/** 归因结论。 */
export interface Attribution {
  /** 本次是否判"目标被会话之外改过"。 */
  readonly externallyChanged: boolean;
  /** 要向后续缺项裁定报的失效点（-1 = 没有）。 */
  readonly staleBase: number;
}

/**
 * 外部改动归因：一次编辑评估里"这一版是谁改的"这一问的**唯一判据**。
 *
 * 两种来源按证据强度分开对待：
 *  - **本轮 mtime 跳变**：可能出自自己刚才那次编辑，故先做内容自证；自证失败即判外部。
 *  - **已落定的失效点**：它问的不是"这一版是谁写的"，而是"模型读过的是不是这一版"。
 *    自证只能说明自己**写过**，说明不了自己**读过**——所以它不接受自证销账，要一直压到
 *    `commitReadObservation` 提交一次成功读取为止。
 */
export function attributeExternalChange(input: AttributionInput): Attribution {
  const { lastEditSeq, selfTextPresent, mtimeJump, pendingStaleBase, jumpSeq } = input;
  const settled = pendingStaleBase >= 0;
  // 已落定的失效点不接受自证销账（见上）；本轮跳变才看自证。
  const selfExplains = !settled && lastEditSeq >= jumpSeq && selfTextPresent !== false;
  // 两种来源同时在位时取**较严**的那个水位：失效点说的是"从那时起就没读过这一版"，
  // 取较大的下标意味着要求一次更晚的读取才算解，方向保守。
  let staleCandidate = pendingStaleBase;
  if (mtimeJump) {
    staleCandidate = Math.max(staleCandidate, jumpSeq);
  }
  const externallyChanged = staleCandidate >= 0 && !(mtimeJump && selfExplains);
  return { externallyChanged, staleBase: externallyChanged ? staleCandidate : -1 };
}
/** 预检把正文当场递进结果里 ⇒ 那枚"还没看过这一版"的失效点可以解除。
 *  为什么调用方不能靠投递水位的位次判：水位记的是日志长度，而外部改动发生在日志之外，
 *  两者会取到同一个下标（delivered.readSeq > staleBase 不成立），会一直卡在缺 read 上。 */
export function clearStaleness(key: string): void {
  const current = basis.get(key);
  if (current !== undefined && current.staleBase >= 0) {
    lruPut(basis, key, { mtimeMs: current.mtimeMs, staleBase: -1 });
  }
}

/** 会话键台账集合（会话销毁时按前缀回收）：键形都是 会话id|目标。 */
export function readBasisLedgers(): readonly Map<string, unknown>[] {
  return [basis, pending];
}

/** 卸载兜底：换代后工作树已变，"上一代要求的失效点"与"上一代看到、还没确认落地的观测"
 *  都没有资格跨代生效。 */
export function clearReadBasis(): void {
  basis.clear();
  pending.clear();
}
