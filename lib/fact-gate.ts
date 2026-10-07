// lib/fact-gate.ts —— 编辑事实强制门（gateguard 移植，ECC MIT）。
//
// 核心洞察（ECC A/B 实证，平均 9.0 vs 6.75）：LLM 自我评估无效——
// 问"你确定吗"永远答"确定"；但 DENY 编辑并强制把具体事实列进上下文
// （谁引用这个文件、哪些测试/文档触达它、逐字引用用户指令），
// 调查行为本身创造了改变输出质量的上下文。
//
// 分工（11 轮讨论定稿）：
//   host.ts                = 证据判定（扫会话事件 + fs 探测）→ 产出**带成因**的缺项
//   本文件                 = 纯状态机：据缺项决定放行/拒绝、守防死锁配额
//   lib/gap-directives.ts  = 把缺项翻成可照做的**指令结构**（`need × why` 全表 + 缺项规范顺序）
//   lib/ref-search-policy.ts = 引用取证的口径面（哪些检索工具算、各自按哪些参数判）
//
// 文案不在本文件：中英两份单源在 lib/messages.ts，渲染函数（gapLine / renderDenyMessage）
// 把消息表当**参数**收——宿主在 guard 调用点传 `messagesFor(MESSAGES, locale)` 的结果。
// 于是状态机既不读设置、也不自带某一种语言，测试只需喂一份字典；键齐全由 tsc 保证
// （`Messages[key]` 取值类型），覆盖率不添不可达分支。
//
// 三条硬原则：
//   1. **新鲜度只认外部改动**（round 13 定稿）：模型自己连续编辑同一文件**不再反复
//      过门**——edit 的返回本身就带着改动后的内容，再逼一次 read 是纯仪式。只有
//      本会话之外改了目标（另一会话 / bash / sed）才作废证据。引用/逐层结论同样
//      不因编辑本文件而失效（谁引用它不由本文件内容决定）。
//   2. **配额只数未收敛的拒绝**：缺项变少 = 模型正在照做 → 计数重置。"一次补一项"
//      是门禁期望的收敛行为，绝不能被配额反过来惩罚。
//   3. **提示按成因定制，不甩统一模板**：同一个"缺 read"，没读过 / 调用失败过 /
//      被别的会话改过，该做的事完全不同。给不出具体路径与文件名的提示等于没说。
//
// 内存：会话分片数上限 maxSessions、每会话文件数上限 maxFiles，各自真 LRU
// （命中即 touch）——这是内存的**实际上界**。dropSession() 由 host 接线到官方
// `session/disposed` 事件主动回收分片（host.ts apply()）；LRU 淘汰只是兜底。

import { fillTemplate } from "./messages.ts";
import type { DangerGuardMessages } from "./messages.ts";
import { NEED_ORDER, gapLine } from "./gap-directives.ts";
import type { RefSearchPolicy } from "./ref-search-policy.ts";

/** 未满足的取证项。host 按档位与层探测结果决定该文件"应当有哪些项"。 */
export type FactNeed =
  // read 过目标文件（新建文件由 host fs 豁免）
  | "read"
  // 项目级引用探查（谁 import/引用它）
  | "refs"
  // test 层触达探查（该层存在时要求）
  | "test"
  // e2e/集成层触达探查（该层存在时要求）
  | "e2e"
  // 文档层触达探查（该层存在时要求）
  | "docs";

/** 为什么缺——决定该给什么指令（核心：不同成因不同提示）。 */
export type NeedWhy =
  // 完全没做过
  | "never"
  // 目标被**本会话之外**改动（另一会话 / bash / sed）→ 冲突风险，不只是重读
  | "external"
  // 做过但调用失败（路径不存在/无权限）
  | "failed"
  // 检索做过但作用域不对（搜文件自身/兄弟目录），看不到引用面
  | "narrow";

/** 一个缺项及其成因。 */
export interface FactGap {
  need: FactNeed;
  why: NeedWhy;
  /** 可选补充（host 注入具体细节，如"你上次 grep 的 path 是 lib/"）。 */
  hint?: string;
}

