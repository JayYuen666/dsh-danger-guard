// test/settings-read.test.ts —— 设置值面的防御性读取：数值与数组字段的降级口径。
//
// 这一层兜的是未经设置 schema 校验的值面（降级注册后的持久段、旧版本残留、手改 profile）。
// 判据只有一条：读不懂就回落内置默认，绝不把脏值读成"更宽松"的阈值。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { DEFAULT_BIG_EDIT_CHARS, DEFAULT_SMALL_EDIT_CHARS } from "../lib/fact-gate.ts";
import { editThresholdsOf, numOf, strArray } from "../lib/settings-read.ts";

/** 一份最小可用的设置值面（其余键由默认底座补齐）。 */
function builtin(): Parameters<typeof editThresholdsOf>[0] {
  return {
    enabled: true,
    factGateEnabled: true,
    preflightEnabled: true,
    judgeStats: false,
    maxDenies: 2,
    strictMode: false,
    smallEditChars: DEFAULT_SMALL_EDIT_CHARS,
    bigEditChars: DEFAULT_BIG_EDIT_CHARS,
    extraTestDirs: [],
    extraDevServerWords: [],
    extraDevRunArgs: [],
    extraSecretPatterns: [],
    refSearchTools: [],
    refSearchStrictTools: [],
  };
}

describe("numOf：只接受有限正安全整数", () => {
  it("正常数值原样交回", () => {
    assert.equal(numOf(80, 200), 80);
    assert.equal(numOf(2000, 2000), 2000);
  });

  it("字符串、数组、布尔、超安全整数与非法数一律回落默认", () => {
    for (const value of [
      "800",
      " 800 ",
      [800],
      true,
      Number.MAX_SAFE_INTEGER + 1,
      0,
      -1,
      Number.NaN,
      Infinity,
    ]) {
      assert.equal(numOf(value, 200), 200, String(value));
    }
  });
});

describe("strArray：数组字段的形状与告警", () => {
  it("合法数组原样交回，显式空数组保持为空数组", () => {
    assert.deepEqual(strArray(["grep"], "refSearchTools"), ["grep"]);
    assert.deepEqual(strArray([], "refSearchTools"), []);
  });

  it("非数组按未配置处理，缺失值不告警", () => {
    assert.equal(strArray("grep", "refSearchTools"), undefined);
    assert.equal(strArray(undefined, "refSearchTools"), undefined);
  });

  it("整组都是非字符串项 ⇒ 未配置（不是显式清空）", () => {
    assert.equal(strArray([1, false], "extraTestDirs"), undefined);
  });

  it("部分合法 ⇒ 只留字符串项", () => {
    assert.deepEqual(strArray(["src", 1], "extraTestDirs"), ["src"]);
  });
});

describe("editThresholdsOf：冲突的一对整对回落", () => {
  it("small < big 时保留用户值", () => {
    assert.deepEqual(editThresholdsOf({ ...builtin(), smallEditChars: 80, bigEditChars: 900 }), {
      smallChars: 80,
      bigChars: 900,
    });
  });

  it("small ≥ big 时两条都回落内置默认，不做局部推断", () => {
    assert.deepEqual(
      editThresholdsOf({ ...builtin(), smallEditChars: 200_000, bigEditChars: 100_000 }),
      { smallChars: DEFAULT_SMALL_EDIT_CHARS, bigChars: DEFAULT_BIG_EDIT_CHARS },
    );
  });
});
