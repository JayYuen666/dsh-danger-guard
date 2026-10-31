// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：条目的 Config schema（0.1.7 起由 profile 条目 id 隐式注册为设置命名空间）声明 N 个
// 设置字段，client 卡片只渲染 M 个（M < N）→ 那 N-M 个字段用户无法从 UI 触及，只能改
// profile 行 config 或读源码。此处踩坑：quality-gate 的 `memoryFeedback`（功能性开关——
// host.ts 的 `if (cfg.memoryFeedback !== false)` 决定是否把门禁失败写入记忆库，且有专门测试）
// 在卡片漏项，两轮审查后才被发现。
//
// 做法：解析**持有 schema 的那个源文件**里 `Schema.object({...})` 块的字段名 + client 源码树
// （src/** + lib/**）实际绑定的字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给
// 理由——测试同时校验 allowUnbound 里的每一项确实未被绑定（防止"挂名豁免"绕过门禁）。
//
// ⚠ schema 住在哪儿：bulkhead（隔舱）把设置面拆成独立条目的包，严格 schema 不在 host.ts
//   而在 lib/settings-schema.ts（danger-guard 即如此）。旧实现只读 host.ts，读不到就把字段
//   集当空集 → 门禁**静默失效**（"0 个字段需要覆盖"永远绿）。现在按 SCHEMA_SOURCES 逐个找，
//   一个都找不到即判红：宁可误报也不开无门禁的口子。
//
// 用法（各包 test/build-client.test.ts 或独立 spec 顶部调用一次）：
//   declareSchemaCoverage(import.meta.url)
//   declareSchemaCoverage(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   })
//
// 注意：绑定识别是「出现即算绑定」的宽松启发式（见 boundFieldsIn）。误认（把非 UI 的
// 同名字面量当成绑定）会让门禁变宽，是这条启发式的已知代价；漏认（真实绑定没认出来）
// 会立刻报错，所以匹配面宁可宽不可严。注释与多词字符串先被抹掉，已知的非 UI 接收者
//（localStorage / Map / Set / cache 等）不计入绑定。

import { test } from "vitest";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** schema 可能的栖身处（按序找第一个含 `Schema.object(` 的文件）：
 *  单条目包 = host.ts；bulkhead 包 = lib/settings-schema.ts（或 settings-host.ts）。 */
const SCHEMA_SOURCES = ["host.ts", "settings-host.ts", "lib/settings-schema.ts"];

/** 字段块起点标记。 */
const SCHEMA_MARKER = "Schema.object(";

/** 从 `open` 处的左括号做深度匹配，返回配对右括号的下标；不闭合则 -1。
 *  字符串与注释整段跳过：默认值里的 `)`（`.default("a)")`）不能提前收口。 */

/** 引号字符集与括号字符集（Set 判定，避免一长串 `||` 把函数复杂度推爆）。 */
const QUOTES = new Set(['"', "'", "`"]);
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const IDENT_START = /^[A-Za-z_$]/u;
/** 整个字符串内容是不是一个裸字段名（决定它保留还是被抹成空格，见 stripCommentsAndStrings）。 */
const IDENT_ONLY = /^[A-Za-z_$][\w$]*$/u;
const IDENT = /^[A-Za-z_$][\w$]*/u;
const FIELD_VALUE = /^\s*:/u;

/** 引号内的一次推进：转义吞掉下一个字符。返回 `[步长, 是否正好闭合]`。
 *  闭合判据看的是**被吞掉之后**那一枚字符：`"a \" b"` 里 `\` 吞掉的是转义引号本身，
 *  `block[i + step - 1]` 正好是那枚 `"`，于是整串被判成闭合、后面的字段全被漏计
 *  （漏计 = 门禁静默失效，正是本文件要防的那类错）。 */
