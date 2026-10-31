// lib/secret-patterns.ts 单元测试：用户扩展密钥模式的校验、编译与按内容记账的缓存。
//
// 这里判的是两件事：换算据要跟着清单内容走（改了配置不能读到旧缓存），以及同一份清单
// 不该在工具调用的同步主路径上反复编译（README 与 DETAIL 承诺「加载期编译一次」）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { partitionSecretPatterns } from "../lib/secret-patterns.ts";

describe("密钥模式清单的校验与编译按清单内容记账（#22）", () => {
  it("清单内容一变即换算据：坏→好不再被拒，回到坏清单仍按坏清单判", () => {
    const broken = ["secret-(a", "^ok$"];
    assert.deepEqual(partitionSecretPatterns(broken).rejected, ["secret-(a"]);
    const repaired = [String.raw`secret\(a`, "^ok$"];
    assert.deepEqual(partitionSecretPatterns(repaired).rejected, [], "修好之后同一位置没有残留");
    assert.deepEqual(
      partitionSecretPatterns(broken).rejected,
      ["secret-(a"],
      "换回旧清单仍给出旧清单的结论（缓存不串味）",
    );
  });

  it("交回的是新数组：调用方就地改写不会污染同一份清单的下一次读数", () => {
    const list = ["^token$"];
    const first = partitionSecretPatterns(list);
    first.accepted.push("POLLUTED");
    const second = partitionSecretPatterns(list);
    assert.notEqual(second.accepted, first.accepted, "不是同一枚数组");
    assert.deepEqual(second.accepted, ["^token$"]);
  });

  it("超出缓存容量后重算，结论逐字不变", () => {
    const lists: string[][] = [];
    for (let index = 0; index < 12; index += 1) {
      lists.push([`^p${String(index)}$`, "[bad"]);
    }
    const first = partitionSecretPatterns(lists[0]!);
    for (const list of lists) {
      partitionSecretPatterns(list);
    }
    const again = partitionSecretPatterns(lists[0]!);
    assert.deepEqual(again, first, "被淘汰的那一份重算后同结论");
  });
});

describe("同一份密钥模式清单不再重编（#22 的编译口径）", () => {
  it("首读之后重复读同一份清单，不再生成 RegExp", () => {
    // 只在读数窗口里换掉 RegExp 构造器：判定链每次现读设置值，若逐次重编，
    // 「加载期编译一次」就只是文档说法。计数落在窗口内，别的时间构造不算。
    const RealRegExp = RegExp;
    const list = ["^a$", "[bad"];
    let builds = 0;
    class CountingRegExp extends RealRegExp {
      public constructor(source: string | RegExp, flags?: string) {
        super(source, flags);
        builds += 1;
      }
    }
    globalThis.RegExp = CountingRegExp as unknown as RegExpConstructor;
    try {
      partitionSecretPatterns(list);
      builds = 0;
      partitionSecretPatterns(list);
      partitionSecretPatterns(list);
    } finally {
      globalThis.RegExp = RealRegExp;
    }
    assert.equal(builds, 0, "同内容命中缓存时不该再编译");
  });
});
