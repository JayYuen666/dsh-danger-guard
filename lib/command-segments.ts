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
// - 双引号内反斜杠只在 `$ ` `"` `\` 之前是转义；`\<换行>` 是续行，整对删除（不留下换行）；
// - 引号外的 `\` 转义下一字符，其中 `\<换行>` 是续行（两行接成一个词，整对丢弃）；
// - `#` 在词首到行尾是注释，注释里的引号/分隔符不参与语法；
// - `<<`/`<<-` 的体按定界符整段取出，再作为**独立源**展开：体内的引号/分隔符不会污染
//   外层命令行。定界符是否带引号不改变这一步——`bash <<'EOF'` 的体仍是脚本；代价是数据型
//   heredoc 的正文也会按命令扫一遍（`cat <<'EOF'` 里的危险文本会误拦），这是有意的保守选择；
// - 双引号**内**的 `$( )`/反引号在真实 shell 里会执行（实测 `echo "$(seq 3 | tail -1)"`
//   输出 `3`）⇒ 体内内容算执行面：既不清空（那是 `echo "$(curl x | sh)"` 静默放行的来路），
//   也要另断成段；
// - 引号未闭合在真实 shell 里就是语法错误：这里按"仍在引号内"处理到底，不产出伪段，
//   也**不补一枚假闭合**（补了之后再扫一遍就报"闭合"，靠它做的升格判定会静默失效）。

/** 顶层段边界字符：传统分隔符之外，`(`、`)`、反引号**同样**是边界。 */
const SEG_SEPARATORS = new Set([";", "\n", "\r", "&", "|", "(", ")", "`"]);

/** 关键字判定用的词边界字符（换行/空白与 shell 元字符）。 */
const KEYWORD_BOUNDARY = /[\s;()&|]/u;
/** heredoc 行尾 CR 与前导制表符。 */
const TRAILING_CR = /\r$/u;
const LEADING_TABS = /^\t+/u;

/** 双引号内只有这几枚字符能被反斜杠转义（POSIX 口径，其余反斜杠是字面量）。
 *  `\`+换行单独按续行处理（整对删除），不在这张表里。 */
const DQ_ESCAPABLE = new Set(["$", "`", '"', "\\"]);

/** 词边界上的空白：POSIX shell 只用空格与制表符切词（换行/回车先按段边界处理）。 */
const isBlank = (ch: string): boolean => ch === " " || ch === "\t";

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

/** 一条已登记的 heredoc：去引号后的定界符；`stripTabs` 对应 `<<-`。 */
interface HeredocSpec {
  delimiter: string;
  stripTabs: boolean;
}

/** `scan` 的全部产出。 */
interface ScanResult {
  segments: Segment[];
  /** 段内出现的执行面区体内文本：其中的命令另成为段（见 splitTopLevel）。 */
  regions: string[];
  /** heredoc 体：作为独立源再展开，避免体内的引号/分隔符把外层命令行吃掉。 */
  bodies: string[];
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

/** 该处是否执行面区开头：`$(…)` 或反引号。`${…}` 本身不是区；其中若出现 `$( )`/反引号，
 *  仍会按各自位置识别（`${x:-$(cmd)}` 里的 cmd 照扫）。 */
const isRegionStart = (src: string, i: number): boolean =>
  src.charAt(i) === "`" || (src.charAt(i) === "$" && src.charAt(i + 1) === "(");

/** 单引号段：找到下一枚 `'`；未闭合吃到串尾（整段按未闭合处理）。 */
function singleQuotedEnd(src: string, open: number): number {
  const end = src.indexOf("'", open + 1);
  return end === -1 ? src.length : end + 1;
}

/** 反引号区的终点（绝对下标，收尾符之后）；找不到给 -1。
 *  旧式替换只认第一枚未被反斜杠转义的反引号，引号不保护收尾符。 */
function backtickEnd(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    if (src.charAt(i) === "\\") {
      i += 2;
    } else if (src.charAt(i) === "`") {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return -1;
}

/** 双引号段：`\"` 不闭合，其余反斜杠跳下一枚；双引号内的反引号体整段跳过。 */
function doubleQuotedEnd(src: string, open: number): number {
  let i = open + 1;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === "\\") {
      i += 2;
    } else if (ch === '"') {
      return i + 1;
    } else if (ch === "`") {
      const end = backtickEnd(src, i + 1);
      if (end === -1) {
        return src.length;
      }
      i = end;
    } else {
      i += 1;
    }
  }
  return src.length;
}

