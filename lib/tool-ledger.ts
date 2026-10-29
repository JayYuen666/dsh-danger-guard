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

const intSchema = z.int().nonnegative();

/**
 * 状态里的台账行 = `ToolCallRecord` / `ToolResultRecord` 的同字段 JSON 形态：
 * "没有这个值"一律写成 `null`。持久缓存按 JSON 往返，而 `undefined` 键会被
 * `JSON.stringify` 整个丢掉——`z.string().optional()` 那种"必填但可为 undefined"的形状
 * 回填时必然解析失败（官方 `restore` 随即丢行，本包就永久只剩回退扫描）。
 *
 * `name` 是唯一一个**不留** `null` 哨兵的字段：它在 shared 侧已经是必填串——少一个可用 name
 * 的 tool/call 由 shared 的扫描层整条滤掉、不出行（`callRecordOf` 两臂都过 `usableName`）。
 * 官方拦不住这种事件（`validateSessionEventData` 自述不校验完整载荷，见
 * packages/core/session/src/surface.ts），所以那道闸门只能由 shared 兜；这里再写
 * `string | null` 等于把同一份不变量抄第二遍，两边迟早漂移，本表只负责如实搬运。
 * 依赖面：要求解析到的 shared ≥ 0.1.2（0.1.1 的扫描层不过滤，运行时会给出 undefined，
 * 而这里的类型已经是 string）。升 shared 后本表不必再动。
 */
