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
// 注意：绑定识别是"出现即算绑定"的宽松启发式（见 isBoundField），假阳性只会让门禁
// 更宽松（不会假绿漏拦功能性缺失）；假阴性会立刻报错，故宁可宽不可严。

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

/** 从 `open` 处的左括号做深度匹配，返回配对右括号的下标；不闭合则 -1。 */
function matchingClose(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 抹掉行注释的**内容**（保留换行与列位），让括号深度匹配与字段抽取不被注释里的括号带偏。
 *  只认整行缩进后的 `//`（schema 块里的注释全是这种），因此不会误伤 `https://` 之类的值。 */
function stripLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*\/\//u.test(line) ? "" : line))
    .join("\n");
}

/** 引号字符集与括号字符集（Set 判定，避免一长串 `||` 把函数复杂度推爆）。 */
const QUOTES = new Set(['"', "'", "`"]);
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const IDENT_START = /^[A-Za-z_$]/u;
const IDENT = /^[A-Za-z_$][\w$]*/u;
const FIELD_VALUE = /^\s*:/u;

/** 引号内的一次推进：转义吞掉下一个字符。返回 `[步长, 是否正好闭合]`。 */
function stepInsideQuote(block: string, i: number, quote: string): readonly [number, boolean] {
  const step = block[i] === "\\" ? 2 : 1;
  return [step, block[i + step - 1] === quote] as const;
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
function topLevelFieldNames(block: string): string[] {
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

/** 从持有 schema 的源文件文本里抽取 `Schema.object({...})` 块内的字段名。
 *  ⚠ 字段名按**结构**取（见 topLevelFieldNames），不按值形态取。旧写法用一条按值形态的正则
 *  （`field: Schema.` / `field: volatile(Schema.`），于是链式换行的
 *  `field: Schema` + 换行 + `.array(String).default(…)` 整字段被静默跳过——本包实测漏掉
 *  extraDevServerWords / extraSecretPatterns / refSearchStrictTools 三项：卡片删掉这三处的
 *  控件门禁照样绿。注释里的 `Schema.object(` 由 stripLineComments 先行抹掉。 */
function hostSchemaFields(hostTs: string): string[] {
  const source = stripLineComments(hostTs);
  const start = source.indexOf(SCHEMA_MARKER);
  if (start === -1) {
    return [];
  }
  // 从 Schema.object( 的左括号起做深度匹配，取到对应右括号
  const open = source.indexOf("(", start);
  const end = open === -1 ? -1 : matchingClose(source, open);
  if (end === -1) {
    return [];
  }
  return topLevelFieldNames(unwrapObjectLiteral(source.slice(open + 1, end)));
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(src: string): Set<string> {
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(match.groups?.["field"] ?? "");
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由 declareSchemaCoverage 与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(match.groups?.["field"] ?? "");
  }
  return out;
}

/** 递归收集目录下所有 .ts 源文件文本（跳过 node_modules）。 */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  const tasks: Promise<string[]>[] = entries.map(async (entry) => {
    if (entry === "node_modules" || entry === "test") {
      return [];
    }
    const fullPath = path.join(dir, entry);
    let st;
    try {
      st = await stat(fullPath);
    } catch {
      return [];
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
async function clientBoundFields(pkgDir: string): Promise<Set<string>> {
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

/** 声明「卡片字段覆盖 host schema」门禁。 */
export async function declareSchemaCoverage(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): Promise<void> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgJson = await readFile(path.resolve(pkgDir, "package.json"), "utf8");
  const nameMatch = /"name":\s*"(?<name>[^"]+)"/u.exec(pkgJson);
  const pkgName = nameMatch?.groups?.["name"] ?? "unknown";
  // 找到**真正持有 schema** 的那个源文件（bulkhead 之后它未必是 host.ts）。
  // 三个候选一起读（无 await-in-loop），再按 SCHEMA_SOURCES 的顺序取第一个真有字段的。
  const candidateTexts = await Promise.all(
    SCHEMA_SOURCES.map((candidate) =>
      readFile(path.resolve(pkgDir, candidate), "utf8").catch(() => ""),
    ),
  );
  const bound = await clientBoundFields(pkgDir);
  let schemaFile = "";
  let hostFields: string[] = [];
  for (const [index, text] of candidateTexts.entries()) {
    const fields = hostSchemaFields(text);
    if (fields.length > 0) {
      schemaFile = SCHEMA_SOURCES[index] ?? "";
      hostFields = fields;
      break;
    }
  }
  const exemptions = new Map((opts.allowUnbound ?? []).map((entry) => [entry.field, entry.reason]));

  test(`${pkgName}: 卡片覆盖 host schema 全部字段（改 host 字段必须同步卡片或声明豁免）`, () => {
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
