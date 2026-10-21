// lib/fs-errors.ts —— fs 错误的**分类**（纯函数，零 I/O）。
//
// 为什么单列：`presenceOf` 用它决定"文件到底存不存在"，而那一格决定"新建文件免 read"
// 这道豁免给不给。方向不对称：把"不可知"读成"不存在"是**放宽**（免掉 read），
// 而那正是这道豁免最不该失守的一侧。所以这条判据要有自己的用例，而它只有抽出来才测得动
//（`host.ts` 里的调用点绑着真实的 `statSync`）。
/**
 * 这个 fs 错误是不是"确实不存在"。
 *
 * **先读 `code`，再回落到 message 前缀**：`code` 是 Node 在**所有平台**都保证的稳定字段
 *（`ENOENT` / `EACCES` / `ENOTDIR` / `ELOOP` …），而 message 的措辞与是否以 errno 名开头
 * 随平台/libuv 版本变化。只认 message 前缀时，Windows 上 `ENOTDIR`（路径中间是文件）
 * 可能被读成"不存在"，于是新建豁免把 read 免掉 —— 方向正是这道豁免最不该失守的那一侧。
 *
 * @param error `statSync` 抛出的东西（未知名）。
 * @returns 仅当 errno 明确是 ENOENT 时为 true。
 */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string") {
    return code === "ENOENT";
  }
  return typeof message === "string" && message.startsWith("ENOENT");
}

/** stat 的三态结论：**不存在**（ENOENT）/ **存在**（拿到 stat）/ **不可知**（其它错误）。
 *  独立成类型是为了让调用方在"不可知"上必须显式选择方向（本包一律保守）。 */
export type Presence = "absent" | "present" | "unknown";

/**
 * 把一次 stat 尝试折成三态之一。
 *
 * 抽成纯函数而不是留在 `host.ts`：它的 `unknown` 分支在这里可以被**直接注入错误形状**
 * 验证，而在宿主里只能靠真实 fs 在该平台恰好抛出某个码 —— 那会让分支覆盖率随平台漂
 *（实测 Windows 上 `stat("文件/子文件")` 报 `ENOENT`，于是 `unknown` 那一支走不到，
 *  覆盖率门红在 99.81%）。
 *
 * @param attempt 取 mtime 的同步函数（真实调用方传 `statSync` 包装）。
 * @returns 三态结论；`unknown` / `absent` 时 `mtimeMs` 为 -1。
 */
export function presenceOfAttempt(attempt: () => number): { presence: Presence; mtimeMs: number } {
  try {
    return { presence: "present", mtimeMs: attempt() };
  } catch (error: unknown) {
    return { presence: isNotFoundError(error) ? "absent" : "unknown", mtimeMs: -1 };
  }
}
