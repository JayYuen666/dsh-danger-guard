// lib/confirm.ts —— 「需确认档」的决定构造：规则键 → **回给模型与弹窗的那两句话**，以及
// 「这条该不该问」的那一步（含每会话的上报去重）。
//
// 为什么单列（而不是留在 host.ts 的接线里）：这一半不碰宿主的决定形状（`PreToolDecision`
// 是判别联合，装配它归 host），只做"这条调用该不该问用户 + 问的话说什么"。
// 于是它可以脱离宿主单测，而 host 那一侧只剩一行形状映射。
//
// 为什么**不依赖 fs / session**（与预检 B 面正相反）：它要的证据全在调用参数里 ——
// 命令原文就是全部输入。B 面预检读不到工具实际用的那份盘就一个字不编（读宿主本地盘
// 冒充会给出错证据），而"这条命令要不要问用户"不需要那份盘。于是没装 fs 后端的 profile
// 照样该弹审批，否则这条档位会在那种部署下静默失效。
//
// 判据**全部复用** `lib/danger-rules.ts` 的 `bashVerdictOf`（它只回"检出什么"），
// 处置由 `lib/mode-policy.ts` 的档位表与宿主给的**逐命中实际处置**共同决定 —— guard 与
// 这里必须传同一个 `severityOf`，否则"沙箱让路"那一步会让两边看到不同的严重度（那正是
// "用户点了允许还是被拒"、以及后段被前段吞掉的防线）。

import { bashVerdictOf } from "./danger-rules.ts";
import type { BashDenialKey, BashDangerOptions } from "./danger-rules.ts";
import { modeNoteApplies, modeNoteKeyOf, severityResolverOf } from "./mode-policy.ts";
import type { PolicyFacts } from "./mode-policy.ts";
import { lruPut } from "./lru.ts";
import { MESSAGES } from "./messages.ts";
import type { DangerGuardMessages } from "./messages.ts";

/** 一次「需确认」请求的宿主无关形态（host 只把它包成官方 `{ kind: "ask", … }`）。 */
export interface AskRequest {
  /** 命中的规则键（文案与上报都指着它）。 */
  key: BashDenialKey;
  /** 被判定的那条命令原文（上报签名用，来自 `BashHit`）。 */
  command: string;
  /** 当次语言的说明（官方 `reason`：回给模型的那句）。 */
  reason: string;
  /** 全语言的展示文案（官方 `displayReason` 形状：弹窗那一面）。 */
  displayReason: { en: string; [locale: string]: string };
}

/**
 * 弹窗那一面的逐语言文案：规则本文 + 该档位的说明。
 *
 * 为什么不能只交 `displayReasonOf(key)`：那只含规则本文，于是模型侧看得到档位说明、
 * 用户在弹窗里看不到——同一件事的两面说两套话，而弹窗才是用户做决定的那个面。
 *
 * @param key   命中的规则键。
 * @param facts 档位事实。
 * @returns 每门语言一份「规则本文 + 换行 + 档位说明」。
 */
function displayReasonWithNote(
  key: BashDenialKey,
  facts: PolicyFacts,
): { en: string; [locale: string]: string } {
  // 档位说明只在**这一档的成因与这条规则有关**时才接：把删除那段话接在 `noVerify` 后面，
  // 等于让用户去考虑一个与本条无关的方面（判据与 `policy-deny` 同一份，见 `NOTE_APPLIES`）。
  const noteKey = modeNoteApplies(facts, key) ? modeNoteKeyOf(facts) : undefined;
  // `en` 只是类型占位：循环覆盖 `MESSAGES` 的全部语言（含 en），逐语言映射只写一遍。
  const out: { en: string; [locale: string]: string } = { en: "" };
  for (const [locale, table] of Object.entries(MESSAGES)) {
    out[locale] = noteKey === undefined ? table[key] : `${table[key]}\n${table[noteKey]}`;
  }
  return out;
}

