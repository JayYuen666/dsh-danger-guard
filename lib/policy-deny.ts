// lib/policy-deny.ts —— 把档位表判出的 `deny` 落成**回给模型的文案**（纯函数，零 I/O）。
//
// 为什么单列：`host.ts` 顶着 `max-lines` 的预算，而"三段文案怎么拼"是这一轮新增的
// 一整块判据面。拼法本身与宿主无关（只要规则键、出路、档位事实与文案表），
// 于是可以脱离宿主逐条单测 —— 尤其是"降级来的 deny 要多一段换档出路"那条，
// 它是本轮"拒绝时附改写示例"的唯一落点。
//
// 文案顺序是刻意的：基础理由（这条命令为什么不对）→ 出路（改哪几个词能过）→
// 档位说明（这一档为什么这样处置）。降级来的 deny 再接一段"这档问不了、换哪一档才能问"。

import type { BashDenialKey } from "./danger-rules.ts";
import type { Fix } from "./fix.ts";
import { decideRule, deniedByPolicy, modeNoteApplies, modeNoteKeyOf } from "./mode-policy.ts";
import type { PolicyFacts, RuleVerdict } from "./mode-policy.ts";
import { renderFix } from "./messages.ts";
import type { DangerGuardMessages } from "./messages.ts";

/** 出一次拒绝文案要的全部输入。 */
export interface PolicyDenyTextInput {
  /** 命中的规则键（文案与档位说明都指着它）。 */
  readonly key: BashDenialKey;
  /** 结构化的出路（`BashVerdict.fix`）；没有出路时这一行不出现。 */
  readonly fix: Fix | undefined;
  /** 档位事实（决定用哪一段档位说明、以及这是不是策略降级）。 */
  readonly facts: PolicyFacts;
  /** 当次语言的文案表（宿主在调用点现取）。 */
  readonly messages: DangerGuardMessages;
}

/**
 * 一次 `deny` 的完整文案。
 *
 * @param input 命中、出路、档位事实与文案表。
 * @returns 回给模型的拒绝理由（多段之间用换行分隔）。
 */
export function policyDenyText(input: PolicyDenyTextInput): string {
  const { key, fix, facts, messages } = input;
  const base = fix === undefined ? messages[key] : `${messages[key]}\n${renderFix(fix, messages)}`;
  // 档位说明只在**这一档的成因与这条规则有关**时才接：工作区档那段讲的是"可写根包套 +
  // 删除不具原子性"，而同一档里被拒的还有 `noVerify`（命令形态）与 `pipeShell`（下载即执行）
  // ——把删除那段话接在它们后面，等于让模型去改一个与本条无关的方面。
  const note = modeNoteApplies(facts, key) ? messages[modeNoteKeyOf(facts)] : "";
  const tail = note.length > 0 ? `\n${note}` : "";
  // "问不了才降级成拒"与"已确认危险"是两种拒绝，前者必须点明换哪一档才能问——
  // 否则模型拿到的只有"不许"，没有下一步。
  return deniedByPolicy(facts, key)
    ? `${base}${tail}\n${messages.askBlockedGeneric}`
    : `${base}${tail}`;
}

/** 供上报面用的判别结果（与文案同一份判据，避免第二处比较）。 */
export interface PolicyDenyFlags {
  /** 本该问、但这档问不了而降级来的拒绝。 */
  readonly policyDenied: boolean;
  /** 档位表给出的结论（上报里要记是哪一档）。 */
  readonly verdict: RuleVerdict;
}

/**
 * 上报面要的两个判别位。
 *
 * @param facts 档位事实。
 * @param key   命中的规则键。
 * @returns 判别结果。
 */
export function policyDenyFlags(facts: PolicyFacts, key: BashDenialKey): PolicyDenyFlags {
  return { policyDenied: deniedByPolicy(facts, key), verdict: decideRule(facts, key) };
}
