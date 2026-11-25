// test/tool-names.test.ts —— MCP 文件工具名的唯一判据（lib/tool-names.ts）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { isApplyPatchToolName, isEditToolName, isReadToolName } from "../lib/tool-names.ts";
import { editTargetPath } from "../lib/danger-rules.ts";
import { writeTargetsOf } from "../lib/write-targets.ts";

describe("isEditToolName：内置工具与 MCP 文件写工具", () => {
  it("内置四个写工具保持命中", () => {
    for (const name of ["edit", "write", "str_replace_editor", "apply_patch"]) {
      assert.equal(isEditToolName(name), true, name);
    }
  });

  it("mcp 的 write_file/edit_file/create_file 等最后一段命中", () => {
    for (const name of [
      "mcp__fs__write_file",
      "mcp__filesystem__edit_file",
      "mcp__filesystem__create_file",
      "mcp__fs__replace_in_file",
      "mcp__fs__patch_file",
      "mcp__fs__str_replace",
      "mcp__fs__write_text_file",
      "mcp__fs__append_file",
      "mcp__fs__replace_text",
      "mcp__fs__insert_text",
      "mcp__fs__delete_text_range",
      "mcp__fs__apply_diff",
    ]) {
      assert.equal(isEditToolName(name), true, name);
    }
  });

  it("普通工具名与 MCP 的读/执行工具不误判", () => {
    for (const name of ["read", "bash", "mcp__fs__read_file", "mcp__shell__run", "writeFile"]) {
      assert.equal(isEditToolName(name), false, name);
    }
  });

  it("缺名字时三个判据都返回 false", () => {
    assert.equal(isEditToolName(undefined), false);
    assert.equal(isApplyPatchToolName(undefined), false);
    assert.equal(isReadToolName(undefined), false);
  });
});

describe("isApplyPatchToolName / isReadToolName", () => {
  it("补丁工具认内置与 MCP 同名", () => {
    assert.equal(isApplyPatchToolName("apply_patch"), true);
    assert.equal(isApplyPatchToolName("mcp__fs__apply_patch"), true);
    assert.equal(isApplyPatchToolName("mcp__fs__write_file"), false);
  });

  it("读工具认 read / view / MCP 读工具", () => {
    assert.equal(isReadToolName("read"), true);
    assert.equal(isReadToolName("str_replace_editor", "view"), true);
    assert.equal(isReadToolName("str_replace_editor", "create"), false);
    assert.equal(isReadToolName("mcp__fs__read_file"), true);
    assert.equal(isReadToolName("mcp__fs__get_file_contents"), true);
    assert.equal(isReadToolName("mcp__fs__read_multiple_files"), true);
    assert.equal(isReadToolName("mcp__fs__write_file"), false);
  });
});

describe("mcp 写工具进入目标门", () => {
  it("editTargetPath 取出 path/file_path", () => {
    assert.equal(editTargetPath("mcp__fs__write_file", { path: "src/a.ts" }), "src/a.ts");
    assert.equal(editTargetPath("mcp__fs__edit_file", { file_path: "src/b.ts" }), "src/b.ts");
    assert.equal(editTargetPath("mcp__fs__append_file", { path: "src/c.ts" }), "src/c.ts");
    assert.equal(editTargetPath("mcp__fs__apply_diff", { path: "src/d.ts" }), "src/d.ts");
    assert.equal(editTargetPath("mcp__fs__apply_patch", { path: "src/a.ts" }), null);
  });

  it("writeTargetsOf 给出目标，不再按空清单静默放过", () => {
    const scan = writeTargetsOf("mcp__fs__write_file", { path: "src/a.ts", content: "x" });
    assert.deepEqual(scan.targets, [{ path: "src/a.ts", creatable: true }]);
  });
});
