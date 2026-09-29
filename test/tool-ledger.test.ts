/**
 * 等价用例（投影的验收面，danger-guard 侧）：同一个事件数组分别喂
 *   - 旧读法：shared `scanToolEvents`（host.ts 迁移前唯一的取数口），与
 *   - 新读法：投影折叠（test/ledger-fold.ts 沿单元的 `init`/`apply` 驱动，与官方 drive
 *     同一条路）+ 读侧换算（callsOf / resultsOf）。
 * 断言两张台账逐字同值（判定侧因此不必区分两条读法）。夹具的 seq 递增器保证
 * 「事件位 = 数组下标」，那正是官方 `seq = log.length` 连号契约下的同一个值。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { scanToolEvents } from "@jayyuen666/dsh-plugin-shared/lib/tool-events";
import type { SessionEvent } from "@jayyuen666/dsh-plugin-shared/lib/tool-events";
import {
  LEDGER_KEY,
  asLedger,
  callsOf,
  resultsOf,
  toolLedgerProjection,
} from "../lib/tool-ledger.ts";
import type { ToolLedger } from "../lib/tool-ledger.ts";
import { foldLedger } from "./ledger-fold.ts";
import { badEvent, call, ptcCall, ptcSettle, unrelated, result } from "./fixtures/events.ts";

/** 单张台账的行数上限。写数字而不是引常量：下面那组窗口用例的价值就是把 2000 这档闸门
 *  钉住（超一行即作废、刚好一行不作废），lib 侧改窗口必须让这些用例一起红。 */
const LEDGER_WINDOW = 2000;

// 事件先攒进本模块的数组，再由用例一次喂两条读法（夹具负责 seq/品牌位）。
const collected: SessionEvent[] = [];

/** `read` 调用的**原始 arguments JSON 串**（官方 `tool/call.arguments` 是模型产出的字符串，
 *  不是对象）：十处日志夹具共用同一枚目标文件，散着写改一处就漏。期望值一侧写的是
 *  对象形状（`{ file_path: "/a/b.ts" }`），两者不互引 ⇒ 断言不是同值复读。 */
const READ_ARGUMENTS_JSON = '{"file_path":"/a/b.ts"}';

function pendingEvents(): SessionEvent[] {
  return collected.splice(0);
}
function push(...evs: SessionEvent[]): void {
  collected.push(...evs);
}

/** 两侧对照：折叠台账必须与全量扫描一字不差。交回折叠出来的可信台账，用例再各自钉
 *  「这一串事件本该折出哪几行」——两条读法同源（都走 shared `toolEventRowsOf`），只比
 *  两侧同值证明不了字段读对了，所以每条用例都另写一份字面期望值。 */
function assertSameLedger(): ToolLedger {
  const evs = pendingEvents();
  const scanned = scanToolEvents(evs);
  const state = foldLedger(evs);
  const usable = asLedger(state);
  assert.ok(usable !== undefined, "本用例的日志是完整折叠的，不该作废");
  assert.deepEqual(callsOf(usable), scanned.calls);
  assert.deepEqual(resultsOf(usable), scanned.results);
  assert.equal(usable.length, evs.length, "logSeq 基准 = 全量扫描的 evs.length");
  return usable;
}

