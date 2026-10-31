// test/messages.test.ts —— 逐语言展示文案的**全语言映射**（lib/messages.ts）。
//
// 为什么单独一份：`displayReasonOf` 的唯一进程内调用方已并入 lib/confirm.ts 的
// displayReasonWithNote（那里要"规则本文 + 档位说明"两段拼接）；这一枚仍是**发布面**
// 的导出（官方 `displayReason` 的形状铸造器），它"逐 locale 取、语言集扩宽时自动跟上"
// 的契约由这里钉住——按 Locale 泛化的写法不被退化成写死 `{ zh, en }`。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { displayReasonOf, fillTemplate, MESSAGES } from "../lib/messages.ts";
import type { DangerGuardMessages } from "../lib/messages.ts";

describe("displayReasonOf：一枚键在全部语言下的文案", () => {
  it("每个 locale 一格，en 单独显式必填；键集与 MESSAGES 的语言集一致", () => {
    const out = displayReasonOf("noteWorkspaceWrite");
    assert.deepEqual(Object.keys(out).toSorted(), Object.keys(MESSAGES).toSorted(), "语言集同源");
    for (const [locale, table] of Object.entries(MESSAGES)) {
      assert.equal(out[locale], table.noteWorkspaceWrite, `locale=${locale}`);
    }
    assert.equal(typeof out.en, "string");
    assert.ok(out.en.length > 0, "官方把 en 定成必填成员");
  });

  it("同一枚 key 在不同语言下是各自的文案（不是同一句复读）", () => {
    const out = displayReasonOf("rmrf");
    assert.notEqual(out["zh"], out.en);
    assert.equal(out["zh"], MESSAGES.zh.rmrf);
    assert.equal(out.en, MESSAGES.en.rmrf);
  });

  it("语言集扩宽时自动跟上（不是写死 zh/en 两条分支）", () => {
    const mutable = MESSAGES as unknown as Record<string, DangerGuardMessages>;
    try {
      mutable["fr"] = MESSAGES.en;
      const out = displayReasonOf("rmrf") as Record<string, string>;
      assert.equal(out["fr"], MESSAGES.en.rmrf, "新增语言必须出现在结果里");
      for (const [locale, value] of Object.entries(out)) {
        assert.ok(value.length > 0, `${locale} 的文案不得为空`);
      }
    } finally {
      Reflect.deleteProperty(mutable, "fr");
    }
  });
});

describe("fillTemplate：槽位插值", () => {
  it("命名槽位被逐个替换，未知槽位原样保留（不吞模型可见的文案）", () => {
    assert.equal(
      fillTemplate("a {name} b {root}", { name: "x.ts", root: "/proj" }),
      "a x.ts b /proj",
    );
    assert.equal(fillTemplate("no slots", {}), "no slots");
    assert.equal(fillTemplate("{missing} stays", {}), "{missing} stays");
  });

  it("替换值是字面量：`$&`/`$1` 等替换模式不被二次解释", () => {
    const literal = "$& $1 $` $' $$";
    assert.equal(fillTemplate("{value}", { value: literal }), literal);
  });

  it("槽位存在但取值缺失时保留原占位符，不写进 undefined", () => {
    assert.equal(fillTemplate("{a}", { a: undefined } as never), "{a}");
  });

  it("槽位值里的占位符字形不被二次解释", () => {
    assert.equal(
      fillTemplate("{text} / {root}", { text: `const p = \${file}; // {root}`, root: "/proj" }),
      `const p = \${file}; // {root} / /proj`,
    );
  });
});