/** 区内的一个整段：转义对跳两格，引号/反引号跳到各自终点，其余一格。 */
function regionStep(src: string, i: number): number {
  const ch = src.charAt(i);
  if (ch === "\\") {
    return 2;
  }
  if (ch === "'") {
    return singleQuotedEnd(src, i) - i;
  }
  if (ch === '"') {
    return doubleQuotedEnd(src, i) - i;
  }
  if (ch === "`") {
    const end = backtickEnd(src, i + 1);
    return (end === -1 ? src.length : end) - i;
  }
  return 1;
}

/**
 * 区内一处关键字（`case` / `esac`）。只在**词边界**上认，避免 `mycase`、`esacris` 这类
 * 标识符被当成关键字。返回 `undefined` 表示这处不是关键字。
 */
function caseKeywordAt(src: string, i: number): "case" | "esac" | undefined {
  const rest = src.slice(i, i + 4);
  const after = src.charAt(i + 4);
  const boundaryAfter = after === "" || KEYWORD_BOUNDARY.test(after);
  let out: "case" | "esac" | undefined;
  if (rest === "case" && boundaryAfter) {
    out = "case";
  } else if (rest === "esac" && boundaryAfter) {
    out = "esac";
  }
  return out;
}

/** 区内这一枚字符是否落在词边界上（关键字判定用）。 */
const isWordBoundaryBefore = (src: string, i: number, from: number): boolean =>
  i === from || KEYWORD_BOUNDARY.test(src.charAt(i - 1));

/**
 * 区的终点。`paren` 决定收尾是最外层 `)` 还是反引号：
 * `$( )` 里圆括号按深度配对，双引号内的 `)`/转义引号不参与配对，反引号体整段跳过；
 * 反引号区只认第一枚未被反斜杠转义的反引号。
 *
 * `case … esac` 里的 `)` 是**模式收尾**，不是区收尾：`x=$(case a in a) rm -rf /etc;; esac)`
 * 在真 bash 里会删掉 `/etc`，而只做圆括号配对时那个 `)` 会让区在第一处提前结束 —— 体内
 * 剩下的命令落到区外、以普通文本形态进判定，实测那条命令被放行。所以 `case` 单独记一层
 * 嵌套深度，只有它归零之后区尾的 `)` 才成立。
 */
/** 区内走到这一格时的两层嵌套深度。`cases` 是 `case … esac` 的层数（模式收尾的 `)` 不算区尾）。 */
interface RegionWalk {
  parens: number;
  cases: number;
}

/** 区内一处关键字：命中 `case`/`esac` 时更新深度并给出下一格下标，否则 `undefined`。 */
function caseAdvance(src: string, i: number, from: number, walk: RegionWalk): number | undefined {
  const keyword = isWordBoundaryBefore(src, i, from) ? caseKeywordAt(src, i) : undefined;
  let out: number | undefined;
  if (keyword === "case") {
    walk.cases += 1;
    out = i + 4;
  } else if (keyword === "esac" && walk.cases > 0) {
    walk.cases -= 1;
    out = i + 4;
  }
  return out;
}

/** 区内一枚括号的处理结果：`"close"` = 这一枚收尾了区；数字 = 下一格下标；`undefined` = 不是括号。 */
type BracketStep = "close" | number | undefined;

/** 区内一枚括号：`case` 层未归零时模式收尾的 `)` 只把自己配掉（落单的 `)` 不进
 *  `parens`，所以那里不减），不收区。 */
function bracketAdvance(src: string, i: number, walk: RegionWalk): BracketStep {
  const ch = src.charAt(i);
  let out: BracketStep;
  if (ch === ")") {
    if (walk.parens > 0) {
      walk.parens -= 1;
      out = i + 1;
    } else if (walk.cases === 0) {
      out = "close";
    }
  } else if (ch === "(") {
    walk.parens += 1;
    out = i + 1;
  }
  return out;
}

