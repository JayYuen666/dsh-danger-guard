// lib/read-targets.ts —— 从 pattern-first 读取命令的参数里取"真正要读的文件"。
//
// `grep` / `rg` / `sed` / `awk` 的第一个非旗标词是模式或脚本，不是文件；`-e` / `-f`
// 的取值也可能把模式与文件互换。这一段只做参数解析，不碰密钥词表，也不读文件。
//
// 单列原因：`lib/danger-rules.ts` 本身顶着 `max-lines` 的 2000 行预算，而这里的
// 选项附着、`--` 终止与 sed 的 `-n1p` 处理可以独立成文、独立测试。

import type { ShellToken } from "./command-segments.ts";

/** 第一个非旗标词是模式/脚本、其后的非旗标词才是文件。 */
export const READ_PATTERN_FIRST_BIN_WORDS = new Set(["grep", "rg", "sed", "awk"]);

/** GNU sed 的 `-n1p` / `-n1,5p` 这类旗标：`-n` 后附的是脚本。 */
const SED_N_SCRIPT_RE = /^-[A-Za-z]*n\d/u;

/** pattern-first 命令里附着在短/长选项上的取值。`-e foo` / `-f file` 由调用点单独处理；
 *  这里只接 `-efoo`、`-f.env`、`--regexp=foo`、`--file=.env` 与 `sed -n1p` 这类写法。 */
function attachedReadOption(
  word: string,
  bin: string,
): { readonly kind: "file" | "pattern"; readonly value: string } | undefined {
  let result: { readonly kind: "file" | "pattern"; readonly value: string } | undefined;
  if (word.startsWith("--file=")) {
    result = { kind: "file", value: word.slice("--file=".length) };
  } else if (word.startsWith("--regexp=")) {
    result = { kind: "pattern", value: word.slice("--regexp=".length) };
  } else if (word.startsWith("--expression=")) {
    result = { kind: "pattern", value: word.slice("--expression=".length) };
  } else if (word.startsWith("-f") && word.length > 2) {
    result = { kind: "file", value: word.slice(2) };
  } else if (word.startsWith("-e") && word.length > 2) {
    result = { kind: "pattern", value: word.slice(2) };
  } else if (bin === "sed" && SED_N_SCRIPT_RE.test(word)) {
    result = { kind: "pattern", value: word.slice(2) };
  }
  return result;
}

interface ReadOption {
  readonly targets: readonly ShellToken[];
  readonly patternConsumed: boolean;
  readonly takeNext: boolean;
}

/** 一个旗标对目标/模式状态的贡献；不认识的旗标返回 undefined（保持原状态）。 */
function readOptionOf(
  bin: string,
  word: string,
  next: ShellToken | undefined,
): ReadOption | undefined {
  let result: ReadOption | undefined;
  if (!READ_PATTERN_FIRST_BIN_WORDS.has(bin)) {
    result = undefined;
  } else if ((word === "-f" || word === "--file") && next !== undefined) {
    result = { targets: [next], patternConsumed: true, takeNext: true };
  } else if ((word === "-e" || word === "--regexp") && next !== undefined) {
    result = { targets: [], patternConsumed: true, takeNext: true };
  } else {
    const attached = attachedReadOption(word, bin);
    if (attached?.kind === "file") {
      result = {
        targets: [{ value: attached.value, raw: attached.value }],
        patternConsumed: true,
        takeNext: false,
      };
    } else if (attached?.kind === "pattern") {
      result = { targets: [], patternConsumed: true, takeNext: false };
    }
  }
  return result;
}

interface ReadStep {
  readonly targets: readonly ShellToken[];
  readonly patternConsumed: boolean;
  /** 需要额外跳过的词数（`-f .env` 的取值）。 */
  readonly advance: number;
  /** `--` 已把剩余词全部收进 targets，循环应结束。 */
  readonly stop: boolean;
}

function readStepOf(
  bin: string,
  token: ShellToken,
  tokens: readonly ShellToken[],
  index: number,
  patternConsumed: boolean,
): ReadStep {
  const word = token.value;
  if (word === "--") {
    return {
      targets: tokens.slice(index + 1),
      patternConsumed,
      advance: 0,
      stop: true,
    };
  }
  if (word.startsWith("-")) {
    const option = readOptionOf(bin, word, tokens[index + 1]);
    if (option === undefined) {
      return { targets: [], patternConsumed, advance: 0, stop: false };
    }
    return {
      targets: option.targets,
      patternConsumed: patternConsumed || option.patternConsumed,
      advance: option.takeNext ? 1 : 0,
      stop: false,
    };
  }
  if (READ_PATTERN_FIRST_BIN_WORDS.has(bin) && !patternConsumed) {
    return { targets: [], patternConsumed: true, advance: 0, stop: false };
  }
  return { targets: [token], patternConsumed, advance: 0, stop: false };
}

/** 取 pattern-first 命令的参数里真正要读的文件；`--` 之后一律是目标。 */
export function readTargetTokens(
  bin: string,
  tokens: readonly ShellToken[],
): readonly ShellToken[] {
  const targets: ShellToken[] = [];
  let patternConsumed = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    /* v8 ignore next 2 —— 循环条件已保证下标在界内 */
    if (token === undefined) {
      break;
    }
    const {
      targets: stepTargets,
      patternConsumed: nextPattern,
      advance,
      stop,
    } = readStepOf(bin, token, tokens, index, patternConsumed);
    targets.push(...stepTargets);
    patternConsumed = nextPattern;
    index += advance;
    if (stop) {
      break;
    }
  }
  return targets;
}
