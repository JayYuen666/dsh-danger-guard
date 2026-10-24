// decorator-transform.mjs —— **装饰器预转换**（构建与测试两条管线共用这一份）。
//
// 为什么需要它（每一步都实测过）：
//  1. 官方 Typert Remote **只能用标准装饰器（TC39）声明**：`remoteMethods()` 只读 `@Remote`
//     写在原型上的那个描述符，没有程序化替代；而 `Remote` 的实现对 legacy 签名**直接抛**
//     （`context === undefined` 那条分支 + `context.addInitializer`），所以 legacy 降级也不行。
//  2. 本仓的两条管线的解析器**都不降级标准装饰器**：rolldown/oxc 的 `DecoratorOptions` 只有
//     `legacy` / `emitDecoratorMetadata` 两个开关（"predates the TC39 standardization process"），
//     实测它把 `@Remote("stats")` **原样吐进产物** —— 那是一段**非法 JS**，插件在宿主里会
//     直接加载失败，而**构建报成功**。
//  3. 进程内的替代入口也没有：本仓 TS 是 **7.0.2**（原生重写版），它的 JS 面上只有 `version`
//     （`transpileModule === undefined`）。上游 dsh 靠 `ts.transpileModule` 是因为它用 TS 6。
//  4. 剩下的可行入口是 **`tsc` CLI 本身**（它就是那个编译器）：实测它对标准装饰器产出完整的
//     `__esDecorate(this, null, _stats_decorators, { kind: "method", … })` —— 正是 `Remote` 要的签名。
//
// 所以本模块跑一次 `tsc`，把**单个**带装饰器的文件编译成 JS 交给管线。
//
// ⚠ `--noResolve` 不是可选项：不加它 tsc 会**顺着 import 把整张图都编译一遍**（实测吐出了
// `danger-rules.js` 等一串），而复用它的产物等于让管线吃两份源码。带上它之后 tsc 只编这一个
// 文件，且**说明符逐字保留**（`from "./judge-stats.ts"` —— 管线的 `.ts` 解析照常）。
// 代价是它对每个 import 报一条 TS2307（"找不到模块"）：那是 `--noResolve` 的必然产物而不是
// 错误信号，所以这里**不看退出码**，只认"产物文件真的出来了"。真出错时那条路会由产物加载
// 门禁（`test/artifact-loads.test.ts`）与测试管线各自当场炸掉，不会静默。
//
// ⚠ 这一步是**同步**的（`execFileSync`）且输出丢弃（`stdio: "ignore"`）：构建与测试的日志必须
// 干净 —— 上面那条"必然的 TS2307"绝不该出现在任何人的终端里（`--noResolve` 的报错正是我们
// 主动选择的行为，不是待修的问题）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 带装饰器的 TS 源形状（本仓只有 `lib/stats-remote.ts` 命中）。
 *  它是"要不要跑一次 tsc"的**快速门槛**——绝大多数文件不该付这个子进程。
 *
 *  判据是「`@` 前面是空白或结构位置」，不是「`@` 在行首」：合法写法里有
 *  `class X { @Remote("stats") m() {} }`、`export default @dec class {}`、
 *  `const C = @dec class {}` 这些内联形态，行首锚定会把它们全部漏掉 —— 漏掉的后果是
 *  含装饰器的原文直接进管线（正是文件头说的「产物是非法 JS、构建却报成功」）。
 *  反向的误判（字符串里出现 `@foo`）只多跑一次 tsc，不会产出错东西，所以这一侧不必收紧。 */