function regionEnd(src: string, from: number, paren: boolean): number {
  if (!paren) {
    return backtickEnd(src, from);
  }
  const walk: RegionWalk = { parens: 0, cases: 0 };
  let i = from;
  while (i < src.length) {
    const keywordNext = caseAdvance(src, i, from, walk);
    const bracket = keywordNext === undefined ? bracketAdvance(src, i, walk) : undefined;
    if (keywordNext !== undefined) {
      i = keywordNext;
    } else if (bracket === "close") {
      return i + 1;
    } else if (typeof bracket === "number") {
      i = bracket;
    } else {
      // 落单的 `)`（`case` 层把它配掉了）也走这里：只吃掉一格，不收区。
      i += regionStep(src, i);
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
  if (ch === "\\" && next === "\n") {
    // 双引号内的续行同样整对删除：值与源形都不留下这对字符
    return { run: plainRun("", ""), next: i + 2, region: "" };
  }
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

/** 引号外的一个字符（含转义对与续行）。续行整对丢弃 ⇒ 不产出片段。 */
function readPlain(src: string, i: number): { run?: Run; next: number } {
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
    // 续行：反斜杠与换行都不进词，也不因此新开一枚词
    return { next: i + 2 };
  }
  return { run: plainRun(ch + next, next), next: i + 2 };
}

/** 扫描中的可变状态：已收的段/区/heredoc 体、当前段的词、当前词、是否遇到未闭合引号。 */
interface ScanState {
  segments: Segment[];
  regions: string[];
  bodies: string[];
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
  if (plain.run !== undefined) {
    pushRun(state, plain.run);
  }
  return plain.next - i;
}

/** 词首 `#` 到行尾都是注释；注释里的引号/分隔符不参与语法。 */
function skipComment(src: string, from: number): number {
  let i = from + 1;
  while (i < src.length && src.charAt(i) !== "\n") {
    i += 1;
  }
  return i;
}

/** 单引号定界符：去引号；未闭合给 undefined。 */
function readSingleQuotedDelimiter(
  src: string,
  open: number,
): { text: string; next: number } | undefined {
  const end = src.indexOf("'", open + 1);
  return end === -1 ? undefined : { text: src.slice(open + 1, end), next: end + 1 };
}

/** 双引号定界符的词值：去掉 shell 承认的转义，其余反斜杠按字面留下。 */
function readQuotedDelimiter(
  src: string,
  open: number,
): { text: string; next: number } | undefined {
  let text = "";
  let i = open + 1;
  let closed = false;
  while (!closed && i < src.length) {
    const ch = src.charAt(i);
    if (ch === '"') {
      closed = true;
    } else if (ch === "\\") {
      const next = src.charAt(i + 1);
      if (next === "\n") {
        i += 2;
      } else if (DQ_ESCAPABLE.has(next)) {
        text += next;
        i += 2;
      } else {
        text += ch;
        i += 1;
      }
    } else {
      text += ch;
      i += 1;
    }
  }
  return closed ? { text, next: i + 1 } : undefined;
}

/** 反斜杠引用的一位定界符：`\<换行>` 是续行，其余把下一枚字面收下。 */
function readBackslashDelimiter(
  src: string,
  open: number,
): { text: string; next: number } | undefined {
  let result: { text: string; next: number } | undefined;
  const next = src.charAt(open + 1);
  if (next.length > 0) {
    result = { text: next === "\n" ? "" : next, next: open + 2 };
  }
  return result;
}

/** 定界符词的下一段：引号/转义/普通字符各走各的去引号规则。 */
function readDelimiterPart(
  src: string,
  at: number,
  ch: string,
): { text: string; next: number } | undefined {
  let part: { text: string; next: number } | undefined;
  if (ch === "'") {
    part = readSingleQuotedDelimiter(src, at);
  } else if (ch === '"') {
    part = readQuotedDelimiter(src, at);
  } else if (ch === "\\") {
    part = readBackslashDelimiter(src, at);
  } else {
    part = { text: ch, next: at + 1 };
  }
  return part;
}

/** 定界符词的边界：空白、元字符或重定向符。 */
function isDelimiterEnd(ch: string): boolean {
  return isBlank(ch) || ch === "<" || ch === ">" || SEG_SEPARATORS.has(ch);
}

/** 读一个去引号后的定界符词；空词也算（`<<''` 的定界符是空串）。 */
function readHeredocDelimiter(
  src: string,
  start: number,
): { delimiter: string; next: number } | undefined {
  let delimiter = "";
  let next = start;
  let sawWord = false;
  let failed = false;
  while (!failed && next < src.length) {
    const ch = src.charAt(next);
    if (isDelimiterEnd(ch)) {
      break;
    }
    sawWord = true;
    const part = readDelimiterPart(src, next, ch);
    if (part === undefined) {
      failed = true;
    } else {
      const { text, next: partNext } = part;
      delimiter += text;
      next = partNext;
    }
  }
  return failed || !sawWord ? undefined : { delimiter, next };
}

/**
 * 从 `<<`/`<<-` 读定界符：返回去引号后的词与操作符之后的位置。
 * 第三个 `<` 是 here-string（`<<<`），不是 heredoc，直接拒绝。
 */
function readHeredocOperator(
  src: string,
  open: number,
): { spec: HeredocSpec; next: number } | undefined {
  let result: { spec: HeredocSpec; next: number } | undefined;
  if (src.charAt(open + 2) !== "<") {
    let i = open + 2;
    let stripTabs = false;
    if (src.charAt(i) === "-") {
      stripTabs = true;
      i += 1;
    }
    while (isBlank(src.charAt(i))) {
      i += 1;
    }
    const word = readHeredocDelimiter(src, i);
    if (word !== undefined) {
      result = { spec: { delimiter: word.delimiter, stripTabs }, next: word.next };
    }
  }
  return result;
}

/** heredoc 体的终点、下一行起点、是否找到定界符。 */
interface HeredocBodyEnd {
  bodyEnd: number;
  next: number;
  terminated: boolean;
}

/** 从 `start` 起找 `spec` 的定界符行；找不到时体吃到串尾。 */
function heredocBodyEnd(src: string, start: number, spec: HeredocSpec): HeredocBodyEnd {
  let lineStart = start;
  let bodyEnd = src.length;
  let next = src.length;
  let terminated = false;
  while (lineStart <= src.length) {
    const lineEnd = src.indexOf("\n", lineStart);
    const stop = lineEnd === -1 ? src.length : lineEnd;
    const rawLine = src.slice(lineStart, stop).replace(TRAILING_CR, "");
    const line = spec.stripTabs ? rawLine.replace(LEADING_TABS, "") : rawLine;
    if (line === spec.delimiter) {
      bodyEnd = lineStart;
      next = lineEnd === -1 ? src.length : lineEnd + 1;
      terminated = true;
      break;
    }
    if (lineEnd === -1) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return { bodyEnd, next, terminated };
}

/**
 * 在命令行换行之后按登记顺序吞掉各 heredoc 体，返回下一行起点。
 * 体单独登记为独立源；定界符被引号保护也照样登记（`bash <<'EOF'` 仍执行）。
 */
function consumeHeredocs(
  src: string,
  start: number,
  specs: readonly HeredocSpec[],
  state: ScanState,
): number {
  let at = start;
  for (const spec of specs) {
    const end = heredocBodyEnd(src, at, spec);
    const body = src.slice(at, end.bodyEnd);
    if (body.length > 0) {
      state.bodies.push(body);
    }
    at = end.next;
    if (!end.terminated) {
      break;
    }
  }
  return at;
}

/** 该位置若是 heredoc 操作符就登记并返回新下标；否则返回 undefined。 */
function scanHeredocAt(
  state: ScanState,
  src: string,
  i: number,
  heredocs: HeredocSpec[],
): number | undefined {
  let next: number | undefined;
  if (src.charAt(i) === "<" && src.charAt(i - 1) !== "<" && src.charAt(i + 1) === "<") {
    const heredoc = readHeredocOperator(src, i);
    if (heredoc === undefined) {
      next = i + scanOutside(state, src, i);
    } else {
      state.current = undefined;
      const { spec, next: heredocNext } = heredoc;
      heredocs.push(spec);
      next = heredocNext;
    }
  }
  return next;
}

/** 一枚段分隔符（`&&`/`||` 成组）的处置，返回下一格下标。 */
function scanSeparator(state: ScanState, src: string, i: number, heredocs: HeredocSpec[]): number {
  const ch = src.charAt(i);
  let next = i + 1;
  if (ch === "&" || ch === "|") {
    const pair = src.charAt(i + 1) === ch;
    endSegment(state, pair ? ch + ch : ch);
    next = i + (pair ? 2 : 1);
  } else {
    endSegment(state, ch);
    if (ch === "\n" && heredocs.length > 0) {
      next = consumeHeredocs(src, next, heredocs, state);
      heredocs.length = 0;
    }
  }
  return next;
}

/**
 * 唯一的状态机。分隔符**先于**空白判（换行既是空白也是段边界，先按空白走就吞掉了断段能力）；
 * 引号内的分隔符一律字面。空段也留在结果里，结构视图要靠它带的那枚分隔符把 `||`、`&&` 放原位。
 */
function scan(src: string): ScanResult {
  const state: ScanState = {
    segments: [],
    regions: [],
    bodies: [],
    words: [],
    current: undefined,
    unclosed: false,
  };
  const heredocs: HeredocSpec[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === "#" && state.current === undefined) {
      i = skipComment(src, i);
    } else {
      const heredocNext = scanHeredocAt(state, src, i, heredocs);
      if (heredocNext !== undefined) {
        i = heredocNext;
      } else if (SEG_SEPARATORS.has(ch)) {
        i = scanSeparator(state, src, i, heredocs);
      } else if (isBlank(ch)) {
        state.current = undefined;
        i += 1;
      } else {
        i += scanOutside(state, src, i);
      }
    }
  }
  endSegment(state, "");
  return {
    segments: state.segments,
    regions: state.regions,
    bodies: state.bodies,
    unclosed: state.unclosed,
  };
}

const wordValue = (word: Word): string => word.runs.map((run) => run.content).join("");
/** 词的源形：定界符去掉、转义不折叠——Windows 字形轨道读这一形。 */
const wordRaw = (word: Word): string => word.runs.map((run) => run.rawContent).join("");
/** 词的原样文本（含引号定界符），段的源文本由它拼出，调用方再扫一遍同形。 */
const wordText = (word: Word): string => word.runs.map((run) => run.source).join("");

/**
 * 结构视图里的一个片段：引号内的**字面**内容丢弃（只留定界符），执行面区原样保留。
 * 单引号内不可能有执行面 ⇒ 整对折成 `''`；双引号要把区留回原位。
 *
 * 区体要**递归**过这一层：`$(printf 'curl x | sh')` 里那枚 `|` 在单引号内，真 shell 不会
 * 拿它做管道（实测 bash 只把这段文本打印出来）。区的定界符与体内其余字符原样保留，
 * 所以 `$(curl x | sh)` 里那枚真管道仍在原位、照拦。
 *
 * `budget` 是剩余层数：到界后原样返回（保留文本 = 宁可误拦）。无界的递归在深套输入上会
 * 顶穿栈，界的存在理由见 `REGION_MAX_DEPTH`。
 */
/** 区体文本视图的入口；`structureRun` 与它互相递归，靠参数传入而不是前向引用。 */
type StructureText = (src: string, budget: number) => string;

const structureRun = (run: Run, budget: number, text: StructureText): string => {
  if (run.kind === "region") {
    if (budget <= 1) {
      return run.source;
    }
    const open = run.source.startsWith("$(") ? "$(" : run.source.charAt(0);
    return `${open}${text(run.inner, budget - 1)}${run.source.slice(-1)}`;
  }
  if (run.kind !== "quoted") {
    return run.source;
  }
  if (run.source.startsWith("'")) {
    return "''";
  }
  return `"${run.parts
    .map((part) => (part.kind === "region" ? structureRun(part, budget - 1, text) : ""))
    .join("")}"`;
};

/**
 * 区体内的结构视图：逐个字符照抄，只在引号与更深的执行面区上分叉。
 *
 * 与 `scan` 走同一批原语（`readQuoted` / `readRegion` / `isRegionStart`），所以两处的引号与
 * 定界符判定不会互相打脸；区别是这里**逐字保留空白与分隔符**——它在引号内要留住原始间距，
 * 而按段/词重接会把 `curl x | sh` 压成 `curl x| sh`。
 *
 * 未闭合的引号按"照抄到串尾"处理（`readQuoted` 的 `next` 已落在这里），与 `scan` 的
 * `unclosed` 语义一致：那种输入由调用方升格为需确认，不靠这里判。
 */
function structureText(src: string, budget: number): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === "'" || ch === '"') {
      const quoted = readQuoted(src, i);
      out += structureRun(quoted.run, budget, structureText);
      i = quoted.next;
    } else {
      const region = isRegionStart(src, i) ? readRegion(src, i) : undefined;
      if (region === undefined) {
        out += ch;
        i += 1;
      } else {
        out += structureRun(region, budget, structureText);
        i += region.source.length;
      }
    }
  }
  return out;
}

