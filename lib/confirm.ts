// lib/confirm.ts —— 「需确认档」的决定构造：规则键 → **回给模型与弹窗的那两句话**。
//
// 为什么单列（而不是留在 host.ts 的接线里）：这一半不碰宿主的决定形状（`PreToolDecision`
// 是判别联合，装配它归 host），只做"这条调用该不该问用户 + 问的话说什么"。
// 于是它可以脱离宿主单测，而 host 那一侧只剩一行形状映射。
//
// 为什么**不依赖 fs / session**（与预检 B 面正相反）：它要的证据全在调用参数里 ——
// 命令原文就是全部输入。B 面预检读不到工具实际用的那份盘就一个字都不编（读宿主本地盘
// 冒充会给出错证据），而"这条命令要不要问用户"不需要那份盘。于是没装 fs 后端的 profile
// 照样该弹审批，否则这条档位会在那种部署下静默失效。
//
// 判据**全部复用** `lib/danger-rules.ts` 的 `bashVerdictOf`（那一个又复用 `bashVerdict`
// 与 `RULE_TIER`）—— 与 guard 读的是同一份判定与同一张档位表，所以两边不可能给出
// 互相打架的结论（详见 `RULE_TIER` 的注释：那正是"用户点了允许还是被拒"的防线）。

import { bashVerdictOf, RULE_TIER } from "./danger-rules.ts";
import type { BashDenialKey, BashDangerOptions } from "./danger-rules.ts";
import { displayReasonOf } from "./messages.ts";
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
 * 这次调用该不该走审批？该的话，两句话分别是什么。
 *
 * @param name    工具名（方言由 `dialectOfTool` 按**调用点身份**给，不从字形猜）。
 * @param args    调用参数（只读 `command`）。
 * @param opts    词表配置（与 guard 共用同一份 `bashOptsOf`）。
 * @param messages 当次语言的文案表（宿主在调用点现取，本模块不读设置也不自带语言）。
 */
export function askRequestOf(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  opts: BashDangerOptions | undefined,
  messages: DangerGuardMessages,
): AskRequest | undefined {
  const hit = bashVerdictOf(name, args, opts);
  let request: AskRequest | undefined;
  // 档位过滤在**本模块**（不在 lib/danger-rules.ts）：那一侧只回"检测到了什么"，
  // "该不该弹审批"是这条通道自己的事。两处读的仍是同一张 `RULE_TIER`，所以
  // guard 与这里不可能同时认领一枚键（那会表现为"用户点了允许还是被拒"）。
  if (hit !== undefined && RULE_TIER[hit.verdict.key] === "ask") {
    const { key } = hit.verdict;
    request = {
      key,
      command: hit.command,
      // 两处文案同源（同一个 key 索引同一份目录），所以模型侧看到的理由与用户在弹窗里
      // 看到的那句说的是同一件事，不会一方说"需确认"、另一方说"已拒绝"。
      reason: messages[key],
      displayReason: displayReasonOf(key),
    };
  }
  return request;
}
