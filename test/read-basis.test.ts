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
  clearStaleness,
  commitReadObservation,
  discardReadObservation,
  MAX_STAGED_PER_KEY,
  observeVersion,
  readBasisLedgers,
  settleVersion,
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

  it("已落定的失效点不接受自证销账：写过的文本不能证明读过这一版", () => {
    const result = attributeExternalChange({
      lastEditSeq: 7,
      selfTextPresent: true,
      mtimeJump: true,
      pendingStaleBase: 3,
      jumpSeq: 3,
    });
    assert.equal(result.externallyChanged, true);
    assert.equal(result.staleBase, 3);
  });

  it("失效点与跳变同时在位时取较严的水位", () => {
    const laterJump = attributeExternalChange({
      lastEditSeq: 7,
      selfTextPresent: true,
      mtimeJump: true,
      pendingStaleBase: 3,
      jumpSeq: 9,
    });
    assert.equal(laterJump.externallyChanged, true);
    assert.equal(laterJump.staleBase, 9, "跳变晚于失效点，要按更晚的读取才解除");

    const earlierJump = attributeExternalChange({
      lastEditSeq: 7,
      selfTextPresent: true,
      mtimeJump: true,
      pendingStaleBase: 9,
      jumpSeq: 3,
    });
    assert.equal(earlierJump.externallyChanged, true);
    assert.equal(earlierJump.staleBase, 9, "失效点晚于跳变，跳变不能把它降回较早水位");
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
    stageReadObservation(`old|${TARGET}`, 1000, TARGET);
    commitReadObservation(`old|${TARGET}`);
    const first = observeVersion(KEY, TARGET, 2000);
    const second = observeVersion(OTHER_KEY, TARGET, 2000);
    assert.equal(first.mtimeJump, true);
    assert.equal(second.mtimeJump, true, "后到的会话同样要从旧基线判跳变");
  });

  it("本会话自己有观测记录时以自己那份为准，不看全局基线", () => {
    stageReadObservation(KEY, 500, TARGET);
    commitReadObservation(KEY);
    // 把全局基线抬到 900（另一会话提交更晚的一版）：两条来源取不同值才有判别力。
    stageReadObservation(OTHER_KEY, 900, TARGET);
    commitReadObservation(OTHER_KEY);
    const own = observeVersion(KEY, TARGET, 700);
    assert.equal(own.mtimeJump, true, "自己那份是 500 ⇒ 700 应判跳变；误用全局 900 会得 false");
  });
});

describe("settleVersion：全局基线在结论落定时刷新", () => {
  beforeEach(() => {
    clearReadBasis();
  });

  it("落定之后推进全局基线：后到的会话按新基线判跳变", () => {
    stageReadObservation(KEY, 1000, TARGET);
    commitReadObservation(KEY);
    settleVersion(KEY, TARGET, 2000, -1);
    const later = observeVersion(OTHER_KEY, TARGET, 3000);
    assert.equal(later.mtimeJump, true);
  });

  it("全局基线已推进到落定那一版：更早的版本不再误判跳变", () => {
    stageReadObservation(KEY, 1000, TARGET);
    commitReadObservation(KEY);
    settleVersion(KEY, TARGET, 3000, -1);
    const earlier = observeVersion(OTHER_KEY, TARGET, 2000);
    assert.equal(earlier.mtimeJump, false, "全局基线停在 3000 时，2000 不能越过它判跳变");
  });

  it("落定的失效点与观测版本写进同一条记录", () => {
    settleVersion(KEY, TARGET, 2000, 5);
    const seen = observeVersion(KEY, TARGET, 2000);
    assert.equal(seen.staleBase, 5);
    assert.equal(seen.mtimeJump, false);
  });
});

describe("clearStaleness：只解除失效点，不动观测基线", () => {
  beforeEach(() => {
    clearReadBasis();
  });

  it("有失效点时解除，mtime 基线保留", () => {
    settleVersion(KEY, TARGET, 2000, 5);
    clearStaleness(KEY);
    const seen = observeVersion(KEY, TARGET, 2000);
    assert.equal(seen.staleBase, -1);
    assert.equal(seen.mtimeJump, false, "解除失效点不能把观测基线一起清掉");
  });

  it("没有记录时是空操作，不为该键新建记录", () => {
    clearStaleness(KEY);
    assert.equal(basisTable().has(KEY), false);
  });
});

describe("暂存观测：同一目标上多笔读同时在飞时按先后排队", () => {
  beforeEach(() => {
    clearReadBasis();
  });

  it("两次暂存各自被自己的提交取走，先暂存的那笔落的是先那一版 mtime", () => {
    stageReadObservation(KEY, 1111, TARGET);
    stageReadObservation(KEY, 2222, TARGET);
    commitReadObservation(KEY);
    assert.deepEqual(basisTable().get(KEY), { mtimeMs: 1111, staleBase: -1 });
    commitReadObservation(KEY);
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
    commitReadObservation(KEY);
    assert.deepEqual(basisTable().get(KEY), { mtimeMs: 2222, staleBase: -1 });
    assert.equal(stagedTable().size, 0);
  });

  it("同一键的暂存队列有上限：超出的最旧记录被丢掉，不能无限堆积", () => {
    for (let index = 1; index <= MAX_STAGED_PER_KEY + 1; index += 1) {
      stageReadObservation(KEY, index, TARGET);
    }
    commitReadObservation(KEY);
    assert.deepEqual(
      basisTable().get(KEY),
      { mtimeMs: 2, staleBase: -1 },
      "最旧的一笔被淘汰，队首应是第二笔",
    );
  });
});

describe("clearReadBasis：换代要把全局基线一起清掉", () => {
  beforeEach(() => {
    clearReadBasis();
  });

  it("清完之后新一代不继承上一代的观测基线", () => {
    stageReadObservation(KEY, 100, TARGET);
    commitReadObservation(KEY);
    clearReadBasis();
    const fresh = observeVersion(OTHER_KEY, TARGET, 1000);
    assert.equal(fresh.mtimeJump, false, "上一代那 100 没有资格当新一代的基线");
    assert.equal(fresh.staleBase, -1);
  });

  it("按会话那两张表都清空，且台账集合仍是两张（全局基线不按会话回收）", () => {
    stageReadObservation(KEY, 1, TARGET);
    stageReadObservation(`other|${OTHER_ROOT}`, 2, OTHER_ROOT);
    commitReadObservation(`other|${OTHER_ROOT}`);
    clearReadBasis();
    assert.equal(basisTable().size, 0);
    assert.equal(stagedTable().size, 0);
    assert.equal(readBasisLedgers().length, 2);
  });
});