const DECORATOR_SYNTAX = /(?:^|[\s{;(,])@[A-Za-z_$][\w$]*/u;

/** 这个文件需要预转换吗（后缀与装饰器形状两道筛）。 */
export function needsDecoratorLowering(id, code) {
  return /\.[cm]?ts$/u.test(id) && DECORATOR_SYNTAX.test(code);
}

/** `tsc` 的入口（本仓 devDependency；用绝对路径而不靠 PATH，免得受调用方环境影响）。 */
const TSC_BIN = path.resolve(import.meta.dirname, "node_modules/typescript/bin/tsc");

/**
 * 源文件后缀 → tsc 为它产出的 JS 后缀。
 *
 * 门槛接受 `.mts` / `.cts`，而 tsc 对它们的产物是 `.mjs` / `.cjs`（不是 `.js`）。
 * 把后缀写死成 `.js` 时，这两种输入会去读一个不存在的文件，栈里只有一句 ENOENT。
 * @param {string} file - 源文件路径
 * @returns {string} 产物后缀
 */
function emittedExtensionOf(file) {
  if (file.endsWith(".mts")) {
    return ".mjs";
  }
  return file.endsWith(".cts") ? ".cjs" : ".js";
}

/**
 * 清理 tsc 注入的装饰器管线：删掉那行**永不生效**的 metadata 发布，并给注入的调用包一层
 * 覆盖率忽略。两件事都是为了让四项 100% 的门禁只盯**我们手写的代码**。
 *
 * ① **metadata 发布**：降级产物里有
 *    `if (_metadata) Object.defineProperty(this, Symbol.metadata, { … });`，
 *    而 `_metadata` 来自 `typeof Symbol === "function" && Symbol.metadata ? … : void 0`。
 *    实测运行期 `typeof Symbol.metadata === "undefined"`（Node 26），所以那个 `if` 的真臂
 *    永远不走 —— 而它的源位置压在**我们那枚类声明**上，覆盖率就会盯着一个不可能为真的分支红。
 *    删掉它是安全的：官方 `Remote` 只往原型上写一枚方法描述符，**从不读 `context.metadata`**
 *    （packages/typert/protocol/src/index.ts 的 `addMarkerInitializer`）。
 *    同一行的 `_metadata` 定义与 `__esDecorate(…, { metadata: _metadata }, …)` 都保留原样
 *    —— 删的只是"把它挂到 `Symbol.metadata` 上"这一步。
 * ② **注入的调用**（类静态块里的 `__esDecorate(…)`、构造器里的 `__runInitializers(…)`）：
 *    前者的上下文里带 TC39 为方法规定的 `access: { has: …, get: … }` 两枚箭头（官方实现同样
 *    不读 `context.access`），后者对本类（没有实例字段初值）是纯噪音 —— 它们的源位置又恰好
 *    压在我们的类/构造器那两行上。给这两行套上本仓既有的「v8 ignore」提示
 *    （同 lib/tool-ledger.ts 的口径：不可达或非本手写的臂要留痕）。
 *
 * ⚠ 提示落在**转换产物**里而不是源码里：这些代码是编译器生成的，理由也就该跟生成它的地方放在
 * 一起。而它只加给**测试管线**（`coverageHints`）：minifier 实测会把这几个注释原样留在产物里
 * （它认不出这是覆盖率提示），而产物里没有任何人在量覆盖率 —— 那份字节不值得发出去。
 * ⚠ 只做**锚点明确的替换**：锚点对不上就原样返回（宁可让覆盖率当场红一次，也不猜着切文件）。
 * @param {string} code - tsc 产物
 * @param {boolean} coverageHints - 给注入的调用加 v8 忽略提示（只有测试管线要）
 * @returns {string} 清理后的产物
 */
function pruneInjectedPlumbing(code, coverageHints, mapLines) {
  // 目标是**任意标识符**，不是固定写 `this`：tsc 按装饰器落点给出不同的接收者 ——
  // 方法装饰器写 `this`（见 lib/stats-remote.ts 的产物），类装饰器或静态成员写 `_classThis`，
  // 派生类写 `_classSuper` 一类临时名。写死 `this` 时只有方法那一支被裁掉，类/静态成员那一支
  // 的发布句会原样留下 —— 而它同样"永不生效"，且会让"删了哪些行"随装饰器位置而变。
  const metadataLine =
    /^\s*if \(_metadata\) Object\.defineProperty\([A-Za-z_$][\w$]*, Symbol\.metadata,/u;
  const SOURCE_MAP_MARK = "//# sourceMappingURL=";
  const out = [];
  // 两件事一起做，并且都**不动行号**：
  //  ① 删掉永不生效的 metadata 发布与文件尾的 sourceMappingURL 注释 —— 用空行占位，
  //    删行会让其后每一行的源映射错位。
  //  ② 把 tsc 注入的两处调用（`__esDecorate` / `__runInitializers`）在映射里"摘掉"——
  //     它们没有对应的源位置，映射项置空之后覆盖率归因自然不看它们，也就不必再往产物里
  //     插 `/* v8 ignore *\/` 提示（提示必须独占一行，那才是行号错位的来源）。
  // 行数始终与 tsc 产物一致，映射逐行对应，不存在"插入位置算错几格"这一类错位。
  //
  // ⚠ 删行按**整条语句**判，不按前缀判：tsc 若哪天把这条 `if` 打成多行，删掉首行会留下
  // 孤立的对象字面量残片 —— 产物直接语法错误，而错误位置指向转换器而不是 tsc。所以匹配到
  // 的行必须以 `);` 收尾，否则当场抛错（宁可炸在构建里，也不发一份非法 JS）。
  const mapped = [];
  let cursor = 0;
  for (const line of code.split("\n")) {
    const sourceMapping = mapLines?.[cursor] ?? "";
    cursor += 1;
    if (metadataLine.test(line) && !line.trimEnd().endsWith(");")) {
      throw new Error(
        `danger-guard: Symbol.metadata 发布语句不是单行（${line.trim().slice(0, 80)}…）：按行裁剪会留下残片，产物会是非法 JS。`,
      );
    }
    if (metadataLine.test(line) || line.startsWith(SOURCE_MAP_MARK)) {
      out.push("");
      mapped.push("");
      continue;
    }
    if (coverageHints && (line.includes("__esDecorate(") || line.includes("__runInitializers("))) {
      out.push(line);
      mapped.push("");
      continue;
    }
    out.push(line);
    mapped.push(sourceMapping);
  }
  // 一条都没匹配上是**允许**的：门槛是"可能是装饰器"的快速筛，字符串里出现 ` @word`
  // 这类误报会白白跑一次 tsc，产物原样返回。真出现"tsc 换了输出形状"时，那条永不生效的
  // 发布句会留在产物里，覆盖率当场红 —— 那正是本文件头写明的取舍（不猜着切文件）。
  return { code: out.join("\n"), mapLines: mapped };
}

/**
 * 把一个带装饰器的 TS 文件编译成 JS。
 * @param {string} code - 源文本（当前实现只做"要不要编"的门槛，编译交给 tsc 读盘上的原文）
 * @param {string} file - 源文件的**绝对路径**（tsc 按它定位产物名）
 * @param {boolean} [coverageHints] - 给注入的调用加 v8 忽略提示（只有测试管线要，见下）
 * @returns {{code: string, map: object | null}} 编译后的代码与源映射
 */
export function lowerStandardDecorators(code, file, coverageHints = false) {
  if (code.length === 0) {
    // 空输入不可能带装饰器（形状门槛已过）；这一句只为说明 `code` 为何参与签名。
    return { code, map: null };
  }
  const outDir = mkdtempSync(path.join(tmpdir(), "dg-decorators-"));
  let tscStderr = "";
  try {
    try {
      execFileSync(
        process.execPath,
        [
          TSC_BIN,
          // 不吃本仓 tsconfig：那一份是**只做类型检查**的（`noEmit`、`erasableSyntaxOnly`），
          // 而这一步要的正是它的反面。
          "--ignoreConfig",
          // 只编这一个文件：见文件头的理由（不加它会把整张图都编出来）。
          "--noResolve",
          "--target",
          "es2024",
          // `preserve` 让 import 说明符**逐字保留**（含 `.ts`），管线照常解析。
          "--module",
          "preserve",
          // 源映射不是可选的：覆盖率按源文件归因，少了它 `lib/stats-remote.ts` 会从
          // 四项 100% 的门禁里凭空消失。
          "--sourceMap",
          "--outDir",
          outDir,
          file,
        ],
        // stdout 仍然丢弃：`--noResolve` 下那条**必然**的 TS2307 走 stdout，它不该出现在
        // 任何人的终端里。stderr 收下来只用于失败诊断（正常路径上一个字节都没有）。
        { cwd: import.meta.dirname, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
      );
    } catch (error) {
      // 见文件头：`--noResolve` 下必有 TS2307，退出码不是可信信号 —— 产物在不在由下一句判。
      // 但原因要留下：TSC_BIN 缺失、参数不被识别、进程崩掉，与"只有 TS2307"在这里长得一样，
      // 最后都退化成 readFileSync 的 ENOENT。留着 stderr 才能把两者分开。
      if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
        tscStderr = error.stderr.trim();
      }
    }
    const emitted = path.join(
      outDir,
      `${path.basename(file).replace(/\.[cm]?ts$/u, "")}${emittedExtensionOf(file)}`,
    );
    let js;
    try {
      js = readFileSync(emitted, "utf8");
    } catch (error) {
      // 产物没出来才算真失败。把 tsc 的 stderr 拼进来 —— 否则这里只剩一句 ENOENT，
      // 而"哪一步错了"是调用方唯一想知道的事。
      const detail = tscStderr === "" ? "（tsc 没有输出 stderr）" : tscStderr;
      throw new Error(
        `danger-guard: 装饰器降级没有产出 ${path.basename(emitted)}（${file}）。tsc stderr：${detail}`,
        { cause: error },
      );
    }
    if (js.length === 0) {
      throw new Error(`danger-guard: decorator lowering produced no output for ${file}`);
    }
    let map = null;
    try {
      map = JSON.parse(readFileSync(`${emitted}.map`, "utf8"));
      // tsc 写的 `sources` 是**相对临时 outDir** 的路径（`../../…/lib/stats-remote.ts`），
      // 而那个目录紧接着就被删了 —— 这份映射交出去之后，任何按它解析的来源都指向不存在的
      // 路径，覆盖率归因与堆栈映射一起失效。改写成源文件的绝对路径，并把源文本一并带上
      // （没有 sourcesContent 时消费方还得自己去磁盘上找，找到的也可能是另一版）。
      map.sources = [file];
      map.sourcesContent = [code];
    } catch {
      // 源映射缺席不是致命项（覆盖率的归因会差一些，但那会由覆盖率门禁自己说话）。
    }
    const mapLines = map === null ? null : map.mappings.split(";");
    const pruned = pruneInjectedPlumbing(js, coverageHints, mapLines);
    if (map !== null) {
      map.mappings = pruned.mapLines.join(";");
    }
    return { code: pruned.code, map };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** rolldown 插件：在它的解析器看到源码之前把标准装饰器编译掉。 */
export function rolldownDecorators() {
  return {
    name: "danger-guard:standard-decorators",
    transform(code, id) {
      return needsDecoratorLowering(id, code) ? lowerStandardDecorators(code, id) : null;
    },
  };
}

/** Vite 插件（测试管线）：与上面同源，只是挂到 Vite 的钩子上（`enforce: pre` 保证在它前面）。 */
export function viteDecorators() {
  return {
    name: "danger-guard:standard-decorators",
    enforce: "pre",
    transform(code, id) {
      // `?` 之后的 query 不是文件名：Vite 用 `x.ts?import`、`x.ts?raw` 这类 id 表示同一份
      // 源码的不同取用方式。`split("?", 1)[0]` 对不带 query 的 id 仍返回整串（含 `?` 的情况
      // 已由下一行兜住），所以这里先判有没有 query 再切。
      const file = id.includes("?") ? id.slice(0, id.indexOf("?")) : id;
      // 单 return：两个分支只差"要不要编译"，而 lint 的 consistent-return 盯着返回值形状。
      // 第三个实参 = 覆盖率提示：**只有测试管线要**（构建产物的字节不该带它，见 pruneInjectedPlumbing）。
      return needsDecoratorLowering(file, code)
        ? lowerStandardDecorators(code, file, true)
        : undefined;
    },
  };
}
