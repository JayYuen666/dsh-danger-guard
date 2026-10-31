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
  modeNoteApplies,
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
    pipeShell: "ask",
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
  // 完全权限：零兵底，只统计不打断 —— 除 `noVerify`：绕 git 钩子与沙箱无关，是这张表自己
  // 的判据（`BASE` 里每一列都是 deny），不该被"这档不问"顺带放行。
  // 逐键写全（不按 ALL_RULE_KEYS 生成）：新增规则键时这里必须**编译失败**，
  // 「这档该不该放行新规则」才会回到用户面前，而不是被默认值静默吞掉。
  "danger-full-access": {
    noVerify: "deny",
    rmrf: "allow",
    pipeShell: "allow",
    devServer: "allow",
    nestedShellUnconfirmed: "allow",
    gitResetHard: "allow",
    gitCheckoutDiscard: "allow",
    gitRestoreDiscard: "allow",
    gitCleanForce: "allow",
    gitStashDrop: "allow",
    gitBranchDelete: "allow",
    gitForcePush: "allow",
    tfDestroy: "allow",
    tfAutoApprove: "allow",
    dockerPrune: "allow",
    kubectlDelete: "allow",
    dbMigrate: "allow",
  },
};

/** 自动审查不是 `GuardMode` 的一列（它是 `danger-full-access` + reviewer），期望单列一份。
 *  同样是逐键写全：灾难删除与下载即执行硬拦；`noVerify` 也硬拦（与沙箱无关的固定判据，
 *  不交给 reviewer）；其余交给它。 */
