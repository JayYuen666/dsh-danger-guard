// test/confirm-dedup.test.ts —— 「同一动作只上报一次」的去重表，与去重键的稳定性。
//
// 这一份单独钉 `lib/confirm.ts` 的 `AskDeduper` / `dedupKeyOf`：它是纯函数与一张有界表，
// 不碰宿主、不碰 fs，于是可以逐条钉住"同一会话同一命令第二次不再上报"这件事。
//
// 为什么这件事故意**只影响上报、不影响判定**：去重掉的那一次仍然照旧交回
// `{ kind: "ask" }`。偷偷放行一次没被判过的危险命令，换来的"少上报"不值。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { AskDeduper, dedupKeyOf } from "../lib/confirm.ts";

/** 两条反复出现的命令原文（去重键的行为全由它们驱动）。 */
const RESET_HARD = "git reset --hard";
const FORCE_PUSH = "git push --force";

describe("dedupKeyOf：同一条命令得同一个键，不同命令得不同键", () => {
  it("同一规则键 + 同一命令原文 ⇒ 同一个键（重复命中才可能被认出来）", () => {
    const first = dedupKeyOf("gitForcePush", FORCE_PUSH);
    const again = dedupKeyOf("gitForcePush", FORCE_PUSH);
    assert.equal(first, again);
  });

  it("命令原文改一个字符 ⇒ 另一个键（不能把不同命令当成同一条）", () => {
    assert.notEqual(
      dedupKeyOf("gitForcePush", FORCE_PUSH),
      dedupKeyOf("gitForcePush", "git push --force origin main"),
    );
    // 等长、仅一个字符不同：长度段相同，摘要必须真正参与键形。
    assert.notEqual(
      dedupKeyOf("gitForcePush", "git push --force a"),
      dedupKeyOf("gitForcePush", "git push --force b"),
    );
  });

  it("规则键参与键形：同一条命令落在两枚规则下互不去重", () => {
    assert.notEqual(
      dedupKeyOf("gitForcePush", FORCE_PUSH),
      dedupKeyOf("gitCleanForce", FORCE_PUSH),
    );
  });

  it("键里带长度：极长的命令不会因为摘要相同就与另一条长命令合并", () => {
    const long = "x".repeat(10_000);
    const key = dedupKeyOf("pipeShell", long);
    assert.ok(key.endsWith(`:${long.length}`));
    // 两条长度不同的命令即便摘要撞了也不会被判成同一条。
    assert.notEqual(key, dedupKeyOf("pipeShell", `${long}y`));
  });
});