/**
 * 这次调用该不该走审批？该的话，两句话分别是什么。
 *
 * @param name    工具名（方言由 `dialectOfTool` 按**调用点身份**给，不从字形猜）。
 * @param args    调用参数（只读 `command`）。
 * @param opts    词表配置 + 调用点的实际处置（与 guard 共用同一份 `bashOptsOf`；其中的
 *                `severityOf` 若由宿主给，应包含沙箱覆盖等逐命中事实）。
 * @param facts   档位事实（宿主读好后传入；缺省处置与档位说明用）。
 * @param messages 当次语言的文案表（宿主在调用点现取，本模块不读设置也不自带语言）。
 *   **调用契约**：弹窗那一面的逐语言文案取自本模块的全局 `MESSAGES`，而模型侧的
 *   `reason` 取自这份参数——类型只约束内容形状、不带语言身份，所以两者同源这件事
 *   由调用方兑现：`messages` 必须取自 `MESSAGES` 的某一语言项。传自造字典时，模型
 *   看到的与用户弹窗里看到的会是两句不同的话。
 * @returns 需要审批时返回请求；`allow`/`deny` 两档返回 `undefined`（分别由下游与 guard 收口）。
 */
export function askRequestOf(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  opts: BashDangerOptions | undefined,
  facts: PolicyFacts,
  messages: DangerGuardMessages,
): AskRequest | undefined {
  // 扫描层必须按**实际处置**排序：否则 `npm run dev && git push -f` 这类串行命令会停在前段
  // （本档放行的那段）上；沙箱覆盖的 `rmrf` 更是"排序时 deny、处置时 allow"，只看键会让它
  // 吞掉后段。宿主经 `opts.severityOf` 把逐命中事实折进来；缺席时按 facts 的档位表求值。
  const dispositionOf = opts?.severityOf ?? severityResolverOf(facts);
  const hit = bashVerdictOf(
    name,
    args,
    opts === undefined ? { severityOf: dispositionOf } : { ...opts, severityOf: dispositionOf },
  );
  let request: AskRequest | undefined;
  // 档位过滤在**本模块**（不在 lib/danger-rules.ts，也不在 lib/mode-policy.ts）：
  // 那一侧只回"检测到了什么"与"该档怎么处置"，"这一趟要不要走审批通道"是这条通道自己的事。
  // 过滤与排序用**同一个** `dispositionOf`；guard 也用它，所以同一枚命中不会在两处得到
  // 不同结论，覆盖后的 `rmrf` 也不会把后段从扫描里抹掉。
  if (hit !== undefined && dispositionOf(hit.verdict) === "ask") {
    const { key } = hit.verdict;
    request = {
      key,
      command: hit.command,
      // 两处文案同源（同一个 key 索引同一份目录），所以模型侧看到的理由与用户在弹窗里
      // 看到的那句说的是同一件事，不会一方说"需确认"、另一方说"已拒绝"。
      // 档位说明两处都接上：模型侧读得到"这是哪一档、为什么这一档要问"，用户在弹窗里
      // 也读得到——只接 `reason` 会让弹窗那一面退回旧文案。
      reason: modeNoteApplies(facts, key)
        ? `${messages[key]}\n${messages[modeNoteKeyOf(facts)]}`
        : messages[key],
      displayReason: displayReasonWithNote(key, facts),
    };
  }
  return request;
}

/**
 * 这次命中在**本会话里**是否已经上报过（同一规则键 + 同一命令原文）。
 *
 * 为什么要有这一步：模型重试同一串命令是常态，而每次都往教训总线报一条一模一样的证据，
 * 只会把那张卡炸成碎片。所以重复的那次不再上报（只在统计里记一格）——**判定与弹卡不变**，
 * 这一层不承担"少问用户一次"的职责。
 *
 * 容量口径：按会话分片、每会话固定上限；分片数也有上限（超出的按插入序淘汰），宿主进程
 * 退出即消失，不落盘。会话结束由宿主调 `drop` 回收分片——那只是提前回收，不是有界的前提。
 */
export class AskDeduper {
  /** 每会话一张键表；分片数由 `maxSessions` 按插入序淘汰兜底。 */
  private readonly seen = new Map<string, Set<string>>();

  /** 每会话记住的去重键上限：键是摘要而不是命令原文，所以这一格就是内存上界。 */
  private readonly perSession: number;

  /** 分片数上限：`session/disposed` 是否必然触发不由本类保证，漏调 drop 时靠它兜底，
   *  外层 Map 才真正有界（否则会话标识按请求生成时，分片数随请求数无界增长）。 */
  private readonly maxSessions: number;

