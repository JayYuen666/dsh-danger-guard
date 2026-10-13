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

/** 带装饰器的 TS 源：只认行首那种形状（本仓只有 `lib/stats-remote.ts` 命中）。
 *  它是"要不要跑一次 tsc"的**快速门槛**——绝大多数文件不该付这个子进程。 */
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/mu;

/** 这个文件需要预转换吗（后缀与装饰器形状两道筛）。 */
export function needsDecoratorLowering(id, code) {
  return /\.[cm]?ts$/u.test(id) && DECORATOR_SYNTAX.test(code);
}

/** `tsc` 的入口（本仓 devDependency；用绝对路径而不靠 PATH，免得受调用方环境影响）。 */
const TSC_BIN = path.resolve(import.meta.dirname, "node_modules/typescript/bin/tsc");

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
function pruneInjectedPlumbing(code, coverageHints) {
  const metadataLine = /^\s*if \(_metadata\) Object\.defineProperty\(this, Symbol\.metadata,/u;
  return code
    .split("\n")
    .filter((line) => !metadataLine.test(line))
    .map((line) => {
      const injected = line.includes("__esDecorate(") || line.includes("__runInitializers(");
      if (!injected || !coverageHints) {
        return line;
      }
      return [
        "/* v8 ignore start -- tsc 注入的装饰器调用（access 两枚箭头与实例初值器都不被本协议读取）*/",
        line,
        "/* v8 ignore stop */",
      ].join("\n");
    })
    .join("\n");
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
        { cwd: import.meta.dirname, stdio: "ignore" },
      );
    } catch {
      // 见文件头：`--noResolve` 下必有 TS2307，退出码不是可信信号 —— 产物在不在由下一句判。
    }
    const emitted = path.join(outDir, `${path.basename(file).replace(/\.[cm]?ts$/u, "")}.js`);
    const js = readFileSync(emitted, "utf8");
    if (js.length === 0) {
      throw new Error(`danger-guard: decorator lowering produced no output for ${file}`);
    }
    let map = null;
    try {
      map = JSON.parse(readFileSync(`${emitted}.map`, "utf8"));
    } catch {
      // 源映射缺席不是致命项（覆盖率的归因会差一些，但那会由覆盖率门禁自己说话）。
    }
    return { code: pruneInjectedPlumbing(js, coverageHints), map };
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
      const file = id.split("?", 1)[0] ?? id;
      // 单 return：两个分支只差"要不要编译"，而 lint 的 consistent-return 盯着返回值形状。
      // 第三个实参 = 覆盖率提示：**只有测试管线要**（构建产物的字节不该带它，见 pruneInjectedPlumbing）。
      return needsDecoratorLowering(file, code)
        ? lowerStandardDecorators(code, file, true)
        : undefined;
    },
  };
}
