/**
 * tool 事件台账投影：把 danger-guard 取证链对会话日志的依赖折成一枚官方
 * `sessionProjections` 单元，守卫里经 `stateOf()` **同步**读。
 *
 * 为什么必须是投影而不是别的：`ToolGuard` 官方签名是同步的
 * （installed @deepseek-ai/dsh-tools/lib/types/index.d.ts:522
 * `(execution: Readonly<ToolExecution>) => string | undefined`），而 `ctx.sessionQuery`
 * 的每条读面都是 `Promise` ⇒ 异步读法在这道闸门上根本不成立；`Session` 上未弃用的同步
 * 成员只有 `seq` / `isOwnSeq`，交不出事件。三条同步读面（`snapshotEvents` / `eventAt` /
 * `ownEvents`）官方全标了 `@deprecated`（"new calls are prohibited"）。
 *
 * 折什么：只折台账所需的行（`calls` / `results` + 日志长度），逐字段实现**复用 shared 的
 * `toolEventRowsOf`**（同一份代码，不是第二份抄本）——折叠路径与回退扫描路径若各写一遍
 * 字段读取，就会在同一串事件上给出不同的证据链，那是这道闸门的 fail-open。
 * 策略面（哪些工具算检索、判据口径、文案）**不进**状态：那些值每次判定现读 settings，
 * 折进状态会让"用户改了名单"不再生效。
 *
 * 什么时候不采信（⇒ 读侧交回 `undefined`，host 回退全量扫描 = 迁移前行为）：
 *   - `dropped`：台账行数越过 `LEDGER_WINDOW` 被清（长跑会话），或折叠起点不在日志开头
 *     （`event.seq` 相对已折长度跳号 = 官方 drive 只把尾部事件交给了本单元）；
 *   - 形状不符（key 未注册 / 持久缓存回填坏值 / 宿主漂移）。
 * 方向一律是"退回更保守的读法"，绝不拿一份可能不全的台账充当完整证据。
 */

import { z } from "zod";
import type { SessionEvent, SessionHeader, SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { toolEventRowsOf } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import type {
  ToolCallRecord,
  ToolResultRecord,
} from "@jayyuen66/dsh-plugin-shared/lib/tool-events";

/** 本包投影单元的注册键（host-only：不声明 wire ⇒ 不进客户端快照）。 */
export const LEDGER_KEY = "danger-guard.toolLedger";

/** 单张台账的行数上限：超了就整体作废（`dropped`）。被裁掉前缀的证据链无法自证完整，
 *  而"多要一次取证"与"免掉一次取证"之间只能选前者。
 *  不导出：窗口边界由 `applyEvent` 自己兑现，用例按字面 2000 钉两侧边界
 *  （见 test/tool-ledger.test.ts 的窗口组）——改这个数字就必须同时过那条用例。 */
const LEDGER_WINDOW = 2000;

const intSchema = z.number().int().nonnegative();

/**
 * 状态里的台账行 = `ToolCallRecord` / `ToolResultRecord` 的同字段 JSON 形态：
 * "没有这个值"一律写成 `null`。持久缓存按 JSON 往返，而 `undefined` 键会被
 * `JSON.stringify` 整个丢掉——`z.string().optional()` 那种"必填但可为 undefined"的形状
 * 回填时必然解析失败（官方 `restore` 随即丢行，本包就永久只剩回退扫描）。
 */
export interface LedgerCallRow {
  name: string | null;
  callId: string | null;
  arguments: Record<string, unknown>;
  badArguments: boolean;
  seq: number;
}

export interface LedgerResultRow {
  callId: string | null;
  isError: boolean;
  seq: number;
}

/** 投影态：全平面 JSON 值（官方单元契约），`stateSchema` 校验每一份回填。 */
export interface ToolLedger {
  /** tool/call（含 PTC 子调用开始）台账，按 `seq` 升序——内容与 `scanToolEvents` 同源。 */
  calls: LedgerCallRow[];
  /** tool/result（含 PTC 结算）台账，按 `seq` 升序。 */
  results: LedgerResultRow[];
  /** 已折入的最新事件位 + 1 = 全量扫描里的 `evs.length`（logSeq / 外部改动基准）。 */
  length: number;
  /** 台账不再完整 ⇒ 读侧回退扫描（粘性：作废后只跟长度，不再维护行）。 */
  dropped: boolean;
}

const callRowSchema = z.object({
  name: z.string().nullable(),
  callId: z.string().nullable(),
  arguments: z.record(z.string(), z.unknown()),
  badArguments: z.boolean(),
  seq: intSchema,
});

const resultRowSchema = z.object({
  callId: z.string().nullable(),
  isError: z.boolean(),
  seq: intSchema,
});

const toolLedgerSchema: z.ZodType<ToolLedger> = z.object({
  calls: z.array(callRowSchema),
  results: z.array(resultRowSchema),
  length: intSchema,
  dropped: z.boolean(),
});

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    "danger-guard.toolLedger": ToolLedger;
  }
}

