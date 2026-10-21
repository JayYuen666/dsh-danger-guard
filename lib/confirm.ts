// lib/confirm.ts —— 「需确认档」的决定构造：规则键 → **回给模型与弹窗的那两句话**，以及
// 「这条该不该问」的那一步（含每会话去重）。
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
// 处置由 `lib/mode-policy.ts` 的档位表给 —— 与 guard 读的是**同一张表**，所以两边不可能
// 给出互相打架的结论（那正是"用户点了允许还是被拒"的防线）。

import { bashVerdictOf } from "./danger-rules.ts";
import type { BashDenialKey, BashDangerOptions } from "./danger-rules.ts";
import { decideRule, modeNoteKeyOf, severityResolverOf } from "./mode-policy.ts";
import type { PolicyFacts } from "./mode-policy.ts";
import { displayReasonOf, MESSAGES } from "./messages.ts";
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
  const base = displayReasonOf(key);
  const noteKey = modeNoteKeyOf(facts);
  const out: { en: string; [locale: string]: string } = {
    en: `${base.en}\n${MESSAGES.en[noteKey]}`,
  };
  for (const [locale, table] of Object.entries(MESSAGES)) {
    out[locale] = `${table[key]}\n${table[noteKey]}`;
  }
  return out;
}

/**
 * 这次调用该不该走审批？该的话，两句话分别是什么。
 *
 * @param name    工具名（方言由 `dialectOfTool` 按**调用点身份**给，不从字形猜）。
 * @param args    调用参数（只读 `command`）。
 * @param opts    词表配置（与 guard 共用同一份 `bashOptsOf`）。
 * @param facts   档位事实（宿主读好后传入；本模块据此决定这一档还能不能问）。
 * @param messages 当次语言的文案表（宿主在调用点现取，本模块不读设置也不自带语言）。
 * @returns 需要审批时返回请求；`allow`/`deny` 两档返回 `undefined`（分别由下游与 guard 收口）。
 */
export function askRequestOf(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  opts: BashDangerOptions | undefined,
  facts: PolicyFacts,
  messages: DangerGuardMessages,
): AskRequest | undefined {
  // 扫描层也要按**同一份档位事实**排序：否则 `npm run dev && git push -f` 这类串行命令
  // 在审批通道里会停在前段（本档放行的那段）上，与 guard 那一侧读到的键不一致。
  const hit = bashVerdictOf(
    name,
    args,
    opts === undefined
      ? { severityOf: severityResolverOf(facts) }
      : { ...opts, severityOf: severityResolverOf(facts) },
  );
  let request: AskRequest | undefined;
  // 档位过滤在**本模块**（不在 lib/danger-rules.ts，也不在 lib/mode-policy.ts）：
  // 那一侧只回"检测到了什么"与"该档怎么处置"，"这一趟要不要走审批通道"是这条通道自己的事。
  // 两处读的仍是同一张档位表，所以 guard 与这里不可能同时认领一枚键。
  if (hit !== undefined && decideRule(facts, hit.verdict.key) === "ask") {
    const { key } = hit.verdict;
    request = {
      key,
      command: hit.command,
      // 两处文案同源（同一个 key 索引同一份目录），所以模型侧看到的理由与用户在弹窗里
      // 看到的那句说的是同一件事，不会一方说"需确认"、另一方说"已拒绝"。
      // 档位说明两处都接上：模型侧读得到"这是哪一档、为什么这一档要问"，用户在弹窗里
      // 也读得到——只接 `reason` 会让弹窗那一面退回旧文案。
      reason: `${messages[key]}\n${messages[modeNoteKeyOf(facts)]}`,
      displayReason: displayReasonWithNote(key, facts),
    };
  }
  return request;
}

/**
 * 这次命中在**本会话里**是否已经问过（同一规则键 + 同一命令原文）。
 *
 * 为什么要有这一步：模型重试同一串命令是常态，而每次都往教训总线报一条一模一样的证据，
 * 只会把那张卡炸成碎片。所以重复的那次不再上报（只在统计里记一格）——**判定与弹卡不变**，
 * 这一层不承担"少问用户一次"的职责。
 *
 * 容量口径：按会话分片、每会话固定上限；宿主进程退出即消失，不落盘。
 */
export class AskDeduper {
  /** 每会话一张键表。 */
  private readonly seen = new Map<string, Set<string>>();

  /** 每会话记住的去重键上限：键是摘要而不是命令原文，所以这一格就是内存上界。 */
  private readonly perSession: number;

  public constructor(perSession = 64) {
    this.perSession = perSession;
  }

  /**
   * 记一次命中，回它是不是**第一次**（第一次 = 该问）。
   *
   * @param sessionKey 会话标识（缺省时退化成一张共用表：无会话上下文的调用仍然只问一次）。
   * @param dedupKey   去重键（规则键 + 命令原文的稳定摘要）。
   * @returns 首次出现返回 `true`。
   */
  public first(sessionKey: string | undefined, dedupKey: string): boolean {
    const key = sessionKey ?? "";
    let table = this.seen.get(key);
    if (table === undefined) {
      table = new Set();
      this.seen.set(key, table);
    }
    if (table.has(dedupKey)) {
      return false;
    }
    // 满了就整表清空而不是逐条淘汰：这张表只用来"少打扰一次"，丢历史只会让某条命令被
    // 再问一次（可接受的退化），而逐条淘汰要为此多养一套顺序结构。
    if (table.size >= this.perSession) {
      table.clear();
    }
    table.add(dedupKey);
    return true;
  }

  /** 丢掉一个会话的分片（`session/disposed` 时调；缺席也只是多留一格内存）。 */
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
  // 逐码点按 31 进制的滚动摘要：分布够用于去重、不引依赖、纯函数、不写位运算。
  // 这里不需要抗碰撞——撞了只会让一条新命令被误判成"问过"，代价是少问一次，
  // 而不是放行一条没判过的危险命令。
  let hash = 0;
  // 按 31 进制滚动的**稳定性摘要**（与 Java `String.hashCode` 同族）：这里只需要"同一串得
  // 同一个键"，不需要密码学性质——撞了只意味着少问一次，而不是放行一条没判过的命令。
  // 用 `charCodeAt` 而不是 `codePointAt`：后者在 code point 层面返回 `number | undefined`，
  // 那个兜底分支在这个输入域里不可达（`for...of` 交出的串必非空），留着就永远在覆盖率门外。
  for (const char of command) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- 理由见上两行：BMP 单元足够稳定，且不引入不可达分支
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) % 2_147_483_647;
  }
  return `${key}:${hash.toString(36)}:${command.length}`;
}
