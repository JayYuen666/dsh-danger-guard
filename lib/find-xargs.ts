// lib/find-xargs.ts —— `find` / `xargs` 的整树删除判据（从 danger-rules 拆出）。
//
// 独立成模块有两个理由：一是这些形态的命令头不是 `rm`，规则与 `catastrophicRm` 是两条
// 独立判据；二是 `danger-rules.ts` 的规则表已经接近文件行数上限，继续堆会把整份判定链
// 拖进 lint 的 max-lines 红。
//
// 判据本体只依赖调用方注入的投影函数（段切分、词法、命令头、bin 名、灾难目标），
// 这样本模块不必反向 import danger-rules 的私有实现，也不会形成运行期环。

import type { BashVerdict } from "./danger-rules.ts";
import type { ShellToken } from "./command-segments.ts";

/** 调用方注入的判定依赖；每一项都来自 danger-rules 里同一套投影，避免两套读法漂移。 */
export interface FindXargsDeps {
  readonly splitSegments: (command: string) => {
    readonly texts: readonly string[];
    readonly pipeConnected: readonly boolean[];
    readonly truncated: boolean;
  };
  readonly lexTokens: (source: string) => readonly ShellToken[];
  readonly peelSeg: (segment: string) => string;
  readonly runPrefixEnd: (tokens: readonly ShellToken[]) => number;
  readonly headStarts: (tokens: readonly ShellToken[]) => readonly number[];
  readonly binNameOf: (value: string) => string;
  readonly rmBinOf: (token: ShellToken) => string;
  readonly shellBinNames: ReadonlySet<string>;
  readonly isWindowsHost: () => boolean;
  readonly isDisasterToken: (token: ShellToken, windowsTrack: boolean) => boolean;
  readonly isSecretTarget: (token: ShellToken, windowsTrack: boolean) => boolean;
  readonly secretRmDanger: (
    head: ShellToken,
    tokens: readonly ShellToken[],
    windowsDialect: boolean,
  ) => BashVerdict | undefined;
  readonly secretReadDanger: (
    head: ShellToken,
    tokens: readonly ShellToken[],
    windowsDialect: boolean,
  ) => BashVerdict | undefined;
}

/** 判据只需要方言一位；不把整枚 `DangerContext` 拖进签名。 */
export interface FindXargsContext {
  readonly windowsDialect: boolean;
}

/** `find` 段里的起始路径：GNU/BSD 的全局选项可以出现在路径前；没有路径时默认 `.`。
 *  只处理 POSIX `find`；Windows 自带 `find.exe` 没有 `-delete`/`-exec` 语义，
 *  调用点已按方言跳过整条规则。 */
const FIND_GLOBAL_FLAGS = new Set(["-L", "-H", "-P"]);
const FIND_GLOBAL_VALUE_FLAGS = new Set(["-D", "-O"]);
const DOT_TOKEN: ShellToken = { value: ".", raw: "." };
const FIND_EXEC_WORDS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** `find` 里会带出"匹配面"字面值的谓词：`-name` / `-path` 的取值可能正是密钥路径。
 *  只收会直接形成目标名的谓词；`-regex` 是模式串，交给 `isSecretTarget` 的 glob 面会误报，
 *  故不在这里展开。 */
const FIND_MATCH_VALUE_FLAGS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
]);

/** 不构成"匹配集"的 find 旗标：动作、遍历顺序、深度/设备边界。其余 `-字母` 一律按谓词。 */
const FIND_NON_FILTER_FLAGS = new Set([
  "-L",
  "-H",
  "-P",
  "-D",
  "-O",
  "-delete",
  "-depth",
  "-follow",
  "-xdev",
  "-noleaf",
  "-ignore_readdir_race",
  "-warn",
  "-nowarn",
  "-daystart",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-print",
  "-print0",
  "-printf",
  "-ls",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-quit",
]);

const XARGS_VALUE_FLAGS = new Set([
  "-n",
  "--max-args",
  "-L",
  "--max-lines",
  "-P",
  "--max-procs",
  "-s",
  "--max-chars",
  "-d",
  "--delimiter",
  "-E",
  "--eof",
  "-I",
  "--replace",
  "-a",
  "--arg-file",
  "-e",
  "-l",
]);

