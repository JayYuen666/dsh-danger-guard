// test/decorator-transform.test.ts —— 装饰器预转换的**判据面**。
//
// 为什么单列：这套东西只有两条真判据 —— "这个文件要不要预转换"与"转换失败时能不能说清
// 为什么"。前者错了的表现是**产物合法但装饰器还在**（装载期才炸，构建报成功）；后者错了
// 的表现是只剩一句 ENOENT，看不出是 tsc 不在、参数不对，还是产物名推导错了。两者都不在
// 任何现有用例的覆盖面上。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";

import {
  lowerStandardDecorators,
  needsDecoratorLowering,
  viteDecorators,
} from "../decorator-transform.mjs";

/** 临时目录前缀（`mkdtemp` 会在它后面追加随机段）。 */
const TMP_PREFIX = "dg-deco-test-";
/** 带装饰器的 TS 源文本：被转换的那一侧，各处复用同一份。 */
const DECORATED_SOURCE = "function dec(_v: unknown, _c: unknown): void {}\n@dec class A {}\n";
/** 含方法装饰器的源文本（类装饰器与方法装饰器会产出不同的 metadata 接收者）。 */
const DECORATED_METHOD_SOURCE =
  "function dec(_v: unknown, _c: unknown): void {}\n@dec class A { @dec m() {} }\n";
/** 门槛用例的输入：只含装饰器那一行。 */
const DECORATED_LINE = "@dec class A {}\n";
/** 下面两份源共用的装饰器落点：本文件的用例都靠它先过门槛，tsc 才有产物可裁。 */
const DECORATOR_TAIL = ["function dec(_v: unknown, _c: unknown): void {}", "@dec class A {}"];
/** 发布句在源里就是多行：看 tsc 打印成什么形状、裁剪认不认它。
 *  `declare const _metadata` 是故意的 —— 它让 tsc 把自己那份临时名改成 `_metadata_1`，
 *  于是产物里只有源里这一条语句带着 `if (_metadata)` 前缀，判据不会和注入的那条混淆。
 *  ⚠ 逐行数组拼装而不是模板字面量：本文件自己也要过装饰器管线，而裁剪的锚点只看行首形状，
 *  字面量里那行 `if (_metadata) Object.defineProperty(` 会在一行里匹配上锚点又不以 `);` 收尾，
 *  于是加载期就落进抛错支（实测过一次）。拼成数组后每行都带引号与前导空格，锚点匹配不上。 */
const SPLIT_METADATA_SOURCE = [
  "declare const _metadata: unknown;",
  "declare const SomeName: Record<string, unknown>;",
  "if (_metadata) Object.defineProperty(SomeName, Symbol.metadata, {",
  "  enumerable: true,",
  "  writable: false,",
  "} as Record<string, unknown>);",
  ...DECORATOR_TAIL,
  "",
].join("\n");
/** 一个普通 TS 文件路径（不读盘，只用来喂门槛）。 */
const TS_PATH = "/some/a.ts";

