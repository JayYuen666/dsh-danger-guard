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
 * @returns 仅当 errno 明确是 ENOENT 时为 true。`code` 缺席时回落到 message 前缀——
 *          那时并没有 errno 可依据，判据比"有 code"那一支松，只作为旧宿主/自定义 fs 的兜底。
 */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string") {
    return code === "ENOENT";
  }
  // 前缀匹配带词边界：libuv 的措辞是 "ENOENT: …"，"ENOENTX" 一类拼接串不得误判成缺失。
  return typeof message === "string" && /^ENOENT(?::|$|\s)/u.test(message);
}

/** stat 的三态结论：**不存在**（ENOENT）/ **存在**（拿到 stat）/ **不可知**（其它错误）。
 *  独立成类型是为了让调用方在"不可知"上必须显式选择方向（本包一律保守）。 */
export type Presence = "absent" | "present" | "unknown";

/** 一次 stat 尝试的结果形状（三态结论 + mtime）。单源导出：host.ts 的调用点复用同一份，
 *  哨兵语义改起来只动一处。 */
export interface StatAttempt {
  readonly presence: Presence;
  readonly mtimeMs: number;
}

/** "取不到 mtime"的哨兵值。真实 mtimeMs 理论上可为负（1970 年前的时间戳），与之撞值时
 *  下游的比较只会把那次读当作"从未见过"——方向是多要求一次取证，不是放行。 */
export const MTIME_UNKNOWN = -1;

/**
 * 把一次 stat 尝试折成三态之一。
 *
 * 抽成纯函数而不是留在 `host.ts`：它的 `unknown` 分支在这里可以被**直接注入错误形状**
 * 验证，而在宿主里只能靠真实 fs 在该平台恰好抛出某个码 —— 那会让分支覆盖率随平台漂
 *（实测 Windows 上 `stat("文件/子文件")` 报 `ENOENT`，于是 `unknown` 那一支走不到，
 *  覆盖率门红在 99.81%）。
 *
 * @param attempt 取 mtime 的同步函数（真实调用方传 `statSync` 包装）。
 * @returns 三态结论；`unknown` / `absent` 时 `mtimeMs` 为 `MTIME_UNKNOWN`。
 */
export function presenceOfAttempt(attempt: () => number): StatAttempt {
  try {
    const mtimeMs = attempt();
    // 非有限值（注入的假 stat / 上游封装的异常返回）不得以 present 向外传播：下游拿它做
    // `mtimeMs > seenMtime` 的跳变判定，NaN 恒假会让外部改动检测**静默失效**。
    return Number.isFinite(mtimeMs)
      ? { presence: "present", mtimeMs }
      : { presence: "unknown", mtimeMs: MTIME_UNKNOWN };
  } catch (error: unknown) {
    return { presence: isNotFoundError(error) ? "absent" : "unknown", mtimeMs: MTIME_UNKNOWN };
  }
}
