// lib/interpreter-rules.ts —— 非 shell 解释器的代码串识别（从 danger-rules 拆出）。
//
// 单列原因与 `lib/danger-regexes.ts` / `lib/find-xargs.ts` 同一条：`lib/danger-rules.ts`
// 顶着 `eslint/max-lines` 的 2000 行预算；这里放一组自成一体的判定，不引入 I/O 与宿主依赖。
//
// 边界：只判"段头是不是取代码串再执行的非 shell 解释器"，以及 `python -` 从 stdin 读代码。
// 脚本文件（`python script.py`）不在这条面上——内容不在输入里，本包不读 fs。

/** 路径前缀剥掉，只留 basename；解释器可带 `/usr/bin/` 前缀。 */
const PATH_PREFIX_RE = /^.*[\\/]/u;
/** `.exe` 后缀（Windows 命令头）。 */
const EXE_SUFFIX_RE = /\.exe$/iu;

const binNameOf = (word: string): string => word.replace(PATH_PREFIX_RE, "");

/** Python 解释器的命令名（含版本化拼法与 `t`/`m` 后缀）：`python`、`python2`、
 *  `python3`、`python3.14`、`python3.14t`、`python3.6m`。版本号不是"另一个命令"，
 *  而是同一个解释器的同一套 `-c`/`-` 语义；旧表只认字面 `python`/`python2`/`python3`，
 *  于是 `python3.14 -c` 从整条判定链上掉出去。 */
export const PYTHON_BIN_NAME = String.raw`python(?:[0-9]+(?:\.[0-9]+)*)?(?:t|m)?`;
export const PYPY_BIN_NAME = String.raw`pypy(?:[0-9]+(?:\.[0-9]+)*)?`;
const PYTHON_INTERPRETER_RE = new RegExp(`^(?:${PYTHON_BIN_NAME}|${PYPY_BIN_NAME})$`, "iu");

/** 命令名是否是 Python/PyPy 解释器（去路径、去 `.exe`、忽略大小写）。 */
export function isPythonInterpreterName(name: string): boolean {
  return PYTHON_INTERPRETER_RE.test(binNameOf(name).replace(EXE_SUFFIX_RE, ""));
}

/** 非 Python 的代码串解释器 → 其"代码串"旗标（值旗标取紧跟的那一枚）。
 *  Python 由上面的家族正则现判，不再逐版本落表；这里只留其它语言。
 *  这些语言的动作不在词法层面可见（`node -e "require('child_process')…"` 里 rm 是字符串片段），
 *  判据看不见就是真看不见——按文件头的例外条款一律升格，不享受"认不准就放行"。
 *  已知不收的同类写法：子命令形态（`deno eval …`）与脚本文件（`bash deploy.sh`）。 */
const CODE_EVAL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  perl5: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
  lua: ["-e", "-ex"],
  osascript: ["-e"],
};

/** 只读自有属性查找：对象字面量会继承 `Object.prototype`，而 key 来自命令输入。 */
const ownLookup = <Value>(table: Readonly<Record<string, Value>>, key: string): Value | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** 执行上下文旗标的位置：段头不参与匹配（真实形态里 `-c`/`-e` 必在命令名之后），
 *  合写形态（`-lc`/`-ic`）同义。 */
export function codeFlagIndex(
  words: readonly string[],
  isCodeFlag: (word: string) => boolean,
): number {
  return words.findIndex((word, index) => index > 0 && isCodeFlag(word));
}

/** 包管理器/环境管理器在解释器前面的 `run`：`uv run python -c`、`poetry run python -c`。
 *  它们不是"另一个命令"，只是把同一个解释器启动起来；旧实现只看段头，于是整条掉出代码串面。 */
const RUN_LAUNCHERS: ReadonlySet<string> = new Set([
  "uv",
  "poetry",
  "pipenv",
  "pdm",
  "hatch",
  "rye",
]);

/** 以子命令启动另一条命令的包管理器：`pnpm exec` / `npm exec` / `yarn exec`。 */
const EXEC_LAUNCHERS: ReadonlySet<string> = new Set(["pnpm", "npm", "yarn", "bun"]);
const EXEC_SUBCOMMANDS: ReadonlySet<string> = new Set(["exec", "dlx"]);

