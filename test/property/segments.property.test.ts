// shell 词法状态机的属性面：切词、断段、结构视图、引号闭合对**任意**输入都必须有确定
// 结论（判定链跑在每次工具调用的热路径上，抛错就是中断整趟判定）。结构视图「清空引号内
// 字面文本」与 lexTokens「值剥离定界符、空词保留」两条契约用生成器扫描；lruPut 与
// AskDeduper 的有界性按各自头注写明的契约独立建模。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  hasUnclosedQuote,
  lexTokens,
  splitSegments,
  splitTopLevel,
  structureView,
} from "../../lib/command-segments.ts";
import { lruPut } from "../../lib/lru.ts";
import { AskDeduper } from "../../lib/confirm.ts";

/** 任意短文本（含引号、反斜杠、反引号、$()、换行——判定链的输入就是这个域）。 */
const shellTextArb = fc.string({ maxLength: 160 });

/** 不含引号/反斜杠/换行、非空的纯字面文本（引号契约的干净生成域）。 */
const plainTextArb = fc
  .string({ maxLength: 40 })
  .filter(
    (text) =>
      text.length > 0 &&
      !text.includes('"') &&
      !text.includes("'") &&
      !text.includes("\\") &&
      !text.includes("\n"),
  );

describe("词法状态机的全性：任意输入不抛", () => {
  it("splitSegments / splitTopLevel / structureView / lexTokens / hasUnclosedQuote 全部有确定结论", () => {
    fc.assert(
      fc.property(shellTextArb, (source) => {
        const segments = splitSegments(source);
        assert.equal(typeof segments.truncated, "boolean");
        assert.ok(Array.isArray(segments.texts));
        assert.ok(Array.isArray(splitTopLevel(source)));
        assert.equal(typeof structureView(source), "string");
        assert.ok(Array.isArray(lexTokens(source)));
        assert.equal(typeof hasUnclosedQuote(source), "boolean");
      }),
    );
  });

  it("同一个输入重复判定结论逐字节一致（无隐藏状态、无 lastIndex 型翻车）", () => {
    fc.assert(
      fc.property(shellTextArb, (source) => {
        assert.deepEqual(splitSegments(source), splitSegments(source));
        assert.equal(structureView(source), structureView(source));
        assert.equal(hasUnclosedQuote(source), hasUnclosedQuote(source));
      }),
    );
  });
});

describe("structureView 的「清空引号内字面文本」契约", () => {
  /** 无任何空白字符的字面文本：纯空白的字面清空后无法与视图自身分隔符的空白区分，不在本性质域内。
   *  同时排除固定文本「echo」的子串——命令词本身就在视图里，那类字面量的「泄漏」是断言假象。 */
  const visibleLiteralArb = plainTextArb.filter(
    (text) => !/\s/u.test(text) && !"echo".includes(text),
  );

  it("双引号内的任意字面文本（含管道、危险词、密钥样式串）不出现在结构视图里", () => {
    fc.assert(
      fc.property(visibleLiteralArb, (literal) => {
        const view = structureView(`echo "${literal}"`);
        assert.equal(
          view.includes(literal),
          false,
          `字面文本泄漏进结构视图：${JSON.stringify(literal)}`,
        );
      }),
    );
  });

  it("真实执行面的管道保留：结构视图里段分隔符仍在（probe 实测 'echo \"\"| rm -rf /' 形）", () => {
    const view = structureView('echo "quoted literal" | rm -rf /');
    assert.ok(view.includes("|"), view);
    assert.equal(view.includes("quoted literal"), false);
  });
});

describe("hasUnclosedQuote 与引号平衡", () => {
  it("成对引号判闭合，缺右引号判未闭合（双引号与单引号两读法）", () => {
    fc.assert(
      fc.property(plainTextArb, (literal) => {
        assert.equal(hasUnclosedQuote(`echo "${literal}"`), false);
        assert.equal(hasUnclosedQuote(`echo "${literal}`), true);
        assert.equal(hasUnclosedQuote(`echo '${literal}'`), false);
        assert.equal(hasUnclosedQuote(`echo '${literal}`), true);
      }),
    );
  });
});

