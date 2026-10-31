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

/** 一次尚未落地的观测。 */
interface StagedRead {
  readonly mtimeMs: number;
  readonly targetN: string;
}

/**
 * 会话|目标 → **尚未落地**的观测队列（guard 时点看到的那一版，理由见文件头第 2 条）。
 *
 * 同一个目标可以同时有多次读在飞（模型一轮里连发两个 read）。每条记录按**先后**排队、
 * 提交与丢弃都从队首取：只留一条时，后一次暂存会把前一次的观测顶掉，于是队首那次读的
 * 提交拿到的是**更晚**那一版 mtime —— 提交一个比实际读到的更新的基线，正好会在
 * "外部在两次读之间改了文件"时把改动抹掉（探针实测：暂存 1111/2222 后提交，落库的是 2222）。
 */
const pending = new Map<string, StagedRead[]>();

/** 同一键最多保留的未落地观测：同一轮里连发多次 read 的真实上界很小，超出的最旧记录
 *  在配对错位（guard 与 post-execute 键不同源）时只会污染后续提交，不能无限堆积。 */
export const MAX_STAGED_PER_KEY = 8;

/** 暂存一次读取观测（guard 时点调用；此时这一趟还**没执行**）。 */
export function stageReadObservation(key: string, mtimeMs: number, targetN: string): void {
  const queue = pending.get(key);
  if (queue === undefined) {
    lruPut(pending, key, [{ mtimeMs, targetN }]);
    return;
  }
  if (queue.length >= MAX_STAGED_PER_KEY) {
    queue.shift();
  }
  queue.push({ mtimeMs, targetN });
}

/** 取走队首那条暂存观测（提交与丢弃共用）。 */
function shiftStaged(key: string): StagedRead | undefined {
  const queue = pending.get(key);
  let staged: StagedRead | undefined;
  if (queue !== undefined) {
    staged = queue.shift();
    if (queue.length === 0) {
      pending.delete(key);
    }
  }
  return staged;
}

/**
 * 提交一次读取观测：调用方已确认**内容真的交付给模型了**。
 *
 * 提交同时解除失效点——"拿到了这一版"正是那条判据的解除条件，不必再在两处各比一次。
 *
 * 没有暂存时**什么都不记**：执行面与 guard 时点的键不同源（例如中途 `cd`）时，这次成功
 * 回调找不到自己那一笔观测；拿"现读的 mtime"当基线等于替一份没验证过的内容背书，还会把
 * 失效点一并清掉（fail-open）。宁可少记一次基线（下次 read 仍要证据）。
 * @param key `会话|目标`
 */
export function commitReadObservation(key: string): void {
  const staged = shiftStaged(key);
  if (staged === undefined) {
    return;
  }
  lruPut(globalMtime, staged.targetN, staged.mtimeMs);
  lruPut(basis, key, { mtimeMs: staged.mtimeMs, staleBase: -1 });
}

/**
 * 丢掉一次读取的暂存观测（读取失败）：基线**不动**——没拿到的内容不能替后来者证明
 * "这一版看过"；失效点同样原样留着（它不是"这次读失败"的结论，而是"还没看过这一版"）。
 */
export function discardReadObservation(key: string): void {
  shiftStaged(key);
}

/**
 * 读取观测基线（评估侧调用）。**只读**：本次观测的落库在 `settleVersion`，这里不写任何表。
 *
 * 返回的两枚值分开用：`staleBase` 是**上一次**判定留下的失效点（-1 = 没有），
 * `mtimeJump` 说明这一趟是否看到 mtime 前进。全局 mtime 的刷新点不在这里——在这里写下去
 * 会让紧随其后的另一个会话再也看不到这次跳变（文件头第 3 条）。
 */
export function observeVersion(
  key: string,
  targetN: string,
  mtimeMs: number,
): { mtimeJump: boolean; staleBase: number } {
  const seen = basis.get(key);
  // 全局基线只供"本会话还没评估过这一版"这一档回落，**不能在这里刷新**：写下去之后
  // 紧随其后的另一个会话就再也看不到这次跳变（探针实测：A、B 依次 observe 同一目标，
  // B 的 mtimeJump 是 false），而它恰恰是这一档唯一的判据来源。刷新点在下一次
  // settleVersion ——结论落定之后才轮到它。
  const seenMtime = seen?.mtimeMs ?? globalMtime.get(targetN);
  return {
    mtimeJump: seenMtime !== undefined && mtimeMs > seenMtime,
    staleBase: seen?.staleBase ?? -1,
  };
}

/**
 * 落定本次评估的结论：观测到的版本 + 这一版还欠不欠一次重读（同一条记录）。
 *
 * 全局基线**在这里**刷新，不在 `observeVersion` 里：那边写下就等于替所有会话宣布
 * "这一版有人看过了"，紧接着评估的另一个会话再也看不到这次跳变。挪到这里之后，
 * 语义变成"这一版既被看见了、结论也定下来了"，而那正是全局兜底该记的时点。
 * @param key      `会话|目标`
 * @param targetN  归一后的目标绝对路径（`globalMtime` 用它当键）
 */
export function settleVersion(
  key: string,
  targetN: string,
  mtimeMs: number,
  staleBase: number,
): void {
  lruPut(basis, key, { mtimeMs, staleBase });
  lruPut(globalMtime, targetN, mtimeMs);
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
  // 自证要求 `selfTextPresent === true`：`undefined` 表示"取不到写入文本"，那是不知，
  // 不是自证。旧写法 `!== false` 把不知当成了知道（探针实测：undefined 下判 externallyChanged=false，
  // 于是外部改动被抹掉）。
  //
  // 另一边不需要再加 `lastEditSeq >= 0`：外部改动成立的前提是 `staleCandidate >= 0`，
  // 而 `lastEditSeq >= jumpSeq` 与 `staleCandidate >= jumpSeq` 联立即已给出 `lastEditSeq >= 0`
  // （`pendingStaleBase` 那一支已被 `settled` 排除）。多写一条是够不到的分支。
  const selfExplains = !settled && selfTextPresent === true && lastEditSeq >= jumpSeq;
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

/**
 * 会话键台账集合（会话销毁时按前缀回收）：键形都是 会话id|目标。
 *
 * `globalMtime` 刻意**不在**这里：它的键是目标绝对路径，没有会话前缀，按前缀删一条都删不掉；
 * 而且它存在的目的正是跨会话——"本会话还没评估过该文件"那一档（重启前另一会话看过）靠它回落。
 * 跟着会话销毁清空，等于让"另一会话看过"这件事永远不成立，那一档回落地基就再也没了。
 * 它只在换代（`clearReadBasis`）时整表清空。
 */
export function readBasisLedgers(): readonly Map<string, unknown>[] {
  return [basis, pending];
}

/** 卸载兜底：换代后工作树已变，"上一代要求的失效点"与"上一代看到、还没确认落地的观测"
 *  都没有资格跨代生效。 */
export function clearReadBasis(): void {
  basis.clear();
  pending.clear();
  // 全局基线同样不能跨代：它记的是"上一代看见过哪一版"，而换代后工作树已经变了，
  // 留着它会让新一代把上一代的版本号当成自己的观测基线（探针实测：清完之后新会话
  // 仍从旧基线判出 mtimeJump，而那一次的"旧版"属于上一代）。
  globalMtime.clear();
}