interface FindDeleteForm {
  readonly delete: boolean;
  readonly filtered: boolean;
}

interface SourceState {
  tokens: readonly ShellToken[] | undefined;
  filtered: boolean;
}

function findPathTokens(tokens: readonly ShellToken[]): readonly ShellToken[] {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    /* v8 ignore next 2 —— 循环条件已保证下标在界内 */
    if (token === undefined) {
      break;
    }
    const word = token.value;
    if (FIND_GLOBAL_FLAGS.has(word)) {
      index += 1;
    } else if (FIND_GLOBAL_VALUE_FLAGS.has(word)) {
      index += 2;
    } else {
      break;
    }
  }
  const paths: ShellToken[] = [];
  while (index < tokens.length) {
    const token = tokens[index];
    /* v8 ignore next 2 —— 循环条件已保证下标在界内 */
    if (token === undefined) {
      break;
    }
    const word = token.value;
    if (word.startsWith("-") || word === "!" || word === "(" || word === ")") {
      break;
    }
    paths.push(token);
    index += 1;
  }
  return paths.length > 0 ? paths : [DOT_TOKEN];
}

/** `find` 这次可能触碰到的字面目标：起始路径 + `-name` / `-path` 一类谓词的取值。
 *  只给密钥判据用；`-delete` 的灾难目标仍只看起始路径（谓词匹配集不能当成整树目标）。 */
function findSecretSourceTokens(tokens: readonly ShellToken[]): readonly ShellToken[] {
  const out: ShellToken[] = [...findPathTokens(tokens)];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== undefined && FIND_MATCH_VALUE_FLAGS.has(token.value)) {
      const value = tokens[index + 1];
      if (value !== undefined) {
        out.push(value);
      }
    }
  }
  return out;
}

/** `find ... -exec/-execdir/-ok/-okdir` 后面的第一条命令（剥掉 `env` / `sudo` 一类运行前缀）。 */
interface FindExecCommand {
  readonly head: ShellToken;
  readonly tokens: readonly ShellToken[];
}

function findExecCommandsOf(
  tokens: readonly ShellToken[],
  deps: FindXargsDeps,
): readonly FindExecCommand[] {
  const result: FindExecCommand[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== undefined && FIND_EXEC_WORDS.has(token.value)) {
      const commandTokens = tokens.slice(index + 1);
      const start = deps.runPrefixEnd(commandTokens);
      const head = commandTokens[start];
      if (head !== undefined) {
        result.push({ head, tokens: commandTokens });
      }
    }
  }
  return result;
}

/** 一组词里命中凭据面的原始写法（去重、按首次出现序）。 */
function secretOffendingOf(
  tokens: readonly ShellToken[],
  windowsTrack: boolean,
  deps: FindXargsDeps,
): readonly string[] {
  return [
    ...new Set(
      tokens.filter((token) => deps.isSecretTarget(token, windowsTrack)).map((token) => token.raw),
    ),
  ];
}

/** 目标里命中的灾难词（去重、按首次出现序）。 */
function disasterOffendingOf(
  tokens: readonly ShellToken[],
  windowsTrack: boolean,
  deps: FindXargsDeps,
): readonly string[] {
  return [
    ...new Set(
      tokens.filter((token) => deps.isDisasterToken(token, windowsTrack)).map((token) => token.raw),
    ),
  ];
}

/** shell `-c` / `--command` 体的最大下钻层数。超过后按"看不见的体"保守判删除；
 *  这里只处理 `find -exec` / `xargs` 的删除判定，不替代 `nestedShell` 的通用升格。 */
const SHELL_BODY_MAX_DEPTH = 8;

/** `sh -c` 的体：支持 `-c`、`--command` 与 `-lc` / `-ec` 这类短簇；
 *  `sh script.sh` 不是执行体，返回 undefined。 */
