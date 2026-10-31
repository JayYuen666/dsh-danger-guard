// test/schema-coverage.test.ts —— 覆盖门禁自身两个解析原语的正确性。
//
// 门禁失效有两个方向，两边都是**静默**的：字段抽取漏掉字段（少要求 = 假绿）、
// 绑定识别把非调用算成绑定（多算 = 假绿）。整条门禁只在「真漏了字段」时才红，
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
});