describe("投影台账 ≡ scanToolEvents", () => {
  it("空日志：两张表都空，logSeq 为 0", () => {
    const state = foldLedger([]);
    // 初态按字面写：这条钉的就是"空日志折出来长什么样"，拿实现算出来的值比即同义反复。
    assert.deepEqual(state, { calls: [], results: [], length: 0, dropped: false });
    assert.deepEqual(callsOf(state), []);
    assert.deepEqual(resultsOf(state), []);
  });

  it("read → result 成功配对", () => {
    push(call("c1", "read", READ_ARGUMENTS_JSON), result("c1"));
    const ledger = assertSameLedger();
    // 一行调用 + 一行结算，且 `seq` 就是事件位（0 与 1）。
    assert.deepEqual(ledger.calls, [
      {
        name: "read",
        callId: "c1",
        arguments: { file_path: "/a/b.ts" },
        badArguments: false,
        seq: 0,
      },
    ]);
    assert.deepEqual(ledger.results, [{ callId: "c1", isError: false, seq: 1 }]);
  });

  it("edit 成功后又有第二次 read（新鲜度形态）", () => {
    push(
      call("c1", "read", READ_ARGUMENTS_JSON),
      result("c1"),
      call("c2", "edit", '{"file_path":"/a/b.ts","old_text":"x","new_text":"y"}'),
      result("c2"),
      call("c3", "read", READ_ARGUMENTS_JSON),
      result("c3"),
    );
    const ledger = assertSameLedger();
    // 三行调用按事件位（0/2/4）留名，edit 那行带着 old_text/new_text（新鲜度判据要读它），
    // 三行结算各自挂在自己的事件位上（1/3/5）。
    assert.deepEqual(
      ledger.calls.map((row) => [row.callId, row.seq]),
      [
        ["c1", 0],
        ["c2", 2],
        ["c3", 4],
      ],
    );
    assert.deepEqual(ledger.calls[1]?.arguments, {
      file_path: "/a/b.ts",
      old_text: "x",
      new_text: "y",
    });
    assert.deepEqual(
      ledger.results.map((row) => [row.callId, row.seq]),
      [
        ["c1", 1],
        ["c2", 3],
        ["c3", 5],
      ],
    );
  });

  it("检索三形态（pattern 口径与 strict-relative 口径的 args 形状都进表）", () => {
    push(
      call("g1", "grep", '{"pattern":"b","path":"/a","include":"*.ts"}'),
      result("g1"),
      call("z1", "zg_search", '{"query":"b","root":"/a"}'),
      result("z1", true),
    );
    const ledger = assertSameLedger();
    // 两种口径的 args 形状各自原样进表（判据在 host 侧现读，台账不改写参数）。
    assert.deepEqual(ledger.calls, [
      {
        name: "grep",
        callId: "g1",
        arguments: { pattern: "b", path: "/a", include: "*.ts" },
        badArguments: false,
        seq: 0,
      },
      {
        name: "zg_search",
        callId: "z1",
        arguments: { query: "b", root: "/a" },
        badArguments: false,
        seq: 2,
      },
    ]);
    // 成败位同表留存：zg_search 那次是失败回填。
    assert.deepEqual(ledger.results, [
      { callId: "g1", isError: false, seq: 1 },
      { callId: "z1", isError: true, seq: 3 },
    ]);
  });

  it("失败的结果位（isError 两侧同读）", () => {
    push(call("c1", "read", READ_ARGUMENTS_JSON), result("c1", true));
    const ledger = assertSameLedger();
    // 失败不塌成"没有结果"：那一行仍在表里，且 isError 为真。
    assert.deepEqual(ledger.results, [{ callId: "c1", isError: true, seq: 1 }]);
    assert.deepEqual(ledger.calls, [
      {
        name: "read",
        callId: "c1",
        arguments: { file_path: "/a/b.ts" },
        badArguments: false,
        seq: 0,
      },
    ]);
  });

  it("pTC 子调用：start 记调用、dispatch 记成败", () => {
    push(
      ptcCall("s1", "read", { file_path: "/a/b.ts" }),
      ptcSettle("s1", "read", false),
      ptcCall("s2", "edit", { file_path: "/a/c.ts", new_text: "n" }),
      ptcSettle("s2", "edit", true),
    );
    const ledger = assertSameLedger();
    // 子调用的串联键是 subCallId（s1/s2），PTC 的 arguments 已是归一化对象 ⇒ badArguments 假。
    assert.deepEqual(ledger.calls, [
      {
        name: "read",
        callId: "s1",
        arguments: { file_path: "/a/b.ts" },
        badArguments: false,
        seq: 0,
      },
      {
        name: "edit",
        callId: "s2",
        arguments: { file_path: "/a/c.ts", new_text: "n" },
        badArguments: false,
        seq: 2,
      },
    ]);
    assert.deepEqual(ledger.results, [
      { callId: "s1", isError: false, seq: 1 },
      { callId: "s2", isError: true, seq: 3 },
    ]);
  });

  it("非工具事件与 str_replace_editor 混排（不进表的行也不占位丢序）", () => {
    push(
      unrelated(),
      call("c1", "read", READ_ARGUMENTS_JSON),
      unrelated(),
      call("c2", "str_replace_editor", '{"command":"view","path":"/a/b.ts"}'),
      result("c2"),
      unrelated(),
      result("c1"),
    );
    const ledger = assertSameLedger();
    // 三条 turn/start 只推长度、不出行；两张表都按事件位记序（乱序结算同形保留）。
    assert.deepEqual(ledger.calls, [
      {
        name: "read",
        callId: "c1",
        arguments: { file_path: "/a/b.ts" },
        badArguments: false,
        seq: 1,
      },
      {
        name: "str_replace_editor",
        callId: "c2",
        arguments: { command: "view", path: "/a/b.ts" },
        badArguments: false,
        seq: 3,
      },
    ]);
    assert.deepEqual(ledger.results, [
      { callId: "c2", isError: false, seq: 4 },
      { callId: "c1", isError: false, seq: 6 },
    ]);
    assert.equal(ledger.length, 7, "非记账事件照样占一位");
  });

  it("坏事件一律跳过，两侧口径同源", () => {
    push(
      // 缺 name 与 callId 的调用：shared 记 name=undefined，danger-guard 侧不记账
      badEvent({ type: "tool/call", data: { arguments: "{}" } }),
      // data 非对象
      badEvent({ type: "tool/call", data: "nope" }),
      // 未知事件类型
      badEvent({ type: "whatever", data: {} }),
      // arguments 非法 JSON：badArguments 两侧同真
      call("c9", "read", "{not json"),
      // result 缺 message
      badEvent({ type: "tool/result", data: {} }),
    );
    const ledger = assertSameLedger();
    // 只有两条 tool/call 出行：缺 name/callId 的那条以 null 占位（两侧同读，不是谁漏记），
    // data 非对象与未知类型整条丢弃；坏 JSON 参数仍出行，但 badArguments 为真。
    assert.deepEqual(ledger.calls, [
      { name: null, callId: null, arguments: {}, badArguments: false, seq: 0 },
      { name: "read", callId: "c9", arguments: {}, badArguments: true, seq: 3 },
    ]);
    // 缺 message 的 result 仍是一行"成功"，callId 为 null（配对键不可信）。
    assert.deepEqual(ledger.results, [{ callId: null, isError: false, seq: 4 }]);
  });

  it("无 callId 的极旧契约调用（扫描器记 callId=undefined，host 侧造 nc:<seq> 键）", () => {
    push(
      badEvent({ type: "tool/call", data: { name: "read", arguments: READ_ARGUMENTS_JSON } }),
      badEvent({ type: "tool/result", data: { message: { source: {}, content: [] } } }),
    );
    const ledger = assertSameLedger();
    // 状态面把"没有 callId"写成 null（JSON 往返友好），读回 shared 记录时还原成 undefined，
    // 由调用方按 seq 造保守键——两头都钉住，免得某侧悄悄把 null 当真实串联键。
    assert.deepEqual(ledger.calls, [
      {
        name: "read",
        callId: null,
        arguments: { file_path: "/a/b.ts" },
        badArguments: false,
        seq: 0,
      },
    ]);
    assert.equal(callsOf(ledger)[0]?.callId, undefined, "读回侧交回 undefined 而不是 null/空串");
    assert.deepEqual(ledger.results, [{ callId: null, isError: false, seq: 1 }]);
  });

  it("长日志（1000 次读 + 结算）逐项同解", () => {
    const evs: SessionEvent[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const id = `c${String(index)}`;
      evs.push(call(id, "read", `{"file_path":"/a/f${String(index)}.ts"}`), result(id));
    }
    push(...evs);
    const ledger = assertSameLedger();
    // 2000 行事件折成 1000 + 1000 行台账，仍在窗口内（不作废），且首末行的事件位对齐。
    assert.equal(ledger.dropped, false);
    assert.equal(ledger.calls.length, 1000);
    assert.equal(ledger.results.length, 1000);
    assert.deepEqual(ledger.calls[0], {
      name: "read",
      callId: "c0",
      arguments: { file_path: "/a/f0.ts" },
      badArguments: false,
      seq: 0,
    });
    assert.deepEqual(ledger.results.at(-1), { callId: "c999", isError: false, seq: 1999 });
  });
});

