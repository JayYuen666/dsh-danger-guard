// test/lru.test.ts —— 容量口径的**入口校验**（lib/lru.ts）。
//
// 这枚模块存在的理由是"容量只该有一条口径"；入口不校验时，`cap <= 0` 或 `NaN` 会让
// 淘汰循环把整张台账删空、`Infinity` 等于关掉淘汰——约束静默失效且没有任何报错。
// 各台账的真实行为由各自的使用方用例钉（read-basis / target-paths / confirm 的去重表），
// 这里只钉"非法容量进不来"这一条。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { LEDGER_CAP, lruPut } from "../lib/lru.ts";

describe("lruPut：容量入口校验", () => {
  it("非法容量（0 / 负数 / 非整数 / NaN / Infinity）直接拒绝，台账不被部分改写", () => {
    for (const cap of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const map = new Map<string, number>([
        ["old", 1],
        ["newer", 2],
      ]);
      assert.throws(
        () => {
          lruPut(map, "k", 1, cap);
        },
        RangeError,
        String(cap),
      );
      assert.equal(map.size, 2, "拒绝必须发生在删/插之前：台账仍是原样");
      assert.deepEqual([...map.keys()], ["old", "newer"]);
    }
  });

  it("合法容量语义不变：超容量按插入序淘汰，先删后插刷新位次", () => {
    const map = new Map<string, number>();
    lruPut(map, "a", 1, 2);
    lruPut(map, "b", 2, 2);
    // 已在表内：先删后插，位次挪到最后。
    lruPut(map, "a", 10, 2);
    // 满员：淘汰最旧的 b。
    lruPut(map, "c", 3, 2);
    assert.deepEqual(
      [...map.entries()],
      [
        ["a", 10],
        ["c", 3],
      ],
    );
    // 默认容量（各台账共用的那枚常量）走同一条入口：攒满即按插入序淘汰最旧。
    const byDefault = new Map<string, number>();
    for (let index = 0; index < LEDGER_CAP; index += 1) {
      lruPut(byDefault, `k${index}`, index);
    }
    lruPut(byDefault, "overflow", -1);
    assert.equal(byDefault.size, LEDGER_CAP, "默认容量下超限淘汰，总量不涨");
    assert.equal(byDefault.has("k0"), false, "最旧的一枚被淘汰");
    assert.equal(byDefault.get("overflow"), -1);
  });
});