function shellBodyOf(tokens: readonly ShellToken[]): string | undefined {
  let body: string | undefined;
  for (let index = 0; index < tokens.length && body === undefined; index += 1) {
    const word = tokens[index]?.value;
    if (
      word === "-c" ||
      word === "--command" ||
      (word !== undefined && word.startsWith("-") && word.includes("c"))
    ) {
      body = tokens[index + 1]?.value;
    }
  }
  return body;
}

/** 实际命令是否删除：rm 家族直接命中；shell 则把 `-c` 体切成命令段，按各段命令头再判。
 *  包装词先由 `runPrefixEnd` 剥掉，`find -exec env rm` 与 `find -exec rm` 同判。 */
function commandDeletes(tokens: readonly ShellToken[], deps: FindXargsDeps, depth = 0): boolean {
  const start = deps.runPrefixEnd(tokens);
  const command = tokens[start];
  if (command === undefined) {
    return false;
  }
  if (deps.rmBinOf(command) !== "") {
    return true;
  }
  if (!deps.shellBinNames.has(deps.binNameOf(command.value).toLowerCase())) {
    return false;
  }
  const body = shellBodyOf(tokens.slice(start + 1));
  if (body === undefined) {
    return false;
  }
  if (depth >= SHELL_BODY_MAX_DEPTH) {
    // 体深到看不见时按删除处理：这是「看不见就不静默放行」的同一方向，不把深层体当安全。
    return true;
  }
  const bodySegments = deps.splitSegments(body);
  if (bodySegments.truncated) {
    return true;
  }
  return bodySegments.texts.some((segment) =>
    commandDeletes(deps.lexTokens(deps.peelSeg(segment)), deps, depth + 1),
  );
}

/** `-exec` 后面的命令是否整树删除；纯 `-exec sh -c 'echo rm'` 不算。 */
function execDeleteOf(tokens: readonly ShellToken[], index: number, deps: FindXargsDeps): boolean {
  return commandDeletes(tokens.slice(index + 1), deps);
}

/** `-exec` / xargs 命令（含 `sh -c` 体）里实际出现的灾难目标。
 *  只给"命令自身是删除"的调用点用；body 截断或超层时故意返回空：此时没有可点名的
 *  目标，结论交给起始路径/上游状态，不能在这里凭空编一个 `/`。 */
function disasterTargetsOfDeleteCommand(
  tokens: readonly ShellToken[],
  windowsTrack: boolean,
  deps: FindXargsDeps,
  depth = 0,
): readonly string[] {
  const start = deps.runPrefixEnd(tokens);
  const command = tokens[start];
  /* v8 ignore next 2 —— 调用点只把非空 exec/xargs 命令交进来；空体由上层按不可见处理 */
  if (command === undefined) {
    return [];
  }
  const direct = disasterOffendingOf(tokens.slice(start + 1), windowsTrack, deps);
  if (direct.length > 0) {
    return direct;
  }
  if (
    deps.rmBinOf(command) !== "" ||
    !deps.shellBinNames.has(deps.binNameOf(command.value).toLowerCase())
  ) {
    return [];
  }
  const body = shellBodyOf(tokens.slice(start + 1));
  if (body === undefined || depth >= SHELL_BODY_MAX_DEPTH) {
    return [];
  }
  const bodySegments = deps.splitSegments(body);
  if (bodySegments.truncated) {
    return [];
  }
  const out: string[] = [];
  for (const segment of bodySegments.texts) {
    const bodyTokens = deps.lexTokens(deps.peelSeg(segment));
    out.push(...disasterTargetsOfDeleteCommand(bodyTokens, windowsTrack, deps, depth + 1));
  }
  return out;
}

/** 删除命令（含 shell 体）里实际点名的密钥目标。shell 包装不能把 `rm .env`
 *  藏成"只是执行了一个 shell"；`isSecretTarget` 与起始路径/xargs source 同一词表。 */
