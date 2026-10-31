// test/disaster-target.test.ts —— 灾难目标词面的归一判据。
//
// 这一层只回答「这个词面落到哪条绝对路径」；判不出来必须交回 undefined（调用方据此不让路）。
// 两个容易写成"编一个看似合理的路径"的入口：空词面与 shell 的 `$HOME`。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { disasterTargetPathOf } from "../lib/disaster-target.ts";
import { asOsPath } from "../lib/path-format.ts";

const ROOT = path.parse(process.cwd()).root;
const CWD = asOsPath(path.resolve(ROOT, "w", "proj"));

describe("disasterTargetPathOf：空词面与相对形", () => {
  it("空词面不归一到 cwd：那是替读不懂的输入编一个目标", () => {
    assert.equal(disasterTargetPathOf("", CWD), undefined);
  });

  it("相对词面按 cwd 归一；没有 cwd 时交回 undefined", () => {
    assert.equal(disasterTargetPathOf("src", CWD), path.resolve(CWD, "src"));
    assert.equal(disasterTargetPathOf("src", undefined), undefined);
  });
});

describe("disasterTargetPathOf：家目录形态", () => {
  it("`~` 与 `~/x` 按 os.homedir() 展开", () => {
    const home = os.homedir();
    assert.equal(disasterTargetPathOf("~", CWD), home);
    assert.equal(disasterTargetPathOf("~/Documents", CWD), path.join(home, "Documents"));
  });

  it("未设置 HOME 时不把 `$HOME` 当成家目录：shell 会把它展开成空串", () => {
    const saved = process.env["HOME"];
    try {
      delete process.env["HOME"];
      assert.equal(disasterTargetPathOf("$HOME", CWD), undefined);
      assert.equal(disasterTargetPathOf("$HOME/Documents", CWD), undefined);
    } finally {
      if (saved !== undefined) {
        process.env["HOME"] = saved;
      }
    }
  });

  it("设置 HOME 时 `$HOME` 与 `~` 同解", () => {
    const saved = process.env["HOME"];
    try {
      process.env["HOME"] = os.homedir();
      assert.equal(disasterTargetPathOf("$HOME", CWD), os.homedir());
      assert.equal(
        disasterTargetPathOf("$HOME/Documents", CWD),
        path.join(os.homedir(), "Documents"),
      );
    } finally {
      if (saved === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = saved;
      }
    }
  });

  it("`HOME` 是相对路径时不把 `~` 当可判目标", () => {
    const saved = process.env["HOME"];
    try {
      process.env["HOME"] = "relative-home";
      assert.equal(disasterTargetPathOf("~", CWD), undefined);
      assert.equal(disasterTargetPathOf("~/Documents", CWD), undefined);
    } finally {
      if (saved === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = saved;
      }
    }
  });
});
