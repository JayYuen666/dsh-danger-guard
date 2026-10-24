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
      const out = lowerStandardDecorators(DECORATED_LINE, file);
      assert.ok(out.code.length > 0, "应当产出编译后的代码");
      assert.ok(out.code.includes("__esDecorate"), "装饰器应当被降级成调用");
      assert.notEqual(out.map, null, ".mts 同样要带源映射");
    } finally {
      await cleanup();
    }
  });

  it(".cts 输入能降级成功", async () => {
    const { file, cleanup } = await tempSource("a.cts", DECORATED_SOURCE);
    try {
      assert.ok(lowerStandardDecorators(DECORATED_LINE, file).code.length > 0);
    } finally {
      await cleanup();
    }
  });
});

describe("失败诊断：产物没出来时要说得出为什么", () => {
  it("源文件不存在时抛错，消息里点名产物与源路径，并带上 stderr 段", () => {
    const missing = path.join(tmpdir(), "dg-deco-does-not-exist.mts");
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
    assert.match(caught.message, /tsc stderr：/u, "必须保留 stderr 段");
  });

  it("stderr 为空时说明是空而不是留一个空白段", () => {
    const missing = path.join(tmpdir(), "dg-deco-empty-stderr.ts");
    assert.throws(
      () => lowerStandardDecorators(DECORATED_LINE, missing),
      /tsc stderr：（tsc 没有输出 stderr）/u,
    );
  });
});

describe("vite 钩子：带 query 的 id 要剥掉 query 再当路径", () => {
  it("`x.mts?import` 与 `x.mts` 走同一条路径（不剥 query 会因后缀不匹配而漏）", async () => {
    const plugin = viteDecorators();
    const { file, cleanup } = await tempSource("q.mts", DECORATED_SOURCE);
    try {
      const out = plugin.transform(DECORATED_LINE, `${file}?import`);
      assert.notEqual(out, undefined, "带 query 的 id 也应当命中");
      assert.ok(out !== undefined && out.code.length > 0);
    } finally {
      await cleanup();
    }
  });

  it("不带 query 且无装饰器时交回 undefined（管线继续用原文）", () => {
    const plugin = viteDecorators();
    assert.equal(plugin.transform("export const x = 1;\n", TS_PATH), undefined);
  });
});

describe("metadata 发布句：整条语句才裁，多行形态当场报错", () => {
  it("类装饰器产物的那条发布句也被裁掉（接收者不是 this 时同样要认出来）", async () => {
    const { file, cleanup } = await tempSource("m.mts", DECORATED_METHOD_SOURCE);
    try {
      const out = lowerStandardDecorators(DECORATED_LINE, file);
      assert.equal(out.code.includes("Symbol.metadata, {"), false, "发布句必须被裁掉");
      assert.ok(out.code.includes("__esDecorate("), "注入的调用本身保留");
    } finally {
      await cleanup();
    }
  });
});
