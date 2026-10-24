// test/read-basis.test.ts —— 「模型读到的是哪一版」这张账本的四个方向。
//
// 这个文件盯的是 lib/read-basis.ts 里四条都不会当场报错的失效方式：
//  · 自证把"取不到写入文本"当成"我写的"；
//  · 全局基线被先到的那次观察顺手刷掉，后到的会话再也看不见跳变；
//  · 同一目标上多笔读同时在飞时，只有最后暂存的那一笔活下来；
//  · 卸载换代只清了按会话的那两张表，全局基线跨代存活。
// 全都靠返回值与台账内容表现，不抛错、不告警——所以要在这里逐条钉住。
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import {
  attributeExternalChange,
  clearReadBasis,
  commitReadObservation,
  discardReadObservation,
  observeVersion,
  readBasisLedgers,
  stageReadObservation,
} from "../lib/read-basis.ts";

/** 一次占位归因：默认参数是「本轮看到跳变、之前没有失效点」。 */
const attributeOf = (input: {
  lastEditSeq: number;
  selfTextPresent: boolean | undefined;
  jumpSeq: number;
}): ReturnType<typeof attributeExternalChange> =>
  attributeExternalChange({ mtimeJump: true, pendingStaleBase: -1, ...input });

/** 按会话那份台账（`readBasisLedgers` 的第 0 项；注解保证它一定在）。 */
const basisTable = (): Map<string, unknown> => readBasisLedgers()[0]!;

/** 暂存那份台账（第 1 项）。 */
const stagedTable = (): Map<string, unknown> => readBasisLedgers()[1]!;

/** 目标目录：按平台根拼，不写死 POSIX 形（Windows 上 `/w` 是「当前盘相对」，落点会漂）。 */
const WORK_ROOT = path.resolve(path.parse(process.cwd()).root, "w");
/** 被判的目录（键里的 goal 段）。 */
const OTHER_ROOT = path.resolve(path.parse(process.cwd()).root, "w2");

const TARGET = path.join(WORK_ROOT, "f.ts");
const KEY = `sess-a|${TARGET}`;
const OTHER_KEY = `sess-b|${TARGET}`;

describe("attributeExternalChange：自证要真的知道，不是「没说不」", () => {
  beforeEach(() => {
    clearReadBasis();
  });

  it("取不到写入文本（selfTextPresent 为 undefined）⇒ 不算自证，判外部改动", () => {
    const result = attributeOf({ lastEditSeq: 7, selfTextPresent: undefined, jumpSeq: 7 });
    assert.equal(result.externallyChanged, true, "不知 ≠ 自证");
    assert.equal(result.staleBase, 7);
  });

  it("写入文本仍在（true）⇒ 自证成立，不判外部改动", () => {
    const result = attributeOf({ lastEditSeq: 7, selfTextPresent: true, jumpSeq: 7 });
    assert.equal(result.externallyChanged, false);
    assert.equal(result.staleBase, -1);
  });

  it("本会话从未编辑过 ⇒ 跳变只能判外部；jumpSeq 退到 -1 时连水位都留不下", () => {
    // 有跳变、有日志位、但从未编辑过：自证拿不出写入位置，判外部。
    const laterJump = attributeExternalChange({
      lastEditSeq: -1,
      selfTextPresent: true,
      mtimeJump: true,
      pendingStaleBase: -1,
      jumpSeq: 0,
    });
    assert.equal(laterJump.externallyChanged, true, "从未编辑过就不可能自证这次跳变");
    assert.equal(laterJump.staleBase, 0);

    // 两个 -1 相等（host.ts 在"本会话没有历史位"时会把 jumpSeq 退到 -1）：水位停在 -1，
    // 于是这一轮判不出外部改动。这是那枚回落值的已知代价，不是自证被误信。
    const bothMinusOne = attributeExternalChange({
      lastEditSeq: -1,
      selfTextPresent: true,
      mtimeJump: true,
      pendingStaleBase: -1,
      jumpSeq: -1,
    });
    assert.equal(bothMinusOne.staleBase, -1);
    assert.equal(bothMinusOne.externallyChanged, false);
  });
});

describe("observeVersion：全局基线不能被先到的那次观察顺手刷掉", () => {
  beforeEach(() => {
    clearReadBasis();
  });

  it("两个会话依次观察同一版本 ⇒ 两边都看到这次跳变", () => {
    // 先造一份"更早的版本"：另一个会话提交过 1000。
    commitReadObservation(`old|${TARGET}`, TARGET, 1000);
    const first = observeVersion(KEY, TARGET, 2000);
    const second = observeVersion(OTHER_KEY, TARGET, 2000);
    assert.equal(first.mtimeJump, true);
    assert.equal(second.mtimeJump, true, "后到的会话同样要从旧基线判跳变");
  });

  it("本会话自己有观测记录时以自己那份为准，不看全局基线", () => {
    commitReadObservation(KEY, TARGET, 500);
    const again = observeVersion(KEY, TARGET, 400);
    assert.equal(again.mtimeJump, false, "版本后退不是跳变");
  });
});

describe("暂存观测：同一目标上多笔读同时在飞时按先后排队", () => {
  beforeEach(() => {
    clearReadBasis();
  });

  it("两次暂存各自被自己的提交取走，先暂存的那笔落的是先那一版 mtime", () => {
    stageReadObservation(KEY, 1111, TARGET);
    stageReadObservation(KEY, 2222, TARGET);
    commitReadObservation(KEY, TARGET, 3333);
    assert.deepEqual(basisTable().get(KEY), { mtimeMs: 1111, staleBase: -1 });
    commitReadObservation(KEY, TARGET, 4444);
    assert.deepEqual(basisTable().get(KEY), { mtimeMs: 2222, staleBase: -1 });
    assert.equal(stagedTable().size, 0, "两笔都被取走之后队列不该留空壳");
  });

  it("丢弃只吃掉队首那笔，后面那笔仍会被自己的提交取走", () => {
    stageReadObservation(KEY, 1111, TARGET);
    stageReadObservation(KEY, 2222, TARGET);
    // 第一笔读失败：只丢队首，基线不动。
    discardReadObservation(KEY);
    assert.equal(basisTable().has(KEY), false, "失败的那次读不提交基线");
    // 第二笔读成功：拿到的是它自己那一版，不是被顶掉的 1111 也不是现读的 9999。
    commitReadObservation(KEY, TARGET, 9999);
    assert.deepEqual(basisTable().get(KEY), { mtimeMs: 2222, staleBase: -1 });
    assert.equal(stagedTable().size, 0);
  });
});

describe("clearReadBasis：换代要把全局基线一起清掉", () => {
  beforeEach(() => {
    clearReadBasis();
  });

  it("清完之后新一代不继承上一代的观测基线", () => {
    commitReadObservation(KEY, TARGET, 100);
    clearReadBasis();
    const fresh = observeVersion(OTHER_KEY, TARGET, 1000);
    assert.equal(fresh.mtimeJump, false, "上一代那 100 没有资格当新一代的基线");
    assert.equal(fresh.staleBase, -1);
  });

  it("按会话那两张表都清空，且台账集合仍是两张（全局基线不按会话回收）", () => {
    stageReadObservation(KEY, 1, TARGET);
    commitReadObservation(`other|${OTHER_ROOT}`, OTHER_ROOT, 2);
    clearReadBasis();
    assert.equal(basisTable().size, 0);
    assert.equal(stagedTable().size, 0);
    assert.equal(readBasisLedgers().length, 2);
  });
});
