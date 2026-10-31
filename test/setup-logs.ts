// test/setup-logs.ts —— 插件运行日志的账本（vitest setupFile）。
//
// 为什么不用 vitest 的 `silent`：那只是不显示，新飘出来的日志照样没人看。这里把「跑测不该有
// 算子日志漏进报告」变成一条可判的契约：
//   ① 每条 `[<pkg>]` 日志必须含有 test/log-templates.ts 里的某个模板片段，否则当场红；
//   ② 带别家标签的日志出现在本包测试里也红（装配范围错了）；
//   ③ 生产侧一行不改：级别、文案、时机全部照旧，账本只在测试进程里接管输出。
// 用例要看日志内容时用 logged()/loggedText() 取，断言写在用例里。
import { afterEach, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { format } from "node:util";

import { LOG_TEMPLATES } from "./log-templates.ts";

/** 包名派生标签前缀：`@scope/dsh-<name>` → `[<name>]`。
 *  硬编码会在包改名或把本文件复制到别的包时让 `ours`/`strangers` 同时为空，账本静默失效。 */
const PKG_PREFIX = ((): string => {
  const pkg = createRequire(import.meta.url)("../package.json") as { name?: unknown };
  const name = typeof pkg.name === "string" ? pkg.name.split("/").pop() : undefined;
  if (name === undefined || name.length === 0) {
    throw new Error("setup-logs：读不到 package.json 的 name，无法派生日志标签");
  }
  return `[${name.replace(/^dsh-/u, "")}]`;
})();

/** 模板片段的最短有效长度：空串 `includes("")` 恒真、极短高频词几乎认可任何日志。 */
const MIN_TEMPLATE_CHARS = 6;

// 模块初始化即校验模板集合：失校必须显式红，不能等某条日志碰巧不匹配才暴露。
assert.ok(LOG_TEMPLATES.length > 0, "LOG_TEMPLATES 不得为空");
for (const fragment of LOG_TEMPLATES) {
  assert.ok(
    fragment.trim().length >= MIN_TEMPLATE_CHARS,
    `日志模板片段过短（< ${String(MIN_TEMPLATE_CHARS)} 字符）：${JSON.stringify(fragment)}`,
  );
}

/** 插件会用到的四个 console 级别（联合类型取属性，避免以字符串索引 Console）。 */
export type LogLevel = "info" | "warn" | "error" | "log";
const LEVELS: readonly LogLevel[] = ["info", "warn", "error", "log"];

/** 一次接管到的调用：拼平的首参 + 其余实参（堆栈通常就藏在其余实参里）。 */
export interface LogRecord {
  level: LogLevel;
  text: string;
  extra: unknown[];
}

let records: LogRecord[] = [];
const originals = new Map<LogLevel, (...args: unknown[]) => void>();

/** 把一次 console 调用拼成一行文本：`util.format` 与 Node 真实输出同源（`%s`/`%d`/对象都能如实展开），
 *  且对 `Object.create(null)` 这类没有 `toString` 的原始负载不会抛（`String()` 会抛 TypeError）。 */
function formatArgs(args: readonly unknown[]): string {
  return format(...args).replaceAll(/\s+/gu, " ");
}

/** 接管一个级别：处理器单独成函数，别在 for 里现造闭包（no-loop-func 拦的就是这个）。 */
function spyLevel(level: LogLevel): void {
  originals.set(level, console[level]);
  console[level] = (...args: unknown[]) => {
    // extra 留的是「首参之外的其余实参」：堆栈通常就藏在其中，用例要能单独取出来断言。
    records.push({ level, text: formatArgs(args), extra: args.slice(1) });
  };
}

/** 接管四个级别。重复调用是幂等的：上一轮 uninstall 没跑到位时不能把 spy 当原始实现。 */
export function install(): void {
  for (const level of LEVELS) {
    if (!originals.has(level)) {
      spyLevel(level);
    }
  }
}

/** 还原并清空原始实现表。 */
export function uninstall(): void {
  for (const [level, fn] of originals) {
    console[level] = fn;
  }

  originals.clear();
}

function containsTemplate(text: string): boolean {
  return LOG_TEMPLATES.some((fragment) => text.includes(fragment));
}

/** 本包标签以外的 console 记录都算别家；完全没标签的记录同样在列。 */
export function strangerTextsOf(entries: readonly LogRecord[]): string[] {
  return entries
    .filter((record) => !record.text.startsWith(PKG_PREFIX))
    .map((record) => record.text.slice(0, 120));
}

/** 带本包标签、但没有模板片段认领的记录。 */
export function unclaimedTextsOf(entries: readonly LogRecord[]): string[] {
  return entries
    .filter((record) => record.text.startsWith(PKG_PREFIX))
    .filter((record) => !containsTemplate(record.text))
    .map((record) => record.text.slice(0, 120));
}

beforeEach(() => {
  records = [];
  install();
});

afterEach(() => {
  uninstall();
  const strangers = strangerTextsOf(records);
  const unclaimed = unclaimedTextsOf(records);

  assert.deepEqual(strangers, [], "本包测试里出现了别家插件的日志：装配范围错了");
  assert.deepEqual(
    unclaimed,
    [],
    "这些日志对不上本包源码里的任何模板片段：新增 console.* 没有用例认领，或消息是临时拼的",
  );
});

/** 本条用例产生的插件日志，按调用顺序。 */
export function logged(): readonly LogRecord[] {
  return records.filter((record) => record.text.startsWith(PKG_PREFIX));
}

/** 拼平的日志正文，便于 match 断言。 */
export function loggedText(): string {
  return logged()
    .map((record) => record.text)
    .join("\n");
}
