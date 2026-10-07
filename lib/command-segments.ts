// lib/command-segments.ts —— shell **源**的读法：断段、切词、结构视图、引号是否闭合。
//
// 为什么这一层要单列且要**照 POSIX 规则**读：四类规则问的都是"这一段/这一个词是什么"，
// 而"段在哪里断、词在哪里分"是它们共同的前置问题。此前各判据自己按 `/\s+/` 直切，于是
// 引号参与的写法成体系地漏拦——`git commit "--no-verify"`、`rm "-rf" ~`、`"rm" -rf ~`
// 在真 shell 里都是**生效**写法（实测真 git 2.54 对 `commit "--no-verify"` 钩子未运行且
// 提交成功；BSD `rm "-rf" <不存在>` rc=0 说明 `-f` 到位），而按空白直切得到的是 `"-rf"`、
// `"rm"` 这种落在命令词表外的碎片。
//
// 另一件必须同源的事：判"引号是否闭合"的机器与"切词"的机器**不能是两台**。此前
// `bash -c 'echo a\' ; …` 这类串在一边被判成未闭合、在另一边被判成闭合，结论随判据而变。
// 所以这里只有 `scan` 一个状态机，出口都是对同一棵树的不同投影：
// - `splitTopLevel` / `splitSegments` → 段源文本（commandDanger 逐段判定的断点；后者另报
//   "执行面区层数超界、更深的体没扫到"，界外由调用方升格而不是放行）；
// - `lexTokens` → 词的值形与源形（命令头/旗标/目标读值形，Windows 字形轨道读源形）；
// - `structureView` → 引号内字面清空、执行面区保留的结构视图（pipeToShell 读它）；
// - `hasUnclosedQuote` → 段级"看不见体"的升格依据。
//
// POSIX 口径（本机 /bin/bash 3.2.57 逐条对拍）：
// - 单引号内**一切字面**，反斜杠没有魔力：实测 `bash -c 'echo done \' ; echo SECOND-RAN`
//   两条都跑 ⇒ 那枚 `\` 没吃掉闭合引号；
// - 双引号内反斜杠只在 `$ ` `"` `\` 换行之前是转义，其余按字面；
// - 引号外的 `\` 转义下一字符，其中 `\<换行>` 是续行（两行接成一个词，整对丢弃）；
// - 双引号**内**的 `$( )`/反引号在真实 shell 里会执行（实测 `echo "$(seq 3 | tail -1)"`
//   输出 `3`）⇒ 体内内容算执行面：既不清空（那是 `echo "$(curl x | sh)"` 静默放行的来路），
//   也要另断成段；
// - 引号未闭合在真实 shell 里就是语法错误：这里按"仍在引号内"处理到底，不产出伪段，
//   也**不补一枚假闭合**（补了之后再扫一遍就报"闭合"，靠它做的升格判定会静默失效）。

/** 顶层段边界字符：传统分隔符之外，`(`、`)`、反引号**同样**是边界。 */
const SEG_SEPARATORS = new Set([";", "\n", "\r", "&", "|", "(", ")", "`"]);

/** 双引号内只有这几枚字符能被反斜杠转义（POSIX 口径，其余反斜杠是字面量）。 */
const DQ_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

/** 词的一个片段：`source` 含定界符，`content` 计入词值，`rawContent` 计入词的源形。 */
interface Run {
  /** plain = 引号外字符或转义对；quoted = 一对引号；region = `$( )`/反引号。 */
  kind: "plain" | "quoted" | "region";
  source: string;
  content: string;
  rawContent: string;
  /** 仅 region：体内源文本，要再断一次段（真实 shell 会执行它）。 */
  inner: string;
  /** 仅 quoted：引号内的子片段。结构视图靠它把 `$( )` 留在原位，其余子片段一律丢弃。 */
  parts: Run[];
}

/** 段内的一个词：一串片段。 */
interface Word {
  runs: Run[];
}