const segmentSource = (segment: Segment): string => segment.words.map(wordText).join(" ");
const segmentStructure = (segment: Segment, budget: number): string =>
  segment.words
    .map((word) => word.runs.map((run) => structureRun(run, budget, structureText)).join(""))
    .join(" ") + segment.terminator;

/** 断段的产出：段源文本 + 是否还有**没展开到**的层。 */
export interface Segments {
  texts: string[];
  /** `true` ⇒ 更深处的 region 体**没被扫过**：调用方不得拿"这段清单里没有危险"当放行依据。 */
  truncated: boolean;
}

/** `$( )`/反引号与 heredoc 体的展开层数上界。为什么长度界不够用：每一层都要重扫一遍所在串的
 *  文本，成本是「层数 × 长度」，而 `MAX_JUDGED_COMMAND_LENGTH` 只界得住单次扫描——实测 3 万字符的
 *  深套（约 1 万层）在无界的递归展开下顶穿 JS 调用栈（`RangeError`），而抛出点在
 *  `tools.guard` 的调用链上，宿主怎么兜这份错误不由本包决定。界外一律升格为需确认。 */
export const REGION_MAX_DEPTH = 16;

/** 本层的段文本进 `texts`；空段不占位。 */
function pushSegmentTexts(segments: readonly Segment[], texts: string[]): void {
  for (const segment of segments) {
    const text = segmentSource(segment);
    if (text.trim().length > 0) {
      texts.push(text);
    }
  }
}