describe("askDeduper：同一会话同一命令只上报一次", () => {
  it("shouldReport 首次为 true（该上报），同键第二次为 false（不再上报）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    assert.equal(deduper.shouldReport("s-1", key), true);
    assert.equal(deduper.shouldReport("s-1", key), false);
  });

  it("会话之间互不影响（另一个会话里同一条命令仍然要上报）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    assert.equal(deduper.shouldReport("s-1", key), true);
    assert.equal(deduper.shouldReport("s-2", key), true);
  });

  it("没有会话上下文时退化成一张共用表（仍然只上报一次，而不是每次重报）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    assert.equal(deduper.shouldReport(undefined, key), true);
    assert.equal(deduper.shouldReport(undefined, key), false);
  });

  it("drop 只丢指定会话：丢掉之后那个会话重新开始上报", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    deduper.shouldReport("s-1", key);
    deduper.shouldReport("s-2", key);
    deduper.drop("s-1");
    assert.equal(deduper.shouldReport("s-1", key), true, "丢掉分片后重新上报");
    assert.equal(deduper.shouldReport("s-2", key), false, "别的会话不受影响");
  });

  it("reset 清空全部（插件重装时归零，与事实门 reset 同一条理由）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    deduper.shouldReport("s-1", key);
    deduper.shouldReport("s-2", key);
    deduper.reset();
    assert.equal(deduper.shouldReport("s-1", key), true, "s-1 分片已清空");
    assert.equal(deduper.shouldReport("s-2", key), true, "s-2 分片同样清空");
  });

  it("每会话有上限：超过之后整表清空（有界内存，只退化成多上报一次）", () => {
    const deduper = new AskDeduper(2);
    const first = dedupKeyOf("gitResetHard", RESET_HARD);
    const second = dedupKeyOf("gitCleanForce", "git clean -fd");
    const third = dedupKeyOf("gitStashDrop", "git stash drop");
    assert.equal(deduper.shouldReport("s", first), true);
    assert.equal(deduper.shouldReport("s", second), true);
    assert.equal(deduper.shouldReport("s", first), false, "上限内仍记得住");
    // 达到上限后新键触发整表清空：同一个键会被重新上报一次（可接受的退化）。
    assert.equal(deduper.shouldReport("s", third), true);
    assert.equal(deduper.shouldReport("s", first), true, "清空后旧键重新上报一次");
  });

  it("perSession 只收正安全整数：非法容量直接拒绝，避免分片永不清空", () => {
    for (const invalid of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => new AskDeduper(invalid), RangeError, String(invalid));
    }
  });

  it("maxSessions 只收正安全整数；分片数有上限，最旧的按插入序淘汰", () => {
    for (const invalid of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => new AskDeduper(4, invalid), RangeError, String(invalid));
    }
    const deduper = new AskDeduper(4, 2);
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    assert.equal(deduper.shouldReport("s-1", key), true);
    assert.equal(deduper.shouldReport("s-2", key), true);
    assert.equal(deduper.shouldReport("s-2", key), false, "容量内的会话照常去重");
    // 先再命中一次 s-1：读取不续命，后面被淘汰的仍应是最早插入的 s-1（FIFO，不是 LRU）。
    assert.equal(deduper.shouldReport("s-1", key), false);
    // 第三个会话挤进两个分片位：最旧的 s-1 被淘汰，s-2 / s-3 存活。
    assert.equal(deduper.shouldReport("s-3", key), true);
    assert.equal(
      deduper.shouldReport("s-2", key),
      false,
      "读取不续命：s-2 仍在（若按 LRU 它会先被淘汰）",
    );
    assert.equal(deduper.shouldReport("s-1", key), true, "最旧的分片被淘汰：重新上报");
    assert.equal(deduper.shouldReport("s-3", key), false, "最新的分片还在：去重照常");
  });

  it("drop 一个从未出现过的会话 / 键是幂等的（不抛）", () => {
    const deduper = new AskDeduper();
    assert.doesNotThrow(() => {
      deduper.drop("never-seen");
      deduper.drop(undefined);
    });
  });

  it("drop(undefined) 真的丢掉无会话共用分片（不是空实现）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    assert.equal(deduper.shouldReport(undefined, key), true);
    deduper.drop(undefined);
    assert.equal(deduper.shouldReport(undefined, key), true, "丢掉之后重新上报");
  });
});

describe("dedupKeyOf：空命令与超长命令的边界", () => {
  it("空命令也得一个稳定键（不抛、不返回空串以外的意外形状）", () => {
    const key = dedupKeyOf("pipeShell", "");
    assert.equal(typeof key, "string");
    assert.ok(key.startsWith("pipeShell:"));
    assert.ok(key.endsWith(":0"), "长度段是 0");
    assert.equal(key, dedupKeyOf("pipeShell", ""), "稳定");
  });

  it("码点落在 BMP 之外（emoji）不改变键的稳定性", () => {
    const command = "echo 🚀🔒";
    assert.equal(dedupKeyOf("pipeShell", command), dedupKeyOf("pipeShell", command));
    assert.notEqual(dedupKeyOf("pipeShell", command), dedupKeyOf("pipeShell", "echo"));
  });

  it("同一高位代理项的不同码点不能得到同一个键（低代理项不能被丢掉）", () => {
    assert.notEqual(
      dedupKeyOf("pipeShell", "echo 😀"),
      dedupKeyOf("pipeShell", "echo 😁"),
      "不同命令不能因为共享高位代理项而被当成同一条",
    );
  });
});