function stepInsideQuote(block: string, i: number, quote: string): readonly [number, boolean] {
  if (block[i] === "\\") {
    // 转义把下一枚字符一起吞掉：被吞掉的那枚就算长得像引号，也是内容而不是闭合。
    return [2, false];
  }
  return [1, block[i] === quote];
}

/** 注释起始 → 跳过后应推进的步长；不是注释则 0。
 *  跳过时**不动**"下一处是不是字段位"的判断——否则 `a: X(), // 说明` 之后的 `b:` 会被
 *  判成不在字段位而漏计（漏计 = 门禁静默失效，正是本文件要防的那类错）。 */
function commentSkip(block: string, i: number): number {
  const next = block[i + 1];
  if (block[i] !== "/" || (next !== "/" && next !== "*")) {
    return 0;
  }
  const lineOnly = next === "/";
  const stop = block.indexOf(lineOnly ? "\n" : "*/", i + 2);
  if (stop === -1) {
    return block.length - i;
  }
  return lineOnly ? stop - i : stop - i + 2;
}

/** 结构扫描的光标：括号深度与当前引号（`""` = 引号外）。 */
interface Cursor {
  depth: number;
  quote: string;
}

/** 引号内推进；闭合时清空引号。返回步长。 */
function stepInside(cursor: Cursor, source: string, i: number): number {
  const [step, closed] = stepInsideQuote(source, i, cursor.quote);
  if (closed) {
    cursor.quote = "";
  }
  return step;
}

/** 引号外一步：注释整段跳过，引号与括号改光标。
 *  `trackDepth` 为 false 时只跟踪引号/注释（找 marker 用，不关心括号）。 */
function stepStructure(
  cursor: Cursor,
  source: string,
  i: number,
  trackDepth: boolean,
): { step: number; closeBracket: boolean } {
  const skipped = commentSkip(source, i);
  if (skipped > 0) {
    return { step: skipped, closeBracket: false };
  }
  const ch = source[i] ?? "";
  if (QUOTES.has(ch)) {
    cursor.quote = ch;
  } else if (trackDepth && ch === "(") {
    cursor.depth += 1;
  } else if (trackDepth && ch === ")") {
    cursor.depth -= 1;
    return { step: 1, closeBracket: cursor.depth === 0 };
  }
  return { step: 1, closeBracket: false };
}

/** 从 `open` 处的左括号做深度匹配，返回配对右括号的下标；不闭合则 -1。
 *  字符串与注释整段跳过：默认值里的 `)`（`.default("a)")`）不能提前收口。 */
function matchingClose(source: string, open: number): number {
  const cursor: Cursor = { depth: 0, quote: "" };
  let i = open;
  while (i < source.length) {
    if (cursor.quote === "") {
      const { step, closeBracket } = stepStructure(cursor, source, i, true);
      if (closeBracket) {
        return i;
      }
      i += step;
    } else {
      i += stepInside(cursor, source, i);
    }
  }
  return -1;
}

/** 扫描状态（`topLevelFieldNames` 的游标旁挂状态；抽步函数后仍是同一份，不改判定语义）。 */
interface ScanState {
  /** 括号深度：非 0 即嵌套层内部，不做字段判定。 */
  depth: number;
  /** 当前所在引号字符（`""` = 在引号外）。 */
  quote: string;
  /** 下一处是否落在"顶层 `,` 之后的字段位"。 */
  expectKey: boolean;
}

/** 引号外一个位置的推进：注释段整段跳过 → 引号 / 括号 / 嵌套层 / `,` / 空白 → 标识符
 *  （顶层字段名候选，命中即 push 进 `out`）。返回该位置的步长；状态改在 `state` 上。
 *  ⚠ 分支顺序 = 抽前的判定顺序，逐条同形，别按"更好读"重排。 */
