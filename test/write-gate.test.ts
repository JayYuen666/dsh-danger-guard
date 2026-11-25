// lib/write-gate 的单元用例：补丁目标无法核对时必须 fail-closed，MCP 同名工具同判。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { writeGateDecisionOf } from "../lib/write-gate.ts";
import type { WriteGateHooks } from "../lib/write-gate.ts";
import { writeTargetsOf } from "../lib/write-targets.ts";

const OPAQUE = "target cannot be checked";

const hooks: WriteGateHooks = {
  scan: writeTargetsOf,
  secret: () => ({
    reason: undefined,
    cost: { face: "secret", ms: 0, length: 0, judged: true },
  }),
  fact: () => "fact-deny",
  opaque: OPAQUE,
};

describe("writeGateDecisionOf 的补丁 fail-closed", () => {
  it("内置与 MCP 的 apply_patch 空目标都走 opaque，不让事实门 undefined 放行", () => {
    for (const name of ["apply_patch", "mcp__fs__apply_patch"]) {
      const decision = writeGateDecisionOf(hooks, name, {});
      assert.equal(decision.deny, OPAQUE, name);
      assert.equal(decision.secretCost, undefined, name);
    }
  });

  it("目标超限同样 fail-closed", () => {
    const lines = ["*** Begin Patch"];
    for (let at = 0; at <= 200; at += 1) {
      lines.push(`*** Add File: f${String(at)}.ts`, "+x");
    }
    lines.push("*** End Patch");
    const decision = writeGateDecisionOf(hooks, "mcp__fs__apply_patch", {
      input: lines.join("\n"),
    });
    assert.equal(decision.deny, OPAQUE);
  });
});
