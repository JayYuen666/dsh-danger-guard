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

/**
 * 出现这些字段就说明是写调用，不再信任 `action:"read"` 之类的声明。
 *
 * 名单按**实际会遇到的写形态**列，不按某一个工具的 schema 列：`str_replace_editor` 用
 * `old_str`/`new_str`，官方文件工具用 `old_string`/`new_string`，批量改动用 `edits`，打补丁用
 * `patch`/`diff`。漏一个就等于「带只读声明 + 那个字段」的调用整趟放开——目标清单为空，
 * 下游密钥闸连判都不判。宁可把不认识的字段判成写：写判多了只是多判一次路径，判少了是漏拦。
 */
const WRITE_PAYLOAD_KEYS = [
  "content",
  "file_text",
  "fileText",
  "new_text",
  "newText",
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "old_str",
  "new_str",
  "oldStr",
  "newStr",
  "edits",
  "patch",
  "diff",
  "insert_line",
  "insertLine",
  "replacement",
] as const;

/** 键名本身像写载荷（`*_text`/`*_content`/`*_string`）时也算写：新 provider 换了字段名不失效。 */
const WRITE_PAYLOAD_SUFFIX = /(?:^|_)(?:text|content|string|str|patch|diff)$/u;
/** 插入写的行号键（两种拼法都认）。 */
const INSERT_LINE_KEY = /^(?:insert_line|insertLine)$/u;

/** 键名折成 snake_case 后再比：`newContent` 与 `new_content` 是同一个载荷位。 */
const snakeKeyOf = (key: string): string =>
  key.replaceAll(/(?<head>[a-z0-9])(?<upper>[A-Z])/gu, "$<head>_$<upper>").toLowerCase();

/** 白名单折成 snake_case：驼峰拼法（`newContent`/`fileText`）也要命中。 */
const WRITE_PAYLOAD_SNAKE_SET: ReadonlySet<string> = new Set(
  WRITE_PAYLOAD_KEYS.map((key) => snakeKeyOf(key)),
);

/** 普通对象判定（不认 null、不认数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 该键的取值是否携带写载荷。
 *
 * 走到这里时键名已经落在白名单或 `*_text`/`*_content` 这类后缀里，所以取值形态够用即可：
 * 任何字符串都是写内容（空串是清空文件，仍然算写）；非空数组是批量编辑（`edits: []`
 * 等于没改，不算写）；行号是插入写。
 */
function isWriteValue(key: string, value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  // 对象载荷也是写内容：`patch: { hunks }`、`content: { type: "text", text }` 这类
  // provider 用对象承载改动。只认 string/数组时，带只读动词 + 对象载荷的调用会整趟
  // 按只读放行、目标清单为空——那是最坏的一侧（漏拦），白名单判定要宁宽勿窄。
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return typeof value === "number" && INSERT_LINE_KEY.test(key);
}

function hasWritePayload(args: Record<string, unknown>): boolean {
  return Object.entries(args).some(([key, value]) => {
    const snake = snakeKeyOf(key);
    return (
      (WRITE_PAYLOAD_SNAKE_SET.has(snake) || WRITE_PAYLOAD_SUFFIX.test(snake)) &&
      isWriteValue(key, value)
    );
  });
}

/**
 * 参数里**任一**动作字段声明为写，就按写处理。
 *
 * 原实现 `args["command"] ?? args["action"] ?? args["mode"]` 只取第一个非空值：同时带
 * `command:"read"` 与 `action:"write"` 时读到的是前者，于是整趟被当只读、目标路径全丢。
 * 只读需要所有出现的动词都是只读，写只要有一个说是写。
 */
function readOnlyAction(args: Record<string, unknown>): boolean {
  const verbs = [args["command"], args["action"], args["mode"]].filter(
    (verb): verb is string => typeof verb === "string",
  );
  if (verbs.length === 0) {
    return false;
  }
  return verbs.every((verb) => READ_ONLY_VERBS.has(verb.toLowerCase())) && !hasWritePayload(args);
}

/** 一次工具调用声明的全部目标路径（键形口径，去重后按键位顺序给出）。 */
export function declaredTargets(args: Record<string, unknown> | undefined | null): string[] {
  const targets: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    // 首尾空白先去掉：`"  "` 这类纯空白串会被下游解析成 cwd，变成一个不存在却"有效"的目标；
    // 带空白的真实路径也会与同一调用的另一种写法重复。
    const trimmed = value.trim();
    if (trimmed.length > 0 && !targets.includes(trimmed)) {
      targets.push(trimmed);
    }
  };
  /** 数组键里的目标偶尔是对象形态（`{ path: "a" }`）；只认键、不认这种形态会静默丢目标。 */
  const addItem = (item: unknown): void => {
    add(item);
    if (isRecord(item)) {
      for (const key of TARGET_PATH_KEYS) {
        add(item[key]);
      }
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
          addItem(item);
        }
      }
    }
  }
  return targets;
}