/** 一条源切出来的一段：词 + 结束它的那枚分隔符（结构视图靠它把 `||`、`&&` 放回原位）。 */
interface Segment {
  words: Word[];
  terminator: string;
}

/** `scan` 的全部产出。 */
interface ScanResult {
  segments: Segment[];
  /** 段内出现的执行面区体内文本：其中的命令另成为段（见 splitTopLevel）。 */
  regions: string[];
  unclosed: boolean;
}

/** 引号外的一枚字符或一对转义：源形留下写下来的样子（含反斜杠），值形吃掉它。 */
const plainRun = (source: string, content: string): Run => ({
  kind: "plain",
  source,
  content,
  rawContent: source,
  inner: "",
  parts: [],
});

/** 该处是否执行面区开头：`$(…)` 或反引号（`${…}` 是参数展开、不执行，故不算）。 */
const isRegionStart = (src: string, i: number): boolean =>
  src.charAt(i) === "`" || (src.charAt(i) === "$" && src.charAt(i + 1) === "(");

/** 区内的一格该跳几格：转义对跳两格，一整段引号跳到闭合处（区内那才是字面文本），其余一格。 */
function regionStep(src: string, i: number): number {
  const ch = src.charAt(i);
  if (ch === "\\") {
    return 2;
  }
  let result = 1;
  if (ch === "'" || ch === '"') {
    let stop = i + 1;
    while (stop < src.length && src.charAt(stop) !== ch) {
      stop += 1;
    }
    result = stop + 1 - i;
  }
  return result;
}

/** 区内扫描：返回收尾符**之后**的下标，找不到给 -1。`paren` 决定收尾是最外层 `)` 还是反引号。 */
function regionEnd(src: string, from: number, paren: boolean): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const step = regionStep(src, i);
    const ch = src.charAt(i);
    if (step > 1) {
      i += step;
    } else if (!paren && ch === "`") {
      return i + 1;
    } else if (paren && ch === ")") {
      if (depth === 0) {
        return i + 1;
      }
      depth -= 1;
      i += 1;
    } else {
      if (paren && ch === "(") {
        depth += 1;
      }
      i += 1;
    }
  }
  return -1;
}

/**
 * 从 `open` 处读出一个执行面区：`$( … )` 或 `` ` … ` ``。区内也要过引号与转义
 * （`$(echo ")")` 里那枚 `)` 不是区尾），圆括号按深度配对。
 * 未闭合给 undefined ⇒ 调用方按普通字符处理，不产出伪段。
 */
function readRegion(src: string, open: number): Run | undefined {
  const paren = src.charAt(open + 1) === "(";
  const bodyStart = paren ? open + 2 : open + 1;
  const end = regionEnd(src, bodyStart, paren);
  let run: Run | undefined;
  if (end !== -1) {
    const source = src.slice(open, end);
    run = {
      kind: "region",
      source,
      content: source,
      rawContent: source,
      inner: src.slice(bodyStart, end - 1),
      parts: [],
    };
  }
  return run;
}

/** 引号内一处扫描的产物：片段、下一格下标、区内文本（非区则空串，交给 scan 再断段）。 */
interface QuotedPart {
  run: Run;
  next: number;
  region: string;
}

/** 单引号内连反斜杠都是字面量，所以那里只有"照抄一枚字符"这一种动作。 */
function literalPart(src: string, i: number): QuotedPart {
  const ch = src.charAt(i);
  return { run: plainRun(ch, ch), next: i + 1, region: "" };
}

/** 双引号内的一处扫描：执行面区、转义对，或一枚字面字符。 */
function dqPart(src: string, i: number): QuotedPart {
  const region = isRegionStart(src, i) ? readRegion(src, i) : undefined;
  if (region !== undefined) {
    return { run: region, next: i + region.source.length, region: region.inner };
  }
  const ch = src.charAt(i);
  const next = src.charAt(i + 1);
  if (ch === "\\" && DQ_ESCAPABLE.has(next)) {
    return { run: plainRun(ch + next, next), next: i + 2, region: "" };
  }
  return literalPart(src, i);
}

