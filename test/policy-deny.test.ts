// test/policy-deny.test.ts —— 拒绝文案的三段拼法（`lib/policy-deny.ts`）。
//
// 这一份钉的是本轮"拒绝时要给改写示例"那条决策的**唯一落点**：
//   基础理由（这条命令为什么不对）→ 出路（改哪几个词能过）→ 档位说明（这一档为什么这样处置），
//   而"本该问、但这档问不了"降级来的 deny 还要再接一段换档出路。
// 少了最后那一段，模型拿到的只有"不许"，读不出成因也看不到下一步。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { policyDenyFlags, policyDenyText } from "../lib/policy-deny.ts";
import { ALL_RULE_KEYS, decideRule } from "../lib/mode-policy.ts";
import { MESSAGES, renderFix } from "../lib/messages.ts";
import type { PolicyFacts } from "../lib/mode-policy.ts";

const ZH = MESSAGES.zh;

const FULL_MODE = "danger-full-access";
const WORKSPACE: PolicyFacts = {
  mode: "workspace-write",
  askable: true,
  autoReview: false,
  sandboxCovers: false,
};

describe("policyDenyText：三段文案的顺序与内容", () => {
  it("不带出路时：与这一档成因相关的键（`rmrf`）接档位说明", () => {
    const text = policyDenyText({
      key: "rmrf",
      fix: undefined,
      facts: WORKSPACE,
      messages: ZH,
    });
    assert.equal(text, `${ZH.rmrf}\n${ZH.noteWorkspaceWrite}`);
  });

  it("与这一档成因无关的键（`pipeShell`）不接那段删除说明", () => {
    const text = policyDenyText({
      key: "pipeShell",
      fix: undefined,
      facts: WORKSPACE,
      messages: ZH,
    });
    assert.equal(text, ZH.pipeShell, "下载即执行与「删除不具原子性」无关，不该被那段话引导");
  });

  it("带出路时：基础理由 → 出路，两段各占一行（`noVerify` 不带工作区档那段说明）", () => {
    const text = policyDenyText({
      key: "noVerify",
      fix: { role: "bypassFlag", offending: ["--no-verify"] },
      facts: WORKSPACE,
      messages: ZH,
    });
    const lines = text.split("\n");
    assert.equal(lines[0], ZH.noVerify, "第一段是基础理由");
    assert.match(lines[1] ?? "", /--no-verify/u, "第二段点名叫出越界旗标");
    assert.equal(lines.length, 2, "命令形态类拒绝不多接一段无关成因");
  });

  it("四段齐全时的逐行顺序：理由 → 出路 → 档位说明 → 换档出路", () => {
    // 四段只在「基础处置是 ask、且该档接说明」时出现：只读档的 git 破坏族 + 降级询问。
    const neverAsk: PolicyFacts = { ...WORKSPACE, mode: "read-only", askable: false };
    const fix = { role: "bypassFlag", offending: ["--force"] } as const;
    const text = policyDenyText({ key: "gitForcePush", fix, facts: neverAsk, messages: ZH });
    assert.deepEqual(text.split("\n"), [
      ZH.gitForcePush,
      renderFix(fix, ZH),
      ZH.noteReadOnly,
      ZH.askBlockedGeneric,
    ]);
  });

  it("三段齐全（硬拒 + 出路 + 档位说明）的逐行顺序", () => {
    // rmrf 在工作区档是硬拒（不上降级那一段），但会接删除原子性的说明。
    const fix = { role: "disasterTarget", offending: ["~"] } as const;
    const text = policyDenyText({ key: "rmrf", fix, facts: WORKSPACE, messages: ZH });
    assert.deepEqual(text.split("\n"), [ZH.rmrf, renderFix(fix, ZH), ZH.noteWorkspaceWrite]);
  });

  it("降级来的 deny 再接一段「这档问不了、换哪一档才能问」", () => {
    const neverAsk: PolicyFacts = { ...WORKSPACE, askable: false };
    const text = policyDenyText({
      key: "gitForcePush",
      fix: undefined,
      facts: neverAsk,
      messages: ZH,
    });
    assert.equal(text, `${ZH.gitForcePush}\n${ZH.askBlockedGeneric}`);
    assert.match(text, /不允许询问/u, "点明这档问不了");
    assert.match(text, /改成会询问/u, "出路指向审批策略，而不是让用户留在原地换档");
  });

  it("同一枚键在三档下文案不同（成因不同就不能说同一句话）", () => {
    const texts = new Set(
      (["read-only", "workspace-write", "unknown"] as const).map((mode) =>
        policyDenyText({
          key: "noVerify",
          fix: undefined,
          facts: { ...WORKSPACE, mode },
          messages: ZH,
        }),
      ),
    );
    assert.equal(texts.size, 3, "三档三段各不相同的说明");
  });
});