/** 消息渲染上下文（host 现算，让提示能落到具体路径而不是空泛模板）。 */
export interface FactGapContext {
  /** 目标文件名（含扩展名），如 `fact-gate.ts`。 */
  targetName: string;
  /** 建议探查起点（项目根 / 最近祖先目录），如 `/w/proj`。 */
  searchPath: string;
  /**
   * 当次生效的检索取证判据（host 从设置运行时值现算）。refs 指令里的**工具名与参数名**
   * 都从这里派生：缺省回落内置默认名单。指令与实际认的工具不一致时，门禁的拒绝理由与
   * 模型能走的路就是两张皮——本字段正是为消除这层脱节而存在。
   */
  searchPolicy?: RefSearchPolicy;
}

/** check 的证据输入（host 现算）：本类不读事件、不碰 fs。 */
export interface FactEvidenceInput {
  /** 仍缺失的取证项（带成因）；空数组 = 取证齐备。 */
  gaps: FactGap[];
  /** 已满足的项：写进消息，明示"做过的不再要求"（防重复劳动）。 */
  done?: FactNeed[];
  /** 证据判定是否可行（false = 会话历史不可得 → 交互式确认）。 */
  determinate: boolean;
  /** 当前已处理事件数（配额水位锚点）。 */
  logSeq: number;
  /** 目标最近一次**成功编辑**的事件 seq（含外部改动折算）；-1 = 从未。 */
  fileEditSeq: number;
  /** 目标是否为新建（write/create 且 fs 不存在）。 */
  newFile?: boolean;
  /** 渲染提示用的具体上下文。 */
  ctx?: FactGapContext;
}

/** 一次拒绝的全部渲染输入（状态机的产出；文案由宿主用当前语言的消息表现渲染）。 */
export interface FactDenial {
  /** 仍缺失的取证项（带成因）。 */
  gaps: FactGap[];
  /** 已满足的项：写进消息，明示"做过的不再要求"（防重复劳动）。 */
  done: FactNeed[];
  /** 第几轮拒绝（>1 时头部改为"仍未放行"并报剩余项数）。 */
  attempt: number;
  /** 目标是否新建（新建走"免 read 但引用面仍要探"的头部）。 */
  newFile: boolean;
  /** host 现算的具体上下文（目标名/起点/生效检索名单）。 */
  ctx?: FactGapContext;
}

/** 组装一次拒绝的渲染输入。ctx 缺席时**不写该键**（exactOptionalPropertyTypes 下
 *  `ctx: undefined` 与"没有 ctx"是两回事），也正好让渲染侧走默认占位文案。 */
const denialOf = (
  gaps: FactGap[],
  done: FactNeed[],
  attempt: number,
  input: FactEvidenceInput | undefined,
): FactDenial => ({
  gaps,
  done,
  attempt,
  newFile: input?.newFile === true,
  ...(input?.ctx === undefined ? {} : { ctx: input.ctx }),
});

/** 渲染拒绝消息：头部反映收敛进度，正文只列仍缺项且按成因定制，
 *  尾巴是要模型同步声明的那部分（机器核动作，结论仍归文字·双轨）。 */
export function renderDenyMessage(denial: FactDenial, messages: DangerGuardMessages): string {
  const { gaps, done, attempt, newFile, ctx } = denial;
  let head: string;
  if (attempt > 1) {
    head = fillTemplate(messages.headRetry, {
      attempt: String(attempt),
      count: String(gaps.length),
    });
  } else if (newFile) {
    head = messages.headNewFile;
  } else {
    head = messages.headFirst;
  }
  const lines = gaps.map((gap) => `· ${gapLine(gap, ctx, messages)}`);
  if (done.length > 0) {
    lines.push(fillTemplate(messages.confirmedLine, { done: done.join(messages.listSeparator) }));
  }
  return [head, ...lines, messages.declareTail].join("\n");
}

/** 编辑类工具名。str_replace_editor 是 dsh-base 并存的另一套编辑器
 *  （create/str_replace/insert 是写操作）；view 只读，host 侧把它算作 read 证据。 */
