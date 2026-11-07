// test/schema-coverage.test.ts —— 覆盖门禁自身两个解析原语的正确性。
//
// 门禁失效有两个方向，两边都是**静默**的：字段抽取漏掉字段（少要求 = 误判通过）、
// 绑定识别把非调用算成绑定（多算 = 误判通过）。整条门禁只在「真漏了字段」时才红，
// 所以它自己的解析错了不会有人发现 —— 这个文件钉的就是那两处。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
  boundFieldsIn,
  clientBoundFields,
  hostSchemaFields,
  topLevelFieldNames,
} from "./schema-coverage.ts";

describe("topLevelFieldNames：字符串里的转义引号不是闭合", () => {
  it("默认值里带转义引号时，后面的字段照样抽得出来", () => {
    // 修复前：`\\` 吞掉下一枚字符后仍拿它比引号，`\"` 被判成闭合，
    // 于是从这个字段起整段剩余内容都被当成字符串内容 —— 只抽到第一项。
    const block = [
      String.raw`  name: Schema.string().default("a \" b"),`,
      "  port: Schema.number().default(1),",
      "  tail: Schema.string(),",
    ].join("\n");
    assert.deepEqual(topLevelFieldNames(block), ["name", "port", "tail"]);
  });

  it("连续反斜杠 / 奇数个反斜杠 / 串尾反斜杠都不误判闭合", () => {
    const block = [
      String.raw`  a: Schema.string().default("C:\\dir\\"),`,
      String.raw`  b: Schema.string().default("q\\\"x"),`,
      "  c: Schema.number(),",
    ].join("\n");
    assert.deepEqual(topLevelFieldNames(block), ["a", "b", "c"]);
  });

  it("没有转义时结论不变（回归）", () => {
    const block = ['  name: Schema.string().default("ab"),', "  port: Schema.number(),"].join("\n");
    assert.deepEqual(topLevelFieldNames(block), ["name", "port"]);
  });
});

describe("boundFieldsIn：注释与提示文案里的写法不算绑定", () => {
  it("注释里的 set('x') 与多词句子里的 set('y') 都不算，真实调用照算", () => {
    const src = [
      "// 旧代码曾 set('legacyField')，已删除",
      "const note = \"调用 set('ghostField') 的历史\";",
      'props.set("realField");',
      "props.unset('anotherField');",
      "field: 'fieldPropField'",
    ].join("\n");
    // 集合语义：不钉匹配的先后顺序（实现合并两次扫描是等价改动）。
    assert.deepEqual([...boundFieldsIn(src)].toSorted(), [
      "anotherField",
      "fieldPropField",
      "realField",
    ]);
  });

  it("正则字面量与模板字符串里的 set('x') 不算绑定", () => {
    const src = [
      'const re = /set("ghostField")/;',
      'const t = `set("tplField")`;',
      'props.set("realField");',
    ].join("\n");
    assert.deepEqual([...boundFieldsIn(src)], ["realField"]);
  });

  it("块注释与行注释里的写法都不算（回归）", () => {
    const src = ["/* unset('blockField') */", "writer.set('keptField');"].join("\n");
    assert.deepEqual([...boundFieldsIn(src)], ["keptField"]);
  });

  it("非 UI 接收者上的 set 不算绑定", () => {
    const src = [
      "localStorage.set('maxDenies', 5);",
      "cache.set('strictMode', true);",
      "props.set('realField', 1);",
    ].join("\n");
    assert.deepEqual([...boundFieldsIn(src)], ["realField"]);
  });

  /** 匹配钉住：哪些写法算绑定、哪些刻意不算，各自的理由写在断言消息里。
   *  不钉住的话，将来放宽正则的人看不出自己动的是哪一侧。 */
  it("写入惯用法的匹配（表驱动）", () => {
    const bound = [
      'props.set("viaSet");',
      "props.unset('viaUnset');",
      'fireAndForget("viaFireAndForget");',
      'writer.writeSet("viaWriteSet");',
      'store.commit("viaCommit");',
      'writer.set<string>("viaGenerics");',
      "props.set(`viaBacktick`);",
      `writer.set(
        "viaMultiline",
      );`,
    ];
    assert.deepEqual(
      [...boundFieldsIn(bound.join("\n"))].toSorted(),
      [
        "viaBacktick",
        "viaCommit",
        "viaFireAndForget",
        "viaGenerics",
        "viaMultiline",
        "viaSet",
        "viaUnset",
        "viaWriteSet",
      ],
      "五种方法名 + 泛型实参段 + 无插值模板字面量首参 + 跨行实参都要认下来",
    );
    for (const miss of [
      {
        src: "props['set']('viaComputed');",
        why: "计算属性：方法名成了数据，正则无从判断这个 set 是不是设置面",
      },
      {
        src: "fireAndForget(`a.b`);",
        why: "反引号里的内容不是整段标识符就不算：认它等于把任意表达式当字段名",
      },
      {
        src: "cache.set('viaCache');",
        why: "排除表里那几枚接收者（localStorage / sessionStorage / Map / Set / WeakMap / WeakSet / cache）不算绑定",
      },
      { src: "props.set(\"unpaired');", why: "引号不配对的写法不算（后向引用要求同一种引号收尾）" },
    ]) {
      assert.deepEqual([...boundFieldsIn(miss.src)], [], miss.why);
    }
    // 排除表认的就是那几枚字形：小写局部变量名（`map`、`store`）落在表外，会被算成绑定。
    // 这是「宁可宽不可严」的另一面——误认让门禁变宽，漏认则当场报错、逼人来登记接收者。
    assert.deepEqual([...boundFieldsIn('map.set("viaLowercaseMap");')], ["viaLowercaseMap"]);
  });
});