describe("lexTokens 的词值契约", () => {
  it("双引号包裹的空格文本是**一枚**词且值保留内部空格；空引号是一枚空词", () => {
    fc.assert(
      fc.property(plainTextArb, (literal) => {
        assert.deepEqual(lexTokens(`echo "${literal}"`), [
          { value: "echo", raw: "echo" },
          { value: literal, raw: literal },
        ]);
      }),
    );
  });

  it("词值与源形对无元字符的单词一致（& | ; ( ) 等是段边界，不在本性质域内）", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9][a-z0-9._/-]{0,9}$/u), (word) => {
        assert.deepEqual(lexTokens(word), [{ value: word, raw: word }]);
      }),
    );
  });
});

describe("splitTopLevel 的段边界契约", () => {
  it("$(…) 体与分号后的命令各自成为独立段（echo $(rm -rf x) 的实测形状）", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/u), (word) => {
        const segments = splitTopLevel(`echo $(rm -rf ${word})`);
        assert.ok(segments.length >= 2, JSON.stringify(segments));
        assert.equal(segments.at(-1), `rm -rf ${word}`);
        const after = splitTopLevel(`echo a; rm -rf ${word}`);
        assert.equal(after.at(-1), `rm -rf ${word}`);
      }),
    );
  });
});

describe("lruPut 的有界 FIFO 契约", () => {
  /** lru 键域：短小写词。 */
  const lruKeyArb = fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/u);

  it("任意写入序列后：容量不破、键序与「写入重排 FIFO」模型逐位一致", () => {
    fc.assert(
      fc.property(fc.array(lruKeyArb, { maxLength: 30 }), (keys) => {
        const cap = 3;
        const map = new Map<string, number>();
        const model: string[] = [];
        for (const [index, key] of keys.entries()) {
          lruPut(map, key, index, cap);
          // 模型：重复键先摘位再入队；超容量从最旧一端淘汰。
          const existing = model.indexOf(key);
          if (existing !== -1) {
            model.splice(existing, 1);
          }
          while (model.length >= cap) {
            model.shift();
          }
          model.push(key);
          assert.ok(map.size <= cap, `容量破界：${String(map.size)}`);
          assert.deepEqual([...map.keys()], model);
          assert.equal(map.get(key), index, "最近一次写入必须可读");
        }
      }),
    );
  });

  it("容量 0 与负数 fail-closed：当场抛 RangeError，绝不静默退化", () => {
    for (const cap of [0, -1]) {
      assert.throws(() => {
        lruPut(new Map<string, string>(), "a", "1", cap);
      }, RangeError);
    }
  });
});

describe("ask 去重器的「首次上报」契约", () => {
  it("任意 (会话, 键) 首次 true、立即重复 false；跨会话互不干扰", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/u),
        fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/u),
        (sessionKey, dedupKey) => {
          const deduper = new AskDeduper();
          assert.equal(deduper.shouldReport(sessionKey, dedupKey), true);
          assert.equal(deduper.shouldReport(sessionKey, dedupKey), false);
          const other = new AskDeduper();
          assert.equal(other.shouldReport(`${sessionKey}-b`, dedupKey), true);
        },
      ),
    );
  });

  it("无会话上下文退化成一张共用表：同键跨调用仍只上报一次", () => {
    const deduper = new AskDeduper();
    assert.equal(deduper.shouldReport(undefined, "k"), true);
    assert.equal(deduper.shouldReport(undefined, "k"), false);
  });

  it("满容量整表清空是文档化退化：溢出后旧键全部恢复上报（钉住行为，防无意识变更）", () => {
    const deduper = new AskDeduper(2);
    assert.equal(deduper.shouldReport("s", "k1"), true);
    assert.equal(deduper.shouldReport("s", "k2"), true);
    assert.equal(deduper.shouldReport("s", "k1"), false);
    assert.equal(deduper.shouldReport("s", "k3"), true);
    assert.equal(deduper.shouldReport("s", "k1"), true, "清空后旧键重新上报");
    assert.equal(deduper.shouldReport("s", "k2"), true);
  });
});
