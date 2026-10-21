// test/mode-policy.test.ts —— **按权限档位分叉的处置表**：四档 × 全部规则键的矩阵。
//
// 这一份钉的是本轮的判据本体（`lib/mode-policy.ts`）：同一枚规则键在四个预设下各是什么结论。
// 它不碰宿主、不碰 fs、不起子进程 —— 纯函数逐格断言，所以矩阵漂了会当场红，
// 而不是等到某天用户在某一档里被莫名拦下。
//
// 表是按**用户拍板的决策**写死的（不是从实现里派生）：期望值独立写在这里，
// 实现改动必须来改这张表，两处一起错才可能一起绿。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  ALL_RULE_KEYS,
  decideRule,
  deniedByPolicy,
  modeNoteKeyOf,
  severityResolverOf,
} from "../lib/mode-policy.ts";
import type { GuardMode, PolicyFacts, RuleVerdict } from "../lib/mode-policy.ts";
import type { BashDenialKey } from "../lib/danger-rules.ts";

/** 本文件反复出现的两个档位名（`no-duplicate-string` 盯字面量重复）。 */
const WS_MODE = "workspace-write";
const FULL = "danger-full-access";

/** 四个预设折算成的档位事实（与官方 `dsh-base` 的预设表一一对应）。 */
const READ_ONLY: PolicyFacts = {
  mode: "read-only",
  askable: true,
  autoReview: false,
  sandboxCovers: false,
};
const WORKSPACE_WRITE: PolicyFacts = { ...READ_ONLY, mode: WS_MODE };
/** 完全权限：`danger-full-access` + `approval: never`，零兵底。 */
const FULL_ACCESS: PolicyFacts = {
  mode: FULL,
  askable: false,
  autoReview: false,
  sandboxCovers: false,
};
/** 自动审查：同为 `danger-full-access`，但审批策略是 `ask` 且带逐调用 reviewer。 */
const AUTO_REVIEW: PolicyFacts = {
  mode: FULL,
  askable: true,
  autoReview: true,
  sandboxCovers: false,
};
/** 读不到沙箱模式（没有可约束的执行器）⇒ 保守列。 */
const UNKNOWN: PolicyFacts = { ...READ_ONLY, mode: "unknown" };

/** 逐格期望表。**用户拍板的决策**，不是从实现反推出来的。 */
const EXPECTED: Readonly<Record<GuardMode, Readonly<Record<BashDenialKey, RuleVerdict>>>> = {
  "read-only": {
    noVerify: "deny",
    rmrf: "deny",
    pipeShell: "allow",
    devServer: "allow",
    nestedShellUnconfirmed: "ask",
    gitResetHard: "ask",
    gitCheckoutDiscard: "ask",
    gitRestoreDiscard: "ask",
    gitCleanForce: "ask",
    gitStashDrop: "ask",
    gitBranchDelete: "ask",
    gitForcePush: "ask",
    tfDestroy: "ask",
    tfAutoApprove: "ask",
    dockerPrune: "ask",
    kubectlDelete: "ask",
    dbMigrate: "ask",
  },
  "workspace-write": {
    noVerify: "deny",
    rmrf: "deny",
    pipeShell: "deny",
    devServer: "allow",
    nestedShellUnconfirmed: "allow",
    gitResetHard: "ask",
    gitCheckoutDiscard: "ask",
    gitRestoreDiscard: "ask",
    gitCleanForce: "ask",
    gitStashDrop: "ask",
    gitBranchDelete: "ask",
    gitForcePush: "ask",
    tfDestroy: "ask",
    tfAutoApprove: "ask",
    dockerPrune: "ask",
    kubectlDelete: "ask",
    dbMigrate: "ask",
  },
  unknown: {
    noVerify: "deny",
    rmrf: "deny",
    pipeShell: "deny",
    devServer: "allow",
    nestedShellUnconfirmed: "ask",
    gitResetHard: "ask",
    gitCheckoutDiscard: "ask",
    gitRestoreDiscard: "ask",
    gitCleanForce: "ask",
    gitStashDrop: "ask",
    gitBranchDelete: "ask",
    gitForcePush: "ask",
    tfDestroy: "ask",
    tfAutoApprove: "ask",
    dockerPrune: "ask",
    kubectlDelete: "ask",
    dbMigrate: "ask",
  },
  // 完全权限：零兵底，全部 allow（只统计不打断）。
  "danger-full-access": Object.fromEntries(ALL_RULE_KEYS.map((key) => [key, "allow"])) as Readonly<
    Record<BashDenialKey, RuleVerdict>
  >,
};

