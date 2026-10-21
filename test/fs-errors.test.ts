// test/fs-errors.test.ts —— 存在性判定必须读 `error.code`，不能只看 message 前缀。
//
// 为什么要有这条：`isNotFoundError` 决定"新建文件免 read"这道豁免给不给，而它的失效方向是
// **放宽**（把"不可知"读成"不存在" ⇒ 免掉 read）。Windows 上 `ENOTDIR`（路径中间是文件）
// 的错误 message 措辞与 POSIX 不同 —— 只认 `startsWith("ENOENT")` 时这一格会判错
//（实测 CI 上「stat 因 ENOTDIR 失败 ⇒ 不给新建豁免」那条用例红）。
//
// 它在 `lib/fs-errors.ts` 里，是纯函数，所以能直接喂两种错误形状验证。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { isNotFoundError, presenceOfAttempt } from "../lib/fs-errors.ts";

/** 造一个只带指定字段的 fs 错误（Node 的真实错误两者都有，这里故意只给一个）。 */
const fsError = (fields: { code?: string; message?: string }): Error =>
  Object.assign(new Error(fields.message ?? ""), fields);

describe("isNotFoundError：`code` 优先于 message", () => {
  it("只有 code=ENOENT 才算「不存在」（message 措辞无关）", () => {
    assert.equal(isNotFoundError(fsError({ code: "ENOENT", message: "任何平台的措辞" })), true);
  });

  it("code=ENOTDIR ⇒ 不是「不存在」（路径中间是文件，文件其实在）", () => {
    const error = fsError({ code: "ENOTDIR", message: "ENOTDIR: not a directory, stat '/x/y'" });
    assert.equal(isNotFoundError(error), false, "把 ENOTDIR 读成不存在会免掉 read");
  });

  it("code=EACCES / ELOOP ⇒ 同样不是「不存在」", () => {
    assert.equal(isNotFoundError(fsError({ code: "EACCES", message: "EACCES: denied" })), false);
    assert.equal(isNotFoundError(fsError({ code: "ELOOP", message: "ELOOP: cycle" })), false);
  });

  it("没有 code 时才回落到 message 前缀（向后兼容老宿主/自定义 fs）", () => {
    assert.equal(isNotFoundError(fsError({ message: "ENOENT: no such file, stat '/x'" })), true);
    assert.equal(isNotFoundError(fsError({ message: "其它错误" })), false);
  });

  it("非对象 / null / 字符串一律不算「不存在」（不猜）", () => {
    for (const value of [null, undefined, "ENOENT", 42]) {
      assert.equal(isNotFoundError(value), false, String(value));
    }
  });

  it("code 存在但不是字符串时回落到 message（形状漂移不当成 ENOENT）", () => {
    const drifted = Object.assign(new Error("ENOENT: ok"), { code: 17 });
    assert.equal(isNotFoundError(drifted), true, "code 非字符串时仍认 message 前缀");
  });
});

describe("presenceOfAttempt：三态分类（与平台无关）", () => {
  it("拿到 mtime ⇒ present", () => {
    assert.deepEqual(
      presenceOfAttempt(() => 1234),
      { presence: "present", mtimeMs: 1234 },
    );
  });

  it("errno 是 ENOENT ⇒ absent（只有这一种才算不存在）", () => {
    const error = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    assert.deepEqual(
      presenceOfAttempt(() => {
        throw error;
      }),
      { presence: "absent", mtimeMs: -1 },
    );
  });

  it("任何其它错误 ⇒ unknown（含 ENOTDIR / EACCES / ELOOP / 非 Error）", () => {
    const others = [
      Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" }),
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
      Object.assign(new Error("ELOOP"), { code: "ELOOP" }),
      // 非 Error 的抛出物：真实世界存在（第三方 fs 替身会抛字符串）。
      "字符串",
    ];
    for (const thrown of others) {
      const attempt = (): number => {
        // oxlint-disable-next-line typescript/only-throw-error -- 故意抛非 Error，验证形状守卫
        throw thrown;
      };
      assert.deepEqual(
        presenceOfAttempt(attempt),
        { presence: "unknown", mtimeMs: -1 },
        typeof thrown,
      );
    }
  });

  it("present 分支的 mtime 就是 attempt 的返回值，不是常量", () => {
    assert.equal(presenceOfAttempt(() => 0).mtimeMs, 0);
    assert.equal(presenceOfAttempt(() => 1_700_000_000).mtimeMs, 1_700_000_000);
  });
});
