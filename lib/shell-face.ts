// lib/shell-face.ts —— 把「会执行命令行的工具」归一成 bash 判据能吃的调用面。
//
// 为什么需要：rc.2 的实验性持久终端 bundle 注册 `terminal_send`，命令放在 `text` 里，
// 而不是 `bash` / `pwsh` 的 `command`；不归一就会整类漏判。判定本体仍走
// `bashVerdictOf` 的同一入口，这里只补两件调用点事实：
//  1. 终端后端的默认 shell 随平台变（POSIX 加载启动文件的 shell / Windows 优先 pwsh），
//     所以方言由平台给，不从 text 的字形反推；
//  2. `text` 折成 `command`；`submit: false` 不豁免——未提交的文本仍可能在后续 Enter
//     时执行，方向保守。`terminal_open` 没有命令参数，不在判定面内。

/** 归一后的一次调用面：`name` 已是 bash 判据认识的调用点身份。 */
export interface ShellFace {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** 实验性持久终端 bundle 的发送工具（rc.2 `@deepseek-ai/dsh-tool-terminal`）。 */
export const TERMINAL_SEND_TOOL = "terminal_send";

/** 宿主 MCP 客户端的工具名前缀（`packages/mcp/mcp-client` 注册为 `mcp__<server>__<tool>`）。 */
const MCP_TOOL_PREFIX = "mcp__";

/** MCP 工具里可能承载命令行的那几个参数名。`code` 不在此列：CUA 的
 *  `cua_run_code` 跑在 PTC 运行时自己的沙箱里，按命令词法读会误判成无沙箱执行。 */
const MCP_COMMAND_KEYS = ["command", "cmd"] as const;

function mcpCommandOf(args: Record<string, unknown> | undefined): string | undefined {
  let result: string | undefined;
  for (const key of MCP_COMMAND_KEYS) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      result = value;
      break;
    }
  }
  return result;
}

/**
 * 这次调用是否真的处在宿主文件沙箱之下。
 *
 * 两处为假：
 * - 调用显式带了 `sandbox_permissions`（升权目标 `workspace-write` / `danger-full-access`）：
 *   审批通过后 bash 工具以 `approvedMode` 执行，插件此刻读到的常驻档位已经不是它要跑的档位；
 *   再按常驻档位算"沙箱盖得住"就是给一次真实的全权删除让路。
 * - MCP 工具：宿主 `StdioClientTransport` 直接 spawn 子进程，没有 bash 执行器的沙箱。
 *
 * 这两类都只影响 `rmrf` 的让路位；其余规则本来就不看沙箱。
 */
export function sandboxAppliesTo(name: string, args: Record<string, unknown> | undefined): boolean {
  const escalation = args?.["sandbox_permissions"];
  if (typeof escalation === "string" && escalation.length > 0) {
    return false;
  }
  return !(name.startsWith(MCP_TOOL_PREFIX) && mcpCommandOf(args) !== undefined);
}

/**
 * 把一次工具调用折成 bash 判据的调用面。
 *
 * @param name 原始工具名。
 * @param args 原始参数（非记录时由调用方折成空记录或 undefined）。
 * @param platform 终端后端所在平台的 `process.platform` 形；测试可注入。
 * @returns `terminal_send` 折成 `bash` / `pwsh` 与 `command`；其余工具原样交回
 *          （`args` 缺省折成空记录，调用方无需再判空）。
 */
export function shellFaceOf(
  name: string,
  args: Record<string, unknown> | undefined,
  platform: NodeJS.Platform = process.platform,
): ShellFace {
  if (name === TERMINAL_SEND_TOOL) {
    const text = args?.["text"];
    return {
      name: platform === "win32" ? "pwsh" : "bash",
      args: { ...args, command: typeof text === "string" ? text : "" },
    };
  }
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    const command = mcpCommandOf(args);
    if (command !== undefined) {
      // MCP shell 的方言按宿主平台给：Windows 上多数是 PowerShell，POSIX 上是 bash。
      // 工具名本身（`mcp__shell__run`）不是 bash/pwsh，`bashVerdictOf` 不认，故归一。
      return {
        name: platform === "win32" ? "pwsh" : "bash",
        args: { ...args, command },
      };
    }
  }
  return { name, args: args ?? {} };
}
