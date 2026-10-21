// test/confirm-dedup.test.ts —— 「同一动作只打扰一次」的去重表，与去重键的稳定性。
//
// 这一份单独钉 `lib/confirm.ts` 的 `AskDeduper` / `dedupKeyOf`：它是纯函数与一张有界表，
// 不碰宿主、不碰 fs，于是可以逐条钉住"同一会话同一命令第二次不再问"这件事。
//
// 为什么这件事故意**只影响上报与打扰次数、不影响判定**：去重掉的那一次仍然照旧交回
// `{ kind: "ask" }`。偷偷放行一次没被判过的危险命令，换来的"少打扰"不值。
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

describe("askDeduper：同一会话同一命令只问一次", () => {
  it("first 首次为 true（该问），同键第二次为 false（不再打扰）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    assert.equal(deduper.first("s-1", key), true);
    assert.equal(deduper.first("s-1", key), false);
  });

  it("会话之间互不影响（另一个会话里同一条命令仍然要问）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    assert.equal(deduper.first("s-1", key), true);
    assert.equal(deduper.first("s-2", key), true);
  });

  it("没有会话上下文时退化成一张共用表（仍然只问一次，而不是每次重问）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    assert.equal(deduper.first(undefined, key), true);
    assert.equal(deduper.first(undefined, key), false);
  });

  it("drop 只丢指定会话：丢掉之后那个会话重新开始问", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    deduper.first("s-1", key);
    deduper.first("s-2", key);
    deduper.drop("s-1");
    assert.equal(deduper.first("s-1", key), true, "丢掉分片后重新问");
    assert.equal(deduper.first("s-2", key), false, "别的会话不受影响");
  });

  it("reset 清空全部（插件重装时归零，与事实门 reset 同一条理由）", () => {
    const deduper = new AskDeduper();
    const key = dedupKeyOf("gitResetHard", RESET_HARD);
    deduper.first("s-1", key);
    deduper.reset();
    assert.equal(deduper.first("s-1", key), true);
  });

  it("每会话有上限：超过之后整表清空（有界内存，只退化成多问一次）", () => {
    const deduper = new AskDeduper(2);
    const first = dedupKeyOf("gitResetHard", RESET_HARD);
    const second = dedupKeyOf("gitCleanForce", "git clean -fd");
    const third = dedupKeyOf("gitStashDrop", "git stash drop");
    assert.equal(deduper.first("s", first), true);
    assert.equal(deduper.first("s", second), true);
    assert.equal(deduper.first("s", first), false, "上限内仍记得住");
    // 达到上限后新键触发整表清空：`first` 会被重新问一次（可接受的退化）。
    assert.equal(deduper.first("s", third), true);
    assert.equal(deduper.first("s", first), true, "清空后旧键重新问一次");
  });

  it("drop 一个从未出现过的会话 / 键是幂等的（不抛）", () => {
    const deduper = new AskDeduper();
    assert.doesNotThrow(() => {
      deduper.drop("never-seen");
      deduper.drop(undefined);
    });
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
});