function advanceOutsideQuote(block: string, i: number, state: ScanState, out: string[]): number {
  const skip = commentSkip(block, i);
  if (skip > 0) {
    return skip;
  }
  const ch = block[i] ?? "";
  if (QUOTES.has(ch)) {
    state.quote = ch;
    state.expectKey = false;
  } else if (OPENERS.has(ch)) {
    state.depth += 1;
    state.expectKey = false;
  } else if (CLOSERS.has(ch)) {
    state.depth -= 1;
    state.expectKey = false;
  } else if (state.depth !== 0) {
    // 嵌套层内部（数组默认值、链式调用的括号…）：一律不做字段判定。
  } else if (ch === ",") {
    state.expectKey = true;
  } else if (/\s/u.test(ch)) {
    // 空白/换行不改变"下一处仍在字段位"——链式换行的 `field: Schema` + 换行 + `.array(…)`
    // 就靠这一步保住（旧正则在这里把整条字段直接漏掉）。
  } else if (IDENT_START.test(ch)) {
    const word = IDENT.exec(block.slice(i))?.[0] ?? "";
    if (state.expectKey && FIELD_VALUE.test(block.slice(i + word.length))) {
      out.push(word);
    }
    state.expectKey = false;
    return word.length;
  } else {
    state.expectKey = false;
  }
  return 1;
}

/** 取一段对象字面量文本里**顶层**（括号深度 0）的 `字段名:`。
 *  与值怎么写、换不换行、有没有注释都无关；嵌套 object 的键在深度 ≥1 处，天然排除。
 *  「字段名」还要求出现在顶层 `,` 之后（中间只允许空白或注释）——三元表达式
 *  `a ? b : c` 里 `b` 后面也有冒号，光看形状会把它当成字段。
 *  ⚠ 本文件在全包 lint 的扫描范围内：不用 `continue`（no-continue），每轮走统一步长。 */
export function topLevelFieldNames(block: string): string[] {
  const out: string[] = [];
  const state: ScanState = { depth: 0, quote: "", expectKey: true };
  let i = 0;
  while (i < block.length) {
    let step: number;
    if (state.quote === "") {
      step = advanceOutsideQuote(block, i, state, out);
    } else {
      // 字符串字面量内部：只有转义能吞掉下一个引号（schema 值里没有正则字面量）。
      const [quotedStep, closed] = stepInsideQuote(block, i, state.quote);
      step = quotedStep;
      if (closed) {
        state.quote = "";
      }
    }
    i += step;
  }
  return out;
}

/** `Schema.object({…})` 实参外面那层 `{…}` 剥掉：不剥的话字段全在深度 1，
 *  顶层判定一个都取不到（与本门禁此前一次静默失效同一类错法）。 */
function unwrapObjectLiteral(block: string): string {
  const body = block.trim();
  if (!body.startsWith("{")) {
    return body;
  }
  const close = body.lastIndexOf("}");
  return close === -1 ? body.slice(1) : body.slice(1, close);
}

/** 一次 schema 解析的结果：没有 marker、marker 存在但括号不闭合、或解析出的字段。
 *  `malformed` 与 `none` 必须分开：把解析失败当成"这个文件没有 schema"会让门禁
 *  静默改用另一个字段更少的候选文件。 */
export type SchemaParse =
  | { readonly kind: "none" }
  | { readonly kind: "malformed" }
  | { readonly kind: "fields"; readonly fields: readonly string[] };

/** 从持有 schema 的源文件文本里抽取 `Schema.object({...})` 块内的字段名。
 *  注释与字符串里的 marker / 括号不参与结构；同一文件里有多段 `Schema.object` 时合并字段
 *  （漏计一个块就是假绿，多计只会多要求一张控件，方向保守）。
 *
 *  ⚠ 字段名按**结构**取（见 topLevelFieldNames），不按值形态取。旧写法用一条按值形态的正则
 *  （`field: Schema.` / `field: volatile(Schema.`），于是链式换行的
 *  `field: Schema` + 换行 + `.array(String).default(…)` 整字段被静默跳过——本包实测漏掉
 *  extraDevServerWords / extraSecretPatterns / refSearchStrictTools 三项：卡片删掉这三处的
 *  控件门禁照样绿。 */