/** 空日志的初态。官方 `init` 另交回 header 与 fork 继承前缀长度：本包的采信判据是
 *  "`event.seq` 相对已折长度不跳号"，比读那一位更直接（跳号即作废），故两位都不读。
 *  不导出：唯一的消费者就是下面那枚单元的 `init`，用例钉的是这份状态的字面形状。 */
function toolLedgerInit(): ToolLedger {
  return { calls: [], results: [], length: 0, dropped: false };
}

/** 状态行 → shared 记录（`null` 还原成"没有这个值"）。 */
function callRecordOf(row: LedgerCallRow): ToolCallRecord {
  return {
    name: row.name ?? undefined,
    callId: row.callId ?? undefined,
    arguments: row.arguments,
    badArguments: row.badArguments,
    seq: row.seq,
  };
}

function resultRecordOf(row: LedgerResultRow): ToolResultRecord {
  return {
    callId: row.callId ?? undefined,
    isError: row.isError,
    seq: row.seq,
  };
}

/** shared 记录 → 状态行（`null` 形态，见 LedgerCallRow 的 JSON 往返理由）。 */
function callRowOf(record: ToolCallRecord): LedgerCallRow {
  return {
    name: record.name ?? null,
    callId: record.callId ?? null,
    arguments: record.arguments,
    badArguments: record.badArguments,
    seq: record.seq,
  };
}

function resultRowOf(record: ToolResultRecord): LedgerResultRow {
  return { callId: record.callId ?? null, isError: record.isError, seq: record.seq };
}

/**
 * 一条已提交事件的转移。行下标用 `event.seq`：官方把 `seq = log.length` 写成连号契约
 * （dsh-session index.d.ts 的 `get seq()` 注记），所以它与 `snapshotEvents(0)` 返回数组的
 * 下标同一个值——也就是 `scanToolEvents` 记进 `seq` 的那一位。两条读法因此同序同值。
 */
function applyEvent(state: ToolLedger, event: SessionEvent): ToolLedger {
  const { seq } = event;
  const length = Math.max(state.length, seq + 1);
  if (state.dropped) {
    // 已作废：只跟长度（回退路径自己读全量日志，这份表没人再读）。
    return { ...state, length };
  }
  // 跳号 = 折叠起点不在日志开头（前缀没交给本单元）⇒ 台账不可能完整。
  if (seq > state.length) {
    return { calls: [], results: [], length, dropped: true };
  }
  const { call, result } = toolEventRowsOf(event, seq);
  if (call === undefined && result === undefined) {
    // 非记账事件：只有长度跟着走（无 wire ⇒ 不产视图、不通知监听）。
    return { ...state, length };
  }
  const calls = call === undefined ? state.calls : [...state.calls, callRowOf(call)];
  const results = result === undefined ? state.results : [...state.results, resultRowOf(result)];
  if (calls.length > LEDGER_WINDOW || results.length > LEDGER_WINDOW) {
    return { calls: [], results: [], length, dropped: true };
  }
  return { ...state, calls, results, length };
}

export const toolLedgerProjection = {
  key: LEDGER_KEY,
  stateVersion: 1,
  stateSchema: toolLedgerSchema,
  init: (_header: SessionHeader, _inherited: SessionLogOffset): ToolLedger => toolLedgerInit(),
  apply: (state: ToolLedger, event: SessionEvent): ToolLedger => applyEvent(state, event),
} satisfies ProjectionDefinition<typeof LEDGER_KEY, ToolLedger>;

/**
 * `stateOf()` 的返回值 → 可信台账。坏形状与被窗口/跳号作废的台账都交回 `undefined`
 * （结构读口交回 unknown：官方 `stateOf` 第一参是名义类 `Session`，本包的替身会话
 * 永远满足不了，见 host.ts 的 ProjectionsRegistry）。
 */
export function asLedger(value: unknown): ToolLedger | undefined {
  const parsed = toolLedgerSchema.safeParse(value);
  return parsed.success && !parsed.data.dropped ? parsed.data : undefined;
}

/** 台账 → `scanToolEvents` 同形状的 calls（判定侧因此不必区分两条读法）。 */
export function callsOf(ledger: ToolLedger): ToolCallRecord[] {
  return ledger.calls.map(callRecordOf);
}

/** 台账 → `scanToolEvents` 同形状的 results。 */
export function resultsOf(ledger: ToolLedger): ToolResultRecord[] {
  return ledger.results.map(resultRecordOf);
}