/** 自动审查不是 `GuardMode` 的一列（它是 `danger-full-access` + reviewer），期望单列一份。 */
const AUTO_EXPECTED = Object.fromEntries(
  ALL_RULE_KEYS.map((key) => [key, key === "rmrf" || key === "pipeShell" ? "deny" : "allow"]),
) as Readonly<Record<BashDenialKey, RuleVerdict>>;

describe("四档矩阵：每一枚规则键在每一个预设下的结论", () => {
  it("仅可查看：写类让给沙箱、长驻让给宿主、其余照问", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(READ_ONLY, key), EXPECTED["read-only"][key], key);
    }
  });

  it("工作区内修改：包住可写根的删除与下载即执行硬拦，认不准的形态放行", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(WORKSPACE_WRITE, key), EXPECTED["workspace-write"][key], key);
    }
  });

  it("完全权限：零兵底，全部放行（用户明确选了只统计不打断）", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(FULL_ACCESS, key), "allow", key);
    }
  });

  it("自动审查：只留灾难删除与下载即执行两条确定性硬拦", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(AUTO_REVIEW, key), AUTO_EXPECTED[key], key);
    }
  });

  it("读不到沙箱模式：按保守列（没有沙箱兜底时更紧）", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(UNKNOWN, key), EXPECTED.unknown[key], key);
    }
  });

  it("四档逐键确实**不同**（这张表不是一个常量穿四件衣服）", () => {
    // 这几枚在四档之间必须分叉，否则"按档位分叉"这件事等于没做。
    for (const key of ["pipeShell", "nestedShellUnconfirmed", "rmrf"] as const) {
      const verdicts = new Set([
        decideRule(READ_ONLY, key),
        decideRule(WORKSPACE_WRITE, key),
        decideRule(FULL_ACCESS, key),
        decideRule(AUTO_REVIEW, key),
      ]);
      assert.ok(verdicts.size >= 2, `${key} 在四档下应当至少有两种结论`);
    }
  });
});

describe("完全权限档的两个分支：零兵底只属于「问不了」的那一支", () => {
  /** 完全权限 + 仍能问（自定义组合，或没装预设服务时的默认 ask）。 */
  const FULL_ACCESS_ASKABLE: PolicyFacts = {
    mode: FULL,
    askable: true,
    autoReview: false,
    sandboxCovers: false,
  };

  it("问不了 ⇒ 零兵底，整档放行", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(FULL_ACCESS, key), "allow", key);
    }
  });

  it("还能问 ⇒ 不能按零兵底放行：沿用工作区档的处置（沙箱不兜底，写类要我们拦）", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(FULL_ACCESS_ASKABLE, key), EXPECTED["workspace-write"][key], key);
    }
  });

  it("那支里的 `rmrf` 仍然拦（不是静默放行）——这正是本条修复的缺口", () => {
    // 沿用工作区档的 `deny`：这一档沙箱完全不兜底，灾难删除不能只问一句。
    assert.equal(decideRule(FULL_ACCESS_ASKABLE, "rmrf"), "deny");
  });

  it("自动审查档仍按两条硬拦收紧", () => {
    const auto: PolicyFacts = { ...FULL_ACCESS_ASKABLE, autoReview: true };
    assert.equal(decideRule(auto, "rmrf"), "deny");
    assert.equal(decideRule(auto, "pipeShell"), "deny");
  });
});