const EDIT_TOOLS = new Set(["edit", "write", "str_replace_editor"]);

/** 明确放行的文件面：仅**文档类**扩展名（md/markdown/txt/rst/adoc）。
 *  test/ 目录**不再跳过**（收紧）：原 SKIP_PATH_RE 让模型可把改动挂到
 *  test/ 下躲过取证——旁路已堵，测试文件编辑同样过门。
 *  不对称是故意的：改文档零摩擦（非执行面），但改代码要探文档层。 */
const SKIP_EXT_RE = /\.(?:md|markdown|txt|rst|adoc)$/iu;

/** 会话分片数上限（与 maxFiles 分离——旧实现同一常量两用，实际界是二次方）。 */
const DEFAULT_MAX_SESSIONS = 64;
/** 每会话记忆的文件数上限。200 = 单会话活跃编辑文件数的合理上界。 */
const DEFAULT_MAX_FILES = 200;
/** 默认未收敛拒绝次数上限：达上限后配额放行 + 警告（防理论死锁）。
 *  导出单源：host 的 BUILTIN_BASE 与 client 设置卡的回退显示共用，防三处漂移。 */
export const DEFAULT_MAX_DENIES = 2;
/** 写面大小阈值（字符数）：≤small 视为小改（只要求 read），>big 视为大段重写（升 high）。
 *  导出单源：host 的 BUILTIN_BASE 与 client 设置卡 fallback 共用，防三处漂移；
 *  放在 lib 而非 host 还避开另一个坑——host 的 BUILTIN_BASE 在模块求值期引用后段
 *  const 会命中 TDZ，插件加载即崩。 */
export const DEFAULT_SMALL_EDIT_CHARS = 200;
export const DEFAULT_BIG_EDIT_CHARS = 2000;

export interface FactGateOptions {
  maxSessions?: number;
  maxFiles?: number;
  maxDenies?: number;
}

/** 判定结果（判别联合：host 按 `kind` 平坦分流，不需要 `"quota" in decision` 探测）。
 *  deny 带的是**渲染输入**（`FactDenial`）而不是成品文案——语言由宿主在调用点决定。 */
export type FactDecision =
  // 取证齐备，放行
  | { kind: "allow" }
  // 未收敛拒绝达上限，配额放行——host 应警告
  | { kind: "quota" }
  // 拒绝：按成因列出仍缺项，文案由宿主现渲染
  | { kind: "deny"; denial: FactDenial }
  // 证据不可判定——host 走交互式确认
  | { kind: "indeterminate" };

/** 会话分片状态。 */
interface SessionState {
  /** 文件 → 连续未收敛拒绝计数与上次缺项集合（命中即 touch，真 LRU）。 */
  pending: Map<string, { denials: number; lastNeeds: string }>;
  /**
   * 配额放行的文件 → 放行时的事件水位（`logSeq`）。**失效条件是设计的一部分**：
   * 只有 host 认定"目标在放行之后被改过"（`fileEditSeq` 大于放行水位）才过期重来。
   * 而 host 的 `fileEditSeq` 只在**确属外部改动**时抬升、其余场景恒为 -1
   * （见 host.ts `evidenceFor` 的 staleBase，round 13 定稿"自己的连续编辑不再反复过门"）
   * ——所以同一会话里配额放行对同一目标是**持久**的，直到该文件被会话外改动、
   * 该分片被 LRU 淘汰、或插件重载（reset）。已知代价：模型"熬满 maxDenies 次拒绝"
   * 即拿到该文件的长期免检。是否收紧属产品决策（防死锁承诺与强校验相互制约），
   * 现有测试钉住当前语义，改动须同时调整新鲜度判据。
   */
  released: Map<string, number>;
}

/** 缺项集合的规范形态（按 need 去重、固定序，不含 why）——比对收敛用。
 *  规范顺序单源在 lib/gap-directives.ts 的 `NEED_ORDER`（与本文件的渲染口同处一份文件）。 */