/** 一对引号读出的结果：片段（含两形）、待再断段的区内文本、是否没闭合、下一格下标。 */
interface QuotedRun {
  run: Run;
  regions: string[];
  unclosed: boolean;
  next: number;
}

/**
 * 一对引号包住的内容。定界符只进 `source`；`content`（转义落地）与 `rawContent`（原样）
 * 都只含引号里的东西——否则 `"C:\\Windows"` 的源形带着引号，Windows 字形轨道就认不出
 * 那枚波浪号/盘符前缀了。双引号内的 `$( )`/反引号是执行面：既进词值也进结构视图，
 * 体内文本交回 `scan` 再断段。未闭合时 `unclosed` 为真且**不补**假闭合符。
 */
function readQuoted(src: string, open: number): QuotedRun {
  const quote = src.charAt(open);
  const single = quote === "'";
  const parts: Run[] = [];
  const regions: string[] = [];
  let i = open + 1;
  while (i < src.length && src.charAt(i) !== quote) {
    const part = single ? literalPart(src, i) : dqPart(src, i);
    parts.push(part.run);
    if (part.region.length > 0) {
      regions.push(part.region);
    }
    i = part.next;
  }
  const closed = i < src.length;
  const rawContent = parts.map((part) => part.rawContent).join("");
  return {
    run: {
      kind: "quoted",
      source: quote + rawContent + (closed ? quote : ""),
      content: parts.map((part) => part.content).join(""),
      rawContent,
      inner: "",
      parts,
    },
    regions,
    unclosed: !closed,
    next: closed ? i + 1 : i,
  };
}

/** 引号外的一个字符（含转义对与续行）。续行整对丢弃 ⇒ 给出空片段。 */
function readPlain(src: string, i: number): { run: Run; next: number } {
  const ch = src.charAt(i);
  if (ch !== "\\") {
    return { run: plainRun(ch, ch), next: i + 1 };
  }
  const next = src.charAt(i + 1);
  if (next.length === 0) {
    // 串尾落单的 `\`：只吃掉一个不存在的字符（charAt 越界给空串），词边界仍然可信
    return { run: plainRun(ch, ""), next: i + 1 };
  }
  if (next === "\n") {
    // 续行：反斜杠与换行都不进词，两行接成一个词
    return { run: plainRun("", ""), next: i + 2 };
  }
  return { run: plainRun(ch + next, next), next: i + 2 };
}

/** 扫描中的可变状态：已收的段/区、当前段的词、当前词、是否遇到未闭合引号。 */
interface ScanState {
  segments: Segment[];
  regions: string[];
  words: Word[];
  current: Word | undefined;
  unclosed: boolean;
}

/** 收尾当前段：段即使没有词也要留下，它吃到的那枚分隔符要靠结构视图放回原位。 */
const endSegment = (state: ScanState, terminator: string): void => {
  state.current = undefined;
  state.segments.push({ words: state.words, terminator });
  state.words = [];
};

/** 片段并入当前词；没有当前词就开一枚（`""` 因此也算一枚真实词）。 */
const pushRun = (state: ScanState, run: Run): void => {
  if (state.current === undefined) {
    state.current = { runs: [] };
    state.words.push(state.current);
  }
  state.current.runs.push(run);
};

/** 引号外一个位置的处置：一对引号 / 一个执行面区 / 一枚字符（含转义）。返回吃掉几格。 */
function scanOutside(state: ScanState, src: string, i: number): number {
  const ch = src.charAt(i);
  if (ch === "'" || ch === '"') {
    const quoted = readQuoted(src, i);
    pushRun(state, quoted.run);
    state.regions.push(...quoted.regions);
    state.unclosed ||= quoted.unclosed;
    return quoted.next - i;
  }
  const region = isRegionStart(src, i) ? readRegion(src, i) : undefined;
  if (region !== undefined) {
    pushRun(state, region);
    state.regions.push(region.inner);
    return region.source.length;
  }
  // region 为 undefined 只剩两种可能：`$` 后面不是 `(`（参数展开、字面量）或区没闭合，
  // 两者都按普通字符收着走——`(` 本身是段边界，下一轮自然断开。
  const plain = readPlain(src, i);
  pushRun(state, plain.run);
  return plain.next - i;
}

