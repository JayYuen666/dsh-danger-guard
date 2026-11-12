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
  if (name !== TERMINAL_SEND_TOOL) {
    return { name, args: args ?? {} };
  }
  const text = args?.["text"];
  return {
    name: platform === "win32" ? "pwsh" : "bash",
    args: { ...args, command: typeof text === "string" ? text : "" },
  };
}