function needsKey(gaps: FactGap[]): string {
  const has = new Set(gaps.map((gap) => gap.need));
  return NEED_ORDER.filter((need) => has.has(need)).join(",");
}

/** a 是否为 b 的**真**子集（收敛判据：只减不增才算照做）。 */
function isStrictSubset(a: string, rhs: string): boolean {
  if (a.length === 0 || a === rhs) {
    return false;
  }
  const rhsSet = new Set(rhs.split(","));
  return a.split(",").every((x) => rhsSet.has(x));
}

/**
 * 事实强制门状态机。纯内存、无 I/O。记忆按 session 分片（旧的全局集会在长驻宿主
 * 进程里跨会话泄漏）。事件循环单线程 → Map 操作无竞态，多会话并行安全。
 */
export class FactGate {
  private static readonly DEFAULT_SESSION = "";
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxSessions: number;
  private readonly maxFiles: number;
  private readonly maxDenies: number;

  public constructor(options: FactGateOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDenies = options.maxDenies ?? DEFAULT_MAX_DENIES;
  }

  /**
   * 编辑工具调用判定。
   * @param name      工具名（edit/write/str_replace_editor 才判定）
   * @param filePath  目标文件路径；空/缺失放行（不猜）
   * @param sessionId 会话身份（`exec.agent.session.id`）；缺省归入默认分片
   * @param input     host 现算的证据输入（缺省保守视为"取证未齐"）
   * @param maxDenies 本次生效的配额（来自 settings 运行时值）；缺省用构造值
   */
  public check(
    name: string | undefined,
    filePath: string | undefined | null,
    sessionId?: unknown,
    input?: FactEvidenceInput,
    maxDenies = this.maxDenies,
  ): FactDecision {
    if (name === undefined || !EDIT_TOOLS.has(name)) {
      return { kind: "allow" };
    }
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { kind: "allow" };
    }
    if (SKIP_EXT_RE.test(filePath)) {
      return { kind: "allow" };
    }
    const st = this.shard(sessionId);
    // 无输入 = 无法判定，保守按"两项都没做过"处理（缺信息一律要更多，不要更少）。
    const gaps: FactGap[] = input?.gaps ?? [
      { need: "read", why: "never" },
      { need: "refs", why: "never" },
    ];
    const done = input?.done ?? [];

    // 1) 配额放行：仅当目标在其后**未**被成功编辑过时有效。
    if (FactGate.tryRelease(st, filePath, input)) {
      return { kind: "allow" };
    }

