// test/cross-platform.test.ts —— 跨平台不变式：**判据不许写死路径分隔符**。
//
// 为什么单列一份：本仓的路径判据（沙箱让路、检索作用域、项目根回落、层级链）都在**宿主真实
// 路径**上做前缀包含比较。写死 `/` 时这些判据在 POSIX 上照常绿、在 Windows 上**静默失效**——
// 而它们失效的方向是不安全的那个（`isAncestorDirOf` 恒假 ⇒ 把本该拦的灾难删除让给沙箱）。
//
// 本文件在**两种语义**下各跑一遍同一份判据：`path.win32` 的语义本机可用，于是不必等 Windows
// runner 就能证明"用平台分隔符的写法对、写死 `/` 的写法错"。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** 反斜杠：源码里直接写会让转义层数难读，故从码点造一枚。 */
const BS = String.fromCodePoint(92);

const winPath = (...parts: readonly string[]): string => path.win32.join(...parts);
const posixPath = (...parts: readonly string[]): string => path.posix.join(...parts);

/**
 * 判据本体：`candidate` 是否为 `target` 的祖先目录（含"补平台分隔符"这一步）。
 *
 * ⚠ 这里是**历史前缀实现的模型**（拼分隔符 + `startsWith`），不代表产品现在的判据：
 * 产品已改为 `lib/target-paths.ts` 的 `isInside`（用 `path.relative` 判越界，空串与 `..` 都单独处理）。
 * 所以本文件钉的是「同一份前缀逻辑在两种分隔符语义下的差异」，**不**能覆盖产品回归。
 * 仍保留的理由：这些用例独立写死了 POSIX 与 Windows 两种期望值，改动前是产品的同构模型。
 */
const isAncestorWith = (candidate: string, target: string, sep: string): boolean => {
  const last = candidate.at(-1);
  const prefix = last === "/" || last === BS ? candidate : `${candidate}${sep}`;
  return candidate !== target && target.startsWith(prefix);
};

describe("前缀包含判据：平台分隔符 vs 写死 '/'", () => {
  it("posix 语义：两种写法都得 true（本机跑的就是这一侧）", () => {
    const root = posixPath("/", "w");
    const child = posixPath("/", "w", "proj");
    assert.equal(isAncestorWith(root, child, path.posix.sep), true);
    assert.equal(child.startsWith(`${root}/`), true);
  });

  it("win32 语义：平台分隔符得 true，**写死 '/' 得 false**（这就是静默失效的机制）", () => {
    const root = winPath("C:", "w");
    const child = winPath("C:", "w", "proj");
    assert.equal(isAncestorWith(root, child, path.win32.sep), true);
    assert.equal(child.startsWith(`${root}/`), false, "写死 '/' 在 Windows 路径上恒假");
  });

  it("自身不是自己的祖先（两种语义一致）", () => {
    const posixDir = posixPath("/", "w");
    const winDir = winPath("C:", "w");
    assert.equal(isAncestorWith(posixDir, posixDir, path.posix.sep), false);
    assert.equal(isAncestorWith(winDir, winDir, path.win32.sep), false);
  });

  it("兄弟目录不算祖先（不能因为前缀相似就误判覆盖）", () => {
    assert.equal(
      isAncestorWith(winPath("C:", "w", "lib"), winPath("C:", "w", "test"), path.win32.sep),
      false,
    );
    assert.equal(
      isAncestorWith(posixPath("/", "w", "lib"), posixPath("/", "w", "test"), path.posix.sep),
      false,
    );
  });
});

/** 按给定语义自目标上溯到根（与产品实现的收敛条件同构）。
 *  放在模块作用域：它不捕获任何用例变量，写在 `describe` 里等于每次调用都重建一遍。 */
const chainOf = (start: string, dirname: (item: string) => string): readonly string[] => {
  const levels: string[] = [];
  let current = dirname(start);
  while (current !== dirname(current)) {
    levels.push(current);
    current = dirname(current);
  }
  levels.push(current);
  return levels;
};