/** 在临时目录里造一份源文件，交回它的绝对路径与一份清理函数。 */
async function tempSource(
  fileName: string,
  source: string,
): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), TMP_PREFIX));
  const file = path.join(dir, fileName);
  await writeFile(file, source);
  return {
    file,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("要不要预转换：形状门槛", () => {
  it("行首装饰器、类体内联、export default 内联、赋值内联都命中", () => {
    const cases: readonly string[] = [
      '@Remote("stats")\nexport class A {}\n',
      'export class B { @Remote("stats") m() {} }\n',
      "export default @dec class {}\n",
      "const C = @dec class {};\n",
    ];
    for (const code of cases) {
      assert.equal(needsDecoratorLowering(TS_PATH, code), true, `漏了这种写法：${code}`);
    }
  });

  it("没有装饰器、或后缀不是 TS 时不命中", () => {
    assert.equal(needsDecoratorLowering(TS_PATH, "export const x = 1;\n"), false);
    assert.equal(needsDecoratorLowering("/some/a.js", DECORATED_LINE), false);
    assert.equal(needsDecoratorLowering("/some/a.json", DECORATED_LINE), false);
  });

  it(".mts / .cts 也是 TS：门槛认它们（产物后缀由下一组用例盯）", () => {
    assert.equal(needsDecoratorLowering("/some/a.mts", DECORATED_LINE), true);
    assert.equal(needsDecoratorLowering("/some/a.cts", DECORATED_LINE), true);
  });
});

describe("产物后缀：按源后缀找 tsc 真正写出的那一份", () => {
  it(".mts 输入能降级成功（照 .js 找会 ENOENT）", async () => {
    const { file, cleanup } = await tempSource("a.mts", DECORATED_METHOD_SOURCE);
    try {
      // 传给转换的 code 必须与写盘的源一致：它会进源映射（sourcesContent），
      // 不一致时用例验的是另一份内容而毫无察觉。
      const out = lowerStandardDecorators(DECORATED_METHOD_SOURCE, file);
      assert.ok(out.code.length > 0, "应当产出编译后的代码");
      assert.ok(out.code.includes("__esDecorate"), "装饰器应当被降级成调用");
      // 返回面是 `{ code, map: { sources, mappings } | null }`（失败给 null，不给 undefined），
      // 所以先按 null 判存在；再钉 sources 指回那份源文件的绝对路径——只断「有映射」的话，
      // sources 写成别的文件也不会红。
      const { map } = out;
      assert.notEqual(map, null, ".mts 同样要带源映射");
      assert.deepEqual(map?.sources, [file], "源映射要指回那份 .mts");
    } finally {
      await cleanup();
    }
  });

  it(".cts 输入能降级成功", async () => {
    const { file, cleanup } = await tempSource("a.cts", DECORATED_SOURCE);
    try {
      assert.ok(lowerStandardDecorators(DECORATED_SOURCE, file).code.length > 0);
    } finally {
      await cleanup();
    }
  });
});

describe("失败诊断：产物没出来时要说得出为什么", () => {
  it("源文件不存在时抛错，消息里点名产物与源路径，并带上 stderr 段", async () => {
    // 在 mkdtemp 出来的空目录里取一个必然不存在的路径：固定 tmpdir() 下会被上一次残留
    // 或别的机器上的同名文件带偏。
    const dir = await mkdtemp(path.join(tmpdir(), TMP_PREFIX));
    const missing = path.join(dir, "does-not-exist.mts");
    try {
      // 用 try/catch 取错误本体而不是给 assert.throws 传校验回调：后者是本仓
      // `promise/prefer-await-to-callbacks` 明确要避免的回调形。
      let caught: unknown;
      try {
        lowerStandardDecorators(DECORATED_LINE, missing);
      } catch (error: unknown) {
        caught = error;
      }
      assert.ok(caught instanceof Error, "源文件不存在时必须抛错");
      assert.match(caught.message, /装饰器降级没有产出/u);
      assert.match(caught.message, /does-not-exist\.mjs/u, "消息按 .mts 推出 .mjs");
      assert.match(caught.message, /does-not-exist\.mts/u, "消息要点名那份源文件，而不只是产物");
      assert.match(caught.message, /tsc stderr：/u, "必须保留 stderr 段");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stderr 为空时说明是空而不是留一个空白段", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), TMP_PREFIX));
    const missing = path.join(dir, "empty-stderr.ts");
    try {
      assert.throws(
        () => lowerStandardDecorators(DECORATED_LINE, missing),
        /tsc stderr：（tsc 没有输出 stderr）/u,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("vite 钩子：带 query 的 id 要剥掉 query 再当路径", () => {
  it("`x.mts?import` 与 `x.mts` 走同一条路径（不剥 query 会因后缀不匹配而漏）", async () => {
    const plugin = viteDecorators();
    const { file, cleanup } = await tempSource("q.mts", DECORATED_SOURCE);
    try {
      const out = plugin.transform(DECORATED_SOURCE, `${file}?import`);
      assert.notEqual(out, undefined, "带 query 的 id 也应当命中");
      assert.ok(out !== undefined && out.code.length > 0);
      assert.ok(out.code.includes("__esDecorate"), "钩子确实执行了降级，而不是原样回吐原文");
    } finally {
      await cleanup();
    }
  });

  it("不带 query 且无装饰器时交回 undefined（管线继续用原文）", () => {
    const plugin = viteDecorators();
    assert.equal(plugin.transform("export const x = 1;\n", TS_PATH), undefined);
  });
});

describe("metadata 发布句：只裁锚点匹配得上的整条单行语句", () => {
  it("类装饰器产物的那条发布句也被裁掉（接收者不是 this 时同样要认出来）", async () => {
    const { file, cleanup } = await tempSource("m.mts", DECORATED_METHOD_SOURCE);
    try {
      const out = lowerStandardDecorators(DECORATED_METHOD_SOURCE, file);
      assert.equal(out.code.includes("Symbol.metadata, {"), false, "发布句必须被裁掉");
      assert.ok(out.code.includes("__esDecorate("), "注入的调用本身保留");
    } finally {
      await cleanup();
    }
  });

  it("被 tsc 打成两行的发布句：锚点匹配不上 ⇒ 一行都不删，产物仍是合法 JS", async () => {
    // 源里写成多行的 `if`，tsc 7.0.2 把条件单独打一行、调用从下一行带缩进起（实测）。
    // 锚点要求前缀与调用同行，所以这里匹配不上 ⇒ **整条语句原样留着**，而不是删掉首行留下
    // 残片 —— 后者才是这条守卫要避免的后果。留在产物里的代价是那条永不生效的发布句进覆盖率，
    // 由门禁自己说话（文件头写明的取舍）。
    const { file, cleanup } = await tempSource("split.ts", SPLIT_METADATA_SOURCE);
    try {
      const out = lowerStandardDecorators(SPLIT_METADATA_SOURCE, file);
      const lines = out.code.split("\n");
      const condAt = lines.findIndex((line) => line.trim() === "if (_metadata)");
      assert.ok(condAt !== -1, "条件被单独打一行：锚点要求前缀与调用同行，这里匹配不上");
      assert.equal(
        lines[condAt + 1]?.trim(),
        "Object.defineProperty(SomeName, Symbol.metadata, {",
        "调用留在下一行、整条语句不得被动过",
      );
      // 只解析不执行：残片的判据是语法，跑起来反而要造齐 __esDecorate 的作用域。
      assert.doesNotThrow(() => new Script(out.code), "半条语句会是非法 JS");
    } finally {
      await cleanup();
    }
  });

  it("锚点匹配得上却不以 `);` 收尾时当场抛错，点名那一行", async () => {
    // 抛错支的真输入不需要桩：模板字面量里的同形文本落到产物就是那一行形（行首顶格、以 `{` 收尾）。
    // 本仓自己撞过一次 —— 把这段源写成本文件的模板字面量时，**本文件**也要过装饰器管线，
    // 加载期就红在这一条上。所以源逐行拼出来：测试文件里的每一枚元素都带引号与前导空格，
    // 匹配不上锚点；写进临时文件之后那一行才顶格。
    const source = [
      ...DECORATOR_TAIL,
      "const text = `",
      "if (_metadata) Object.defineProperty(SomeName, Symbol.metadata,",
      "  enumerable: true,",
      "});",
      "`;",
      "export { text };",
      "",
    ].join("\n");
    const { file, cleanup } = await tempSource("anchor-in-string.ts", source);
    try {
      let message: string | undefined;
      try {
        lowerStandardDecorators(source, file);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.ok(message !== undefined, "必须当场抛错，而不是发出半条语句的产物");
      // 三条各管一段：为什么炸、炸在哪一行、不炸会怎样。少了中间那条就得自己去产物里找。
      assert.match(message, /Symbol\.metadata 发布语句不是单行/u);
      assert.match(message, /if \(_metadata\) Object\.defineProperty\(SomeName/u);
      assert.match(message, /非法 JS/u);
    } finally {
      await cleanup();
    }
  });
});