function secretTargetsOfDeleteCommand(
  tokens: readonly ShellToken[],
  windowsTrack: boolean,
  deps: FindXargsDeps,
  depth = 0,
): readonly string[] {
  const start = deps.runPrefixEnd(tokens);
  const command = tokens[start];
  /* v8 ignore next 2 —— 调用点只把非空 exec/xargs 命令交进来；空体由上层按不可见处理 */
  if (command === undefined) {
    return [];
  }
  const direct = secretOffendingOf(tokens.slice(start + 1), windowsTrack, deps);
  if (direct.length > 0) {
    return direct;
  }
  if (
    deps.rmBinOf(command) !== "" ||
    !deps.shellBinNames.has(deps.binNameOf(command.value).toLowerCase())
  ) {
    return [];
  }
  const body = shellBodyOf(tokens.slice(start + 1));
  if (body === undefined || depth >= SHELL_BODY_MAX_DEPTH) {
    return [];
  }
  const bodySegments = deps.splitSegments(body);
  if (bodySegments.truncated) {
    return [];
  }
  const out: string[] = [];
  for (const segment of bodySegments.texts) {
    const bodyTokens = deps.lexTokens(deps.peelSeg(segment));
    out.push(...secretTargetsOfDeleteCommand(bodyTokens, windowsTrack, deps, depth + 1));
  }
  return out;
}

/** 读取命令（含 shell 体）里的密钥读取命中；`cat` 被 `sh -c` 包住时也要看见。 */
function secretReadInCommandTree(
  tokens: readonly ShellToken[],
  windowsTrack: boolean,
  deps: FindXargsDeps,
  depth = 0,
): BashVerdict | undefined {
  const start = deps.runPrefixEnd(tokens);
  const command = tokens[start];
  let result: BashVerdict | undefined;
  /* v8 ignore next 2 —— 调用点只交非空命令；空体在 splitSegments 的 texts 里不会进到这里 */
  if (command !== undefined) {
    result = deps.secretReadDanger(command, tokens, windowsTrack);
    if (
      result === undefined &&
      deps.shellBinNames.has(deps.binNameOf(command.value).toLowerCase())
    ) {
      const body = shellBodyOf(tokens.slice(start + 1));
      if (body !== undefined && depth < SHELL_BODY_MAX_DEPTH) {
        const bodySegments = deps.splitSegments(body);
        if (!bodySegments.truncated) {
          result = bodySegments.texts
            .map((segment) =>
              secretReadInCommandTree(
                deps.lexTokens(deps.peelSeg(segment)),
                windowsTrack,
                deps,
                depth + 1,
              ),
            )
            .find((hit) => hit !== undefined);
        }
      }
    }
  }
  return result;
}

/** `find` 的删除形态：`-delete`，或 `-exec`/`-execdir`/`-ok`/`-okdir` 后跟整树删除命令。 */
function findDeleteFormOf(tokens: readonly ShellToken[], deps: FindXargsDeps): FindDeleteForm {
  let deleteFlag = false;
  let filtered = false;
  let inExec = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    /* v8 ignore next 2 —— 循环条件已保证下标在界内 */
    if (token === undefined) {
      break;
    }
    const word = token.value;
    if (inExec) {
      // `-exec rm -rf {} +` 里的 `-rf` 是**被执行的 rm** 的旗标，不是 find 谓词；
      // 进到执行体就跳过，直到 `;`/`+` 终止符。
      if (word === ";" || word === "+") {
        inExec = false;
      }
    } else if (word === "!" || word === "(" || word === ")") {
      filtered = true;
    } else if (word.startsWith("-") && !FIND_NON_FILTER_FLAGS.has(word)) {
      filtered = true;
    } else if (word === "-delete") {
      deleteFlag = true;
    } else if (FIND_EXEC_WORDS.has(word)) {
      inExec = true;
      deleteFlag ||= execDeleteOf(tokens, index, deps);
    }
  }
  return { delete: deleteFlag, filtered };
}

/** `xargs` 自己的命令词下标：跳过它自己的旗标（含带值旗标）；没有命令词时 undefined。 */
function xargsCommandIndex(tokens: readonly ShellToken[]): number | undefined {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    /* v8 ignore next 2 —— 循环条件已保证下标在界内 */
    if (token === undefined) {
      break;
    }
    const word = token.value;
    if (word === "--") {
      index += 1;
      break;
    }
    if (!word.startsWith("-")) {
      break;
    }
    index += XARGS_VALUE_FLAGS.has(word) ? 2 : 1;
  }
  return tokens[index] === undefined ? undefined : index;
}