export function hostSchemaFields(hostTs: string): SchemaParse {
  const fields: string[] = [];
  const cursor: Cursor = { depth: 0, quote: "" };
  let markers = 0;
  let i = 0;
  while (i < hostTs.length) {
    if (cursor.quote === "") {
      if (hostTs.startsWith(SCHEMA_MARKER, i)) {
        markers += 1;
        const open = i + SCHEMA_MARKER.length - 1;
        const end = matchingClose(hostTs, open);
        if (end === -1) {
          return { kind: "malformed" };
        }
        const literal = unwrapObjectLiteral(hostTs.slice(open + 1, end));
        fields.push(...topLevelFieldNames(literal));
        // 跳过整块：块内嵌套的 Schema.object 属于值，不是另一个设置 schema。
        i = end + 1;
      } else {
        const { step } = stepStructure(cursor, hostTs, i, false);
        i += step;
      }
    } else {
      i += stepInside(cursor, hostTs, i);
    }
  }
  return markers === 0 ? { kind: "none" } : { kind: "fields", fields };
}

/** 把**注释**抹成空格，并把「看起来不像字段名」的字符串内容也抹掉。
 *
 *  两件事分开做，因为要识别的字段名字面量**自己就在字符串里**（`set("x")`）：
 *  注释里写过的 `set('legacy')` 一定不是调用（整条抹掉）；而字符串只在内容
 *  **不是一个裸标识符**时才抹 —— 提示文案里引用的 `set('ghost')` 是多词句子，
 *  抹掉；`set("realField")`、`field: 'fieldPropField'` 是单个标识符，保留。
 *  把它们算进来等于给这些字段一张免检证：门禁的假阴性方向被收窄，
 *  `allowUnbound` 的反向校验也不会再把它们判成「已绑定」而逼人删掉正当豁免。 */
/** `/` 出现在表达式起始位置时按正则字面量读（`const re = /…/`）。
 *  只看前一非空白字符：这些位置后面不可能接除法。 */
function startsRegex(out: string): boolean {
  const trimmed = out.trimEnd();
  if (trimmed === "") {
    return true;
  }
  return "([{,;:=!&|?+-*%~^<>".includes(trimmed.at(-1) ?? "");
}

/** 正则字面量的结束下标（含 flags）；不是正则（未闭合/跨行）时交回 -1。 */
function regexEnd(src: string, start: number): number {
  let inClass = false;
  let index = start + 1;
  while (index < src.length) {
    const ch = src[index] ?? "";
    if (ch === "\n" || ch === "\r") {
      return -1;
    }
    if (ch === "\\") {
      index += 2;
    } else if (ch === "[") {
      inClass = true;
      index += 1;
    } else if (ch === "]") {
      inClass = false;
      index += 1;
    } else if (ch === "/" && !inClass) {
      index += 1;
      while (index < src.length && /[a-z]/iu.test(src[index] ?? "")) {
        index += 1;
      }
      return index;
    } else {
      index += 1;
    }
  }
  return -1;
}

/** 字符串外的一步：注释与正则整段抹成空格，引号开串，其余原样前进。 */
function stepOutsideString(
  src: string,
  start: number,
  out: string,
): { step: number; text: string; quote: string } {
  const skipped = commentSkip(src, start);
  if (skipped > 0) {
    return { step: skipped, text: " ".repeat(skipped), quote: "" };
  }
  const ch = src[start] ?? "";
  // 正则字面量里的 `set("x")` 不是调用：整段抹掉（否则幽灵字段会被算成已绑定）。
  if (ch === "/" && startsRegex(out)) {
    const end = regexEnd(src, start);
    return end === -1
      ? { step: 1, text: ch, quote: "" }
      : { step: end - start, text: " ".repeat(end - start), quote: "" };
  }
  return QUOTES.has(ch) ? { step: 1, text: ch, quote: ch } : { step: 1, text: ch, quote: "" };
}