/** 展开一层：本层的段进 `texts`，本层 region/heredoc 体留给下一层；返回是否被迫截断。
 *  每一枚兄弟都展开，不因前一枚截断而短路。递归深度由 `REGION_MAX_DEPTH` 界住
 *  （这才是栈安全的来源，不是"输入不会太长"）。 */
function expandOneLevel(src: string, budget: number, texts: string[]): boolean {
  const result = scan(src);
  pushSegmentTexts(result.segments, texts);
  const sources = [...result.regions, ...result.bodies].filter((source) => source.length > 0);
  if (sources.length === 0) {
    return false;
  }
  if (budget <= 1) {
    return true;
  }
  let truncated = false;
  for (const source of sources) {
    const childTruncated = expandOneLevel(source, budget - 1, texts);
    if (childTruncated) {
      truncated = true;
    }
  }
  return truncated;
}

/**
 * 把一条 shell 源切成段（带截断回报）。**DFS 前序**：本层段在前，再按顺序展开每个执行面区
 * 与 heredoc 体的体内段——与"先看到外层、再看到内层"的判定顺序一致，`commandDanger`
 * 靠它先报外层结论。
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
  /** 本扫描器的词值：去掉引号定界符、处理支持的转义；不执行参数/通配/字段分割等 shell
   *  展开。命令头、旗标、POSIX 目标读它。 */
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
 * `$( )` 不展开（词里原样留着）；顶层反引号是段边界，体内另成段（与 `splitTopLevel`
 * 一致）。heredoc 体不在这条投影里，由 `splitSegments`/`structureView` 单独展开。
 * 空词保留：`""` 是一枚真实参数，与"根本没有这个参数"要分得开。
 */