export interface LedgerCallRow {
  name: string;
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
  name: z.string(),
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

const toolLedgerSchema: z.ZodType<ToolLedger> = z
  .object({
    calls: z.array(callRowSchema),
    results: z.array(resultRowSchema),
    length: intSchema,
    dropped: z.boolean(),
  })
  // 字段类型之外的两条**结构不变量**（host 把 `length` 当 logSeq 新鲜度基准、把
  // "更靠后的行即更新的证据"当隐含前提——坏缓存破坏它们时判定会基于错位的水位，
  // 且不会像其它坏形状那样退回全量扫描）：
  //   1. 行在各表内按 `seq` 严格升序；
  //   2. `length` 严格大于任何行内 `seq`（空表时只需非负，intSchema 已保证）。
  .superRefine((value, ctx) => {
    const checkRows = (rows: readonly { seq: number }[], label: string): void => {
      for (let index = 1; index < rows.length; index += 1) {
        const row = rows[index];
        const previous = rows[index - 1];
        if (row !== undefined && previous !== undefined && row.seq <= previous.seq) {
          ctx.addIssue({
            code: "custom",
            path: [label, index, "seq"],
            message: `rows must be strictly ascending by seq (${String(row.seq)} after ${String(previous.seq)})`,
          });
        }
      }
    };
    checkRows(value.calls, "calls");
    checkRows(value.results, "results");
    const maxSeq = Math.max(
      -1,
      ...value.calls.map((row) => row.seq),
      ...value.results.map((row) => row.seq),
    );
    if (maxSeq >= 0 && value.length <= maxSeq) {
      ctx.addIssue({
        code: "custom",
        path: ["length"],
        message: `length (${String(value.length)}) must exceed max row seq (${String(maxSeq)})`,
      });
    }
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
    name: row.name,
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

/**
 * shared 记录 → 状态行（`null` 形态，见 LedgerCallRow 的 JSON 往返理由）。
 *
 * 缺可用 name 的记录交回 `undefined`（整条不折进台账），而不是写一行 `name: undefined`。
 * 这不是重复 shared 的过滤，是**写侧的自卫**：本表的状态 schema 要求 name 是必填串，
 * 一旦写进一个 undefined 行，整份投影在 `asLedger` 那里就再也解析不回来——不是少一行，
 * 是整份台账永久作废、宿主每次判定都退回全量扫描（= 迁移前的慢路径）。官方拦不住这种事件
 * （`validateSessionEventData` 自述不校验完整载荷）。
 * 判据与 shared 的 `usableName` 同形：非串、或空串都算没有。
 *
 * 与 shared 的分工：那边在**读侧**滤（扫描层整条不出行），本表在**写侧**再兜一道。装着的
 * 0.1.2 里 `ToolCallRecord.name` 的类型已经是 `string`，所以这一臂从 `applyEvent` 走不到
 * （见下面的 v8 ignore）。留着它的理由是失效代价不对称：多写一行坏行 = 整份台账永久作废，
 * 少折一行 = 对一条本就无名的事件不做记账；而编译期管不到真实载荷——宿主漂移与持久缓存
 * 回填都能送来类型声明之外的东西。
 *
 * v8 ignore next -- 装着的 shared 在读侧就滤掉了这类记录 ⇒ 本臂从 applyEvent 不可达
 * （`callRowOf` 未导出，没有直接单测入口）；它是上面那条不变量本身，不是留着的冗余分支。
 */
function callRowOf(record: ToolCallRecord): LedgerCallRow | undefined {
  const { name } = record;
  // 单一 return：本仓 lint 开了 consistent-return 且 treatUndefinedAsUnspecified，
  // 与带值 return 混写的裸 undefined 会被判红（同 lib/record.ts 的 ownMessage）。
  const usable = typeof name === "string" && name.length > 0;
  /* v8 ignore next -- 装着的 shared 在读侧就滤掉了这类记录，本臂从 applyEvent 不可达；
     它守的是「本表自己不写坏行」这条不变量，代价只有一次 typeof，见函数头注释。 */
  return usable
    ? {
        name,
        callId: record.callId ?? null,
        arguments: record.arguments,
        badArguments: record.badArguments,
        seq: record.seq,
      }
    : undefined;
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
  // 幂等自卫：`seq < state.length` = 该事件位已折过（持久缓存回填后重放、宿主重投递、
  // 非严格递增的投递）。再折一遍会在表尾追加同一事件的第二份拷贝——既让证据链重复，
  // 也会提前撞上窗口作废（之后每次判定都退回全量扫描）。与其余越界情况一样，这里
  // 不信"官方保证只投新事件"的口头契约。
  if (seq < state.length) {
    return state;
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
  // callRowOf 可能因为 name 不可用而交回 undefined（见它的注释）：那一行不折进来，但
  // length 照走——滤掉出行 ≠ 滤掉事件位，宿主的 logSeq 基准不能因此偏移。
  const row = call === undefined ? undefined : callRowOf(call);
  const calls = row === undefined ? state.calls : [...state.calls, row];
  const results = result === undefined ? state.results : [...state.results, resultRowOf(result)];
  if (calls.length > LEDGER_WINDOW || results.length > LEDGER_WINDOW) {
    return { calls: [], results: [], length, dropped: true };
  }
  return { ...state, calls, results, length };
}

export const toolLedgerProjection = {
  key: LEDGER_KEY,
  // 2 = name 去掉 null 哨兵（字段形状变了，官方 README 要求随状态字段变化递增；
  // 版本对不上的持久行按官方 restore 判据整行丢弃 ⇒ 读侧回退全量扫描，不作废）。
  stateVersion: 2,
  stateSchema: toolLedgerSchema,
  init: (_header: SessionHeader, _inherited: SessionLogOffset): ToolLedger => toolLedgerInit(),
  apply: (state: ToolLedger, event: SessionEvent): ToolLedger => applyEvent(state, event),
} satisfies ProjectionDefinition<typeof LEDGER_KEY, ToolLedger>;

/**
 * `stateOf()` 的返回值 → 可信台账。坏形状与被窗口/跳号作废的台账都交回 `undefined`
 * （结构读口交回 unknown：官方 `stateOf` 第一参是名义类 `Session`，本包的替身会话
 * 永远满足不了，见 host.ts 的 ProjectionsRegistry）。
 *
 * 校验/解码按**对象身份**记忆化：投影态不可变（`applyEvent` 每次返回新对象），而本函数
 * 在守卫判定的热路径上被反复调用（每次判定多处读水位/证据），每次 safeParse 都要为
 * 最多两千行逐行重建对象。按身份缓存让同一份状态只解析一次；缓存键是 WeakMap，状态
 * 对象被宿主换代后自然回收。同一对象被就地改写后再来（违反不可变契约）会拿到旧结果——
 * 投影态的不可变是官方单元契约的一部分，这里不再为违约者多付一遍解析。
 */
const ledgerCache = new WeakMap<object, ToolLedger | undefined>();

export function asLedger(value: unknown): ToolLedger | undefined {
  if (typeof value !== "object" || value === null) {
    const parsed = toolLedgerSchema.safeParse(value);
    /* v8 ignore next -- 原始值必然过不了对象 schema（数组的 typeof 是 object，走缓存分支），
       "解析成功"那一臂在这个入口不可达；仍走 safeParse 是为了不把采信判据抄第二份。 */
    return parsed.success && !parsed.data.dropped ? parsed.data : undefined;
  }
  if (!ledgerCache.has(value)) {
    const parsed = toolLedgerSchema.safeParse(value);
    ledgerCache.set(value, parsed.success && !parsed.data.dropped ? parsed.data : undefined);
  }
  return ledgerCache.get(value);
}

/** 台账 → `scanToolEvents` 同形状的 calls（判定侧因此不必区分两条读法）。 */
export function callsOf(ledger: ToolLedger): ToolCallRecord[] {
  return ledger.calls.map(callRecordOf);
}

/** 台账 → `scanToolEvents` 同形状的 results。 */
export function resultsOf(ledger: ToolLedger): ToolResultRecord[] {
  return ledger.results.map(resultRecordOf);
}
