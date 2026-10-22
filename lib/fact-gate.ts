// lib/fact-gate.ts —— 编辑事实强制门（gateguard 移植，ECC MIT）。
//
// 核心洞察（ECC A/B 实证，平均 9.0 vs 6.75）：LLM 自我评估无效——
// 问"你确定吗"永远答"确定"；但 DENY 编辑并强制把具体事实列进上下文
// （谁引用这个文件、哪些测试/文档触达它、逐字引用用户指令），
// 调查行为本身创造了改变输出质量的上下文。
//
// 分工（讨论定稿）：
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
//   1. **新鲜度只认外部改动**（定稿）：模型自己连续编辑同一文件**不再反复
//      过门**——edit 的返回本身就带着改动后的内容，再逼一次 read 是纯仪式。只有
//      本会话之外改了目标（另一会话 / bash / sed）才作废证据。引用/逐层结论同样
//      不因编辑本文件而失效（谁引用它不由本文件内容决定）。
//   2. **配额只数未收敛的拒绝**：缺项变少 = 模型正在照做 → 计数重置。"一次补一项"
//      是门禁期望的收敛行为，绝不能被配额反过来惩罚。
//   3. **提示按成因定制，不甩统一模板**：同一个"缺 read"，没读过 / 调用失败过 /
//      被别的会话改过，该做的事完全不同。给不出具体路径与文件名的提示等于没说。
//
// 内存：会话分片数上限 maxSessions；每会话两张台账（pending / released）各 maxFiles，
// 各自按访问型 LRU 淘汰（`check` 命中即 touch；`releasedFor` 保持只读不 touch）——单会话
// 上界约 maxSessions × 2 × maxFiles 个文件条目。dropSession() 由 host 接线到官方
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

/** 逐层探查项：引用面与 read 有各自的投递/新鲜度口径，不参与 layerSeqs。 */
export type LayerNeed = Exclude<FactNeed, "read" | "refs">;

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
  gaps: readonly FactGap[];
  /** 已满足的项：写进消息，明示"做过的不再要求"（防重复劳动）。 */
  done?: readonly FactNeed[];
  /** 证据判定是否可行（false = 会话历史不可得 → 交互式确认）。 */
  determinate: boolean;
  /** 当前已处理事件数（配额水位锚点）。 */
  logSeq: number;
  /** 目标当前**未了结的外部改动**水位（事件下标）；-1 = 没有。
   *  只由 host 的外部改动归因抬升，模型自己的连续编辑不抬升——配额与新鲜度都按这条口径。 */
  externalChangeSeq: number;
  /** 目标是否为新建（write/create 且 fs 不存在）。 */
  newFile?: boolean;
  /** 渲染提示用的具体上下文。 */
  ctx?: FactGapContext;
}

/** 预检的投递水位：两项各自的**投递位次**（-1 = 这一项从未投递）。
 *  拆成两位而不是 `{seq, read, refs}` 一枚：A 面只投 refs、B 面可能只投 read，两者先后落在
 *  同一个键上——合一位要么覆盖掉对方那一项，要么把 read 的新鲜度按 refs 的位次重算，而
 *  read 的判据要的正是**它自己那次**投递的位次（与 `staleBase` 比）。 */
export interface DeliveryWatermark {
  readonly readSeq: number;
  readonly refsSeq: number;
  /** 层探查（test/e2e/docs）各自的投递位次：与 refs 同理由拆位——一次 B 面可能只覆盖其中
   *  两层（第三层不在扫描覆盖里），合一位就会把"已投递"扩散到没覆盖的那层上。 */
  readonly layerSeqs: Readonly<Partial<Record<LayerNeed, number>>>;
}

/** 没有投递时的缺省水位：两位皆 -1——与"从未投递"在比较与短路下同形（比较恒假）。
 *  运行时也冻结：它被多个模块当共享常量传递，冻结让"谁把它改了一格"当场暴露。 */
export const NO_DELIVERY: DeliveryWatermark = Object.freeze({
  readSeq: -1,
  refsSeq: -1,
  layerSeqs: Object.freeze({}),
});

