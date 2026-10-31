// test/setup-logs.test.ts —— 日志账本两列归类的判据。
//
// 账本本身是 vitest setupFile，跑在每个用例前后；这里只测它交给 afterEach 的两份名单，
// 因为「没有标签的日志」原先两边都不进，正是这条契约最容易漏的形状。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { LOG_TEMPLATES } from "./log-templates.ts";
import { install, strangerTextsOf, unclaimedTextsOf, uninstall } from "./setup-logs.ts";
import type { LogRecord } from "./setup-logs.ts";

const record = (text: string): LogRecord => ({ level: "warn", text, extra: [] });

describe("日志账本的归类", () => {
  it("没有标签的日志也算别家：console.warn(error) 不能两边都不进", () => {
    assert.deepEqual(strangerTextsOf([record("boom")]), ["boom"]);
  });

  it("带别家标签的日志算别家", () => {
    assert.deepEqual(strangerTextsOf([record("[other-plugin] hello")]), ["[other-plugin] hello"]);
  });

  it("本包标签但模板不认领 ⇒ 进未认领列", () => {
    assert.deepEqual(unclaimedTextsOf([record("[danger-guard] 临时拼的消息")]), [
      "[danger-guard] 临时拼的消息",
    ]);
  });

  it("本包标签且命中模板 ⇒ 两列都为空", () => {
    const [known] = LOG_TEMPLATES;
    assert.ok(known !== undefined, "模板清单不能为空");
    const text = `${known} 具体内容`;
    assert.deepEqual(strangerTextsOf([record(text)]), []);
    assert.deepEqual(unclaimedTextsOf([record(text)]), []);
  });

  it("重复 install 是幂等的：漏掉一次 uninstall 也不会把 spy 当原始实现", () => {
    let original = console.warn;
    try {
      uninstall();
      original = console.warn;
      install();
      install();
      uninstall();
      assert.equal(console.warn, original, "两层 spy 只还原一层会把 console 永久留在账本里");
    } finally {
      uninstall();
      console.warn = original;
    }
  });
});