describe("rmrf 的沙箱让路只发生在「沙箱确实盖住这次目标」时", () => {
  it("沙箱盖住 ⇒ 让给宿主（它会给出官方标记与升级路径）", () => {
    const covered: PolicyFacts = { ...WORKSPACE_WRITE, sandboxCovers: true };
    assert.equal(decideRule(covered, "rmrf"), "allow");
  });

  it("沙箱盖不住 ⇒ 我们拦（路径白名单不提供原子性，先删掉的不回滚）", () => {
    assert.equal(decideRule(WORKSPACE_WRITE, "rmrf"), "deny");
  });

  it("这一位只对 `rmrf` 有意义：别的键传 true 也不改变结论", () => {
    const bogus: PolicyFacts = { ...WORKSPACE_WRITE, sandboxCovers: true };
    assert.equal(decideRule(bogus, "pipeShell"), "deny");
    assert.equal(decideRule(bogus, "gitCleanForce"), "ask");
  });
});

describe("「问不了」的档位把 ask 收口成 deny，并标出这是策略降级", () => {
  it("能问 ⇒ ask 就是 ask", () => {
    assert.equal(decideRule(WORKSPACE_WRITE, "gitForcePush"), "ask");
    assert.equal(deniedByPolicy(WORKSPACE_WRITE, "gitForcePush"), false);
  });

  it("问不了（自定义 workspace-write + never）⇒ deny，且标记为策略降级", () => {
    const neverAsk: PolicyFacts = { ...WORKSPACE_WRITE, askable: false };
    assert.equal(decideRule(neverAsk, "gitForcePush"), "deny");
    assert.equal(deniedByPolicy(neverAsk, "gitForcePush"), true);
  });

  it("本来就 deny 的键不算策略降级（那是命令形态错，不是这档问不了）", () => {
    const neverAsk: PolicyFacts = { ...WORKSPACE_WRITE, askable: false };
    assert.equal(decideRule(neverAsk, "pipeShell"), "deny");
    assert.equal(deniedByPolicy(neverAsk, "pipeShell"), false);
  });

  it("完全权限档不参与降级标记：它整体就是 allow（零兵底）", () => {
    assert.equal(deniedByPolicy(FULL_ACCESS, "gitForcePush"), false);
  });
});

describe("档位说明：同一枚键在不同预设下说不同的话", () => {
  it("四档各取各的说明键", () => {
    assert.equal(modeNoteKeyOf(READ_ONLY), "noteReadOnly");
    assert.equal(modeNoteKeyOf(WORKSPACE_WRITE), "noteWorkspaceWrite");
    assert.equal(modeNoteKeyOf(FULL_ACCESS), "noteFullAccess");
    assert.equal(modeNoteKeyOf(UNKNOWN), "noteUnknown");
  });
});

describe("severityResolverOf：扫描层按真实档位排序（串行命令的漏拦修复）", () => {
  /** 只读档：`pipeShell` 与 `devServer` 放行，git 族仍要问——这组差异正是排序要用的。 */
  const READ_ONLY_FACTS: PolicyFacts = {
    mode: "read-only",
    askable: true,
    autoReview: false,
    sandboxCovers: false,
  };

  it("逐键回的就是 `decideRule` 的结论", () => {
    const severity = severityResolverOf(READ_ONLY_FACTS);
    for (const key of ALL_RULE_KEYS) {
      assert.equal(severity(key), decideRule(READ_ONLY_FACTS, key), key);
    }
  });

  it("同一键重复求值结果稳定（内部有记忆，但语义与逐次求值一致）", () => {
    const severity = severityResolverOf(READ_ONLY_FACTS);
    assert.equal(severity("gitForcePush"), severity("gitForcePush"));
  });

  it("只读档里 `pipeShell` 是 allow、`gitForcePush` 是 ask（后者更严重）", () => {
    const severity = severityResolverOf(READ_ONLY_FACTS);
    assert.equal(severity("pipeShell"), "allow");
    assert.equal(severity("gitForcePush"), "ask");
  });
});