/** 启动器自己的带值旗标：跳过它们时连取值一起跳过，否则 `uv run --project . python -c`
 *  会把 `.` 当成要执行的命令，整条漏掉。只收会吃掉下一词的旗标；布尔旗标不在此列。 */
const LAUNCHER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--project",
  "-p",
  "--with",
  "--python",
  "--index",
  "--extra",
  "--group",
  "--directory",
  "--config-file",
  "--toolchain",
  "--env-file",
  "--python-platform",
  "--cache-dir",
  "--link-mode",
  "--package",
]);

/** 跳过启动器自己的旗标（含带值旗标的取值）；`--` 之后直接就是命令。 */
function skipLauncherOptions(words: readonly string[], start: number): number {
  let index = start;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined || !word.startsWith("-")) {
      break;
    }
    if (word === "--") {
      return index + 1;
    }
    index += !word.includes("=") && LAUNCHER_VALUE_FLAGS.has(word) ? 2 : 1;
  }
  return index;
}

/** 剥掉 `uv run` / `poetry run` / `pnpm exec` 一类启动器，留下真正要执行的命令词。 */
function afterRunLauncher(words: readonly string[]): readonly string[] {
  const [head, sub] = words;
  if (head === undefined) {
    return words;
  }
  const base = binNameOf(head).toLowerCase().replace(EXE_SUFFIX_RE, "");
  if (RUN_LAUNCHERS.has(base) && sub === "run") {
    return words.slice(skipLauncherOptions(words, 2));
  }
  if (base === "npx" || base === "bunx") {
    return words.slice(skipLauncherOptions(words, 1));
  }
  if (EXEC_LAUNCHERS.has(base) && sub !== undefined && EXEC_SUBCOMMANDS.has(sub)) {
    return words.slice(skipLauncherOptions(words, 2));
  }
  return words;
}

/** 代码串/标准输入执行器的旗标：Python 按家族名现判，其余语言查静态表。
 *  `python -` 是从 stdin 读并执行，不是 `-c`，由 `codeInterpreterHead` 单列一条。 */
function codeEvalFlagsOf(head: string | undefined): readonly string[] {
  if (head === undefined) {
    return [];
  }
  const bin = binNameOf(head).toLowerCase().replace(EXE_SUFFIX_RE, "");
  return PYTHON_INTERPRETER_RE.test(bin) ? ["-c"] : (ownLookup(CODE_EVAL_FLAGS, bin) ?? []);
}

/** 短旗标合写/附着：`-cprint(1)`（Python getopt 把 `c` 的参数取 `print(1)`）、
 *  `-lc`（c 在簇里，取值是下一个词）、`-econsole.log(1)`（node 的 `-e` 附着形）。
 *  只认以该短旗标字母开头的簇；长旗标另按 `--flag=` 判。 */
function shortFlagAttached(word: string, flag: string): boolean {
  if (!flag.startsWith("-") || flag.startsWith("--") || !word.startsWith("-")) {
    return false;
  }
  return word.startsWith(flag) || (flag.length === 2 && word.slice(1).includes(flag.slice(1)));
}

/** 是否在解释器之后出现代码串旗标（含合写/附着形态）。 */
function hasCodeFlag(words: readonly string[], flags: readonly string[]): boolean {
  return words.some((word, index) => {
    if (index === 0) {
      return false;
    }
    return flags.some((flag) =>
      flag.startsWith("--")
        ? word === flag || word.startsWith(`${flag}=`)
        : shortFlagAttached(word, flag),
    );
  });
}

/** 段头是不是"取代码串再执行"的非 shell 解释器（它的动作看不见 ⇒ 需确认）。
 *  `python -` / `python3.14 -` 从 stdin 读代码，与 `-c` 同属"语言层动作不在词法上"，
 *  所以一并归到这里；`python script.py` 仍是文件执行，不在这条面上（内容不在输入里）。 */
export function codeInterpreterHead(words: readonly string[]): boolean {
  const face = afterRunLauncher(words);
  const [head] = face;
  const flags = codeEvalFlagsOf(head);
  return (
    (flags.length > 0 && hasCodeFlag(face, flags)) ||
    (head !== undefined &&
      isPythonInterpreterName(head) &&
      face.slice(1).some((word) => word === "-"))
  );
}