/** `echo`/`printf` 这类"把字面数据送到管道"的段：取非旗标词当候选目标。
 *  `ls` 刻意不在此列：它的操作数是目录，输出的是目录里的条目名，不能把 `.` 当成
 *  即将交给 xargs 的数据——`ls . | xargs rm` 是未知集合，按 `nestedShellUnconfirmed`
 *  需确认，而不是把 `.` 当整树目标硬拒。 */
function literalSourceTokens(tokens: readonly ShellToken[]): readonly ShellToken[] {
  return tokens.slice(1).filter((token) => token.value !== "--" && !token.value.startsWith("-"));
}

function candidateStarts(tokens: readonly ShellToken[], deps: FindXargsDeps): ReadonlySet<number> {
  const starts = new Set(deps.headStarts(tokens));
  const prefixEnd = deps.runPrefixEnd(tokens);
  // `headStarts` 会把 `xargs` 当运行前缀剥掉（它确实在 RUN_PREFIX_WORDS 里），
  // 于是 xargs 自己永远不会成为候选头。这里把前缀覆盖到的每个位置补回来：
  // 只在前缀区内补，`echo xargs rm` 这类数据词不会被当成命令头。
  for (let index = 0; index < prefixEnd; index += 1) {
    starts.add(index);
  }
  return starts;
}

/** 全部 `-exec` 里的删除密钥命中；shell 包装与多 `-exec` 都由这里统一看。 */
function execSecretDeleteOf(
  execs: readonly FindExecCommand[],
  windowsTrack: boolean,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  let result: BashVerdict | undefined;
  for (const exec of execs) {
    result = deps.secretRmDanger(exec.head, exec.tokens, windowsTrack);
    if (result === undefined && commandDeletes(exec.tokens, deps)) {
      const offending = secretTargetsOfDeleteCommand(exec.tokens, windowsTrack, deps);
      if (offending.length > 0) {
        result = {
          key: "secretDelete",
          fix: { role: "disasterTarget", offending },
        };
      }
    }
    if (result !== undefined) {
      break;
    }
  }
  return result;
}

/** 全部 `-exec` 里的密钥读取命中；source tokens 作为兜底与旧行为同形。 */
function execSecretReadOf(
  execs: readonly FindExecCommand[],
  sourceTokens: readonly ShellToken[],
  windowsTrack: boolean,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  let result: BashVerdict | undefined;
  for (const exec of execs) {
    result =
      secretReadInCommandTree(exec.tokens, windowsTrack, deps) ??
      deps.secretReadDanger(exec.head, [exec.head, ...sourceTokens], windowsTrack);
    if (result !== undefined) {
      break;
    }
  }
  return result;
}

/** 全部 `-exec` 自身命令里的灾难目标；只认真正执行删除的那几条。 */
function execDisasterOf(
  execs: readonly FindExecCommand[],
  windowsTrack: boolean,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  let result: BashVerdict | undefined;
  for (const exec of execs) {
    if (commandDeletes(exec.tokens, deps)) {
      const offending = disasterTargetsOfDeleteCommand(exec.tokens, windowsTrack, deps);
      if (offending.length > 0) {
        result = {
          key: "rmrf",
          fix: { role: "disasterTarget", offending },
        };
        break;
      }
    }
  }
  return result;
}