    // 2) 取证齐备 → 放行，并清掉拒绝计数（下一轮从 1 起，"连续"名副其实）。
    if (gaps.length === 0) {
      st.pending.delete(filePath);
      return { kind: "allow" };
    }
    const prev = st.pending.get(filePath);
    // 3) 首拒：不论证据可否判定，先给**行动清单**——模型还没开始取证，此刻说
    //    "无法验证"既不可达也不行动（教它做什么优先于评判它做得如何）。
    if (prev === undefined) {
      this.note(st, filePath, 1, needsKey(gaps));
      return { kind: "deny", denial: denialOf(gaps, done, 1, input) };
    }
    return this.decideAfterFirstDeny(st, filePath, prev, maxDenies, { input, gaps, done });
  }

  public dropSession(sessionId: unknown): void {
    const key = FactGate.keyOf(sessionId);
    if (key !== FactGate.DEFAULT_SESSION) {
      this.sessions.delete(key);
    }
  }

  /** 清空全部记忆（插件停用时）。 */
  public reset(): void {
    this.sessions.clear();
  }

  /**
   * 配额放行判定：命中且目标编辑位不晚于放行位才放行；否则记入过期并回到正常过门。
   * 「目标编辑位」由 host 提供，host 只在确属外部改动时抬升它（见 SessionState.released
   * 的不变式说明）——这里不做任何 fs/会话推断。
   */
  private static tryRelease(
    st: SessionState,
    filePath: string,
    input: FactEvidenceInput | undefined,
  ): boolean {
    const releaseSeq = st.released.get(filePath);
    let released = false;
    if (releaseSeq !== undefined) {
      if ((input?.fileEditSeq ?? -1) <= releaseSeq) {
        released = true;
      } else {
        // 编辑过 → 配额过期，回到正常过门。
        st.released.delete(filePath);
      }
    }
    return released;
  }

  /** 首拒之后的收敛/配额判定（步骤 4-5，独立出来降 check 复杂度）。 */
  private decideAfterFirstDeny(
    st: SessionState,
    filePath: string,
    prev: { denials: number; lastNeeds: string },
    maxDenies: number,
    req: { input: FactEvidenceInput | undefined; gaps: FactGap[]; done: FactNeed[] },
  ): FactDecision {
    const { input, gaps, done } = req;
    // 4) 重试仍无法判定 → 交互式确认（不消耗配额；逃生口文案见消息表的 indeterminate 键）。
    if (input !== undefined && !input.determinate) {
      return { kind: "indeterminate" };
    }
    // 5) 收敛性：缺项集合是上次**真子集** = 模型确实在补 → 计数重置为 1。
    //    不能只比数量：`[refs,test] → [read]` 数量 2→1 看着像在收敛，实际没补上
    //    refs 反而新开了缺口——真子集判定（'read' ⊄ 'refs,test'）才不奖励它。
    //    但也不能"集合一变就重置"（否则永远攒不满配额 → 无限循环）。
    //    故定死：真子集才重置，其余（含不变、换项、变多）一律计数。
    const key = needsKey(gaps);
    const denials = isStrictSubset(key, prev.lastNeeds) ? 1 : prev.denials + 1;
    let decision: FactDecision;
    if (denials > maxDenies) {
      st.pending.delete(filePath);
      this.lruSet(st.released, filePath, input?.logSeq ?? 0);
      decision = { kind: "quota" };
    } else {
      this.note(st, filePath, denials, key);
      decision = { kind: "deny", denial: denialOf(gaps, done, denials, input) };
    }
    return decision;
  }

  private note(st: SessionState, filePath: string, denials: number, lastNeeds: string): void {
    this.lruSet(st.pending, filePath, { denials, lastNeeds });
  }

  /** 取会话分片（不存在则建，并按 maxSessions 真 LRU 淘汰）。 */
  private shard(sessionId: unknown): SessionState {
    const key = FactGate.keyOf(sessionId);
    let st = this.sessions.get(key);
    if (st !== undefined) {
      // touch：活跃会话不会被插入序挤掉。
      this.sessions.delete(key);
      this.sessions.set(key, st);
      return st;
    }
    st = { pending: new Map(), released: new Map() };
    FactGate.lruSetAt(this.sessions, key, st, this.maxSessions);
    return st;
  }

  private static keyOf(sessionId: unknown): string {
    if (typeof sessionId === "string" && sessionId.length > 0) {
      return sessionId;
    }
    if (
      typeof sessionId === "number" ||
      typeof sessionId === "bigint" ||
      typeof sessionId === "boolean"
    ) {
      return String(sessionId);
    }
    return FactGate.DEFAULT_SESSION;
  }

  /** LRU 写入（会话表与每会话两张表共用）：先删后插刷新位次，超容量按插入序淘汰。
   *  淘汰用 for-of 而非 `keys().next()`——后者要一个"取不到键"的收窄分支，而容量判定已保证
   *  表非空，那个分支永远不可达（永远测不到 = 覆盖率与代码诚实度的双重负债）。 */
  private static lruSetAt<Value>(
    map: Map<string, Value>,
    key: string,
    value: Value,
    cap: number,
  ): void {
    map.delete(key);
    for (const oldest of map.keys()) {
      if (map.size < cap) {
        break;
      }
      map.delete(oldest);
    }
    map.set(key, value);
  }

  /** 会话内两张台账（pending/released）的 LRU 写入，容量为 maxFiles。 */
  private lruSet<Value>(map: Map<string, Value>, key: string, value: Value): void {
    FactGate.lruSetAt(map, key, value, this.maxFiles);
  }
}
