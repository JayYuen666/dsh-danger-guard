// lib/glob-match.ts —— 把 shell glob 模式编译成同段正则。
//
// 单列原因：`lib/danger-rules.ts` 贴着 `max-lines` 的 2000 行预算，而这段
// 纯词法转换与调用它的灾难目标判定可以分开；本模块不读 fs、不依赖任何判定规则。
//
// 语义刻意取**超集**：`*` → `[^/]*`、`?` → 一枚非分隔符、`[...]` 整类 → 一枚非分隔符
// （不解析字符类内容）。判据只问"能否落到受保护前缀上"，宁可多拦也不漏。
// 未闭合的 `[` 在真实 shell 里是字面量，故按字面转义。

/** 目标里出现未展开的 glob 元字符：shell 会先展开它，判据该看展开后的那批路径。 */
export const GLOB_METACHAR_RE = /[*?[]/u;

/** 正则元字符：glob 模式的字面部分进 `new RegExp` 前必须转义。 */
const REGEX_METACHARS: ReadonlySet<string> = new Set(String.raw`\^$.|+()[]{}*?`);

/** 绝对路径尾斜杠不改变展开结果，但会让同段正则多要一格。 */
const TRAILING_SLASHES = /\/+$/u;

/** 把 glob 模式编译成**同段匹配**的正则（`^...$`）。 */
export function globRegExp(pattern: string): RegExp {
  let src = "";
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern.charAt(index);
    if (ch === "*") {
      src += "[^/]*";
    } else if (ch === "?") {
      src += "[^/]";
    } else if (ch === "[") {
      const close = pattern.indexOf("]", index + 1);
      src += close === -1 ? String.raw`\[` : "[^/]";
      index = close === -1 ? index : close;
    } else {
      src += REGEX_METACHARS.has(ch) ? `\\${ch}` : ch;
    }
    index += 1;
  }
  return new RegExp(`^${src}$`, "u");
}

/**
 * 一枚**绝对** glob 目标能否落到受保护探针上——探针各试"本身"与"其下一层"
 * （`/etc/*` 展开的是 `/etc/<项>`，不是 `/etc` 本身）。判"能否"而不是"会"：
 * 命中即拦，方向与 `rm` 那一族"看不见就不放行"一致。
 *
 * 相对 glob 在这里一律不命中：`*` 展开的是当前目录里的条目，不是家目录。Windows 上
 * 家目录是反斜杠串，`*` 的 `[^/]*` 会整段命中它——不放这道门，`rm -rf *` 会被误判成
 * 家目录整树删除。
 */
export function absoluteGlobCouldHit(pattern: string, probes: readonly string[]): boolean {
  if (!pattern.startsWith("/")) {
    return false;
  }
  const re = globRegExp(pattern.replace(TRAILING_SLASHES, ""));
  return probes.some((probe) => re.test(probe) || re.test(`${probe}/x`));
}