function findHeadDanger(
  tokens: readonly ShellToken[],
  start: number,
  state: SourceState,
  windowsTrack: boolean,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  const candidate = tokens.slice(start);
  const paths = findPathTokens(candidate);
  const form = findDeleteFormOf(candidate, deps);
  state.tokens = paths;
  state.filtered = form.filtered;
  let result: BashVerdict | undefined;
  if (form.delete) {
    const offending = disasterOffendingOf(paths, windowsTrack, deps);
    if (offending.length > 0) {
      // 带谓词时删的是匹配集（`find . -name '*.ts' -delete`），不是整棵起始树；
      // 起点仍包住可写根就交审批，不能按 `rmrf` 硬拒。`nestedShellUnconfirmed` 不行：
      // 它在工作区档是 allow，会把一次已知删除静默放行。
      result = form.filtered
        ? { key: "findDelete" }
        : { key: "rmrf", fix: { role: "disasterTarget", offending } };
    }
  }

  // `find` 的密钥面与 xargs 同一条判据：起始路径与 `-name` / `-path` 的取值、
  // 以及 `-exec` 命令自身的目标都要过。`find .env -delete` / `find .env -exec rm {} \;`
  // 过去只算灾难目标（`.env` 不是），于是整条漏掉。
  const sourceTokens = findSecretSourceTokens(candidate);
  const directSecret = form.delete ? secretOffendingOf(sourceTokens, windowsTrack, deps) : [];
  const execs = findExecCommandsOf(candidate, deps);
  const execSecretDelete = execSecretDeleteOf(execs, windowsTrack, deps);
  const execSecretRead = execSecretReadOf(execs, sourceTokens, windowsTrack, deps);
  // `-exec rm -rf /` 的目标写在 exec 自己的命令里，不在 find 的起始路径上：
  // 只看 `paths` 会把这条显式整树删除降成 `findDelete`（ask）。删除命令自身的
  // 灾难目标必须先结算，且不能被后面的密钥/阅读命中覆盖。多个 `-exec` 逐条看，
  // 不能只拿第一条（`-exec echo … \; -exec rm -rf / \;` 是真实形态）。
  if (form.delete) {
    result = execDisasterOf(execs, windowsTrack, deps) ?? result;
  }
  const secretDelete =
    directSecret.length > 0
      ? {
          key: "secretDelete" as const,
          fix: { role: "disasterTarget" as const, offending: directSecret },
        }
      : execSecretDelete;

  // rmrf 是已确认的整树删除，不能被更轻的密钥/阅读命中覆盖；其余按先密钥后阅读。
  if (result?.key !== "rmrf") {
    result = secretDelete ?? execSecretRead ?? result;
  }
  return result;
}

function xargsDeleteResult(
  effectiveTokens: readonly ShellToken[],
  state: SourceState,
  windowsTrack: boolean,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  let result: BashVerdict | undefined;
  if (commandDeletes(effectiveTokens, deps)) {
    // 命令自带的目标（`echo foo | xargs rm -rf /`）必须先于上游目标结算：
    // 上游是 `foo` 时若只看 `state.tokens`，这条显式整树删除会整条漏掉；
    // 上游是 `find . -name …` 时又会把它降成 `findDelete`。
    const directOffending = disasterTargetsOfDeleteCommand(effectiveTokens, windowsTrack, deps);
    if (directOffending.length > 0) {
      result = { key: "rmrf", fix: { role: "disasterTarget", offending: directOffending } };
    } else if (state.tokens === undefined) {
      result = { key: "nestedShellUnconfirmed" };
    } else {
      const offending = disasterOffendingOf(state.tokens, windowsTrack, deps);
      if (offending.length > 0) {
        result = state.filtered
          ? { key: "findDelete" }
          : { key: "rmrf", fix: { role: "disasterTarget", offending } };
      }
    }
  }
  return result;
}

function xargsHeadDanger(
  tokens: readonly ShellToken[],
  start: number,
  state: SourceState,
  windowsTrack: boolean,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  const args = tokens.slice(start);
  const commandIndex = xargsCommandIndex(args);
  let result: BashVerdict | undefined;
  if (commandIndex !== undefined) {
    const commandTokens = args.slice(commandIndex);
    const effectiveTokens = commandTokens.slice(deps.runPrefixEnd(commandTokens));
    const [command] = effectiveTokens;
    /* v8 ignore next 1 —— xargsCommandIndex 保证有命令词；runPrefixEnd 走空只可能是无意义前缀句，结果照 undefined 返回 */
    if (command !== undefined) {
      result = xargsDeleteResult(effectiveTokens, state, windowsTrack, deps);

      // 命令自身带的目标（`xargs rm /x/.env`）与 source tokens（`echo /x/.env | xargs rm`）
      // 都过密钥面；shell 体里的 `rm .env` / `cat .env` 也要看见，不能只按命令头
      // `sh` 就放过。两类命令词各自复用 danger-rules 的同一套判定。
      const sourceTokens = state.tokens ?? [];
      const treeSecretDelete = commandDeletes(effectiveTokens, deps)
        ? secretTargetsOfDeleteCommand(effectiveTokens, windowsTrack, deps)
        : [];
      const secretDelete =
        deps.secretRmDanger(command, effectiveTokens, windowsTrack) ??
        (treeSecretDelete.length > 0
          ? {
              key: "secretDelete" as const,
              fix: { role: "disasterTarget" as const, offending: treeSecretDelete },
            }
          : undefined) ??
        deps.secretRmDanger(command, [command, ...sourceTokens], windowsTrack);
      const secretRead =
        secretReadInCommandTree(effectiveTokens, windowsTrack, deps) ??
        deps.secretReadDanger(command, [command, ...sourceTokens], windowsTrack);
      if (result?.key !== "rmrf") {
        result = secretDelete ?? secretRead ?? result;
      }
    }
  }
  return result;
}

