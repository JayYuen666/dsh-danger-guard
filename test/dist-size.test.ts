// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：`pnpm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人在切面里塞进大对象字面量或整段查表」这类回退——
// 它们不会让任何现有用例变红（体积不是行为），所以必须有一道单独的尺子。
//
// 预算怎么定的：以最近一次实测值为基线，按当轮增量的性质上浮一档——只加判据与文案时留百分之几，
// 预期的大改才留两位数；翻倍一定会顶穿。真需要突破时改这些常量并写明理由。
//
// 三枚运行期产物开 `minify: true`（裁决见下），types/ 的声明**不**压缩：那是发布面给编辑器
// 读的 API 文档，JSDoc 就是它的正文。
//
// ⚠ 更正一条曾写在**这里**的错误结论（它的影响是让本包白白多背了几百 KB）：此前记的是
// "压缩后 `from "@jayyuen66/dsh-plugin-shared/lib/record"` 与 `from "@deepseek-ai/schemastery"`
// 两个说明符双双消失，于是两道外部化门禁会变成恒绿"。**实测否证**：那时看到的是
// `from"x"`（minify 去掉了空格）与 `from "x"` 的差异 —— 说明符一直在，依赖照样外部化。
// 真正会被 minify 打瞎的是**带标识符的文本判据**（内联体的函数名会被 mangle，实测故意不外部化
// dsh-brand 时产物里 `brandNumber` 一次都查不到），所以那两道门禁已改成**结构性判据**：
// 看 chunk 的 `moduleIds` 里有没有依赖表的包（test/build-host.test.ts）。产物可读性不再是
// 一条门禁（谁也不会去读装载器吃的文件），体积与"依赖没被内联"各由一道真门禁盯着。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 拦截半产物体积预算：实测 124,464 B → 取 125,500 B（约 1% 余量）。
 *  余量按当轮增量的性质定：判据本体与守卫一类的改动只留百分之几，预期的大改才留两位数；
 *  翻倍一定会顶穿。逐轮「加了什么、实测多少」不写在这里——那是 CHANGELOG 与提交历史的
 *  对象，抄进测试文件只会变成一份无法校验、还会错号的流水账。
 *  顶穿时的处置：改这条常量并写明理由；先怀疑是不是某个切面塞进了大查表或字面量。
 */
const HOST_BUDGET_BYTES = 125_500;
/** 设置半产物体积预算：实测 5,022 B → 取 5,100 B（约 1.5% 余量）。与拦截半分属两个 bulkhead
 *  条目、各自记账；余量口径与顶穿时的处置见上面拦截半那条说明。 */
const SETTINGS_BUDGET_BYTES = 5100;
/** 客户端半产物体积预算：实测 34,671 B → 取 40,000 B（浏览器侧加载，按平台计账）。这一档的余量
 *  是设置卡迁到 shared card-ui 那一次留下的——组件与样式表随 bundle 打入；余量口径见拦截半那条。 */
const CLIENT_BUDGET_BYTES = 40_000;
/** 声明**入口层**体积预算（只量 types/ 顶层的 host.d.ts / settings-host.d.ts）。
 *  types/lib 下的依赖声明同样随包发布、同样是 tarball 体积主体，本预算刻意不覆盖它们；
 *  这里守的是入口桩不被塞进大表。要按 tarball 口径量全量声明，请另立一条递归预算。 */
const DECLARATION_ENTRY_BUDGET_BYTES = 120_000;

/** 产物文件名与预算的对照。
 *  ⚠ 新增一个运行期入口（再拆一枚 bulkhead 产物）时，这里要同时加一行：闸门只量它列出的
 *  文件，构建脚本产出什么它不认得——漏加不会有任何用例变红。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  ["host.js", HOST_BUDGET_BYTES],
  ["settings.js", SETTINGS_BUDGET_BYTES],
  ["client.js", CLIENT_BUDGET_BYTES],
];

/**
 * 某目录下 `.d.ts` 的字节合计（**不递归**）。
 *
 * 不递归是刻意的：types/ 一层就是两个声明入口（host.d.ts / settings-host.d.ts），lib/ 下是
 * 它们各自的依赖，量级不同。只对一层求和，就不必去减一个可能为空的子目录——那种写法在
 * 子目录为空时得到 0、断言恒真，而一条永远绿的闸门比没有闸门更坏：它让人以为有护栏。
 *
 * @param dir - 目录绝对路径
 * @returns 字节合计
 */
function entryDeclarationBytes(dir: string): number {
  const entries = readdirSync(dir).filter((name) => name.endsWith(".d.ts"));
  if (entries.length === 0) {
    // 一个都没匹配到时求和恒为 0、预算恒成立——与子目录为空同一类假护栏。
    throw new Error(`types/ 下没有任何 .d.ts：build:types 没跑，或产物命名约定变了`);
  }
  return entries.reduce((sum, name) => sum + readFileSync(path.join(dir, name)).byteLength, 0);
}

describe("产物体积", () => {
  // 用 it.each 而不是手写循环：三条预算断言形状完全相同，手写循环会多一层缩进，且新增一条
  // 预算时容易忘了把它塞进某个数组的某个分支里。
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    const artifactPath = path.join(pkgDir, file);
    // 产物不在与体积超预算是两件事：前者是「没构建/改名/没 prepack」，处置是去构建；
    // 后者才是体积回退。让它在这里分岔，读日志的人不必先去猜 ENOENT 是哪一种。
    assert.ok(
      existsSync(artifactPath),
      `${file} 不在盘上：先跑 npm run build（产物由构建生成，不在版本库里）`,
    );
    const bytes = readFileSync(artifactPath).byteLength;
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表或字面量。` +
        `确属正常演进就改 test/dist-size.test.ts 里对应的预算常量，并写明理由。`,
    );
  });

  it("types/ 入口声明不超出预算", () => {
    const bytes = entryDeclarationBytes(path.join(pkgDir, "types"));
    assert.ok(
      bytes <= DECLARATION_ENTRY_BUDGET_BYTES,
      `types/ 入口声明实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${DECLARATION_ENTRY_BUDGET_BYTES.toLocaleString("en-US")} B。` +
        `确认是正常演进就改这条预算常量，并写明理由。`,
    );
  });
});