describe("policyDenyFlags：与文案同一份判据", () => {
  it("deny 档两类都算（本档硬拒 + 降级硬拒）；判据即 mode-policy 的 decideRule", () => {
    // isDenied 已删：guard 的两个调用点直接调 decideRule（判据单源在 mode-policy），
    // 这里钉的是 policyDenyFlags 与 decideRule 同源。
    assert.equal(decideRule(WORKSPACE, "pipeShell"), "deny", "本档硬拒");
    assert.equal(decideRule({ ...WORKSPACE, askable: false }, "gitForcePush"), "deny", "降级硬拒");
    assert.equal(decideRule(WORKSPACE, "gitForcePush"), "ask", "ask");
    assert.equal(decideRule(WORKSPACE, "devServer"), "allow", "allow");
  });

  it("policyDenyFlags.verdict 与 decideRule 逐格一致（不复制第二份判据表）", () => {
    const factSets: PolicyFacts[] = [
      WORKSPACE,
      { ...WORKSPACE, askable: false },
      { ...WORKSPACE, mode: "read-only" },
      { mode: FULL_MODE, askable: false, autoReview: false, sandboxCovers: false },
      { mode: FULL_MODE, askable: true, autoReview: true, sandboxCovers: false },
    ];
    for (const facts of factSets) {
      for (const key of ALL_RULE_KEYS) {
        assert.equal(
          policyDenyFlags(facts, key).verdict,
          decideRule(facts, key),
          `${facts.mode}/${String(facts.askable)}/${String(facts.autoReview)}/${key}`,
        );
      }
    }
  });

  it("判别位里 policyDenied 只在降级那一支为真", () => {
    assert.equal(policyDenyFlags(WORKSPACE, "pipeShell").policyDenied, false);
    assert.equal(
      policyDenyFlags({ ...WORKSPACE, askable: false }, "gitForcePush").policyDenied,
      true,
    );
    assert.equal(policyDenyFlags(WORKSPACE, "gitForcePush").verdict, "ask", "顺带交出结论");
  });
});

describe("档位说明的适用面：哪些键才接那段成因", () => {
  const ZERO_GUARD: PolicyFacts = {
    mode: FULL_MODE,
    askable: false,
    autoReview: false,
    sandboxCovers: false,
  };

  it("自动审查档：`rmrf` 与 `pipeShell` 接说明，git 族不接", () => {
    const auto: PolicyFacts = { ...ZERO_GUARD, askable: true, autoReview: true };
    for (const key of ["rmrf", "pipeShell"] as const) {
      const text = policyDenyText({ key, fix: undefined, facts: auto, messages: ZH });
      assert.ok(text.includes(ZH.noteFullAccess), `${key} 应带档位说明`);
    }
    const other = policyDenyText({
      key: "gitForcePush",
      fix: undefined,
      facts: auto,
      messages: ZH,
    });
    assert.equal(other, ZH.gitForcePush, "与本档成因无关的键不接说明");
  });

  it("只读档与 unknown 档：任何键都接**本档**说明（期望文案显式写出）", () => {
    const NOTE = { "read-only": ZH.noteReadOnly, unknown: ZH.noteUnknown } as const;
    for (const mode of ["read-only", "unknown"] as const) {
      const facts: PolicyFacts = { ...ZERO_GUARD, mode };
      for (const key of ["rmrf", "pipeShell", "gitForcePush"] as const) {
        const text = policyDenyText({ key, fix: undefined, facts, messages: ZH });
        assert.ok(text.includes(NOTE[mode]), `${mode}/${key}`);
      }
    }
  });

  it("完全权限的三个出口按真实拒绝面接说明", () => {
    // 问不了：整档只硬拒 noVerify，不能把「问不了」的说明接到已放行的硬拦键上。
    const never = policyDenyText({
      key: "noVerify",
      fix: undefined,
      facts: ZERO_GUARD,
      messages: ZH,
    });
    assert.ok(never.includes(ZH.noteFullAccess));

    // 仍能问：rmrf 走工作区档的硬拒，接完全权限的说明；pipeShell 不接。
    const askable: PolicyFacts = { ...ZERO_GUARD, askable: true };
    assert.ok(
      policyDenyText({ key: "rmrf", fix: undefined, facts: askable, messages: ZH }).includes(
        ZH.noteFullAccess,
      ),
    );
    assert.equal(
      policyDenyText({ key: "pipeShell", fix: undefined, facts: askable, messages: ZH }),
      ZH.pipeShell,
    );
  });
});

describe("策略降级：基础文案里的「请用户确认」在本档不可行", () => {
  it("降级文案明确覆盖那条出路，只留改写形态与换档两条", () => {
    // 基础文案（gitForcePush 等）收尾写着「或请用户确认」；同一段话又接
    // 「本档不允许询问」时，模型会拿到两条互斥的下一步。
    const text = policyDenyText({
      key: "gitForcePush",
      fix: undefined,
      facts: { ...WORKSPACE, askable: false },
      messages: ZH,
    });
    assert.ok(text.includes(ZH.gitForcePush));
    assert.ok(text.includes(ZH.askBlockedGeneric));
    assert.match(text, /「请用户确认」，在本档不可行/u);
  });
});