describe("层级链：dirname 逐级上溯到文件系统根", () => {
  it("win32：能上溯到盘根，而不是在第一个 '/' 上截断成空串", () => {
    const start = winPath("C:", "w", "proj", "src", "a", "b", "mod.ts");
    const levels = chainOf(start, (item) => path.win32.dirname(item));
    assert.equal(levels.at(-1), `C:${BS}`, "收敛到盘根");
    assert.equal(levels[0], winPath("C:", "w", "proj", "src", "a", "b"), "目标所在目录打头");
    const lastSlash = start.lastIndexOf("/");
    const slashPrefixed = start.slice(0, Math.max(lastSlash, 0));
    assert.equal(slashPrefixed, "", "对照：写死 '/' 切出空串");
  });

  it("posix：同样上溯到 `/`", () => {
    const start = posixPath("/", "w", "proj", "src", "a", "mod.ts");
    const levels = chainOf(start, (item) => path.posix.dirname(item));
    assert.equal(levels.at(-1), "/");
  });
});

describe("家目录子路径拼接：词面的 '/' 不改变宿主的分隔符形状", () => {
  it("win32 家目录 + 子段 ⇒ 全反斜杠（`path.posix.join` 会拼出混分隔符）", () => {
    const home = winPath("C:", "Users", "runneradmin");
    assert.equal(path.win32.join(home, "Documents"), `${home}${BS}Documents`);
    assert.ok(
      path.posix.join(home, "Documents").includes("/"),
      "对照：posix.join 在 Windows 家目录上留下 '/'",
    );
  });
});

describe("防回归：仓库里不许再出现写死分隔符的前缀比较", () => {
  // 判据是**源码扫描**而不是跑一次某个函数：这一类缺陷的本性就是"在本机跑不出来"。
  // 只扫产品源码（lib/ 与 host.ts）：`lib/danger-rules.ts` **未列入扫描清单**（它按 posix 语义
  // 解析 shell 命令文本，不是宿主路径判据）；其余位置出现 `startsWith(..."/")` 形式就是漏改。
  // ⚠ 这是一份硬编码清单：新增带前缀比较的产品文件时必须评估是否入单。
  // `lib/target-paths.ts` 必须入单：`isInside` / `isAncestorDirOf` / `toPosixRelative` / `underLayer`
  // 这四个跨平台判据已从 host.ts 搬到那里，清单不跟着走就等于把最该扫的四个函数漏在扫描面之外。
  const PRODUCT = [
    "host.ts",
    "lib/confirm.ts",
    "lib/preflight-scan.ts",
    "lib/sandbox-scope.ts",
    "lib/target-paths.ts",
  ];

  /** 允许写死 `/` 的**唯一**一类：两枚入参都已经是 `toPosixRelative` 的产物（统一 `/` 形）。
   *
   *  `underLayer(rel, file)` 的两侧都由 `path.relative(...).split(path.sep).join("/")` 折过，
   *  于是这里的 `/` 不是"平台分隔符假设"，而是那个函数的**输出契约**。换成 `path.sep`
   *  反而会错——它拿 `/` 形的串去比 `\` 形的前缀。 */
  const ALLOWED_LINES = ["underLayer"];

  it("产品源码里做前缀包含比较时，补分隔符必须走平台 API", () => {
    const offenders: string[] = [];
    for (const file of PRODUCT) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      // 形如 `${x}/` 或 `${x}${"/"}` 直接拼在 startsWith 里的写法
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        const suspicious = line.includes("startsWith(") && /\$\{[^}]+\}\//u.test(line);
        // 该行所属函数的签名在上文几行里（本仓约定：函数注释在签名之前），按函数名判白名单。
        const context = lines.slice(Math.max(index - 3, 0), index).join(" ");
        const allowlisted = ALLOWED_LINES.some((name) => context.includes(name));
        if (suspicious && !allowlisted) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `这些位置的前缀比较写死了 '/'：\n${offenders.join("\n")}`);
  });
});

/** 注释行讲的就是这件事本身，不参与判定。 */
const isComment = (trimmed: string): boolean =>
  trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");