/**
 * 唯一的状态机。分隔符**先于**空白判（换行既是空白也是段边界，先按空白走就吞掉了断段能力）；
 * 引号内的分隔符一律字面。空段也留在结果里，结构视图要靠它带的那枚分隔符把 `||`、`&&` 放原位。
 */
function scan(src: string): ScanResult {
  const state: ScanState = {
    segments: [],
    regions: [],
    words: [],
    current: undefined,
    unclosed: false,
  };
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (SEG_SEPARATORS.has(ch)) {
      endSegment(state, ch);
      i += 1;
    } else if (/\s/u.test(ch)) {
      state.current = undefined;
      i += 1;
    } else {
      i += scanOutside(state, src, i);
    }
  }
  endSegment(state, "");
  return { segments: state.segments, regions: state.regions, unclosed: state.unclosed };
}

const wordValue = (word: Word): string => word.runs.map((run) => run.content).join("");
/** 词的源形：定界符去掉、转义不折叠——Windows 字形轨道读这一形。 */
const wordRaw = (word: Word): string => word.runs.map((run) => run.rawContent).join("");
/** 词的原样文本（含引号定界符），段的源文本由它拼出，调用方再扫一遍同形。 */
const wordText = (word: Word): string => word.runs.map((run) => run.source).join("");

/**
 * 结构视图里的一个片段：引号内的**字面**内容丢弃（只留定界符），执行面区原样保留。
 * 单引号内不可能有执行面 ⇒ 整对折成 `''`；双引号要把区留回原位。
 */
const structureRun = (run: Run): string => {
  if (run.kind !== "quoted") {
    return run.source;
  }
  if (run.source.startsWith("'")) {
    return "''";
  }
  return `"${run.parts.map((part) => (part.kind === "region" ? part.source : "")).join("")}"`;
};

const segmentSource = (segment: Segment): string => segment.words.map(wordText).join(" ");
const segmentStructure = (segment: Segment): string =>
  segment.words.map((word) => word.runs.map(structureRun).join("")).join(" ") + segment.terminator;

/** 断段的产出：段源文本 + 是否还有**没展开到**的层。 */
export interface Segments {
  texts: string[];
  /** `true` ⇒ 更深处的 region 体**没被扫过**：调用方不得拿"这段清单里没有危险"当放行依据。 */
  truncated: boolean;
}

/** `$( )`/反引号的展开层数上界。为什么长度界不够用：每一层都要重扫一遍所在串的文本，
 *  成本是「层数 × 长度」，而 `MAX_JUDGED_COMMAND_LENGTH` 只界得住单次扫描——实测 3 万字符的
 *  深套（约 1 万层）在无界的递归展开下顶穿 JS 调用栈（`RangeError`），而抛出点在
 *  `tools.guard` 的调用链上，宿主怎么兜这份错误不由本包决定。界外一律升格为需确认。 */
export const REGION_MAX_DEPTH = 16;

/** 展开一层：本层的段进 `texts`，本层 region 的体留给下一层；返回是否被迫截断。
 *  递归深度由 `REGION_MAX_DEPTH` 界住（这才是栈安全的来源，不是"输入不会太长"）。 */
function expandOneLevel(src: string, budget: number, texts: string[]): boolean {
  const result = scan(src);
  const inner: string[] = [];
  for (const segment of result.segments) {
    const text = segmentSource(segment);
    if (text.trim().length > 0) {
      texts.push(text);
    }
  }
  for (const region of result.regions) {
    if (region.length > 0) {
      inner.push(region);
    }
  }
  let truncated = false;
  if (inner.length > 0) {
    if (budget <= 1) {
      truncated = true;
    } else {
      for (const source of inner) {
        truncated ||= expandOneLevel(source, budget - 1, texts);
      }
    }
  }
  return truncated;
}