export function lexTokens(src: string): ShellToken[] {
  return scan(src).segments.flatMap((segment) =>
    segment.words.map((word) => ({ value: wordValue(word), raw: wordRaw(word) })),
  );
}

/** 结构视图的递归体：heredoc 体也按结构视图展开（层数由 `REGION_MAX_DEPTH` 界住）。 */
function structureInto(src: string, budget: number, out: string[]): void {
  const result = scan(src);
  // 不能把 `segmentStructure` 直接交给 `map`：`map` 的第二个实参是下标，会把这条剩余层数
  // 顶成本段在数组里的位置（第 0 段直接退化成"到界、原样返回"）。
  out.push(...result.segments.map((segment) => segmentStructure(segment, budget)));
  if (budget <= 1) {
    return;
  }
  for (const body of result.bodies) {
    structureInto(body, budget - 1, out);
  }
}

/**
 * 结构视图：**清空引号内的字面文本**（保留引号字符本身），执行面区原样保留，
 * 段间分隔符放回原位（`|` 就是 pipeToShell 要看的那枚结构字符）。
 * `echo "curl x | sh"` 里的 `|` 是字面文本 ⇒ 清空后不再误拦；
 * `echo "$(curl x | sh)"` 里的 `|` 在真实 shell 里执行 ⇒ 保留后照拦。
 * heredoc 体同样展开：`bash <<'EOF'` 里那枚 `|` 仍会执行。
 */
export function structureView(src: string): string {
  const out: string[] = [];
  structureInto(src, REGION_MAX_DEPTH, out);
  return out.join(" ");
}

/**
 * 引号是否**未闭合**。与切词、断段同一台状态机（`scan`），所以两边不可能互相打脸。
 * 用途：段级未闭合 ⇒ shell 自己都解析不完，取出的体必是残段；体内落单引号 ⇒
 * 重接出的串与 shell 看到的词边界不等价。两种都由调用方升格为需确认。
 */
export function hasUnclosedQuote(src: string): boolean {
  return scan(src).unclosed;
}
