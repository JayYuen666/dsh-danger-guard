// lib/tool-names.ts —— 编辑/读取工具名的唯一判据。
//
// 宿主的 MCP 客户端按 `mcp__<server>__<tool>` 注册工具；同一类文件操作在不同 server 上
// 叫 `write_file` / `edit_file` / `read_file`，字面名单写死在 writeTargets/factGate 各一份
// 时，新 server 一接就漏。这里只按**最后一段**判，前缀仍要求 `mcp__`，不猜普通工具名。

const MCP_PREFIX = "mcp__";

/** 编辑类 MCP 工具的最后一段（宿主内置 fs 与常见 filesystem server 的拼法）。 */
const MCP_EDIT_SUFFIXES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "create_file",
  "replace_in_file",
  "patch_file",
  "apply_patch",
  "str_replace",
  "write_text_file",
  // 常见 filesystem / patch server 的其它写形态：都带一个可识别的目标路径，
  // 按名字末段收进来才能进密钥闸与事实门；不认识的末段仍不猜。
  "append_file",
  "replace_text",
  "insert_text",
  "delete_text_range",
  "apply_diff",
]);

/** 读取类 MCP 工具的最后一段。 */
const MCP_READ_SUFFIXES: ReadonlySet<string> = new Set([
  "read_file",
  "read_text_file",
  "get_file_contents",
  "view_file",
  "read_multiple_files",
]);

function mcpSuffixOf(name: string): string | undefined {
  let result: string | undefined;
  if (name.startsWith(MCP_PREFIX)) {
    // 前缀本身含 `__`，走到这里 lastIndexOf 必不为 -1；不再留一条不可达的兜底。
    result = name.slice(name.lastIndexOf("__") + 2);
  }
  return result;
}

/** 写类工具：内置四个 + MCP 的常见文件写工具。 */
export function isEditToolName(name: string | undefined): boolean {
  if (name === undefined) {
    return false;
  }
  if (
    name === "edit" ||
    name === "write" ||
    name === "str_replace_editor" ||
    name === "apply_patch"
  ) {
    return true;
  }
  const suffix = mcpSuffixOf(name);
  return suffix !== undefined && MCP_EDIT_SUFFIXES.has(suffix);
}

/** 补丁类工具：内置 `apply_patch` 与 MCP 同名工具走同一条逐目标解析。 */
export function isApplyPatchToolName(name: string | undefined): boolean {
  return name === "apply_patch" || mcpSuffixOf(name ?? "") === "apply_patch";
}

/** 读类工具：内置 `read` + `str_replace_editor` 的 view（由调用点带上 command）+ MCP 读工具。 */
export function isReadToolName(name: string | undefined, command?: unknown): boolean {
  if (name === "read") {
    return true;
  }
  if (name === "str_replace_editor" && command === "view") {
    return true;
  }
  const suffix = mcpSuffixOf(name ?? "");
  return suffix !== undefined && MCP_READ_SUFFIXES.has(suffix);
}
