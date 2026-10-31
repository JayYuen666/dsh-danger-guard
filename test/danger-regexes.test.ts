// test/danger-regexes.test.ts —— 正则字面量判据的边界。
//
// 这条判据决定用户给的密钥模式是「裸片段」还是「写成字面量」；判错的方向是静默失效
// （字面量被当裸片段编译，永远匹配不到），所以逐形钉住。
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { isSlashPatternLiteral } from "../lib/danger-regexes.ts";

describe("isSlashPatternLiteral", () => {
  it("非斜杠开头或过短的一律不是字面量", () => {
    assert.equal(isSlashPatternLiteral("x"), false);
    assert.equal(isSlashPatternLiteral(String.raw`secrets/prod\.env$`), false);
    assert.equal(isSlashPatternLiteral("/"), false);
  });

  it("整串被斜杠包住、flags 合法才算字面量", () => {
    assert.equal(isSlashPatternLiteral("/x/"), true);
    assert.equal(isSlashPatternLiteral("/x/gi"), true);
    assert.equal(isSlashPatternLiteral("/x/z"), false, "非法 flags 不是字面量");
    assert.equal(isSlashPatternLiteral("/x"), false, "缺闭合斜杠");
  });

  it("字符类里的斜杠不结束字面量", () => {
    assert.equal(isSlashPatternLiteral(String.raw`/^[^/]+\.env$/i`), true);
    assert.equal(isSlashPatternLiteral("/[a/b]/"), true);
  });

  it("转义斜杠不结束字面量", () => {
    assert.equal(isSlashPatternLiteral(String.raw`/a\/b/`), true);
  });
});