/** 无法判定证据时的退化输入：只按 read/refs 两项起步，**不探层**——历史不可得时 host
 *  也没有可归因的层结论，`layerSeqs` 因此不参与这一面。
 *  预检的投递水位不在"没做过"之列——那是插件自己的记录（B 面当场递过正文、A 面随读取
 *  附过引用面），**不依赖会话日志**。不剔除它就会出现"预检补完 → guard 仍按不可判定缺项
 *  拒 → 再补 → 再拒"的死循环（配额放行只是把死循环换成免检，不是解）。
 *  `done` 那格照本模块的口径带上，让拒绝文案能说清"已经给过的不再要求"。
 *  两项都已投递 ⇒ gaps 为空，`check` 直接放行（首拒/交互确认都不再发生）。 */
export function undeterminable(delivered: DeliveryWatermark): FactEvidenceInput {
  const gaps: FactGap[] = [];
  const done: FactNeed[] = [];
  if (delivered.readSeq >= 0) {
    done.push("read");
  } else {
    gaps.push({ need: "read", why: "never" });
  }
  if (delivered.refsSeq >= 0) {
    done.push("refs");
  } else {
    gaps.push({ need: "refs", why: "never" });
  }
  return { gaps, done, determinate: false, logSeq: 0, externalChangeSeq: -1 };
}

/** 一次拒绝的全部渲染输入（状态机的产出；文案由宿主用当前语言的消息表现渲染）。 */
export interface FactDenial {
  /** 仍缺失的取证项（带成因）。 */
  gaps: readonly FactGap[];
  /** 已满足的项：写进消息，明示"做过的不再要求"（防重复劳动）。 */
  done: readonly FactNeed[];
  /** 当前这一轮**连续未收敛**的拒绝计数（缺项变真子集时重置为 1；不是总尝试次数）。 */
  attempt: number;
  /** 目标是否新建（新建走"免 read 但引用面仍要探"的头部）。 */
  newFile: boolean;
  /** 本轮**配额被扣下**：缺项里还有 `read`（见 `decideAfterFirstDeny` 的决策 4 说明）。
   *  渲染时据此多一行——配额只免上层探查，`read` 不在豁免内。 */
  quotaWithheld?: true;
  /** host 现算的具体上下文（目标名/起点/生效检索名单）。 */
  ctx?: FactGapContext;
}

/** 组装一次拒绝的渲染输入。ctx 缺席时**不写该键**（exactOptionalPropertyTypes 下
 *  `ctx: undefined` 与"没有 ctx"是两回事），也正好让渲染侧走默认占位文案。
 *  数组取副本：状态机不把调用方可变的数组借给异步渲染方。 */
const denialOf = (
  gaps: readonly FactGap[],
  done: readonly FactNeed[],
  attempt: number,
  input: FactEvidenceInput | undefined,
  quotaWithheld = false,
): FactDenial => ({
  gaps: [...gaps],
  done: [...done],
  attempt,
  newFile: input?.newFile === true,
  ...(quotaWithheld ? { quotaWithheld: true as const } : {}),
  ...(input?.ctx === undefined ? {} : { ctx: input.ctx }),
});

/** 内部 need 键 → 文案表里的可读名字段。`satisfies` 让新增 FactNeed 在编译期必须补表。 */
const NEED_LABEL_KEYS = {
  read: "needLabelRead",
  refs: "needLabelRefs",
  test: "needLabelTest",
  e2e: "needLabelE2e",
  docs: "needLabelDocs",
} as const satisfies Record<FactNeed, keyof DangerGuardMessages>;

const needLabelOf = (messages: DangerGuardMessages, need: FactNeed): string =>
  messages[NEED_LABEL_KEYS[need]];

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
    const labels = done.map((need) => needLabelOf(messages, need)).join(messages.listSeparator);
    lines.push(fillTemplate(messages.confirmedLine, { done: labels }));
  }
  if (denial.quotaWithheld === true) {
    lines.push(messages.quotaWithheld);
  }
  return [head, ...lines, messages.declareTail].join("\n");
}

/** 编辑类工具名。str_replace_editor 是 dsh-base 并存的另一套编辑器
 *  （create/str_replace/insert 是写操作）；view 只读，host 侧把它算作 read 证据。 */
const EDIT_TOOLS = new Set(["edit", "write", "str_replace_editor"]);