  /**
   * @param perSession 每会话最多记住的键数，必须是正安全整数。非法值直接拒绝：
   *                   `NaN`/`Infinity` 会让分片永不清空，`0`/负数会让容量语义失真，
   *                   而"有界"正是这张表在长驻宿主里成立的前提。
   * @param maxSessions 最多同时记几个会话的分片，必须是正安全整数；超出的按插入序淘汰
   *                   最旧的分片（丢历史只会让某条命令被再上报一次，可接受的退化）。
   */
  public constructor(perSession = 64, maxSessions = 256) {
    if (!Number.isSafeInteger(perSession) || perSession <= 0) {
      throw new RangeError("perSession 必须是正安全整数");
    }
    if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
      throw new RangeError("maxSessions 必须是正安全整数");
    }
    this.perSession = perSession;
    this.maxSessions = maxSessions;
  }

  /**
   * 记一次命中，回它是不是**本会话第一次出现**（第一次 = 该上报）。
   *
   * 返回值**不控制审批**：调用方仍须照常交回 `{ kind: "ask" }`；它只决定这趟要不要把
   * 同一份证据再塞进教训总线。
   *
   * @param sessionKey 会话标识（缺省时退化成一张共用表：无会话上下文的调用仍然只上报一次）。
   * @param dedupKey   去重键（规则键 + 命令原文的稳定摘要）。
   * @returns 首次出现返回 `true`（该上报）。
   */
  public shouldReport(sessionKey: string | undefined, dedupKey: string): boolean {
    const key = sessionKey ?? "";
    let table = this.seen.get(key);
    if (table === undefined) {
      table = new Set();
      // 分片也走容量口径：淘汰按插入序（命中不续命），最旧会话的丢法同上面那条退化理由。
      lruPut(this.seen, key, table, this.maxSessions);
    }
    if (table.has(dedupKey)) {
      return false;
    }
    // 满了就整表清空而不是逐条淘汰：这张表只用来"少上报一次"，丢历史只会让某条命令被
    // 再上报一次（可接受的退化），而逐条淘汰要为此多养一套顺序结构。
    if (table.size >= this.perSession) {
      table.clear();
    }
    table.add(dedupKey);
    return true;
  }

  /** 丢掉一个会话的分片（`session/disposed` 时调；缺席只是多留一个分片，最多 `perSession` 条）。 */
  public drop(sessionKey: string | undefined): void {
    this.seen.delete(sessionKey ?? "");
  }

  /** 清空（插件重装时归零，与事实门 reset 同一条理由）。 */
  public reset(): void {
    this.seen.clear();
  }
}

/**
 * 去重键：规则键 + 命令原文的稳定摘要。
 *
 * 为什么不是原文本身：命令可以长到判据自己的长度上限，拿原文当 Map 键等于让这条去重表
 * 随模型输入线性涨。摘要只用来判"是不是同一条"，不需要可逆。
 *
 * @param key     规则键。
 * @param command 命令原文。
 * @returns 稳定键。
 */
export function dedupKeyOf(key: BashDenialKey, command: string): string {
  // 逐 UTF-16 代码单元按 31 进制滚动（与 Java `String.hashCode` 同族）：分布够用于去重、
  // 不引依赖、纯函数、不写位运算。这里不需要抗碰撞——撞了只会让一条新命令被误判成
  // "已上报"，代价是少一条证据，而不是放行一条没判过的危险命令。
  let hash = 0;
  // 用 `charCodeAt` 而不是 `codePointAt`，且按**代码单元**遍历：后者把代理对折成一个码点，
  // 低位代理项会被丢掉，于是同一高位代理项下的不同 emoji 得到同一个键。这里要的正是
  // 代理对的两个单元都参与滚动；`codePointAt` 还会在边界返回 `number | undefined`，
  // 留下一个在这个输入域里不可达的兜底分支。
  for (let index = 0; index < command.length; index += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- 理由见上两行：代理对的两个代码单元都要参与滚动，码点读法会丢掉低位代理项
    hash = (Math.imul(hash, 31) + command.charCodeAt(index)) % 2_147_483_647;
  }
  return `${key}:${hash.toString(36)}:${command.length}`;
}