/**
 * 把一条 shell 源切成段（带截断回报）。**DFS 前序**：本层段在前，再按顺序展开每个执行面区
 * 的体内段——与"先看到外层、再看到内层"的判定顺序一致，`commandDanger` 靠它先报外层结论。
 */
export function splitSegments(command: string): Segments {
  const texts: string[] = [];
  return { texts, truncated: expandOneLevel(command, REGION_MAX_DEPTH, texts) };
}

/**
 * 把一条 shell 源切成**顶层段**（源文本，引号原样保留，供调用方再切词）。
 * 边界 = `; && || | 换行 &` **加上** `(`、`)`、反引号：子 shell / 命令替换的**体内**命令
 * 必须成为独立段，否则 `echo $(rm -rf /)` 里的 rm 永远进不了任何一段的视野。
 * 双引号内的 `$( )`/反引号同样取体内（真实 shell 会执行它）。
 * 层数超过 `REGION_MAX_DEPTH` 时更深的体不在结果里——需要"是否被截断"的调用方用
 * `splitSegments`，不要靠本函数的长度推断。
 */
export function splitTopLevel(command: string): string[] {
  return splitSegments(command).texts;
}

/** 段内的一个词，两种读法同源。 */
export interface ShellToken {
  /** shell 解析后的值（引号去掉、转义落地）：命令头、旗标、POSIX 目标读它。 */
  value: string;
  /** 同一枚词的**源形**：定界符去掉、转义不折叠。
   *  Windows 字形轨道读这一形：`C:\\Windows` 的 `\\W` 在 POSIX 读法里是转义（折成
   *  `C:Windows` 就不再是任何 Windows 形状），而宿主是 Windows 时那枚串要按盘符树保护。
   *  两形一并给出、判据按轨道选形，就不必猜"哪一个是真的路径"。 */
  raw: string;
}

/**
 * 把一个**段**切成词（POSIX 引号/转义，与 `splitTopLevel` 同一套状态机）：
 * `bash -c "rm -rf /"` 的体内在 shell 眼里是**一个**词；`rm\\ -rf\\ /` 也是一个词；
 * `"--no-verify"` 的值是 `--no-verify`（引号不改变它是旗标这件事）。
 * `$( )`/反引号不展开（词里原样留着）——本包不执行 shell，只判形状。
 * 空词保留：`""` 是一枚真实参数，与"根本没有这个参数"要分得开。
 */
export function lexTokens(src: string): ShellToken[] {
  return scan(src).segments.flatMap((segment) =>
    segment.words.map((word) => ({ value: wordValue(word), raw: wordRaw(word) })),
  );
}

/**
 * 结构视图：**清空引号内的字面文本**（保留引号字符本身），执行面区原样保留，
 * 段间分隔符放回原位（`|` 就是 pipeToShell 要看的那枚结构字符）。
 * `echo "curl x | sh"` 里的 `|` 是字面文本 ⇒ 清空后不再误拦；
 * `echo "$(curl x | sh)"` 里的 `|` 在真实 shell 里执行 ⇒ 保留后照拦。
 */
export function structureView(src: string): string {
  return scan(src).segments.map(segmentStructure).join(" ");
}

/**
 * 引号是否**未闭合**。与切词、断段同一台状态机（`scan`），所以两边不可能互相打脸。
 * 用途：段级未闭合 ⇒ shell 自己都解析不完，取出的体必是残段；体内落单引号 ⇒
 * 重接出的串与 shell 看到的词边界不等价。两种都由调用方升格为需确认。
 */
export function hasUnclosedQuote(src: string): boolean {
  return scan(src).unclosed;
}