const AUTO_EXPECTED: Readonly<Record<BashDenialKey, RuleVerdict>> = {
  noVerify: "deny",
  rmrf: "deny",
  pipeShell: "deny",
  devServer: "allow",
  nestedShellUnconfirmed: "allow",
  gitResetHard: "allow",
  gitCheckoutDiscard: "allow",
  gitRestoreDiscard: "allow",
  gitCleanForce: "allow",
  gitStashDrop: "allow",
  gitBranchDelete: "allow",
  gitForcePush: "allow",
  tfDestroy: "allow",
  tfAutoApprove: "allow",
  dockerPrune: "allow",
  kubectlDelete: "allow",
  dbMigrate: "allow",
};

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

  it("完全权限：零兵底，除钩子绕以外全部放行（用户明确选了只统计不打断）", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(FULL_ACCESS, key), EXPECTED[FULL][key], key);
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

  it("四档两两整列不同（这张表不是一个常量穿四件衣服）", () => {
    const columns = [READ_ONLY, WORKSPACE_WRITE, FULL_ACCESS, AUTO_REVIEW].map((facts) =>
      ALL_RULE_KEYS.map((key) => `${key}=${decideRule(facts, key)}`).join(","),
    );
    for (const [leftIndex, left] of columns.entries()) {
      for (const [rightIndex, right] of columns.entries()) {
        if (leftIndex < rightIndex) {
          assert.notEqual(left, right, `第 ${leftIndex} 档与第 ${rightIndex} 档的整列结论必须不同`);
        }
      }
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

  it("问不了 ⇒ 零兵底（`noVerify` 除外，它不靠问也不靠沙箱）", () => {
    for (const key of ALL_RULE_KEYS) {
      assert.equal(decideRule(FULL_ACCESS, key), EXPECTED[FULL][key], key);
    }
    // 单点钉住那条例外：整档 allow 会把它一起放掉，而这正是本条的缺口。
    assert.equal(decideRule(FULL_ACCESS, "noVerify"), "deny");
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
    assert.equal(decideRule(AUTO_REVIEW, "rmrf"), "deny");
    assert.equal(decideRule(AUTO_REVIEW, "pipeShell"), "deny");
  });

  it("自动审查 + 问不了：硬拦仍然生效，不被零兵底整档放行", () => {
    const autoNever: PolicyFacts = { ...FULL_ACCESS_ASKABLE, autoReview: true, askable: false };
    for (const key of ["rmrf", "pipeShell", "noVerify"] as const) {
      assert.equal(decideRule(autoNever, key), "deny", key);
    }
    assert.equal(decideRule(autoNever, "gitForcePush"), "allow");
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

  it("`unknown` 档不因 `sandboxCovers` 让路：没有沙箱模式就没有兜底", () => {
    const unknownCovered: PolicyFacts = {
      ...UNKNOWN,
      sandboxCovers: true,
    };
    assert.equal(decideRule(unknownCovered, "rmrf"), "deny");
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

  it("完全权限的三个出口各接各的说明（不把「问不了」的话接到能问的出口）", () => {
    const askable: PolicyFacts = { ...FULL_ACCESS, askable: true };
    assert.equal(modeNoteApplies(askable, "rmrf"), true);
    assert.equal(modeNoteApplies(askable, "pipeShell"), false);
    assert.equal(modeNoteApplies(askable, "gitForcePush"), false);

    const auto: PolicyFacts = { ...FULL_ACCESS, askable: true, autoReview: true };
    assert.equal(modeNoteApplies(auto, "rmrf"), true);
    assert.equal(modeNoteApplies(auto, "pipeShell"), true);
    assert.equal(modeNoteApplies(auto, "noVerify"), true);
    assert.equal(modeNoteApplies(auto, "gitForcePush"), false);

    // 问不了时整档只硬拒 `noVerify`，硬拦集合这一支反而放行，不能接说明。
    assert.equal(modeNoteApplies(FULL_ACCESS, "noVerify"), true);
    assert.equal(modeNoteApplies(FULL_ACCESS, "rmrf"), false);
  });
});

describe("severityResolverOf：扫描层按真实档位排序（串行命令的漏拦修复）", () => {
  /** 只读档：`devServer` 放行、git 族仍要问——这组差异正是排序要用的。 */
  const READ_ONLY_FACTS: PolicyFacts = READ_ONLY;

  it("逐键回的就是 `decideRule` 的结论", () => {
    const severity = severityResolverOf(READ_ONLY_FACTS);
    for (const key of ALL_RULE_KEYS) {
      assert.equal(severity({ key }), decideRule(READ_ONLY_FACTS, key), key);
    }
  });

  it("同一键重复求值结果稳定（内部有记忆，但语义与逐次求值一致）", () => {
    const severity = severityResolverOf(READ_ONLY_FACTS);
    assert.equal(severity({ key: "gitForcePush" }), severity({ key: "gitForcePush" }));
  });

  it("串行命令按真实档位择优：前段放行不会吞掉后段该问的那一条", () => {
    // 只读档里 `devServer` 放行、`gitForcePush` 仍要问：按静态表「最严重」排序会让前段的
    // allow 提前收工，把后段该问的那条整个吞掉。
    const severity = severityResolverOf(READ_ONLY_FACTS);
    const verdicts = [{ key: "devServer" }, { key: "gitForcePush" }].map((hit) =>
      severity(hit as { key: BashDenialKey }),
    );
    assert.deepEqual(verdicts, ["allow", "ask"], "两段的实际处置按档位给出");
    const rank: Readonly<Record<RuleVerdict, number>> = { allow: 0, ask: 1, deny: 2 };
    let worst: RuleVerdict = "allow";
    for (const verdict of verdicts) {
      if (rank[verdict] > rank[worst]) {
        worst = verdict;
      }
    }
    assert.equal(worst, "ask", "取最严重的那一段：ask，而不是被前段的 allow 吞掉");
  });

  it("只读档里 `devServer` 是 allow、`gitForcePush` 是 ask（后者更严重）", () => {
    const severity = severityResolverOf(READ_ONLY_FACTS);
    assert.equal(severity({ key: "devServer" }), "allow");
    assert.equal(severity({ key: "gitForcePush" }), "ask");
  });
});