describe("采信门：什么时候不作废", () => {
  it("事件位跳号（折叠起点不在日志开头）⇒ 作废，读侧交回 undefined", () => {
    const gap = badEvent({
      type: "tool/call",
      data: { name: "read", arguments: "{}" },
      seq: 9,
    });
    const state = foldLedger([gap]);
    assert.equal(state.dropped, true);
    assert.equal(asLedger(state), undefined, "宁可不给答案，也不给一份缺前缀的台账");
    // 回退路径对同一串事件仍给出完整台账（"退回更保守读法"的具体含义）
    assert.equal(scanToolEvents([gap]).calls.length, 1);
  });

  it("作废是粘性的：后续事件只跟长度，不再维护表", () => {
    const gap = badEvent({
      type: "tool/call",
      data: { name: "read", arguments: "{}" },
      seq: 9,
    });
    // gap 之后夹具继续从 1 计数：跳号一旦发生，后面再干净的事件也不恢复台账
    const state = foldLedger([gap, call("c1", "read", READ_ARGUMENTS_JSON), result("c1")]);
    assert.equal(state.dropped, true);
    assert.deepEqual(state.calls, []);
    assert.equal(state.length, 10, "长度停在跳号那一位的后一格");
  });

  it(`台账超过窗口（${String(LEDGER_WINDOW)} 行）⇒ 作废而不是裁半给人看`, () => {
    const evs: SessionEvent[] = [];
    for (let index = 0; index <= LEDGER_WINDOW; index += 1) {
      evs.push(call(`k${String(index)}`, "read", READ_ARGUMENTS_JSON));
    }
    const state = foldLedger(evs);
    assert.equal(state.dropped, true);
    assert.deepEqual(state.calls, []);
    assert.equal(asLedger(state), undefined);
  });

  it("刚好等于窗口长度不作废（边界在窗口内仍采信）", () => {
    const calls: SessionEvent[] = [];
    for (let index = 0; index < LEDGER_WINDOW; index += 1) {
      calls.push(call(`k${String(index)}`, "read", READ_ARGUMENTS_JSON));
    }
    const state = foldLedger(calls);
    assert.equal(state.dropped, false);
    assert.equal(state.calls.length, LEDGER_WINDOW);
    // results 那半边同判据：各自独立封顶，都不越窗就不作废
    const settled = [...calls];
    for (let index = 0; index < LEDGER_WINDOW; index += 1) {
      settled.push(result(`k${String(index)}`));
    }
    const both = foldLedger(settled);
    assert.equal(both.dropped, false);
    assert.equal(both.results.length, LEDGER_WINDOW);
  });

  it("results 单表越窗同样作废", () => {
    const evs: SessionEvent[] = [];
    for (let index = 0; index <= LEDGER_WINDOW; index += 1) {
      evs.push(result(`r${String(index)}`));
    }
    assert.equal(foldLedger(evs).dropped, true);
  });
});

