// test/shell-face.test.ts —— terminal_send 的调用面归一（lib/shell-face.ts）。
//
// 为什么单列：rc.2 的实验性持久终端把命令放在 `text` 里，后端默认 shell 又随平台变；
// 归一是两条判定通道（guard 与需确认档）共用的唯一入口，错一位就是整类漏判或方言漂移。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { sandboxAppliesTo, shellFaceOf, TERMINAL_SEND_TOOL } from "../lib/shell-face.ts";

/** MCP shell 用例反复用的命令字面量：同一串改一处就漏。 */
const MCP_RM_ETC = "rm -rf /etc";

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

describe("shellFaceOf：MCP shell 的 command 归一", () => {
  it("mcp__<server>__<tool> 的 command 折成 bash/pwsh 调用面", () => {
    const face = shellFaceOf("mcp__shell__run", { command: MCP_RM_ETC, timeout: 10 }, "darwin");
    assert.equal(face.name, "bash");
    assert.equal(face.args["command"], MCP_RM_ETC);
    assert.equal(face.args["timeout"], 10);
  });

  it("win32 平台折成 pwsh，cmd 参数同样认", () => {
    const face = shellFaceOf(
      "mcp__shell__run",
      { cmd: String.raw`Remove-Item -Recurse C:\Windows` },
      "win32",
    );
    assert.equal(face.name, "pwsh");
    assert.equal(face.args["command"], String.raw`Remove-Item -Recurse C:\Windows`);
  });

  it("没有 command/cmd 的 MCP 工具原样交回（cua_run_code 的 code 不按 shell 读）", () => {
    const args = { code: "await fs.rm('/etc')" };
    const face = shellFaceOf("mcp__dsh_cua__cua_run_code", args, "darwin");
    assert.equal(face.name, "mcp__dsh_cua__cua_run_code");
    assert.equal(face.args, args);
  });
});

describe("sandboxAppliesTo：MCP 与显式升权都没有常驻沙箱", () => {
  it("普通 bash / terminal_send 在沙箱之下", () => {
    assert.equal(sandboxAppliesTo("bash", { command: "rm -rf ./build" }), true);
    assert.equal(sandboxAppliesTo(TERMINAL_SEND_TOOL, { text: "rm -rf ./build" }), true);
  });

  it("显式 sandbox_permissions 的调用不算常驻沙箱覆盖", () => {
    assert.equal(
      sandboxAppliesTo("bash", { command: MCP_RM_ETC, sandbox_permissions: "danger-full-access" }),
      false,
    );
  });

  it("mcp shell 没有 bash 执行器的沙箱；无 command 的 MCP 工具不参与判定", () => {
    assert.equal(sandboxAppliesTo("mcp__shell__run", { command: MCP_RM_ETC }), false);
    assert.equal(sandboxAppliesTo("mcp__dsh_cua__cua_run_code", { code: "x" }), true);
  });
});
