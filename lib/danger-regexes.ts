// lib/danger-regexes.ts —— danger-rules 判定层反复用到的正则字面量。
//
// 为什么单独成模块：这些字面量必须在模块作用域只求值一次（e18e/prefer-static-regex 的
// 要求——写在函数里等于每次调用重新编译），而 danger-rules.ts 本身已贴着
// eslint/max-lines 的上限（2000 行）。这里只放常量，不含任何判定逻辑。

/** danger-rules 的模块级正则表。 */
export const DANGER_RE = {
  /** 词首的单个 `$`（shell 变量前缀）。 */
  leadingDollar: /^\$/u,
  /** 路径里最后一个分隔符之前的部分（bin 名剥路径用）。 */
  pathSeparatorPrefix: /^.*[\\/]/u,
  /** 带符号十进制整数（`nice` 的 niceness 取值）。 */
  signedInteger: /^[+-]?\d+$/u,
  /** 包名尾部的 `@版本/标签` 选择器。 */
  packageVersionSuffix: /@[^/]*$/u,
  /** 单独的 `.` / `..` 段。 */
  dotSegment: /^\.{1,2}$/u,
  /** 行首连续的分隔符（全局版，供 replaceAll 用）。 */
  leadingSeparators: /^[/\\]+/gu,
  /** 任意连续的分隔符（split 用）。 */
  separatorRuns: /[/\\]+/u,
  /** 尾随斜杠。 */
  trailingSlashes: /\/+$/u,
  /** `{1..3}` / `{1..3..2}` 数字序列。 */
  braceNumeric: /^(?<start>-?\d+)\.\.(?<end>-?\d+)(?:\.\.(?<step>-?\d+))?$/u,
  /** `{a..c}` 字母序列。 */
  braceAlpha: /^(?<start>[A-Za-z])\.\.(?<end>[A-Za-z])$/u,
  /** glob 末尾的 `*`（可带一个前导 `/`）。 */
  trailingGlobStars: /\/?\*+$/u,
  /** 段尾的闭括号/分号/空白。 */
  trailingSegmentSeparators: /[;\s}]*$/u,
  /** 段首的 `!` 与随后的空白（shell 历史展开/取反前置）。 */
  leadingBangs: /^!+\s*/u,
  /** `/…/flags` 形态的正则字面量（密钥模式判据）。 */
  slashPatternLiteral: /^\/(?:[^/\\]|\\.)+\/[dgimsuvy]*$/u,
};
