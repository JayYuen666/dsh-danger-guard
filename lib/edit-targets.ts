// lib/edit-targets.ts —— 一次编辑/写调用的目标路径提取（键形口径）。
//
// 目标按参数键认，不按工具名认：工具名随 provider 与版本变，而"要动哪个文件"就在参数里。
// 只读动作的声明**不能压过写载荷**：宿主工具参数根是开放对象，`write`/`edit` 的 execute
// 只读自己认识的字段，多带的 `action:"read"` 不会改变真实写入行为。

/** 标量目标键。 */
const TARGET_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "target_path",
  "targetPath",
];

/** 批量目标键：数组形态同样逐枚检查。 */
const TARGET_PATH_ARRAY_KEYS = [
  "paths",
  "file_paths",
  "filePaths",
  "notebook_paths",
  "notebookPaths",
  "target_paths",
  "targetPaths",
];

/** 只读动词（`str_replace_editor` 的 `command:"view"` 是合法只读形态）。 */
const READ_ONLY_VERBS = new Set(["view", "read", "cat", "list", "search", "fetch", "get"]);

/** 出现这些字段就说明是写调用，不再信任 `action:"read"` 之类的声明。 */
function hasWritePayload(args: Record<string, unknown>): boolean {
  return (
    typeof args["content"] === "string" ||
    typeof args["file_text"] === "string" ||
    typeof args["old_string"] === "string" ||
    typeof args["new_string"] === "string"
  );
}

function readOnlyAction(args: Record<string, unknown>): boolean {
  const verb = args["command"] ?? args["action"] ?? args["mode"];
  return (
    typeof verb === "string" && READ_ONLY_VERBS.has(verb.toLowerCase()) && !hasWritePayload(args)
  );
}

/** 一次工具调用声明的全部目标路径（键形口径，去重后按键位顺序给出）。 */
export function declaredTargets(args: Record<string, unknown> | undefined | null): string[] {
  const targets: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && !targets.includes(value)) {
      targets.push(value);
    }
  };
  if (args && typeof args === "object" && !readOnlyAction(args)) {
    for (const key of TARGET_PATH_KEYS) {
      add(args[key]);
    }
    for (const key of TARGET_PATH_ARRAY_KEYS) {
      const value = args[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          add(item);
        }
      }
    }
  }
  return targets;
}