/** 字符串内的一步：转义对吞两枚（内容记作两个空格），闭合引号收尾，其余进内容缓冲。 */
function stepInString(
  src: string,
  start: number,
  quote: string,
): { step: number; content: string; closed: boolean } {
  const ch = src[start] ?? "";
  if (ch === "\\") {
    return { step: 2, content: "  ", closed: false };
  }
  if (ch === quote) {
    return { step: 1, content: "", closed: true };
  }
  return { step: 1, content: ch, closed: false };
}

function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  let quote = "";
  let content = "";
  const flushContent = (): void => {
    out += IDENT_ONLY.test(content) ? content : " ".repeat(content.length);
    content = "";
  };
  while (i < src.length) {
    if (quote === "") {
      const { step, text, quote: opened } = stepOutsideString(src, i, out);
      out += text;
      i += step;
      quote = opened;
    } else {
      const step = stepInString(src, i, quote);
      content += step.content;
      if (step.closed) {
        flushContent();
        out += quote;
        quote = "";
      }
      i += step.step;
    }
  }
  return out;
}

/** 已知的非 UI 接收者：这些对象上的 set/unset 与设置字段无关。 */
const NON_UI_RECEIVER = /\b(?:localStorage|sessionStorage|Map|Set|WeakMap|WeakSet|cache)\s*\.\s*$/u;

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
export function boundFieldsIn(src: string): Set<string> {
  const out = new Set<string>();
  // 注释与字符串内容先抹掉再匹配：字段名字面量本身在引号里，引号被保留所以仍能命中。
  const code = stripCommentsAndStrings(src);
  // 输入行组件的 field prop：field: 'x'
  for (const match of code.matchAll(/\bfield\s*:\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(match.groups?.["field"] ?? "");
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。已知不属于设置面的接收者单独排除。
  for (const match of code.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    const receiver = code.slice(0, match.index);
    if (!NON_UI_RECEIVER.test(receiver)) {
      out.add(match.groups?.["field"] ?? "");
    }
  }
  return out;
}

/** 目录遍历要跳过的目录名：产物与测试面都不该被当成卡片源码。 */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "test", "tests", "__tests__"]);
/** 测试文件后缀：`src/**` 下也可能有，按文件排除。 */
const TEST_FILE = /\.(?:test|spec)\.ts$/u;