function headDangerOf(
  tokens: readonly ShellToken[],
  start: number,
  state: SourceState,
  windowsTrack: boolean,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  const head = tokens[start];
  let result: BashVerdict | undefined;
  if (head !== undefined) {
    const bin = deps.binNameOf(head.value).toLowerCase();
    if (bin === "find") {
      result = findHeadDanger(tokens, start, state, windowsTrack, deps);
    } else if (bin === "echo" || bin === "printf") {
      state.tokens = literalSourceTokens(tokens.slice(start));
      state.filtered = false;
    } else if (bin === "xargs") {
      result = xargsHeadDanger(tokens, start, state, windowsTrack, deps);
    }
  }
  return result;
}

function segmentDangerOf(
  segment: string,
  state: SourceState,
  windowsTrack: boolean,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  const tokens = deps.lexTokens(deps.peelSeg(segment));
  const starts = candidateStarts(tokens, deps);
  let result: BashVerdict | undefined;
  for (const start of starts) {
    result = headDangerOf(tokens, start, state, windowsTrack, deps);
    if (result !== undefined) {
      break;
    }
  }
  return result;
}

/**
 * `find` / `xargs` 的灾难删除：`find . -delete`、`find ~ -delete`、
 * `find / -exec rm -rf {} +`、`find . -print0 | xargs -0 rm -rf`、
 * `echo ~ | xargs rm -rf` 这些形态的**命令头不是 rm**，所以 `catastrophicRm`
 * 看不到；目标一旦包住可写根，宿主沙箱没有原子性（先删工作区再撞边界），
 * 这条必须在插件侧判。命中后复用 `rmrf` 的键、出路与沙箱让路逻辑。
 *
 * `xargs` 的上游不可见（没有 `find`/`echo`/`printf` 供目标）时按
 * `nestedShellUnconfirmed` 需确认，不静默放行。
 */
export function findXargsDanger(
  command: string,
  ctx: FindXargsContext,
  deps: FindXargsDeps,
): BashVerdict | undefined {
  let result: BashVerdict | undefined;
  if (!ctx.windowsDialect) {
    const windowsTrack = deps.isWindowsHost();
    const state: SourceState = { tokens: undefined, filtered: false };
    const segmentation = deps.splitSegments(command);
    for (const [index, text] of segmentation.texts.entries()) {
      // 只有真正的 `|` 边才把上一条命令的输出交给下一条；`;` / `&&` / `||` 的分段
      // 不共享 source，否则 `echo .; xargs rm` 会把一个从未进管道的数据当成目标。
      if (segmentation.pipeConnected[index] !== true) {
        state.tokens = undefined;
        state.filtered = false;
      }
      const current = segmentDangerOf(text, state, windowsTrack, deps);
      if (current !== undefined) {
        // 不能首个命中就收工：前段可能是 `findDelete` / `secretRead` 这类 ask，
        // 后段却是 `find / -delete` 的 rmrf。ask 只作备选，deny 才是已结算。
        // 同一档内保持先到先得（更具体的 find/secret 规则先命中就先说）。
        result ??= current;
        if (current.key === "rmrf") {
          result = current;
          break;
        }
      }
    }
  }
  return result;
}
