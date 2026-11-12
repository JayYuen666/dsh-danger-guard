// test/shell-face.test.ts —— terminal_send 的调用面归一（lib/shell-face.ts）。
//
// 为什么单列：rc.2 的实验性持久终端把命令放在 `text` 里，后端默认 shell 又随平台变；
// 归一是两条判定通道（guard 与需确认档）共用的唯一入口，错一位就是整类漏判或方言漂移。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { shellFaceOf, TERMINAL_SEND_TOOL } from "../lib/shell-face.ts";

describe("shellFaceOf：非命令行工具原样交回", () => {
  it("bash 的参数对象保持同一份引用", () => {
    const args = { command: "git status" };
    const face = shellFaceOf("bash", args);
    assert.equal(face.name, "bash");
    assert.equal(face.args, args);
  });

  it("参数缺席时折成空记录（调用方不必再判空）", () => {
    assert.deepEqual(shellFaceOf("read", undefined), { name: "read", args: {} });
  });
});

describe("shellFaceOf：terminal_send 折成终端后端的默认 shell", () => {
  it("posix 平台走 bash，text 折成 command 且其余参数保留", () => {
    const face = shellFaceOf(
      TERMINAL_SEND_TOOL,
      { sessionId: "t1", text: "rm -rf ~", submit: false },
      "darwin",
    );
    assert.equal(face.name, "bash");
    assert.deepEqual(face.args, {
      sessionId: "t1",
      text: "rm -rf ~",
      submit: false,
      command: "rm -rf ~",
    });
  });

  it("win32 平台走 pwsh", () => {
    const face = shellFaceOf(TERMINAL_SEND_TOOL, { text: "Remove-Item -Recurse ~" }, "win32");
    assert.equal(face.name, "pwsh");
    assert.equal(face.args["command"], "Remove-Item -Recurse ~");
  });

  it("text 非字符串 ⇒ command 空串（不猜：非串输入不参与判定）", () => {
    assert.deepEqual(shellFaceOf(TERMINAL_SEND_TOOL, { text: 42 }, "linux").args, {
      text: 42,
      command: "",
    });
  });

  it("参数整个缺席 ⇒ command 空串", () => {
    assert.deepEqual(shellFaceOf(TERMINAL_SEND_TOOL, undefined, "linux").args, { command: "" });
  });

  it("缺省平台读 process.platform", () => {
    const expected = process.platform === "win32" ? "pwsh" : "bash";
    assert.equal(shellFaceOf(TERMINAL_SEND_TOOL, { text: "echo x" }).name, expected);
  });
});