describe("stateOf 回填与单元形状", () => {
  it("jSON 往返后的状态仍被采信（持久缓存那条路）", () => {
    push(call("c1", "read", READ_ARGUMENTS_JSON), result("c1"));
    const state = foldLedger(pendingEvents());
    // 持久缓存那一层按 JSON 落盘，这条用例钉的就是那条路。
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- 判据要的正是 JSON 语义：undefined 键在 stringify 时整枚消失、structuredClone 会留着它 ⇒ 换成后者即测不到那一位，用例失去对象
    const restored = asLedger(JSON.parse(JSON.stringify(state)));
    assert.ok(restored !== undefined, "状态里没有 undefined 键可被 stringify 丢掉");
    assert.deepEqual(callsOf(restored), callsOf(state));
    assert.deepEqual(resultsOf(restored), resultsOf(state));
  });

  it("坏回填值一律 undefined", () => {
    for (const bad of [
      undefined,
      null,
      "x",
      7,
      {},
      { calls: "no", results: [], length: 0, dropped: false },
    ]) {
      assert.equal(asLedger(bad), undefined);
    }
  });

  it("行里的可选位在状态中是 null（不是缺席）", () => {
    push(badEvent({ type: "tool/call", data: { name: "read", arguments: "{}" } }));
    const state = foldLedger(pendingEvents());
    assert.equal(state.calls[0]?.callId, null);
    assert.equal(callsOf(state)[0]?.callId, undefined, "读回 shared 记录时还原成 undefined");
  });

  it("注册键、stateVersion 与 host-only 形状", () => {
    assert.equal(toolLedgerProjection.key, LEDGER_KEY);
    assert.equal(toolLedgerProjection.stateVersion, 1);
    assert.equal("wire" in toolLedgerProjection, false, "host-only：不进客户端快照");
    const first = call("c1", "read", "{}");
    const stepped = toolLedgerProjection.apply(
      toolLedgerProjection.init({} as never, 0 as never),
      first,
    );
    // 期望值按字面写：折一条 read 调用之后该是哪一行、长度停在哪一格。此前这条比的是
    // lib 里那份并行 fold 的产物，两个口与 fold 同源即算通过；折叠既已收归单元，这里就
    // 直接钉形状本身（test/ledger-fold.ts 的等价用例逐条覆盖其余事件形态）。
    assert.deepEqual(stepped, {
      calls: [{ name: "read", callId: "c1", arguments: {}, badArguments: false, seq: 0 }],
      results: [],
      length: 1,
      dropped: false,
    });
  });
});
