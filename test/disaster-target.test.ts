// test/disaster-target.test.ts —— 灾难目标词的归一判据。
//
// 这一层只回答「这个词落到哪条绝对路径」；判不出来必须交回 undefined（调用方据此不让路）。
// 两个容易写成"编一个看似合理的路径"的入口：空输入与 shell 的 `$HOME`。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { disasterTargetPathOf } from "../lib/disaster-target.ts";
import { asOsPath } from "../lib/path-format.ts";

const ROOT = path.parse(process.cwd()).root;
const CWD = asOsPath(path.resolve(ROOT, "w", "proj"));

describe("disasterTargetPathOf：空输入与相对路径形", () => {
  it("空输入不归一到 cwd：那是替读不懂的输入编一个目标", () => {
    assert.equal(disasterTargetPathOf("", CWD), undefined);
  });

  it("相对的词按 cwd 归一；没有 cwd 时交回 undefined", () => {
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
    // os.homedir() 的可读来源随平台变：POSIX 读 HOME，Windows 读 USERPROFILE。只注入一枚时，
    // 另一平台读到的仍是真实家目录（绝对形），这条用例就会在那边判成「可判」。两枚一起改、
    // 一起恢复，测的才是「家目录本身是相对形」这一个条件。
    const savedHome = process.env["HOME"];
    const savedProfile = process.env["USERPROFILE"];
    try {
      process.env["HOME"] = "relative-home";
      process.env["USERPROFILE"] = "relative-home";
      assert.equal(disasterTargetPathOf("~", CWD), undefined);
      assert.equal(disasterTargetPathOf("~/Documents", CWD), undefined);
    } finally {
      if (savedHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = savedHome;
      }
      if (savedProfile === undefined) {
        delete process.env["USERPROFILE"];
      } else {
        process.env["USERPROFILE"] = savedProfile;
      }
    }
  });
});