/** 明确放行的文件面：**文档格式**扩展名（md/markdown/rst/adoc）。
 *  `.txt` 不在其中：它是通用文本容器，`CMakeLists.txt` / `requirements.txt` 是构建与
 *  依赖逻辑，不是"无执行影响"的文档。`.md` 也可能被文档构建系统消费，所以这条豁免
 *  只表示"按后缀免取证"，不承诺目标没有执行影响。
 *  test/ 目录**不再跳过**（收紧）：原 SKIP_PATH_RE 让模型可把改动挂到
 *  test/ 下躲过取证——旁路已堵，测试文件编辑同样过门。
 *  不对称是故意的：改文档零摩擦，但改代码要探文档层。
 *  **导出**是给 host 侧的预检用（`runPreflight` 与 `attachRefsOnRead` 两个触发点共用这同一道
 *  跳过判据）：预检要在门禁之前就决定"这次的编辑面根本不判"，两处各写一份正则迟早会漂——
 *  漂了就是"门禁不判、预检却代跑了一次扫描"（或反过来：模型以为预检覆盖了，实际门禁照拒）。 */
export const SKIP_EXT_RE = /\.(?:md|markdown|rst|adoc)$/iu;

/** 会话分片数上限（与 maxFiles 分离——旧实现同一常量两用，实际界是二次方）。 */
const DEFAULT_MAX_SESSIONS = 64;
/** 每张会话内台账（pending / released）的文件数上限；单会话最多记住约 2× 个条目。 */
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

/** 构造参数。三项都必须是**正安全整数**（`maxDenies` 的最小值是 1）；非法值在构造时抛
 *  `RangeError`，不再落到 `lruSetAt` 的"容量 0/NaN/Infinity"或"配额永不兑现"等隐式行为。 */
export interface FactGateOptions {
  maxSessions?: number;
  maxFiles?: number;
  maxDenies?: number;
}

