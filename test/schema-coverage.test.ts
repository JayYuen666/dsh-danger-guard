// test/schema-coverage.test.ts —— 覆盖门禁自身两个解析原语的正确性。
//
// 门禁失效有两个方向，两边都是**静默**的：字段抽取漏掉字段（少要求 = 假绿）、
// 绑定识别把非调用算成绑定（多算 = 假绿）。整条门禁只在「真漏了字段」时才红，
// 所以它自己的解析错了不会有人发现 —— 这个文件钉的就是那两处。

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { boundFieldsIn, topLevelFieldNames } from "./schema-coverage.ts";

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
    assert.deepEqual([...boundFieldsIn(src)], ["fieldPropField", "realField", "anotherField"]);
  });

  it("块注释与行注释里的写法都不算（回归）", () => {
    const src = ["/* unset('blockField') */", "writer.set('keptField');"].join("\n");
    assert.deepEqual([...boundFieldsIn(src)], ["keptField"]);
  });
});