describe("hostSchemaFields：结构匹配不被字符串与注释带偏", () => {
  it("默认值字符串里的右括号不截断后面的字段", () => {
    const src = [
      "export const S = Schema.object({",
      '  a: Schema.string().default("x)"), // 行尾注释里的 )',
      "  /* 块注释里的 ) 与 Schema.object({ legacy: 1 }) */",
      "  b: Schema.number(),",
      "});",
    ].join("\n");
    assert.deepEqual(hostSchemaFields(src), { kind: "fields", fields: ["a", "b"] });
  });

  it("注释里提到的 Schema.object( 不算 marker", () => {
    const src = [
      "// 旧版 Schema.object({ legacy: 1 })",
      "export const S = Schema.object({ a: Schema.string() });",
    ].join("\n");
    assert.deepEqual(hostSchemaFields(src), { kind: "fields", fields: ["a"] });
  });

  it("同一文件里的多段 schema 合并字段", () => {
    const src = [
      "const A = Schema.object({ a: Schema.string() });",
      "const B = Schema.object({ b: Schema.number() });",
    ].join("\n");
    assert.deepEqual(hostSchemaFields(src), { kind: "fields", fields: ["a", "b"] });
  });

  it("括号不闭合报 malformed，而不是当成没有 schema", () => {
    assert.deepEqual(hostSchemaFields("const S = Schema.object({ a: Schema.string()"), {
      kind: "malformed",
    });
  });

  it("没有 marker 报 none；空对象是 fields 空数组", () => {
    assert.deepEqual(hostSchemaFields("const x = 1;"), { kind: "none" });
    assert.deepEqual(hostSchemaFields("const S = Schema.object({});"), {
      kind: "fields",
      fields: [],
    });
  });
});

describe("clientBoundFields：测试面不参与绑定", () => {
  it("src 下的 *.test.ts、*.spec.ts、tests/、__tests__/ 都被排除", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dg-schema-bound-"));
    try {
      await mkdir(path.join(root, "src", "__tests__"), { recursive: true });
      await mkdir(path.join(root, "src", "tests"), { recursive: true });
      await writeFile(path.join(root, "src", "card.ts"), "props.set('realField', 1);\n");
      await writeFile(path.join(root, "src", "card.test.ts"), "props.set('testField', 1);\n");
      await writeFile(path.join(root, "src", "card.spec.ts"), "props.set('specField', 1);\n");
      await writeFile(
        path.join(root, "src", "__tests__", "helper.ts"),
        "props.set('dunderField', 1);\n",
      );
      await writeFile(
        path.join(root, "src", "tests", "helper.ts"),
        "props.set('testsField', 1);\n",
      );
      const bound = await clientBoundFields(root);
      assert.deepEqual([...bound], ["realField"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("扫描范围为空时抛在布局上，而不是交回空集合", async () => {
    // 空集合在这里有两种成因：客户端入口不在这两棵树里（包根 client.ts），或 src/ 下只剩测试面。
    // 两种都没东西可判，而调用方拿到空集合会说不出成因地说「schema 字段全都没绑」，
    // 把「门禁自己不认识这种布局」写成一条指向卡片的红。所以这里必须当场报错。
    const noTrees = await mkdtemp(path.join(tmpdir(), "dg-schema-none-"));
    const testsOnly = await mkdtemp(path.join(tmpdir(), "dg-schema-tests-only-"));
    try {
      await writeFile(path.join(noTrees, "client.ts"), "props.set('rootEntryField', 1);\n");
      await mkdir(path.join(testsOnly, "src"), { recursive: true });
      await writeFile(path.join(testsOnly, "src", "card.test.ts"), "props.set('t', 1);\n");
      await assert.rejects(
        () => clientBoundFields(noTrees),
        /一个源文件都没扫到/u,
        "入口在包根：既没有 src/ 也没有 lib/，必须先红在布局上",
      );
      await assert.rejects(
        () => clientBoundFields(testsOnly),
        /一个源文件都没扫到/u,
        "src/ 下只有测试面：等于没有客户端源码可判，同样不许静默交出空集合",
      );
    } finally {
      await rm(noTrees, { recursive: true, force: true });
      await rm(testsOnly, { recursive: true, force: true });
    }
  });
});