/** 构造参数校验：缺省用内置值，给值则必须是正安全整数。 */
function positiveIntOf(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** 运行时覆盖值的降级：非法值回落构造值，而不是把配额变成永不兑现/首拒即放行。 */
function limitOf(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
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
   * 只有 host 认定"目标在放行之后被改过"（`externalChangeSeq` **不小于**放行水位）
   *  才过期重来。host 的 `externalChangeSeq` 只在**确属外部改动**时抬升、其余场景恒为 -1
   * （见 host.ts `evidenceFor` 的 staleBase——定稿口径"自己的连续编辑不再反复过门"）
   * ——所以同一会话里配额放行对同一目标是**持久**的，直到该文件被会话外改动、
   * 该分片被 LRU 淘汰、或插件重载（reset）。命中配额会刷新本条目的 LRU 位次。
   * 已知代价：模型"熬满 maxDenies 次拒绝"即拿到该文件的长期免检。是否收紧属产品决策
   * （防死锁承诺与强校验相互制约），现有测试钉住当前语义，改动须同时调整新鲜度判据。
   */
  released: Map<string, number>;
}

/** 缺项集合的规范形态（按 need 去重、固定序，不含 why）——比对收敛用。
 *  规范顺序单源在 lib/gap-directives.ts 的 `NEED_ORDER`（与本文件的渲染口同处一份文件）。 */
function needsKey(gaps: readonly FactGap[]): string {
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
 * 进程里跨会话泄漏）。单次调用内的状态更新是同步的，不会在函数内部交错；证据新鲜度
 * 与"判定到编辑执行"之间的原子性由 host / 工具执行层保证，本类不宣称后者。
 */
export class FactGate {
  /** 无/非法 sessionId 的内部标识：用 symbol 与任何真实字符串会话 id 隔离。 */
  private static readonly DEFAULT_SESSION = Symbol("danger-guard-default-session");
  private readonly sessions = new Map<string | symbol, SessionState>();
  private readonly maxSessions: number;
  private readonly maxFiles: number;
  private readonly maxDenies: number;

  public constructor(options: FactGateOptions = {}) {
    this.maxSessions = positiveIntOf(options.maxSessions, DEFAULT_MAX_SESSIONS, "maxSessions");
    this.maxFiles = positiveIntOf(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
    this.maxDenies = positiveIntOf(options.maxDenies, DEFAULT_MAX_DENIES, "maxDenies");
  }

  /**
   * 编辑工具调用判定。
   * @param name      工具名（edit/write/str_replace_editor 才判定）
   * @param filePath  目标文件路径；空/缺失放行（不猜）。host 应传**归一化后的绝对目标**，
   *                  否则同一个文件的不同写法会分裂状态、同一相对路径跨项目会共享状态。
   * @param sessionId 会话身份（`exec.agent.session.id`）；缺省归入默认分片
   * @param input     host 现算的证据输入；缺省归一为 `undeterminable(NO_DELIVERY)`：
   *                  首拒给行动清单，重试转交互确认（而不是按"两项都没做过"无限拒绝）
   * @param maxDenies 本次生效的配额（来自 settings 运行时值）；非法值回落构造值
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
    // 无输入 = 无法判定：与 determinate:false 走同一条退化路径（首拒→交互确认）。
    const evidence = input ?? undeterminable(NO_DELIVERY);
    const { gaps, done = [] } = evidence;

    // 1) 配额放行：仅当目标的外部改动水位**严格早于**放行水位时有效。
    if (this.tryRelease(st, filePath, evidence)) {
      return { kind: "allow" };
    }

    // 2) 取证齐备 → 放行，并清掉拒绝计数（下一轮从 1 起，"连续"名副其实）。
    if (gaps.length === 0) {
      st.pending.delete(filePath);
      return { kind: "allow" };
    }
    const prev = st.pending.get(filePath);
    if (prev !== undefined) {
      // 命中即续命：pending 的 LRU 位次按访问刷新（indeterminate 路径同样算命中）。
      this.lruSet(st.pending, filePath, prev);
    }
    // 3) 首拒：不论证据可否判定，先给**行动清单**——模型还没开始取证，此刻说
    //    "无法验证"既不可达也不行动（教它做什么优先于评判它做得如何）。
    if (prev === undefined) {
      this.note(st, filePath, 1, needsKey(gaps));
      return { kind: "deny", denial: denialOf(gaps, done, 1, evidence) };
    }
    return this.decideAfterFirstDeny(st, filePath, prev, limitOf(maxDenies, this.maxDenies), {
      input: evidence,
      gaps,
      done,
      logSeq: evidence.logSeq,
    });
  }

  public dropSession(sessionId: unknown): void {
    const key = FactGate.keyOf(sessionId);
    if (key !== FactGate.DEFAULT_SESSION) {
      this.sessions.delete(key);
    }
  }

  /**
   * 只读查询：该目标此刻是否处于**配额放行**态（防死锁承诺）。
   * 与 `tryRelease` 同一条严格判据（外部改动水位**严格早于**放行水位），但**一个状态都不改**：
   * 不建分片、不 touch、不删过期项——那些留给真正的 `check()`。
   * 当前**可判定地**仍缺 `read` 时一律返回 false：配额只免上层探查，不能让预检在
   * "模型还没看过当前版本"时替门禁让路。不可判定态沿用旧配额（交互确认是那条路的出口）。
   * 存在的理由：预检的「带证据拦一次」（host.ts 的 B 面）跑在 `tools/pre-execute`，而
   * guard 在其之后才跑。已经熬满 maxDenies 拿到免检的目标若被预检再停一次，等于把
   * 「防死锁」换成「插件自己新加的拒绝」——那是这道配额存在的反面。预检先问这一句，
   * 命中就整趟让路。
   */
  public releasedFor(sessionId: unknown, filePath: string, input: FactEvidenceInput): boolean {
    if (input.determinate && input.gaps.some((gap) => gap.need === "read")) {
      return false;
    }
    const releaseSeq = this.sessions.get(FactGate.keyOf(sessionId))?.released.get(filePath);
    return releaseSeq !== undefined && input.externalChangeSeq < releaseSeq;
  }

  /** 清空全部记忆（插件停用时）。 */
  public reset(): void {
    this.sessions.clear();
  }

  /**
   * 配额放行判定：命中且外部改动水位**严格早于**放行水位才放行；否则记入过期并回到正常过门。
   * 「外部改动水位」由 host 提供，host 只在确属外部改动时抬升它（见 SessionState.released
   * 的不变式说明）——这里不做任何 fs/会话推断。命中时刷新 released 的 LRU 位次；
   * `releasedFor` 的只读查询不走这里，因此不会 touch。
   */
  private tryRelease(st: SessionState, filePath: string, input: FactEvidenceInput): boolean {
    const releaseSeq = st.released.get(filePath);
    let released = false;
    if (releaseSeq !== undefined) {
      if (input.determinate && input.gaps.some((gap) => gap.need === "read")) {
        // 配额只免上层探查：可判定的 read 缺项不能让旧配额替它开门；不可判定态沿用旧配额，
        // 因为"历史读不到"本身不证明模型没读过这一版（交互确认是那条路的出口）。
        st.released.delete(filePath);
      } else if (input.externalChangeSeq < releaseSeq) {
        this.lruSet(st.released, filePath, releaseSeq);
        released = true;
      } else {
        // 外部改动水位到达或越过放行位 → 配额过期，回到正常过门。
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
    req: {
      input: FactEvidenceInput;
      gaps: readonly FactGap[];
      done: readonly FactNeed[];
      /** 配额水位锚点（`check` 现算，见那里的说明）。 */
      logSeq: number;
    },
  ): FactDecision {
    const { input, gaps, done, logSeq } = req;
    // 4) 重试仍无法判定 → 交互式确认（不消耗配额；逃生口文案见消息表的 indeterminate 键）。
    if (!input.determinate) {
      return { kind: "indeterminate" };
    }
    // 5) 收敛性：缺项集合是上次**真子集** = 模型确实在补 → 计数重置为 1。
    //    不能只比数量：`[refs,test] → [read]` 数量 2→1 看着像在收敛，实际没补上
    //    refs 反而新开了缺口——真子集判定（'read' ⊄ 'refs,test'）才不奖励它。
    //    但也不能"集合一变就重置"（否则永远攒不满配额 → 无限循环）。
    //    故定死：真子集才重置，其余（含不变、换项、变多）一律计数。
    const key = needsKey(gaps);
    const denials = isStrictSubset(key, prev.lastNeeds) ? 1 : prev.denials + 1;
    // 6) 决策 ④：配额**只免上层探查，不免 `read`**。达上限却仍缺 `read` 时扣下配额、照常拒
    //    （文案多一行点明这件事），于是"防死锁"只保住贵的那几项搜索；而 `read` 是最便宜、
    //    也最不可替代的一步证据 —— 放行它等于给一个**从未看过原文**的目标开长期免检，
    //    后面每次编辑都不会再被要求看过文件。补上 read 后，下一轮缺项集合成为真子集，
    //    计数重置；再连续拒绝到上限才兑现配额，所以这条路不会把模型困死。
    if (denials > maxDenies && gaps.some((gap) => gap.need === "read")) {
      this.note(st, filePath, denials, key);
      return { kind: "deny", denial: denialOf(gaps, done, denials, input, true) };
    }
    let decision: FactDecision;
    if (denials > maxDenies) {
      st.pending.delete(filePath);
      this.lruSet(st.released, filePath, logSeq);
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

  private static keyOf(sessionId: unknown): string | symbol {
    if (typeof sessionId === "string" && sessionId.length > 0) {
      return `s:${sessionId}`;
    }
    if (typeof sessionId === "number") {
      return `n:${String(sessionId)}`;
    }
    if (typeof sessionId === "bigint") {
      return `b:${String(sessionId)}`;
    }
    if (typeof sessionId === "boolean") {
      return `o:${String(sessionId)}`;
    }
    return FactGate.DEFAULT_SESSION;
  }

  /** LRU 写入（会话表与每会话两张表共用）：先删后插刷新位次，超容量按插入序淘汰。
   *  淘汰用 for-of 而非 `keys().next()`——后者要一个"取不到键"的收窄分支，而容量判定已保证
   *  表非空，那个分支永远不可达（永远测不到 = 覆盖率与代码诚实度的双重负债）。
   *  容量由构造参数校验保证是正安全整数；`0/NaN/Infinity` 不再落到这里。 */
  private static lruSetAt<Key, Value>(
    map: Map<Key, Value>,
    key: Key,
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