/** 读一个候选文件；不存在时交回空串，其它 IO 失败照常抛出（权限问题不能被吞成"没有 schema"）。 */
async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/** 递归收集目录下所有 .ts 源文件文本（跳过产物与测试面）。
 *  只有 ENOENT 算"这个目录不存在"；其余读盘失败必须冒出去，不能被当成空集合。 */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return out;
    }
    throw error;
  }
  const tasks: Promise<string[]>[] = entries.map(async (entry) => {
    if (SKIP_DIRS.has(entry) || TEST_FILE.test(entry)) {
      return [];
    }
    const fullPath = path.join(dir, entry);
    let st;
    try {
      st = await stat(fullPath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
    if (st.isDirectory()) {
      return walk(fullPath);
    }
    if (entry.endsWith(".ts")) {
      const text = await readFile(fullPath, "utf8");
      return [text];
    }
    return [];
  });
  const results = await Promise.all(tasks);
  for (const result of results) {
    out.push(...result);
  }
  return out;
}

/** client 侧实际绑定的字段名集合（src/** + lib/** + client-entry 同级单文件）。 */
export async function clientBoundFields(pkgDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const sources = [
    ...(await walk(path.join(pkgDir, "src"))),
    ...(await walk(path.join(pkgDir, "lib"))),
  ];
  for (const src of sources) {
    for (const field of boundFieldsIn(src)) {
      out.add(field);
    }
  }
  return out;
}

/** 声明「卡片字段覆盖 host schema」门禁。
 *  `test()` 在任何 I/O 之前调用：读不到 package.json、候选文件解析失败都会变成一条红的
 *  用例，而不是让收集阶段 reject、该文件一条用例都不注册。函数的 async 只为让调用方与
 *  其他门禁用同一种 `await` 写法，注册在返回 Promise 之前已经完成。 */
export async function declareSchemaCoverage(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): Promise<void> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgDirName = path.basename(pkgDir);
  const exemptions = new Map((opts.allowUnbound ?? []).map((entry) => [entry.field, entry.reason]));

  test(`${pkgDirName}: 卡片覆盖 host schema 全部字段（改 host 字段必须同步卡片或声明豁免）`, async () => {
    const pkgJson = await readFile(path.resolve(pkgDir, "package.json"), "utf8");
    const nameMatch = /"name":\s*"(?<name>[^"]+)"/u.exec(pkgJson);
    const pkgName = nameMatch?.groups?.["name"] ?? pkgDirName;
    // 找到**真正持有 schema** 的那个源文件（bulkhead 之后它未必是 host.ts）。
    // 三个候选一起读（无 await-in-loop），再按 SCHEMA_SOURCES 的顺序取第一个真有字段的。
    const candidateTexts = await Promise.all(
      SCHEMA_SOURCES.map((candidate) => readOptional(path.resolve(pkgDir, candidate))),
    );
    const bound = await clientBoundFields(pkgDir);
    const candidates = candidateTexts.map((text, index) => ({
      file: SCHEMA_SOURCES[index] ?? "",
      parsed: hostSchemaFields(text),
    }));
    const firstWithMarker = candidates.find((entry) => entry.parsed.kind !== "none");
    if (firstWithMarker?.parsed.kind === "malformed") {
      throw new Error(
        `[${pkgName}] ${firstWithMarker.file} 里的 Schema.object( 括号不闭合，门禁无法解析`,
      );
    }
    let schemaFile = "";
    let hostFields: string[] = [];
    if (firstWithMarker?.parsed.kind === "fields") {
      if (firstWithMarker.parsed.fields.length === 0) {
        throw new Error(
          `[${pkgName}] ${firstWithMarker.file} 里有 Schema.object 但解析出 0 个字段`,
        );
      }
      schemaFile = firstWithMarker.file;
      hostFields = [...firstWithMarker.parsed.fields];
    }

    assert.ok(
      hostFields.length > 0,
      `在 ${SCHEMA_SOURCES.join(" / ")} 里都没找到 Schema.object 字段` +
        `（解析失败、或本包确无设置项 → 那就不该再声明本门禁）`,
    );
    const missing = hostFields.filter((field) => !bound.has(field));
    const unexempted = missing.filter((field) => !exemptions.has(field));
    assert.deepEqual(
      unexempted,
      [],
      `[${pkgName}] 以下设置字段卡片未暴露：${unexempted.join(", ")}\n` +
        `字段全集来自：${schemaFile}\n` +
        `host 字段全集：${hostFields.join(", ")}\n` +
        `卡片已绑定：${[...bound].join(", ")}\n` +
        `→ 补卡片控件；若确实不该有 UI 入口，在 declareSchemaCoverage 的 allowUnbound 里\n` +
        `  显式声明 { field, reason }（测试会校验被豁免项确实未绑定，防止挂名豁免）。`,
    );
    // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
    const stale = [...exemptions].filter(([field]) => bound.has(field));
    assert.deepEqual(
      stale,
      [],
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
    // 豁免必须有理由，否则等于无门禁。
    const noReason = [...exemptions].filter(
      ([, reason]) => typeof reason !== "string" || reason.trim().length === 0,
    );
    assert.deepEqual(
      noReason,
      [],
      `[${pkgName}] allowUnbound 项缺少 reason：${noReason.map(([field]) => field).join(", ")}`,
    );
  });
}
