// lib/write-targets 的单元用例：apply_patch 的逐操作目标、move 目的路径与预算上限。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  APPLY_PATCH_TARGET_LIMIT,
  dedupeWriteTargets,
  writeTargetsOf,
} from "../lib/write-targets.ts";

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";

describe("writeTargetsOf", () => {
  it("普通编辑器仍走单目标，edit/write 的 creatable 按工具名给", () => {
    assert.deepEqual(writeTargetsOf("edit", { file_path: "a.ts" }), {
      targets: [{ path: "a.ts", creatable: false }],
      overflow: false,
    });
    assert.deepEqual(writeTargetsOf("write", { file_path: "b.ts" }), {
      targets: [{ path: "b.ts", creatable: true }],
      overflow: false,
    });
  });

  it("apply_patch 把 move 的源与目的都算成目标（目的可创建）", () => {
    const patch = [
      PATCH_BEGIN,
      "*** Update File: b.ts",
      "*** Move to: c.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: d.ts",
      PATCH_END,
    ].join("\n");
    assert.deepEqual(writeTargetsOf("apply_patch", { input: patch }), {
      targets: [
        { path: "b.ts", creatable: false },
        { path: "c.ts", creatable: true },
        { path: "d.ts", creatable: false },
      ],
      overflow: false,
    });
  });

  it("dedupe 直接丢弃空路径", () => {
    assert.deepEqual(
      dedupeWriteTargets([
        { path: "", creatable: true },
        { path: "a.ts", creatable: true },
      ]),
      [{ path: "a.ts", creatable: true }],
    );
  });

  it("空路径被丢弃；同一路径重复出现时按最保守的 creatable 收口", () => {
    const empty = writeTargetsOf("apply_patch", {
      input: "*** Begin Patch\n*** Add File: \n+x\n*** End Patch",
    });
    assert.deepEqual(empty.targets, [], "空路径不进目标表");

    const addThenUpdate = [
      PATCH_BEGIN,
      "*** Add File: dup.ts",
      "+x",
      "*** Update File: dup.ts",
      "@@",
      "-x",
      "+y",
      PATCH_END,
    ].join("\n");
    assert.deepEqual(writeTargetsOf("apply_patch", { input: addThenUpdate }).targets, [
      { path: "dup.ts", creatable: false },
    ]);

    const updateThenAdd = [
      PATCH_BEGIN,
      "*** Update File: dup2.ts",
      "@@",
      "-x",
      "+y",
      "*** Add File: dup2.ts",
      "+x",
      PATCH_END,
    ].join("\n");
    assert.deepEqual(writeTargetsOf("apply_patch", { input: updateThenAdd }).targets, [
      { path: "dup2.ts", creatable: false },
    ]);
  });

  it("超过目标上限时标 overflow，交回调用方 fail-closed", () => {
    const lines = [PATCH_BEGIN];
    for (let at = 0; at <= APPLY_PATCH_TARGET_LIMIT; at += 1) {
      lines.push(`*** Add File: f${String(at)}.ts`, "+x");
    }
    lines.push(PATCH_END);
    const scan = writeTargetsOf("apply_patch", { input: lines.join("\n") });
    assert.equal(scan.targets.length, APPLY_PATCH_TARGET_LIMIT + 1);
    assert.equal(scan.overflow, true);
  });
});