/** 形如 `"/w/…"` 的**代码**字面量（注释与行内说明不算）。 */
const POSIX_LITERAL = /["'`]\/(?:w|Users|home)\b/u;

/** 一个测试文件里所有把 `/w/` 当路径用的代码行。 */
const offencesOf = (name: string): string[] => {
  const text = readFileSync(new URL(`../test/${name}`, import.meta.url), "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((trimmed) => !isComment(trimmed) && POSIX_LITERAL.test(trimmed))
    .map((trimmed) => `${name}: ${trimmed}`);
};

describe("防回归：测试夹具不许把 POSIX 字面路径当宿主真实路径", () => {
  // 这一条防的正是"本机绿、Windows 红"那一整类：夹具写死 `/w/proj` 时，在 Windows 上它
  // 是「当前盘相对」（`isAbsolute` 判真但 root 只有分隔符），落点取决于进程当前盘，
  // 于是同一份断言在两种平台上测的不是同一个东西。
  //
  // 判据是**源码扫描**：`lib/danger-rules.ts` 这类纯字符串判据允许（它判的是 shell 命令
  // 文本，POSIX 语义正是被测对象），其余出现 `/w/` 字面量的位置得说得出理由。
  const ALLOWED = new Map([
    ["danger-rules.test.ts", "纯字符串判据：判的是 shell 命令文本，POSIX 语义即被测对象"],
    ["fact-gate.test.ts", "纯状态机：FactGate 不碰文件系统"],
    ["cross-platform.test.ts", "本文件自身要演示 POSIX 与 win32 的差异"],
    ["path-format.test.ts", "只演示 brand 的类型层约束：路径是字面量，不碰文件系统"],
    ["blast-radius.test.ts", "只拼预演命令的 cwd 参数，不碰文件系统（且不改写落点）"],
    [
      "sandbox-scope.test.ts",
      "纯字符串判据的输入（sandboxDropsOf 不碰文件系统）；它要的正是「按 pathApi 方言给串」",
    ],
  ]);

  it("只有白名单里的测试文件可以在代码里写 `/w/` 字面路径", () => {
    const files = readdirSync(new URL("../test", import.meta.url)).filter(
      (name) => name.endsWith(".test.ts") && !ALLOWED.has(name),
    );
    const offenders = files.flatMap((name) => offencesOf(name));
    assert.deepEqual(
      offenders,
      [],
      `这些行把 POSIX 字面路径当宿主路径（Windows 上落点会漂）：\n${offenders.join("\n")}`,
    );
  });
});

describe("路径工具本身：isAbsolute 与平台一致性", () => {
  it("windows 的 `/w/proj` 虽被 isAbsolute 认作绝对，却没有盘符（是「当前盘」相对形）", () => {
    assert.equal(path.win32.isAbsolute(winPath("C:", "w")), true);
    // ⚠ `path.win32.isAbsolute("/w/proj")` 实测是 **true**：win32 认「根相对」形态。
    // 但它解析出来没有盘符（root 是 `\`），落点取决于进程当前盘 ⇒ 不能当"宿主绝对路径"用。
    // 这正是测试夹具不能写死 `/w/proj` 的原因——判据得看 root 有没有盘符，不是只看 isAbsolute。
    assert.equal(path.win32.isAbsolute("/w/proj"), true, "win32 认根相对形态");
    // ⚠ 这里**不能**断言 `resolve("/w/proj")` 以反斜杠开头：它依赖宿主当前盘 ——
    // 在 macOS 上得 `\w\proj`，在 Windows 上得 `D:\w\proj`（补上 cwd 所在盘）。
    // 那种断言本身就是"平台相关"，正是本文件要消灭的东西。
    // 平台无关的判据是：**盘符形**才带盘符，根相对形不带。
    assert.equal(path.win32.parse("/w/proj").root, "/", "根相对形：root 只有分隔符");
    assert.equal(
      path.win32.parse(winPath("C:", "w")).root,
      `C:${String.fromCodePoint(92)}`,
      "盘符形：root 带盘符",
    );
    assert.equal(path.posix.isAbsolute("/w/proj"), true, "同一串在 POSIX 上是绝对形");
  });

  it("测试夹具必须按平台根构造绝对路径，不能写死 `/w/proj`", () => {
    const fixture = path.resolve(path.parse(process.cwd()).root, "w", "proj");
    assert.equal(path.isAbsolute(fixture), true, `夹具根必须是宿主绝对路径：${fixture}`);
  });
});
