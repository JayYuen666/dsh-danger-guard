// danger-guard host 半：危险命令物理拦截 + 首次编辑事实强制门。
//
// 两个防线都挂 ctx.tools.guard（同步谓词，返回字符串即拒绝）：
//   1. bashDanger  — ECC block-no-verify / dev-server-block / curl|sh / rm -rf 移植
//   2. editDanger  — 密钥/凭据路径编辑拦截（edit/write + str_replace_editor，
//     view 只读不拦；两套编辑器并存，漏掉后者即成旁路面）
//   3. FactGate    — gateguard 事实强制门（ECC A/B +2.25 分实证机制）
// 宿主拒绝路径已核实：guardReason → tool result "Error: <理由>" isError:true，
// 模型收到可行动的指令而非静默失败。
//
// 运行方式：dsh cordis Loader 直接 import 本 .ts（Node ≥22.18 类型剥离）。
// schemastery 的值导入只发生在 lib/settings-schema.ts（设置条目那一侧）。
// @deepseek-ai/* 里本文件**只有一处**值导入：`@deepseek-ai/dsh-brand` 的 `brandNumber`。
// 原因是官方的 `SessionLogOffset`（dsh-session/lib/types/types.d.ts:21）是**编译期幻影品牌**
// （`number & { [BRAND]: "SessionLogOffset" }`），type-only 面没有任何构造口，而 lint 的
// `typescript/no-unsafe-type-assertion` 禁止用 `as` 硬造——唯一合法的送法就是官方自己的
// `brandNumber`（dsh-brand/lib/types/index.d.ts:34）。它是 dsh-brand 的恒等函数，且该包
// 自述「不拥有任何具体域值，也不保留任何运行时身份或可变状态，独立安装的副本产出可互换的
// 值」），所以把 dsh-brand 落在 **dependencies**、产物留裸说明符：
// 官方自述它不保留运行时身份，且放 devDependencies 会被 rolldown 把函数体内联进 host.js
// （等于每包各持一份官方实现）。其余 @deepseek-ai/* 一律 type-only。

import path from "node:path";
import { statSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import type { Context, Events } from "@deepseek-ai/cordis";
// 官方工具契约（type-only）：`ctx.tools` 的服务面与 guard 谓词收到的执行面都直接从
// `ToolRuntime` / `ToolExecution` 上取（见下方 GuardService / GuardExecution），本文件一个字
// 都不再重述它们的签名。dsh-tools 是 devDependency，产物里不能出现对它的运行时引用。
import type { ToolExecution, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
// 设置面 schema 单源在 lib/settings-schema.ts：设置条目（settings-host.ts）持有它，
// 本文件只读那个条目挂出的读数口（见 settingsConfig）。
import { BUILTIN_BASE, SETTINGS_READER } from "./lib/settings-schema.ts";
import type { Config } from "./lib/settings-schema.ts";
import { bashDanger, editDanger, editTargetPath } from "./lib/danger-rules.ts";
import type { BashDenialKey, BashDangerOptions, EditDangerOptions } from "./lib/danger-rules.ts";
import {
  FactGate,
  renderDenyMessage,
  DEFAULT_MAX_DENIES,
  DEFAULT_SMALL_EDIT_CHARS,
  DEFAULT_BIG_EDIT_CHARS,
} from "./lib/fact-gate.ts";
import type { FactDenial, FactEvidenceInput, FactGap, FactNeed, NeedWhy } from "./lib/fact-gate.ts";
// 引用取证的口径面单源在 lib/ref-search-policy.ts：名单默认值与派生映射都在那里，
// 本文件每次判定现读设置算出策略，指令渲染侧（lib/gap-directives.ts）吃同一份。
import {
  refSearchPolicyOf,
  DEFAULT_REF_SEARCH_STRICT_TOOLS,
  DEFAULT_REF_SEARCH_TOOLS,
} from "./lib/ref-search-policy.ts";
import type { RefSearchCriterion, RefSearchPolicy } from "./lib/ref-search-policy.ts";
// 模型可见文案的中英两份单源。判定链（lib/*、下面的 evidenceFor/assembleGaps）只产结构，
// 文案在本文件的 guard 调用点按当前语言现取现渲染——纯函数不读设置。
import { fillTemplate, MESSAGES } from "./lib/messages.ts";
import type { DangerGuardMessages } from "./lib/messages.ts";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（未注册即中文）。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
// 共享记账骨架：事件流 → tool/call+tool/result 两张表，
// 与 quality-gate 共用同一实现；FieldGate 的读/写/引用分类留在本文件。
// `SessionEvent` 是**官方**判别联合（shared 从 @deepseek-ai/dsh-session 原样 re-export，
// 两个 PTC 变体由 @deepseek-ai/dsh-tools/types 官方增强并入）：本文件不再自声明
// 「最小投影」，按 event.type 分支即收窄 data，宿主换形状就编译不过。
import { scanToolEvents } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
import type {
  SessionEvent,
  ToolCallRecord,
  ToolResultRecord,
} from "@jayyuen66/dsh-plugin-shared/lib/tool-events";
// 取证台账投影：单元 + 读侧换算 + 采信门（台账不可信 ⇒ undefined ⇒ 回退全量扫描）。
import {
  LEDGER_KEY,
  asLedger,
  callsOf,
  resultsOf,
  toolLedgerProjection,
} from "./lib/tool-ledger.ts";
import type { ToolLedger } from "./lib/tool-ledger.ts";
// 会话只读面（SessionLogFace）与日志偏移品牌都钉到官方声明：`Session` 是
// @deepseek-ai/dsh-session 的类面（名义比较，故只 Pick 成员而不取整类），
// `SessionLogOffset` 是品牌数，`brandNumber` 是它唯一的合法构造口（见文件头）。
import { brandNumber } from "@deepseek-ai/dsh-brand";
import type { Session, SessionLogOffset } from "@deepseek-ai/dsh-session";
// lesson bus 收口：lesson-loop 的 report/pass 现在是异步落库（返回 Promise），
// 只包一层同步 try/catch 抓不到 rejection——失败会被静默吞掉，还给宿主进程留一枚
// 未处理拒绝。同步抛错与异步拒绝共用这一个出口（三个包的调用点降级口径一致）。
import { settleLessonCall } from "@jayyuen66/dsh-plugin-shared/lib/lesson-bus";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 事实门教训的类别级稳定签名：lesson-loop 规则卡按
 *  该签名归并，而非按目标文件路径——与 lesson-store 的 CATEGORY_SIGNATURES
 *  ["factgate-deny"] 保持同值。target 路径在上报 evidence 里，不丢信息。 */
const FACTGATE_SIGNATURE = "edit-before-factgate";

/** 嵌套 shell `-c` 体**未被检查**（引号不闭合 / 超出下钻上限）的类别级稳定签名。
 *  它与"命中危险模式"的拒绝共用 dangerous-bash 分类，但签名必须分开：前者教的是
 *  「认不准就先找人确认」，后者教的是「换掉那个危险形态」。用命令原文当前者的签名，
 *  只会把同一条教训按套娃长度碎成无数张卡（每次输入都不重复，永远攒不到 armed）。 */
const NESTED_UNCONFIRMED_SIGNATURE = "bash-nested-shell-unconfirmed";

/** 官方 `ToolExecution.agent` 去掉可选后的 `Agent`。本包**未**声明 `@deepseek-ai/dsh-agent`
 *  依赖，故经官方成员索引访问取到它，而不 import 类名（zvec-grep/lib/routing.ts:40 同策）。 */
type OfficialAgent = NonNullable<ToolExecution["agent"]>;

/** tools.guard 收到的调用面 = **官方 `ToolExecution` 的本包读取投影**。
 *  两位键名与值域都不再本地重述：
 *  - `name` / `arguments` 直接 `Pick`（installed `@deepseek-ai/dsh-tools/lib/types/index.d.ts`
 *    `ToolExecutionInput` :206 上的 `readonly name: string` :213 与 `readonly arguments: unknown`
 *    :217，两者**必选**，`ToolExecution` :272 原样继承）。旧镜像把 `arguments` 抄成可选，那是
 *    一位比契约**更宽**的声明：宿主不交付"缺 arguments 的执行面"，宽出来的那一档只会在谓词里
 *    长出测不到的死分支（注释里写「投影不该比契约更宽」，抄的却是宽版——现已归官方）。
 *  - `agent` 一位只能投影、不能取官方类：官方 `Agent.session` 是 dsh-session 的 `Session`
 *    类（`readonly session: Session`，dsh-agent/lib/types/runtime-types.d.ts:143，**必选**），
 *    而 `Session` 带私有字段（`private log` / `private readonly surfaceManager`，
 *    dsh-session/lib/types/index.d.ts:105-107 → TS 按**名义**比较），本包的替身会话永远满足
 *    不了整类。故这里只**借两个键名**（`agent` 由 `ToolExecution` 交出、`session` 由
 *    `OfficialAgent` 交出，官方任一环改名即在此编译不过），值域换成 `SessionLogFace`。
 *  `agent` / `session` 留可选是本包对**跨进程边界**的口径（官方 `agent?: Agent` :219 本就可选，
 *  无 agent 的执行体确实存在；会话是否交得出来只能运行时判），不是替宿主重新裁定必选性。 */
type GuardExecution = Pick<ToolExecution, "name" | "arguments"> & {
  /** 调用方 agent 链（ToolExecution.agent），会话隔离取证用。
   *  session 面见 SessionLogFace：真实 session 有 snapshotEvents（quality-gate 同款），
   *  证据判定（read/grep 过目标文件）靠扫描会话历史得到。 */
  readonly agent?: {
    readonly [Key in keyof Pick<OfficialAgent, "session">]?: SessionLogFace;
  };
};

/** `ctx.tools` 的服务面 = 官方 `ToolRuntime`（installed dsh-tools/lib/types/index.d.ts:512，
 *  cordis `Service` 子类 + 一整套私有字段 → 名义比较，结构替身与本包测试桩都满足不了）的
 *  **方法面投影**：只 `Pick` 本文件调的 `guard`，签名一个字都不再重述——原文在同文件 `:638`
 *  `guard(guard: ToolGuard): () => void`（谓词类型 `ToolGuard` 在 `:507`，交出
 *  `Readonly<ToolExecution>`；`Context.tools: ToolRuntime` 的官方增强在 `:34`）。
 *  于是 guard 谓词的入参与撤销句柄的返回都跟着官方成员走：官方加一枚必填参数或换掉载荷类型，
 *  本文件当场是编译错误，而不是镜像照样编译通过、调用点静默拿到错形状。
 *  （`ocr-review` / `zvec-grep` 还额外 `Pick` 了 `register`——它们注册工具；本包不注册。） */
type GuardService = Pick<ToolRuntime, "guard">;

/** 设置条目挂出的值面读数口（与 settings-host.ts 的导出形状同源，按结构本地声明：
 *  拦截半不 import 设置半，两个产物各自自包含，谁也不依赖谁的运行时）。 */
interface SettingsReader {
  read: () => Config;
}

/**
 * 官方 `SettingsForms`（installed `@deepseek-ai/dsh-settings/lib/types/index.d.ts:62`，
 * `Service` 子类 + private `ownerContext/revisions/closed/scheduled/presentations` → 名义
 * 比较）的方法面投影：本文件只用 `describe`（跨命名空间读官方 locale 偏好，见 localeMessages）。
 * 此前这里挂的是**整个类**，那是一条对本包需求的过度声明——它宣称「宿主必须给我一枚完整的
 * settings 服务」，而 `HostCtx` 其余每个服务面都只点名自己用到的成员，`isDangerGuardHost`
 * 也只探 `describe` 这一位（多探一项就等于多给闸门一条失败路径）。投影不重述签名：
 * `describe(options?: SettingsDescribeOptions): SettingsDescriptor[]` 的入参与返回都由官方
 * 成员交出（installed :96）。口径同 ocr-review/host.ts:223 与 zvec-grep/host.ts:210——区别只在
 * 那两包还用了 `configure`：本包的页面策略归**设置条目**声明（见 apply 上方注释），故不取。
 */
type SettingsFormsService = Pick<SettingsForms, "describe">;

/** 宿主服务面（结构投影：与真实 Context 接口兼容，避免值导入 @deepseek-ai/*）。 */
interface HostCtx {
  tools?: GuardService;
  settings: SettingsFormsService;
  /** 可选服务读取：本地面**故意**留着，不吃 `Context["get"]`。官方那是两枚重载
   *  （installed `@deepseek-ai/cordis/lib/types/reflect.d.ts:14`
   *  `get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]` 与
   *  :16 `get(name: string, strict?: boolean): any`），而本文件读的两枚名字
   *  （`SETTINGS_READER`、`lessonLoop`）**都没有**声明进官方 `Context`——`lessonLoop` 在整份
   *  宿主安装里检索为 0 命中（它是本仓 sibling 插件自己 provide 的名字），故任何一枚都只能落到
   *  :16 那条 `any` 兜底臂上。那等于把两个调用点从现在的 `unknown` + 函数象限守卫
   *  （`isSettingsReader` / `isLessonLoopReporter`）降级成 `any` 直灌，还会新添一批
   *  no-unsafe-* 噪音。返回 `undefined` 是官方语义（:12 "or `undefined` when not (yet)
   *  provided"），这一点本地面与官方一致。 */
  get?: (name: string) => unknown;
  /** 官方效应面（`interface Context extends Pick<Fiber, 'effect'>`，installed
   *  `@deepseek-ai/cordis/lib/types/fiber.d.ts:8`，两条重载在 :157/:159）——本地不再重述
   *  工厂签名。⚠ 官方的返回域（`SyncEffect` / `Effect`，:49-51）**不受理 `undefined`**：
   *  「这一趟没有要清理的东西」在契约里是一枚空 disposer，见 NOOP_DISPOSER。 */
  effect: Context["effect"];
  /** 会话销毁事件（官方 session/disposed）——接线 fact-gate 会话分片及时回收。
   *  载荷不再手抄成 `{ id?: unknown }`：它就是官方事件的第一个实参
   *  （`session/disposed(this: Scoped<Session>, session: Session): void`，installed
   *  `@deepseek-ai/dsh-session/lib/types/index.d.ts:51`，经 cordis `Events` 的官方增强），
   *  故 `Parameters<Events["session/disposed"]>[0]` = 官方 `Session` 类面，本包读的那三位
   *  （`id` / `header` / `snapshotEvents`）由 `SessionLogFace` 承接。
   *  ⚠ 这里**不**换成 `Context["on"]`：那是全仓延后项（泛型 `on<K extends keyof Events>` 会
   *  重写每一枚监听器签名，ctx-observe/host.ts:329-336 记着同一条理由）。 */
  on?: (
    event: "session/disposed",
    listener: (session: Parameters<Events["session/disposed"]>[0]) => void,
  ) => unknown;
  /** 注入子上下文（用它挂投影单元的注册与读口）。按**可选**收：cordis 只在依赖到位时
   *  才激活回调，没装 dsh-session-projection 的 profile 上这条路径整体不存在，闸门沿用
   *  回退扫描——写进 `isDangerGuardHost` 的硬前置等于把闸门下线（同 session-rescue 的口径：
   *  探针只能探"真会直接调的方法"）。child 面按本包用到的那一位投影。 */
  inject?: (
    deps: readonly string[],
    activate: (child: { sessionProjections: ProjectionsRegistry }) => void,
  ) => unknown;
}

/**
 * 空 disposer：官方 `Context['effect']` 的工厂返回域是 `SyncEffect` / `Effect`
 *（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:49-51`，
 * `SyncEffect<T> = Disposable<T> | Iterable<Disposable<T>, void, void>`，:50），两支都
 * **不受理 `undefined`**——「这一趟没有要清理的东西」在官方契约里是一枚空 disposer，而不是
 * 缺省返回。旧代码让工厂走到末尾（`svc.effect(() => { factGate.reset(); })`），是被本地那份
 * 比官方宽的效果面镜像（`(factory: () => (() => void) | undefined, …) => void`）惯出来的；
 * `effect` 改绑官方后那一处当场红，编译器原话：
 * `error TS2769: No overload matches this call. The last overload gave the following error.
 *  Argument of type '() => void' is not assignable to parameter of type '() => Effect<any>'.
 *  Type 'void' is not assignable to type 'Effect<any>'`。
 * ⚠ 这是一处**官方与旧代码的分歧**，不是本包的语义修复：改的只是「交回什么给 cordis 记账」
 * （undefined → 一枚什么都不做的回收函数），运行时行为逐字不变（reset 仍在 apply 时同步跑一次，
 * fiber 卸载时调用的空 disposer 无副作用）。
 */
const NOOP_DISPOSER = (): void => {
  void 0;
};

/** host 是否为本插件所需服务面（settings/effect 保证存在；tools/get/on 可选）。
 *  逐字段解构守卫，避免 `ctx as HostCtx` 的不安全断言（no-unsafe-type-assertion）。
 *  拦截半对 settings 的**唯一**硬前置是 describe()（跨命名空间读：locale 偏好 +
 *  设置条目的值面）；旧的 register / get 已从宿主删除，configure 归设置条目，
 *  都不再是本条目的装配条件——多探一项就等于多给闸门一条失败路径。 */
function isDangerGuardHost(value: unknown): value is Context & HostCtx {
  if (!isRecord(value)) {
    return false;
  }
  const { settings, effect } = value;
  if (typeof effect !== "function" || !isRecord(settings)) {
    return false;
  }
  return typeof settings["describe"] === "function";
}

/** lesson-loop 总线最小面类型守卫：report/pass 我都按函数判（象限守卫）。 */
function isLessonLoopReporter(value: unknown): value is LessonLoopReporter {
  if (!isRecord(value)) {
    return false;
  }
  const { report, pass } = value;
  return typeof report === "function" && (pass === undefined || typeof pass === "function");
}

/** unknown → 稳定字符串键：原始类型转成 String，其余给 ""（会话键只需能区分即可，
 *  避免 no-base-to-string 对任意对象 String() 的默认序列化）。 */
function stringIdOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/**
 * lesson-loop 总线最小面（自进化闭环）：可选读——总线未装/未就绪时
 * 拦截照常生效，只丢报告；report 自身容错，守卫热路径绝不因总线故障而失败。
 *
 * 返回值按 unknown 收而不是 void：lesson-loop 落库已异步（report 返回 Promise，
 * pass 按契约也可能），而 `(input) => void` 的函数类型**恰好允许调用方丢弃返回的
 * Promise**——TS 不会报"游离 Promise"，no-floating-promises 也看不到，失败于是被
 * 静默吞掉并留下一枚未处理拒绝，正是这次修的根因。unknown 保留真实形状，逼调用方
 * 经 settleLessonCall 收口（见其注释）。
 */
interface LessonLoopReporter {
  report: (input: {
    source: "danger-guard";
    category: string;
    cwd?: unknown;
    sessionId?: unknown;
    signature: string;
    detail: string;
    evidence?: Record<string, unknown>;
  }) => unknown;
  /** pass 信号：规则场景被触发且被遵守（fact-gate 通过）。 */
  pass?: (input: {
    category: string;
    cwd?: unknown;
    sessionId?: unknown;
    signature: string;
  }) => unknown;
}

/** settings 数组字段收窄：unknown[] → string[]（非数组 → undefined 用 base）。
 *  低危可观测：数组里混入非字符串项会被丢弃——一次性 warn，避免"配了没生效"无迹可循。 */
let strArrayWarned = false;
const strArray = (value: unknown): string[] | undefined => {
  let out: string[] | undefined;
  if (Array.isArray(value)) {
    const valid = value.filter((x): x is string => typeof x === "string");
    if (valid.length !== value.length && !strArrayWarned) {
      strArrayWarned = true;
      console.warn(
        `[danger-guard] settings 数组含 ${value.length - valid.length} 个非字符串项，已忽略`,
      );
    }
    out = valid;
  }
  return out;
};

/**
 * 设置面（schema / 内置默认 / 命名空间）在 `lib/settings-schema.ts` 单源，本文件只是转发
 * 给既有导入方（test/*、client 侧的字段清单）继续用 `from "../host.ts"` 这一条路径。
 *
 * ⚠ 拦截半（本文件）**不再导出 `Config` 键**：0.1.7 的条目 Config 由 cordis 在 apply
 * 之前校验（vendor/cordis/src/fiber.ts:50、:641-664），越界值会让该条目 FAILED。
 * 一份用户可手改的严格 schema 挂在安全闸门上 = 一行笔误就让闸门整体下线（fail-open）。
 * 它现在只挂在设置条目 `danger-guard-settings`（settings-host.ts）上，两条目互相独立：
 * 设置面炸了只炸设置面，闸门照装、值面落回 BUILTIN_BASE 并大声告警。
 * （BUILTIN_BASE 与 Config 本文件内部也要用，故 import 与 export 各写一次。）
 */
export { BUILTIN_BASE, ConfigSchema, SETTINGS_NS } from "./lib/settings-schema.ts";
export type { Config } from "./lib/settings-schema.ts";

/**
 * 取证器读取的 session 只读面：**官方 `Session` 的成员投影**
 * （`@deepseek-ai/dsh-session` 安装态 `lib/types/index.d.ts`：`get id(): SessionId` :122、
 * `readonly header: SessionHeader` :118、
 * `snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[]` :192）。
 * 不再手抄字段形状——官方换形状即在此编译不过。
 *
 * `Session` 是类面（`private log` 等私有字段让它按**名义**比较），故只 `Pick` 三个成员、
 * 不取整类：本插件的替身对象永远满足不了整个类，而 `Pick` 出来的成员形状与官方同源。
 *
 * 三位一律 `Partial`：官方把 `header`/`snapshotEvents` 记成必选成员（:110-117 还写明
 * "a minimal header is synthesized … so `session.header` is always present"），但那句承诺
 * 说的是**宿主自己 `new` 出来的 Session**。本面收的是跨进程边界送来的宿主对象——在位与否
 * 只能运行时判（`buildEvalContext` 里读出的 `typeof reader === "function"`、`session.header?.cwd`）。
 * 官方类型描述宿主**承诺**什么，守卫负责宿主**交付**什么，两者并存。
 * `SessionHeader.cwd` 官方即 `readonly cwd?: string`（types.d.ts:69），故
 * `typeof cwdRaw === "string"` 那道守卫在迁移前后都仍然必要（空串另算：长度判定保留）。
 *
 * ⚠ 官方已把 `snapshotEvents` 标为 `@deprecated`（"new calls are prohibited"，:186-187）：
 * 如今这条读只剩**回退**用途——取证台账的主路径是 `ctx.sessionProjections` 上注册的
 * `danger-guard.toolLedger` 单元（lib/tool-ledger.ts），只有注册表缺席/迟到、台账被窗口
 * 或跳号作废时才走到这里（`ToolGuard` 官方签名同步 ⇒ 异步的 `ctx.sessionQuery` 在这道闸门
 * 上用不了，见那个文件的头部说明）。豁免因此**留在**这里，理由从"迁移另案"换成了它兜的那三件事。
 * 形参是官方品牌数 `SessionLogOffset`（types.d.ts:21）而**不是** `number`：读日志首必须
 * 经 `brandNumber<SessionLogOffset>(0)` 送出（见文件头列出的 dsh-brand 值导入）。
 */
type SessionLogFace = Partial<Pick<Session, "id" | "header" | "snapshotEvents">>;

/**
 * `ctx.sessionProjections` 的本包读面 = 官方 `SessionProjectionRegistry` 的成员投影
 * （installed @deepseek-ai/dsh-session-projection/lib/types/index.d.ts：host-only 的
 * `register(definition)` 第二重载、`stateOf(session, key)` :167-175）。
 * `stateOf` 的第一参官方钉名义类 `Session`，本包的替身会话永远满足不了 ⇒ 这里按
 * `unknown` 收，返回值再经 `asLedger` 过一次 `stateSchema`
 * （wukil-plugins/wukil-dev-tools.ts 与 session-rescue 的 ProjectionsRegistry 同形）。
 */
interface ProjectionsRegistry {
  register: (definition: typeof toolLedgerProjection) => () => void;
  stateOf: (session: unknown, key: typeof LEDGER_KEY) => unknown;
}

/** 可信台账读口：注册表在位时由 inject 回调装上；缺席 ⇒ 整条判定走回退扫描。 */
type LedgerReader = (session: SessionLogFace) => ToolLedger | undefined;

/** 台账容量（各台账共用；按插入序淘汰，防长驻进程无界增长）。 */
const LEDGER_CAP = 200;
/** 词干过短不做匹配（防 a.ts / ab.ts 这类两字母名到处顶包）。 */
const MIN_STEM = 4;
/**
 * 目标 → 任一会话最近看到的 mtime（**全局兜底**：给"本会话还没评估过该文件"的
 * 场景提供基线，见 mtimeBySessionPath）。
 */
const mtimes = new Map<string, number>();
/**
 * `会话|目标` → **该会话**上次看到的 mtime（新鲜度的实际基线）。
 * 只按路径共享会**消费掉跳变信号**：A 先评估就把 mtime 更新为新值，B 随后评估
 * 时看不到任何变化，于是带着改动前的旧 read 盲改。按会话存基线，才每个会话都能
 * 看见"自从我上次看它之后它变过"。
 */
const mtimeBySessionPath = new Map<string, number>();
/**
 * `会话|目标` → 该会话上次评估时的日志长度。
 * **必须按会话键**：存的是事件下标，跨会话复用会让新鲜度基准直接错位
 * （A 会话 len=50 写进台账，B 会话读到的 baseline 就是 A 的下标）。
 */
const seenLenBySessionPath = new Map<string, number>();
/** 项目根探测缓存（路径 → 根）。 */
const rootCache = new Map<string, string>();

/** LRU 写入：先删后插刷新位次；超容量按最旧淘汰。
 *  淘汰用 for-of 而非 `keys().next()` + undefined 收窄——容量判定已保证表非空，
 *  那个"取不到键"的分支永远不可达（测不到的分支就是覆盖率与可读性的双份负债）。 */
function lruPut<Value>(map: Map<string, Value>, key: string, value: Value): void {
  map.delete(key);
  for (const oldest of map.keys()) {
    if (map.size < LEDGER_CAP) {
      break;
    }
    map.delete(oldest);
  }
  map.set(key, value);
}

/** tools.guard 同步谓词契约需要同步 fs 访问（stat 用于存在性/mtime 取证）。
 *  *（同步契约下异步 fs 会破坏守卫热路径，此处必须同步。名称入 node/no-sync ignores。） */
function syncStat(targetPath: string): Stats {
  return statSync(targetPath);
}

/** tools.guard 同步契约下读取文件全文（mtime 归因的内容自证）。同样必须同步。 */
function syncReadText(targetPath: string): string {
  return readFileSync(targetPath, "utf8");
}

/** stat 的三态结论：**不存在**（ENOENT）/ **存在**（拿到 stat）/ **不可知**（其它错误）。 */
type Presence = "absent" | "present" | "unknown";

/**
 * fs 存在性判定（tools.guard 同步契约，经 syncStat）。
 * **只把 ENOENT 认作"文件不存在"**：EACCES（目录无权限）、ENOTDIR（路径中间是文件）、
 * ELOOP（符号链接成环）下文件其实**存在**，一律归为"不可知"。调用方据此决定新建豁免——
 * 把任何 stat 失败都当"新文件"，等于让权限问题替模型免掉 read（正是这道豁免最不该失守的方向）。
 * Node 的 fs 错误 message 以 errno 名开头（`ENOENT: no such file or directory, stat …`），
 * 取前缀即可分类，不必在 unknown 上做 code 字段收窄。
 */
function presenceOf(targetPath: string): { presence: Presence; mtimeMs: number } {
  let out: { presence: Presence; mtimeMs: number };
  try {
    out = { presence: "present", mtimeMs: syncStat(targetPath).mtimeMs };
  } catch (error: unknown) {
    const notFound = error instanceof Error && error.message.startsWith("ENOENT");
    out = { presence: notFound ? "absent" : "unknown", mtimeMs: -1 };
  }
  return out;
}

/** 文件是否存在（经 syncStat 取 stat，为 tools.guard 同步契约）。
 *  这里只用于"层目录/mark 文件在不在"的存在性探测——探测不出即按不在处理，
 *  方向保守（少要求一层探查）；目标文件的存在性必须用 presenceOf 区分。 */
function pathExists(targetPath: string): boolean {
  return presenceOf(targetPath).presence === "present";
}

/** 项目根：向上找工程标记（与 quality-gate gate-detect 同一族标记），否则退到会话 cwd。 */
const ROOT_MARKERS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "pnpm-workspace.yaml",
  ".git",
  "tsconfig.json",
];
/** 项目根探测使用的存在性包络（模块级，避免在循环内定义函数）。 */
const hasRootMarker = (dir: string): boolean =>
  ROOT_MARKERS.some((marker) => pathExists(`${dir}/${marker}`));

function projectRootOf(targetN: string, cwd: string | undefined): string {
  const cached = rootCache.get(targetN);
  if (cached !== undefined) {
    return cached;
  }
  let root = cwd ?? path.dirname(targetN);
  let dir = path.dirname(targetN);
  for (let depth = 0; depth < 12; depth += 1) {
    if (hasRootMarker(dir)) {
      root = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  lruPut(rootCache, targetN, root);
  return root;
}

/**
 * 波及面层目录（round 9「机械探查 + 文字声明双轨」的机械半轨）。
 * 层**存在**才要求探查——不存在由 fs 判定直接豁免，比让模型 grep 一次空目录便宜且
 * 零作弊面；存在的层要求至少一次**可归因**动作落在其中（符号级结论仍归文字声明）。
 */
const LAYER_DIRS: { need: FactNeed; names: string[] }[] = [
  { need: "test", names: ["test", "tests", "__tests__", "spec", "specs"] },
  { need: "e2e", names: ["e2e", "cypress", "playwright", "integration"] },
  { need: "docs", names: ["docs", "doc"] },
];

/** 目录是否存在（经 syncStat 取 stat 判定，为 tools.guard 同步契约）。 */
function isDir(targetPath: string): boolean {
  try {
    return syncStat(targetPath).isDirectory();
  } catch {
    return false;
  }
}

/** 层目录查找第一条命中（模块级，避免在循环内定义函数）。 */
const firstExistingLayer = (dir: string, names: string[]): string | undefined =>
  names.find((name) => isDir(`${dir}/${name}`));

/** 一条被探测到的层：need + 实际目录绝对路径（提示与归因都要具体路径）。 */
interface FactLayer {
  need: FactNeed;
  dir: string;
}

/** 层存在性缓存（`起点目录|追加测试目录` → 该链上存在的层）。 */
const layersByStart = new Map<string, FactLayer[]>();

/** 一个目录上的层探查（`existingLayersOf` 上走链的循环体）：对**尚未命中**的每一层，
 *  按层名表（test 层追加用户配置的 extraTestDirs）取第一条实际存在的目录记入 `found`。
 *  判定顺序与抽前逐字相同：先按 `LAYER_DIRS` 声明序、层名表内序，首次命中即占位。 */
function probeLayersAt(dir: string, found: Map<FactNeed, string>, extraTestDirs: string[]): void {
  for (const layer of LAYER_DIRS) {
    if (!found.has(layer.need)) {
      const names = layer.need === "test" ? [...layer.names, ...extraTestDirs] : layer.names;
      const hit = firstExistingLayer(dir, names);
      if (hit !== undefined) {
        found.set(layer.need, `${dir}/${hit}`);
      }
    }
  }
}

/**
 * 目标文件所属包链上**实际存在**的层（round 9 机械半轨的存在性判定）。
 * 从目标父目录一路向上到项目根逐级找层名——monorepo 里 `packages/foo/test/` 才是
 * 该文件的真实测试层，只在项目根找会漏。层不存在 → 直接豁免（不必让模型 grep 空目录
 * 自证"没有"）。缓存键含 extraTestDirs：词表变化时旧缓存必须失效。
 */
function existingLayersOf(targetN: string, root: string, extraTestDirs: string[]): FactLayer[] {
  const start = path.dirname(targetN);
  const cacheKey = `${start}|${extraTestDirs.join(",")}`;
  const cached = layersByStart.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const found = new Map<FactNeed, string>();
  let dir = start;
  for (let depth = 0; depth < 12; depth += 1) {
    probeLayersAt(dir, found, extraTestDirs);
    if (dir === root || dir === path.dirname(dir)) {
      break;
    }
    dir = path.dirname(dir);
  }
  // 按 LAYER_DIRS 声明序输出（稳定序，供 needsKey 之外的展示与收敛比对用）
  const out: FactLayer[] = [];
  for (const layer of LAYER_DIRS) {
    const at = found.get(layer.need);
    if (at !== undefined) {
      out.push({ need: layer.need, dir: at });
    }
  }
  lruPut(layersByStart, cacheKey, out);
  return out;
}

/**
 * 一次检索的作用域是否覆盖某层：检索 path 是层目录的**祖先或它本身**即算覆盖。
 * 项目根级 grep 的结果本就包含 test 层的命中，强制再进 test/ 搜一次是纯摩擦；
 * 但**兄弟目录**（如 lib/ 之于 test/）不覆盖，蹭不到证据。
 */
function scopeCoversLayer(root: string | undefined, layer: FactLayer): boolean {
  return root !== undefined && (root === layer.dir || layer.dir.startsWith(`${root}/`));
}

/** 触及导出面/签名的关键字：改动文本含这些词 → 波及面大概率超出文件自身，升档。 */
const SIG_KEYWORD_RE =
  /\b(?:export|default|declare|pub|fn|func|def|class|interface|type|enum|struct|trait|impl|public|protected)\b/u;

/** 高风险路径：manifest / lockfile / 构建配置 / CI / cordis 装配——改一个字符也能全局波及。 */
const RISKY_PATH_RE =
  /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|bun\.lockb?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|uv\.lock|requirements\.txt|setup\.py|tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?js|cordis\.(?:ya?ml|json)|Makefile|Dockerfile|docker-compose\.ya?ml|\.env(?:\.[\w-]+)?$|schema\.sql)$/u;

/**
 * 取证档位（round 11 定稿：按写面风险分档，配 strictMode 回到"每文件全探查"）。
 * 升档用**三元信号**而非只看大小——`package.json` 改一个版本号是"写面极小、爆炸半径
 * 最大"的典型，单靠 size 会把它放进最低档。
 */
type FactTier = "low" | "mid" | "high";

interface RiskFacts {
  /** 本次调用能否创建文件（write / str_replace_editor create）。 */
  creatable: boolean;
  /** 高风险路径（manifest/lockfile/CI/装配）。 */
  riskyPath: boolean;
  /** 改动文本是否触及导出面/签名关键字。 */
  sigChanged: boolean;
  /** 写面字符数；**取不到**（write 整文件覆盖、str_replace_editor edits 数组）。 */
  contentChars: number | undefined;
  strictMode: boolean;
  smallChars: number;
  bigChars: number;
}

/**
 * 定档。缺信息一律**升档**（③）：宁可多要一次探查，不可少要。
 *   high：新建 / 大段重写 / 触及导出签名 / 高风险路径（manifest·lockfile·装配）/ strictMode
 *   low ：小改且不触及签名且非高风险路径（只要 read）
 *   mid ：其余（read + 项目级引用探查）
 */
function tierOf(facts: RiskFacts): FactTier {
  if (facts.strictMode || facts.creatable) {
    return "high";
  }
  if (facts.sigChanged) {
    return "high";
  }
  // 取不到写面大小 → 保守升档
  if (facts.contentChars === undefined) {
    return "high";
  }
  if (facts.contentChars > facts.bigChars) {
    return "high";
  }
  // 改一个版本号也能全局波及：size 是最差的代理
  if (facts.riskyPath) {
    return "high";
  }
  if (facts.contentChars <= facts.smallChars) {
    return "low";
  }
  return "mid";
}

/** 数值型设置取值：非法/缺省回落内置默认。**绝不用 0 兜底**——0 等于关掉整道防线。
 *  阈值默认值单源在 lib/fact-gate.ts（DEFAULT_SMALL/BIG_EDIT_CHARS），host 导入使用。 */
function numOf(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/**
 * 设置面读数降级告警：**只响一次**。守卫谓词每次工具调用都跑，坏设置在修复前会一直
 * 存在——逐次刷屏会把日志冲干净，反而盖掉真正的拦截记录（`strArray` 的降级告警同口径）。
 */
let settingsFallbackWarned = false;
function warnSettingsFallback(): void {
  if (settingsFallbackWarned) {
    return;
  }
  settingsFallbackWarned = true;
  console.warn(
    "[danger-guard] 设置面（条目 danger-guard-settings）不可用，本轮回落内置默认底座；" +
      "危险命令拦截照常生效。修复请查该条目的装配状态（dsh 日志里的 ValidationError）。",
  );
}

/** 设置条目挂出的读数口形状守卫（`ctx.get(SETTINGS_READER)` 给的是 unknown）：
 *  与 lessonLoop 总线同款的**函数象限守卫**，不经任何类型断言。 */
function isSettingsReader(value: unknown): value is SettingsReader {
  return isRecord(value) && typeof value["read"] === "function";
}

/**
 * 一次守卫调用的配置快照：现读**另一个条目**（设置条目 danger-guard-settings）挂出的
 * 值面读数口。
 *
 * 0.1.6 这一步是 `scope.get()`（register 的返回面）+ `mergeRowConfig` 合底座；
 * 0.1.7 迁移的第一版是让 cordis 把校验过的行 config 直接交进本条目的 apply——**那等于
 * 把安全闸门的存活绑在用户可手改的配置上**：越界值（`maxDenies: 0`）在 apply 之前就让
 * 条目 fiber FAILED（vendor/cordis/src/fiber.ts:50、:641-664），闸门整体下线（fail-open，
 * 比"设置没生效"严重得多）。现在严格 schema 住在设置条目里，本条目读它两件事都成不了：
 *  1. 设置条目不在组合里 / 被 disabled → 它没 apply 过 → 没有读数口；
 *  2. 设置条目 FAILED（行 config 越界，炸在**它自己的** fiber 上）→ 同样没有读数口
 *     ——**用户写的坏配置杀不掉闸门**，这是本次改造唯一的目的；
 *  3. 读数口在，但形状不对（第三方抢注了同名服务）→ 守卫不认，同样回落。
 * 三条都落回 BUILTIN_BASE（= schema 默认值，即"闸门开着"那一组值）并各告警一次。
 * @param svc 宿主上下文（`get` 是 cordis 官方可选读法：未注册返回 undefined，不抛错）
 * @returns 本次判定用的 plain Config
 */
function settingsConfig(svc: HostCtx): Config {
  const readerRaw: unknown = svc.get?.(SETTINGS_READER);
  if (!isSettingsReader(readerRaw)) {
    warnSettingsFallback();
    return BUILTIN_BASE;
  }
  // 引用即现读：设置卡改完，下一次工具调用就是新值，不需要重载本条目。
  return readerRaw.read();
}

/**
 * 从一次写调用提取风险事实。缺信息一律留 undefined → tierOf 保守升档（③）：
 * write 是整文件覆盖（无"改动面"可言）、str_replace_editor 是 edits 数组，两者都
 * 算不出可靠 diff 尺寸，宁可多要取证。
 * `sigChanged` 是"写面小但波及大"的主要机器信号：改一行 `export const TIMEOUT`
 * 远比改一百行局部变量危险。
 */
function riskFactsOf(
  name: string,
  args: Record<string, unknown>,
  // 目标路径由调用方（已用 editTargetPath 归一化）传入，不在这里二次取键——
  // 两侧取键形不一致正是"门禁要的路径"与"证据记账的路径"漂移的根源。
  target: string,
): Pick<RiskFacts, "creatable" | "riskyPath" | "sigChanged" | "contentChars"> {
  let contentChars: number | undefined;
  let sigChanged = false;
  if (name === "edit") {
    const oldS = typeof args["old_string"] === "string" ? args["old_string"] : undefined;
    const newS = typeof args["new_string"] === "string" ? args["new_string"] : undefined;
    // **字段缺失 ≠ 改动很小**：取不到就留 undefined → tierOf 保守升档。旧写法用 ''
    // 兜底使长度算成 0，`0 <= smallChars` 会把"信息缺失"直接降到最低档（只要 read），
    // 恰好把原则③「缺信息一律要更多」反过来——被自家接线测试抓到。
    if (oldS !== undefined && newS !== undefined) {
      contentChars = oldS.length + newS.length;
    }
    sigChanged = SIG_KEYWORD_RE.test(newS ?? "") || SIG_KEYWORD_RE.test(oldS ?? "");
  }
  return {
    creatable: name === "write" || (name === "str_replace_editor" && args["command"] === "create"),
    riskyPath: RISKY_PATH_RE.test(target),
    sigChanged,
    contentChars,
  };
}

/** 无法判定证据时的保守输入：按"两项都没做过"处理（缺信息一律要更多，不要更少）。 */
function undeterminable(determinate: boolean): FactEvidenceInput {
  return {
    gaps: [
      { need: "read", why: "never" },
      { need: "refs", why: "never" },
    ],
    determinate,
    logSeq: 0,
    fileEditSeq: -1,
  };
}

/**
 * 去正则转义与元字符。必须容忍转义：模型写 grep 的天性是 `host\.ts`、`a[.]ts`，
 * 按字面量 includes 判会永不相等——我自己就被这条咬过一次（误判"未取证"）。
 */
function flattenSig(sig: string): string {
  return sig.replaceAll("\\", "").replaceAll(/[.*+?^${}()|[\]]/gu, "");
}

/** 多个候选字段合成检索签名串（string / string[] 混合）。 */
function sigOf(...values: unknown[]): string {
  let out = "";
  for (const value of values) {
    if (typeof value === "string") {
      out += ` ${value}`;
    } else if (Array.isArray(value)) {
      out += ` ${value.filter((x): x is string => typeof x === "string").join(" ")}`;
    }
  }
  return out;
}

/**
 * 记账 tool/call 并返回其键：有 callId 用 callId 等结果回填；无 callId（极旧契约）
 * 以 `nc:<seq>` 为键，由第二遍后的收编循环按成功计（见 evidenceFor 尾部）。
 */
function remember(map: Map<string, number>, callId: string | undefined, seq: number): string {
  const key = callId ?? `nc:${seq}`;
  map.set(key, seq);
  return key;
}

/** 写类工具名。read 与 str_replace_editor 的 view 是**只读**面，不进写台账。 */
type WriteToolName = "edit" | "write" | "str_replace_editor";

/**
 * 一次调用是"写"还是"读"：把判定收敛成一个函数，writeTextOf 才敢把最后一支当 else 用。
 * 原来 writeTextOf 自己还要再问一次 `toolName === "str_replace_editor"`，而调用方
 * （applyToolCall 的 switch）只可能传这三个名字进来 → 那道 if 的 false 路是**死分支**
 * （覆盖率 100% 目标下它就是一个永远测不到的洞）。
 * 宿主若新增写类编辑器，三处须同步：applyToolCall 的 switch、WriteToolName、本函数——
 * 漏了本函数会把写误判成 read（少一次自证），故在类型别名处一并留痕。
 */
function writeToolNameOf(name: string, command: unknown): WriteToolName | undefined {
  let result: WriteToolName | undefined;
  // 三支判定同一条：命中就是"这个名字算写"，两支的分支体本来就一模一样（同一枚 `result = name`），
  // 于是按 sonarjs/no-duplicated-branches 把条件并成一支，判据一条不减：
  //   edit / write 一律是写；str_replace_editor 里 create/str_replace/insert 是写，
  //   view 只读 → 等价 read 证据（所以 `command !== "view"` 仍是它自己的守卫，短路与原来一致）。
  if (
    name === "edit" ||
    name === "write" ||
    (name === "str_replace_editor" && command !== "view")
  ) {
    result = name;
  }
  return result;
}

/**
 * 各写类工具"新写入内容"的字段名。字段名逐一实测自工具 schema，不猜：
 *   edit → new_string；write → content；
 *   str_replace_editor → create 用 file_text，str_replace/insert 用 new_str。
 */
function writeTextFieldOf(toolName: WriteToolName, command: unknown): string {
  if (toolName === "edit") {
    return "new_string";
  }
  if (toolName === "write") {
    return "content";
  }
  return command === "create" ? "file_text" : "new_str";
}

/**
 * 提取一次写操作"新写入的内容"，用于 mtime 归因的**内容自证**（见 evidenceFor）。
 * 取不到（字段缺失 / 非字符串——模型可能把 content 传成数组或数字）返回 undefined，
 * 调用方按"无法自证"保守处理。
 */
function writeTextOf(toolName: WriteToolName, a: Record<string, unknown>): string | undefined {
  const value = a[writeTextFieldOf(toolName, a["command"])];
  let text: string | undefined;
  if (typeof value === "string") {
    text = value;
  }
  return text;
}

/**
 * 判定目标文件的取证完成度 → 产出状态机需要的**带成因**缺项清单。
 * 完全基于客观动作（会话日志 tool/call + tool/result），不采信模型自述：
 * ECC 实证 LLM 自评无效，但"被迫去查"这个动作本身改变输出质量。
 *
 *  1. **新鲜度只认外部改动**（round 13 定稿）：模型自己连续编辑同一目标**不再反复
 *     过门**——edit 的返回本身就带着改动后的内容，再逼一次 read 是纯仪式。故基准
 *     `staleBase` 只在"确属外部改动"时才抬升，否则为 -1（任何一次成功 read 即满足）。
 *     本次编辑的 tool/call 虽已在日志（appendToolCall 先于 dispatch），但其结果未
 *     回填 → 不入任何统计 → 不会自我否证。引用证据同样不失效（谁引用它不由本文件决定）。
 *  2. **引用探查必须项目级**（缺陷②）：搜文件自身只算内容探查，看不到"谁引用它"；
 *     故 path 必须是目标的祖先目录，且 pattern/query 命中文件名或足够长的词干。
 *     签名比对两侧同形归一（见 flattenSig），否则正则转义会误判"未取证"。
 *  3. **失败调用不算证据**（缺陷①）：grep 路径打错报错 ≠ 做过探查；被门禁拒掉的编辑
 *     也不算（它同样不推进 lastEditSeq，而 lastEditSeq 用于第 4 条的归因）。
 *  4. **外部改动识别**（缺陷③ + 第 1 项修复）：mtime 比上次评估更晚**且**该跳变无法
 *     被本会话解释时才算 external。归因两步——(a) 那次成功编辑的**结果事件位**不早于
 *     跳变位；(b) **内容自证**：当时写进去的文本此刻仍在文件中。文本不在了说明自己
 *     那份已被覆盖 → 判外部（保守方向）。旧实现拿 tool/call 下标比长度：call 早已在
 *     日志里，必然更小 → 自有编辑被恒判"外部改动"（实测连番冤枉我自己）。
 *  5. **新建豁免**（C3/C4）：write/create 且目标 fs 不存在 → 免 read 要求。
 *     不解析报错文本（"报错也算数"会给假证据开门）；edit 打在不存在的文件上本就
 *     会失败，不需要门禁假装那算取证。
 *  6. **逐层波及面**（round 9 机械半轨）：test/e2e/docs 由 fs 探测存在性——不存在即
 *     豁免；存在则要求一次**可归因**的检索（path 落在该层目录内 且 签名命中本文件）。
 *     只要求"在该层发生过任何动作"会被无关 read 白嫖，故收紧到可归因。
 */
/** 检索目标与会话的只读归一化环境（evidenceFor 拆分后各助手共享）。 */
interface EvalCtx {
  /** tool/call 台账（投影或全量扫描而来，两者同形状：shared `scanToolEvents` 的产物）。 */
  calls: ToolCallRecord[];
  /** tool/result 台账，同上。 */
  results: ToolResultRecord[];
  /** 日志长度（= 全量扫描里的 `evs.length` = 官方 `session.seq`）：logSeq 与外部改动基准用它。 */
  logSeq: number;
  sessKey: string;
  cwd: string | undefined;
  targetN: string;
  base: string;
  stems: string[];
  norm: (value: unknown) => string | undefined;
  /** 当次生效的「检索工具名 → 判据口径」映射（由 settings 运行时值现算）。 */
  refPolicy: RefSearchPolicy;
  /** 当次生效语言的文案表（host 在 guard 调用点取；缺项 hint 由它渲染）。 */
  messages: DangerGuardMessages;
}

/** 第一遍记账的产出：读/写/引用调用台账 + 层覆盖 + 落点收窄。 */
interface CallLedger {
  readCalls: Map<string, number>;
  editCalls: Map<string, number>;
  refCalls: Map<string, number>;
  editTexts: Map<string, string>;
  layersByCall: Map<string, FactNeed[]>;
  narrowAdds: Set<string>;
}

/** 第二遍回填后的成败结算。 */
interface ResultLedger {
  readSeq: number;
  refsSeq: number;
  lastEditSeq: number;
  lastEditKey: string | undefined;
  layerSeq: Map<FactNeed, number>;
  readFailed: boolean;
  refsFailed: boolean;
}

/** 目标 → 逐级剥扩展名得到的词干（全名 + 各级带点后缀）。 */
function buildStems(base: string): string[] {
  const stems: string[] = [];
  let stem = base;
  for (let i = 0; i < 4; i += 1) {
    const dot = stem.lastIndexOf(".");
    if (dot <= 0) {
      break;
    }
    stem = stem.slice(0, dot);
    stems.push(stem);
  }
  return stems;
}

/** 检索签名是否指向本文件：全名或任一级足够长的词干命中。 */
const sigHitsOf = (ctx: EvalCtx, sig: string): boolean => {
  // **两侧同形归一**：flattenSig 会剥掉 `.` 等元字符，若只剥签名一侧，
  // `host.test.ts`（flat 成 hosttestts）永远匹配不上未剥的 base——实测我自己
  // 因此被门禁误拒过（它报"缺引用探查"，而我确实搜过）。
  const flat = flattenSig(sig);
  if (flat.includes(flattenSig(ctx.base))) {
    return true;
  }
  return ctx.stems.some((stem) => {
    const flatStem = flattenSig(stem);
    return flatStem.length >= MIN_STEM && flat.includes(flatStem);
  });
};

/** 引用探查的项目级作用域判定：path 是目标的祖先目录（非文件自身）。 */
const isProjectScopeOf = (ctx: EvalCtx, targetPath: string | undefined): boolean => {
  // 没有 path 就谈不上项目级作用域。守卫写成前置返回而不是 `?.`：本条链里被守卫的
  // `targetPath` 只出现在模板串（startsWith 的实参位），不是任何成员访问的接收者，
  // `?.` 无从落脚（`prefer-optional-chain` 报的是这条 `!== undefined` 前置守卫）。
  if (targetPath === undefined) {
    return false;
  }
  return targetPath !== ctx.targetN && ctx.targetN.startsWith(`${targetPath}/`);
};

/** 路径显示形态：有 cwd 则相对（提示里更短更可读），否则原样。 */
const relOf = (ctx: EvalCtx, targetPath: string): string =>
  ctx.cwd !== undefined && targetPath.startsWith(`${ctx.cwd}/`)
    ? targetPath.slice(ctx.cwd.length + 1)
    : targetPath;

/** 路径归一化：相对路径按会话 cwd 解析（C5 同款——模型常报相对路径）。 */
const resolveTarget = (value: string, cwd: string | undefined): string =>
  cwd !== undefined && !path.isAbsolute(value) ? path.resolve(cwd, value) : value;

/**
 * 回退扫描的全量日志读（只在投影不可用时走到这里）。
 * undefined = 证据不可得（会话没交出面 / 返回的不是数组）⇒ 调用方按 undeterminable 降级。
 */
function readSessionLog(session: SessionLogFace): readonly SessionEvent[] | undefined {
  // 官方 `snapshotEvents` 自带 `@deprecated`（dsh-session/lib/types/index.d.ts:186-187
  // "new calls are prohibited"）：把本面钉回官方成员之后，lint 的 typescript/no-deprecated
  // 才**第一次**看得见它——旧手抄镜像没有那枚标记，那条绿一直是假的。如今这条读只剩回退
  // 用途（主路径见 lib/tool-ledger.ts），豁免因此留在这里并写清它兜的是哪三件事。
  // oxlint-disable-next-line typescript/no-deprecated -- 回退扫描的全量同步事件读（投影不可用时才走），主路径见 tool-ledger 投影；官方替代 `sessionQuery.observeSession()` 是异步，而本读落在 `ToolGuard` 谓词里（官方签名不收 Promise），改 await 即动判定链
  const reader = session.snapshotEvents;
  // 形参是官方品牌数 `SessionLogOffset`：0 必须经 `brandNumber<…>(0)` 送出（幻影品牌
  // type-only 造不出来，`as` 又被 no-unsafe-type-assertion 禁掉；见文件头列出的 dsh-brand 值导入）。
  // 且必须以真实 session 为 `this` 调用：snapshotEvents 读 this.log/this.seq，解绑会以本对象
  // 为 this → TypeError（quality-gate/host.ts:822-824 的 0.1.6 实证同款）。
  const evs =
    typeof reader === "function"
      ? reader.call(session, brandNumber<SessionLogOffset>(0))
      : undefined;
  // 官方契约说这里必是 readonly SessionEvent[]，Array.isArray 挡的是**类型外**的输入
  // （宿主版本漂移/自定义 session 实现送来 null、字符串）：那时按"证据不可得"降级，
  // 首拒给清单、重试走交互确认，绝不因为"读到了个东西"就当作有证据。
  return Array.isArray(evs) ? evs : undefined;
}

/**
 * 取证台账取数（两条读法，同形状）：
 *   - 投影在位且可信 ⇒ 增量折叠的当前态（守卫里 `stateOf` 的同步水位读，零全量扫）；
 *   - 否则 ⇒ 回退扫描（注册表缺席/迟到、台账被窗口或跳号作废、回填形状不符）。
 * undefined = 两条路都拿不到证据 ⇒ 上层按"不可判定"走交互确认。
 */
function ledgerRows(
  session: SessionLogFace,
  readLedger: LedgerReader | undefined,
): { calls: ToolCallRecord[]; results: ToolResultRecord[]; logSeq: number } | undefined {
  const ledger = readLedger === undefined ? undefined : readLedger(session);
  if (ledger !== undefined) {
    return { calls: callsOf(ledger), results: resultsOf(ledger), logSeq: ledger.length };
  }
  const evs = readSessionLog(session);
  return evs === undefined ? undefined : { ...scanToolEvents(evs), logSeq: evs.length };
}

/** 构造只读评估环境；会话不可得/两条读法都拿不到台账 → undefined（复用 undeterminable 保守输入）。 */
function buildEvalContext(
  session: SessionLogFace | undefined,
  target: string,
  refPolicy: RefSearchPolicy,
  messages: DangerGuardMessages,
  readLedger: LedgerReader | undefined,
): EvalCtx | undefined {
  let result: EvalCtx | undefined;
  const rows = session === undefined ? undefined : ledgerRows(session, readLedger);
  if (session !== undefined && rows !== undefined) {
    const cwdRaw = session.header?.cwd;
    const cwd = typeof cwdRaw === "string" && cwdRaw.length > 0 ? cwdRaw : undefined;
    const norm = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? resolveTarget(value, cwd) : undefined;
    const targetN = resolveTarget(target, cwd);
    const base = path.posix.basename(targetN);
    result = {
      ...rows,
      sessKey: `${stringIdOf(session.id)}|`,
      cwd,
      targetN,
      base,
      stems: buildStems(base),
      norm,
      refPolicy,
      messages,
    };
  }
  return result;
}

/** 登记一次写：按 callId/seq 记账，并把写入文本挂到同一个键上。 */
function rememberWriteInto(
  ledger: CallLedger,
  callId: string | undefined,
  seq: number,
  tool: WriteToolName,
  args: Record<string, unknown>,
): void {
  const key = remember(ledger.editCalls, callId, seq);
  const written = writeTextOf(tool, args);
  if (written !== undefined) {
    ledger.editTexts.set(key, written);
  }
}

/** 登记一次有效的引用探查：记 refs 证据，并登记它顺带覆盖了哪些层。 */
function rememberScopeHitInto(
  ledger: CallLedger,
  layers: FactLayer[],
  targetPath: string | undefined,
  callId: string | undefined,
  seq: number,
): void {
  const key = remember(ledger.refCalls, callId, seq);
  const covered = layers
    .filter((layer) => scopeCoversLayer(targetPath, layer))
    .map((layer) => layer.need);
  if (covered.length > 0) {
    ledger.layersByCall.set(key, covered);
  }
}

/** 单条 tool/call 的分类输入（name + 参数 + 归因键）。
 *  ⚠ 这是本插件记账台账的**投影类型**（shared ToolCallRecord 落地成读/写/引用三类后
 *  的形态），不是宿主事件形状的第二份抄本 —— 抄官方形状的那一份已经删了（原 FactEvent），
 *  事件流一律按 shared 的官方 SessionEvent 判别联合读。
 *
 *  四个字段**全部**从 shared 的 `ToolCallRecord`（shared/lib/tool-events.ts:30-48）取形，
 *  本文件不再各自重述：
 *  - `callId` / `seq` 直接 `Pick`。台账键**故意不是**官方 `ToolCallId` / `SessionSeq`：
 *    shared 的 `usableCallId` 把空串归一为 `undefined`，空 callId 因此永远冒充不了一枚键
 *    （shared :80-88 记着这条理由）；`seq` 是**入参数组的切片下标**，shared :43-47 明写
 *    它不是官方 `SessionSeq`（消费方按窗口切片读流，切片下标才是它们的游标语义）。
 *  - `name` 取 `NonNullable<ToolCallRecord["name"]>`：shared 交回 `string | undefined`，
 *    本文件在 `call.name !== undefined` 之后才构造台账行（见 scanToolCalls），故收窄一位。
 *  - `a` 即 `ToolCallRecord["arguments"]`（已解析的 `Record<string, unknown>`）。 */
type ToolCall = Pick<ToolCallRecord, "callId" | "seq"> & {
  name: NonNullable<ToolCallRecord["name"]>;
  a: ToolCallRecord["arguments"];
};

/**
 * 一次读/写调用声明的目标路径。判定侧（门禁要哪个文件取证）走 `editTargetPath`，
 * 取证侧（模型对哪个文件做过动作）**必须同一个键形**——两侧不同键时，模型照门禁
 * 要求做了动作却永远记不上证据（静默死锁 + 无限 indeterminate）。editTargetPath 认
 * `file_path ?? path`（edit/write）与 `path`（str_replace_editor），read/view 不在它
 * 的表内（它只管"要不要过门"），故在此补齐同样的双键宽容。
 */
function callPathOf(name: string, a: Record<string, unknown>): string | undefined {
  const gatePath = editTargetPath(name, a);
  if (gatePath !== null) {
    return gatePath;
  }
  const candidate = name === "str_replace_editor" ? a["path"] : (a["file_path"] ?? a["path"]);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** 写/读型调用记账：read 与 str_replace_editor 的 view 记 readCalls，其余按写登记。 */
function applyWriteCall(ctx: EvalCtx, ledger: CallLedger, call: ToolCall): void {
  if (ctx.norm(callPathOf(call.name, call.a)) !== ctx.targetN) {
    return;
  }
  // 写面判定收敛在 writeToolNameOf（read / view → 只读，等价 read 证据；
  // 门禁侧 editTargetPath 不会对 view 传路径）。
  const writeName = writeToolNameOf(call.name, call.a["command"]);
  if (writeName === undefined) {
    remember(ledger.readCalls, call.callId, call.seq);
    return;
  }
  // create/str_replace/insert 与 edit/write 一样是**写**：必须登记进 editCalls，否则
  // lastEditSeq 停在 -1，模型用它自改目标后 mtime 跳变会被误判成"另一会话改的"（既多要
  // 一次 read，又误报冲突）。两套编辑器并存正是这里最容易漏的面。
  rememberWriteInto(ledger, call.callId, call.seq, writeName, call.a);
}

/** 引用型调用记账：按工具名对应的判据口径取签名与作用域，命中后给 refs 或记窄落点。 */
function applySearchCall(
  ctx: EvalCtx,
  ledger: CallLedger,
  layers: FactLayer[],
  call: ToolCall,
  criterion: RefSearchCriterion,
): void {
  // 两套口径读的参数字段不同（见 lib/ref-search-policy.ts 的 RefSearchCriterion 注释）。口径由**工具名
  // 映射**决定，不再看名字本身：第三方语义检索工具声明进严格名单后走的就是下面这支。
  const relativeScope = criterion === "strict-relative";
  const sig = relativeScope
    ? `${sigOf(call.a["query"], call.a["queries"])} ${sigOf(call.a["fts"], call.a["vector"])}`
    : sigOf(call.a["pattern"], call.a["include"]);
  const hits = sigHitsOf(ctx, sig);
  const targetPath = relativeScope
    ? ctx.norm(call.a["root"])
    : ctx.norm(call.a["path"] ?? call.a["file_path"]);
  if (relativeScope) {
    // 严格口径多一条通路：签名可以不含文件名、只含目标的相对路径片段。
    const rel = relOf(ctx, ctx.targetN);
    if (!hits && !(rel.length > 0 && sig.includes(rel))) {
      return;
    }
  } else if (!hits) {
    return;
  }
  // 命中文件名但作用域不对（搜文件自身 / 兄弟目录）→ 不当证据，但记下落点。
  if (isProjectScopeOf(ctx, targetPath)) {
    rememberScopeHitInto(ledger, layers, targetPath, call.callId, call.seq);
  } else if (targetPath !== undefined) {
    ledger.narrowAdds.add(relOf(ctx, targetPath));
  }
}

/** 对单条 tool/call 分类记账（读/写/引用各自入口）。 */
function applyToolCall(
  ctx: EvalCtx,
  ledger: CallLedger,
  layers: FactLayer[],
  call: ToolCall,
): void {
  switch (call.name) {
    case "read":
    case "str_replace_editor":
    case "edit":
    case "write": {
      // 读/写分组**先判**：即便有人把 "read" 写进 refSearchTools，它也仍然只按读证据记账
      // （否则一次笔误就能把 read 面从取证里摘掉）。
      applyWriteCall(ctx, ledger, call);
      break;
    }
    default: {
      const criterion = ctx.refPolicy.criteria.get(call.name);
      if (criterion !== undefined) {
        applySearchCall(ctx, ledger, layers, call, criterion);
      }
      // 名单外的工具（bash / 未知名 / 未列入的第三方检索）不参与取证记账。
      break;
    }
  }
}

/** 第一遍：tool/call 记账（成败未知先挂起，等第二遍回填）。
 *  解析骨架复用 shared scanToolEvents（arguments 双形态/view 判定/坏参标记），
 *  quality-gate 与 danger-guard 不再各有 JSON.parse 双实现；此处只做 FactGate
 *  领域的读/写/引用分类。坏参（JSON 语法非法）语义与原实现一致：跳过记账。 */
function scanToolCalls(ctx: EvalCtx, layers: FactLayer[]): CallLedger {
  const ledger: CallLedger = {
    readCalls: new Map(),
    editCalls: new Map(),
    refCalls: new Map(),
    editTexts: new Map(),
    layersByCall: new Map(),
    narrowAdds: new Set(),
  };
  const { calls } = ctx;
  for (const call of calls) {
    if (call.name !== undefined && !call.badArguments) {
      applyToolCall(ctx, ledger, layers, {
        name: call.name,
        a: call.arguments,
        callId: call.callId,
        seq: call.seq,
      });
    }
  }
  return ledger;
}

/** 第二遍结算的中间态（resolveResultLedger 的累加器）。 */
interface ResultState {
  readSeq: number;
  refsSeq: number;
  lastEditSeq: number;
  lastEditKey: string | undefined;
  layerSeq: Map<FactNeed, number>;
  readFailed: boolean;
  refsFailed: boolean;
}

/** 对单条 tool/result 回填成败（callId 串联；契约同 quality-gate readEditedFiles）。 */
function settleResultEvent(
  state: ResultState,
  ledger: CallLedger,
  cid: string,
  isError: boolean,
  seq: number,
): void {
  const readCall = ledger.readCalls.get(cid);
  const refCall = ledger.refCalls.get(cid);
  const editCall = ledger.editCalls.get(cid);
  if (isError) {
    // 失败：不算证据、也不算"文件变了"（被门禁自己拒掉的编辑落到这里——它的
    // tool/call 在日志里但没有落地，若计入会把一次拒绝当成外部改动）。
    if (readCall !== undefined) {
      state.readFailed = true;
    }
    if (refCall !== undefined) {
      state.refsFailed = true;
    }
  } else if (readCall !== undefined) {
    state.readSeq = Math.max(state.readSeq, readCall);
  } else if (refCall !== undefined) {
    state.refsSeq = Math.max(state.refsSeq, refCall);
    // 该次检索顺带覆盖的层同步计为证据。失败检索在上面已跳过，
    // 所以"grep 了个不存在的路径"既不给 refs 也不给层证据——同一原则，不留偏门。
    for (const need of ledger.layersByCall.get(cid) ?? []) {
      state.layerSeq.set(need, refCall);
    }
  } else if (editCall !== undefined) {
    // 归因用**结果下标**而非调用下标：上次评估记下的日志长度已包含这次编辑的
    // tool/call（appendToolCall 先于 dispatch），拿调用下标比长度必然更小 → 自有
    // 编辑被恒判"外部改动"。结果下标在长度之后，自有编辑即归因正确。
    state.lastEditSeq = seq;
    state.lastEditKey = cid;
  }
}

/** 第二遍：tool/result 回填成败（callId 串联；契约同 quality-gate readEditedFiles）。
 *  结果表复用 shared scanToolEvents（callId/isError/seq），不再重复遍历事件流。 */
function resolveResultLedger(ctx: EvalCtx, ledger: CallLedger): ResultLedger {
  const state: ResultState = {
    readSeq: -1,
    refsSeq: -1,
    lastEditSeq: -1,
    lastEditKey: undefined,
    layerSeq: new Map(),
    readFailed: false,
    refsFailed: false,
  };
  const { results } = ctx;
  for (const result of results) {
    if (result.callId !== undefined) {
      settleResultEvent(state, ledger, result.callId, result.isError, result.seq);
    }
  }
  // 无 callId 的极旧契约事件（键由 remember() 造为 `nc:<seq>`）等不到成败回填 →
  // 按其文档承诺**保守计成功**。旧实现只登记不结算：注释说"按成功计"而实际永远
  // 回填不上，模型真做过 read/grep 会被永久判"未取证"（静默死锁 + 契约漂移无人知）。
  for (const [key, seq] of ledger.readCalls) {
    if (key.startsWith("nc:")) {
      state.readSeq = Math.max(state.readSeq, seq);
    }
  }
  for (const [key, seq] of ledger.editCalls) {
    if (key.startsWith("nc:")) {
      state.lastEditSeq = Math.max(state.lastEditSeq, seq);
    }
  }
  for (const [key, seq] of ledger.refCalls) {
    if (key.startsWith("nc:")) {
      state.refsSeq = Math.max(state.refsSeq, seq);
      for (const need of ledger.layersByCall.get(key) ?? []) {
        state.layerSeq.set(need, seq);
      }
    }
  }
  return {
    readSeq: state.readSeq,
    refsSeq: state.refsSeq,
    lastEditSeq: state.lastEditSeq,
    lastEditKey: state.lastEditKey,
    layerSeq: state.layerSeq,
    readFailed: state.readFailed,
    refsFailed: state.refsFailed,
  };
}

/** 内容自证：那次成功编辑写进去的文本此刻是否仍在文件里。 */
function selfWritesStillPresent(targetPath: string, written: string): boolean {
  let current: string | undefined;
  try {
    current = syncReadText(targetPath);
  } catch {
    current = undefined;
  }
  // 读不到（不存在/无权限）⇒ 谈不上"写进去的文本还在"，`?.` 的落空支交回 false。
  return current?.includes(written) ?? false;
}

/** 缺项组装的输入（由 evidenceFor 结算好，assembleGaps 只做产出）。 */
interface GapInput {
  readSeq: number;
  refsSeq: number;
  staleBase: number;
  newFile: boolean;
  tier: FactTier;
  narrowAdds: Set<string>;
  readFailed: boolean;
  refsFailed: boolean;
  externallyChanged: boolean;
  layers: FactLayer[];
  layerSeq: Map<FactNeed, number>;
}

/** refs 窄落点的 hint 文案。提成模块级函数：嵌进 gaps.push 的三元里会超
 *  unicorn/max-nested-calls 上限（push → fillTemplate → join 已是第三层）。 */
const narrowScopeHint = (messages: DangerGuardMessages, narrowAdds: Set<string>): string =>
  fillTemplate(messages.gapNarrowScope, {
    paths: [...narrowAdds].slice(0, 3).join(messages.listSeparator),
  });

/** 层缺项的 hint 文案（同样为 max-nested-calls 提成模块级函数）。 */
const layerDirHint = (ctx: EvalCtx, dir: string): string =>
  fillTemplate(ctx.messages.gapLayerDir, { dir: relOf(ctx, dir) });

/** read 侧裁定并落清单（判据与抽前逐字相同）：已满足的两种形态记 done —— 新建文件
 *  （无旧内容可 read）、**成功** read 晚于目标最近一次成功编辑（新鲜度）。
 *  缺项成因优先级：外部改动 > read 失败 > 从未 read。 */
function collectReadVerdict(input: GapInput, gaps: FactGap[], done: FactNeed[]): void {
  if (input.newFile || input.readSeq > input.staleBase) {
    done.push("read");
    return;
  }
  let readWhy: NeedWhy;
  if (input.externallyChanged) {
    readWhy = "external";
  } else if (input.readFailed) {
    readWhy = "failed";
  } else {
    readWhy = "never";
  }
  gaps.push({ need: "read", why: readWhy });
}

/** refs 侧裁定并落清单（已满足 = 有过一次**成功**的名单内检索，refsSeq ≥ 0）。
 *  成因优先级：窄落点未覆盖 > refs 失败 > 从未 refs；只有 narrow 带落点 hint。 */
function collectRefsVerdict(
  messages: DangerGuardMessages,
  input: GapInput,
  gaps: FactGap[],
  done: FactNeed[],
): void {
  if (input.refsSeq >= 0) {
    done.push("refs");
    return;
  }
  let refsWhy: NeedWhy;
  if (input.narrowAdds.size > 0) {
    refsWhy = "narrow";
  } else if (input.refsFailed) {
    refsWhy = "failed";
  } else {
    refsWhy = "never";
  }
  gaps.push({
    need: "refs",
    why: refsWhy,
    ...(refsWhy === "narrow" ? { hint: narrowScopeHint(messages, input.narrowAdds) } : {}),
  });
}

/** 层侧裁定并落清单（逐层，仅 high 档走到）：层证据 = 某次**成功**检索的作用域覆盖该层目录
 *  （项目根级 grep 顺带覆盖，不另要求进层目录重搜一次；兄弟目录不覆盖，蹭不到证据）。
 *  覆盖到记 done、没覆盖记 gaps，顺序按 `input.layers` 原序 —— 与抽前同一条循环。 */
function collectLayerVerdicts(
  ctx: EvalCtx,
  input: GapInput,
  gaps: FactGap[],
  done: FactNeed[],
): void {
  for (const layer of input.layers) {
    if (input.layerSeq.has(layer.need)) {
      done.push(layer.need);
    } else {
      gaps.push({ need: layer.need, why: "never", hint: layerDirHint(ctx, layer.dir) });
    }
  }
}

/** 产出带成因的缺项清单（决策面：read/refs/逐层三面的裁定各在 `collectReadVerdict`/
 *  `collectRefsVerdict`/`collectLayerVerdicts` 里，本函数按抽前的 read → refs → 层顺序
 *  依次组装同一对清单）。 */
function assembleGaps(ctx: EvalCtx, input: GapInput): FactEvidenceInput {
  const gaps: FactGap[] = [];
  const done: FactNeed[] = [];
  collectReadVerdict(input, gaps, done);
  if (input.tier !== "low") {
    collectRefsVerdict(ctx.messages, input, gaps, done);
  }
  if (input.tier === "high") {
    collectLayerVerdicts(ctx, input, gaps, done);
  }
  return {
    gaps,
    done,
    determinate: true,
    logSeq: ctx.logSeq,
    fileEditSeq: input.staleBase,
    newFile: input.newFile,
    // 指令里的检索工具名与实际记账用同一份映射（缺它就等于对模型撒谎"用 X 搜就行"）。
    ctx: {
      targetName: ctx.base,
      searchPath: projectRootOf(ctx.targetN, ctx.cwd),
      searchPolicy: ctx.refPolicy,
    },
  };
}

/**
 * 判定模型是否对目标文件取过证（严格举证 + 新鲜度，二次修订版）→ 产出状态机需要的
 * **带成因**缺项清单：
 *  - read 侧：**成功** read 过目标（tool/result.isError 过滤；被 guard 拒掉的调用
 *    在日志里 isSuccess=false 同样不算），且该 read 晚于目标文件最近一次成功编辑
 *    （新鲜度：编辑后内容已变，旧 read 证据作废，防"开头 read 一次、结尾当免检金牌"）。
 *  - 引用侧：成功用**名单内**的检索工具（refSearchTools，默认 grep/glob/zg_search）搜过它
 *    （搜到空 = "无引用"也是有效确认，新建文件不僵尸）。工具名 → 判据口径按映射走
 *    （lib/ref-search-policy.ts 的 RefSearchPolicy），不再按名字硬编码分支：
 *      pattern 口径（默认 grep/glob）：起点 path/file_path 是目标的祖先目录，且 pattern/include
 *        命中 basename 或足够长的词干；
 *      strict-relative 口径（默认 zg_search）：起点取 root，签名取 query/queries/fts/vector，
 *        除 basename 外还可凭目标的相对路径片段（≥"目录/basename"）命中，防 index.ts 撞名顶包。
 *    第三方包注册的检索工具（rg_search…）要成为凭证，列进名单即可，口径二选一。
 *  - 路径按会话 cwd 归一化后比较（resolve；C5 同款——模型常报相对路径）。
 *  - determinate=false：会话历史不可得 → 交互式确认（首拒仍先给行动清单）。
 *
 * 主流程（拆分自原单一 98-complexity 大函数）：buildEvalContext 构造只读环境，
 * scanToolCalls/resolveResultLedger 分两遍结算调用台账，assembleGaps 产出缺项。
 * 外部改动归因（mtime + 内容自证）与档位判定留在本入口内串起各助手。
 */
function evidenceFor(
  session: SessionLogFace | undefined,
  target: string,
  creatable: boolean,
  // 档位、追加层目录、检索取证判据、当次语言的文案表都由 guard 侧算好**必传**（四者都要读
  // settings 运行时值）：可选参数会留下"缺省升档/缺省名单/缺省语言"的兜底分支，
  // 而唯一的调用方永远传全——留着就是测不到的死分支。
  gating: {
    tier: FactTier;
    extraTestDirs: string[];
    refPolicy: RefSearchPolicy;
    messages: DangerGuardMessages;
    /** 台账读口（注册表缺席时为 undefined ⇒ 走回退扫描；见 lib/tool-ledger.ts）。 */
    ledger: LedgerReader | undefined;
  },
): FactEvidenceInput {
  const ctx = buildEvalContext(session, target, gating.refPolicy, gating.messages, gating.ledger);
  if (ctx === undefined) {
    return undeterminable(false);
  }
  // fs：存在性（三态，见 presenceOf）+ 外部改动检测
  const { presence, mtimeMs } = presenceOf(ctx.targetN);
  const lenKey = `${ctx.sessKey}${ctx.targetN}`;
  // 基线优先取**本会话**上次看到的 mtime；本会话没见过该文件时回落到全局值兜底
  // （例：重启前另一会话评估过）。旧实现只有全局一份 → 谁先评估谁消费掉跳变信号。
  const seenMtime = mtimeBySessionPath.get(lenKey) ?? mtimes.get(ctx.targetN);
  lruPut(mtimes, ctx.targetN, mtimeMs);
  lruPut(mtimeBySessionPath, lenKey, mtimeMs);
  const external = seenMtime !== undefined && mtimeMs > seenMtime;
  // 外部改动基准取**真实事件下标**（不是 evs.length）：用长度会让任何 read 都显得更早，
  // 从而在 mtime 跳变后死锁。这里用"本会话上次评估时的日志长度"当作那次改动的位置。
  // 本会话没有历史位时保守取当前末尾：本轮判"需重读"，台账随即写入，重读后下一轮凭
  // 更大下标通过——自愈，代价最多一次重读。**旧写法 ?? -1 是 fail-open**（完全漏判）。
  const externalEditSeq = external ? (seenLenBySessionPath.get(lenKey) ?? ctx.logSeq) : -1;
  lruPut(seenLenBySessionPath, lenKey, ctx.logSeq);

  // 波及面层（round 9 机械半轨）：fs 探测该文件所属包链上**实际存在**的层。
  // 不存在的层直接豁免——不必让模型去 grep 空目录自证"这里没有测试"。
  const projectRoot = projectRootOf(ctx.targetN, ctx.cwd);
  const layers = existingLayersOf(ctx.targetN, projectRoot, gating.extraTestDirs);
  const ledger = scanToolCalls(ctx, layers);
  const resolved = resolveResultLedger(ctx, ledger);

  // 内容自证（归因：自己改的还是外部改动）。
  //   a) 本会话那次成功编辑的**结果位**已不早于跳变位 → 可能是自己改的；
  //   b) 那次写进去的文本此刻仍在文件里 → 确证是自己；不在了（或读不到内容）→
  //      说明自己那份已被覆盖 → 判外部，方向保守。
  let selfExplains = resolved.lastEditSeq >= externalEditSeq;
  if (selfExplains && resolved.lastEditKey !== undefined) {
    const written = ledger.editTexts.get(resolved.lastEditKey);
    if (
      written !== undefined &&
      written.length > 0 &&
      !selfWritesStillPresent(ctx.targetN, written)
    ) {
      selfExplains = false;
    }
  }
  const externallyChanged = external && !selfExplains;
  const staleBase = externallyChanged ? externalEditSeq : -1;
  // 新建豁免：目标**确凿不存在**（ENOENT）**且**本次调用有能力创建它（write/create）。
  // 两个条件都不能少：① 对已存在文件执行 write 是全量覆盖，恰恰最需要先 read（否则会
  // 无声清掉没看过的内容）；② presence 为 "unknown"（EACCES/ENOTDIR/ELOOP，或会话
  // header.cwd 缺失时相对路径按进程 cwd 解析）不等于"新文件"——把读不到的文件当新的，
  // 等于让权限问题替模型免掉 read，是这道豁免最不该失守的方向。
  const newFile = presence === "absent" && creatable;
  // 档位（round 11）：缺省一律 **high**——缺信息要更多取证，不要更少。
  //   low  只要 read（小改、不触签名、非高风险路径）
  //   mid  read + 项目级引用探查
  //   high 再加所有**实际存在**的层（不存在的层已被 fs 探测豁免，不进要求集）
  const tier: FactTier = gating.tier;
  return assembleGaps(ctx, {
    readSeq: resolved.readSeq,
    refsSeq: resolved.refsSeq,
    staleBase,
    newFile,
    tier,
    narrowAdds: ledger.narrowAdds,
    readFailed: resolved.readFailed,
    refsFailed: resolved.refsFailed,
    externallyChanged,
    layers,
    layerSeq: resolved.layerSeq,
  });
}

/** 一次 bash 危险判定的产出：命中的规则键 + **被判定的那条命令**（上报与判定同一个值，
 *  不让上报侧再解析一次参数——两处解析就会漂移，且 `key` 有值时命令必是字符串，
 *  上报侧再写一次 `typeof === "string"` 兜底就是一道永远测不到的死分支）。
 *  规则键有两种性质：命中危险模式（拦）与 `-c` 体未被检查（需用户确认），
 *  调用方按键区分上报，见 apply 里的 NESTED_UNCONFIRMED_SIGNATURE 分支。 */
interface BashDenial {
  command: string;
  key: BashDenialKey;
}

/** bash 危险命令闸（git 绕过 / rm -rf / curl|sh / dev server）；非 bash/pwsh 或无危险 → undefined。
 *  shell 方言按**工具身份**给：`pwsh` 调用点知道这段源由 PowerShell 读，于是 Windows 字形轨道
 *  在该调用点参与判定（POSIX 宿主上跑 PowerShell Core 时 `os.platform()` 不是 win32，而
 *  `Remove-Item -Recurse -Force C:\Windows` 删的确实是那个树）。`bash` 调用点保持 POSIX 读法，
 *  「非 Windows 宿主上轨道退出」的结论一字不动 —— 方言不从字形反推，猜字形就是
 *  此前 over-block 的来源。 */
function bashDenialOf(
  name: string,
  args: Record<string, unknown>,
  opts: BashDangerOptions | undefined,
): BashDenial | undefined {
  let result: BashDenial | undefined;
  if (name === "bash" || name === "pwsh") {
    const { command } = args;
    if (typeof command === "string") {
      const key = bashDanger(command, {
        ...opts,
        shellDialect: name === "pwsh" ? "windows" : "posix",
      });
      if (key !== undefined) {
        result = { command, key };
      }
    }
  }
  return result;
}

/** 事实门单次判定的产出（由 guard 回调翻译成 return/report）。 */
type FactGateOutcome =
  | { kind: "pass"; target: string; quota?: boolean }
  | { kind: "indeterminate"; target: string }
  | { kind: "deny"; target: string; tier: FactTier; denial: FactDenial };

/**
 * 一次 guard 评估的运行时输入：settings 运行时值 + **当前语言的文案表**。
 * 两个都由 guard 回调现取（用户改了设置卡/切了语言，下一次调用即生效），
 * 下游判定链因此既不读设置也不自带某一种语言。合成一个对象也是为守住 max-params=5。
 */
interface GuardRuntime {
  cfg: Config;
  messages: DangerGuardMessages;
  /** 投影台账读口的装箱：`ctx.sessionProjections` 到位时由 inject 回调装上，
   *  缺席/迟到 ⇒ undefined ⇒ 每次判定走回退扫描（迁移前行为）。装箱而不是直接字段：
   *  rt 每次 guard 调用现构造（cfg/messages 都要现读），读口只在 apply 期装一次。 */
  ledger: { value: LedgerReader | undefined };
}

/**
 * 生效的「检索工具名 → 引用取证判据」映射（记账与拒绝指令共用这一份）。
 * 与 extraTestDirs 那类"空数组=没追加"的字段**不同**，这里的空数组是用户的显式选择：
 *  - 值缺失/非数组（降级注册后持久段未经 schema 校验）→ 回落内置默认名单；
 *  - 显式 `[]` → 任何检索都不计入引用取证（凭证面只收紧不放宽；配额上限仍是防死锁出口）。
 */
const refPolicyOf = (cfg: Config): RefSearchPolicy =>
  refSearchPolicyOf(
    strArray(cfg.refSearchTools) ?? DEFAULT_REF_SEARCH_TOOLS,
    strArray(cfg.refSearchStrictTools) ?? DEFAULT_REF_SEARCH_STRICT_TOOLS,
  );

/**
 * 评估一次写调用的取证档位 + 决策（含配额放行警示）。
 * 无目标路径 → undefined 直接放行；否则返回判别结果供 guard 回调翻译成 return/report。
 * deny 只回传渲染输入（`FactDenial`），拒绝理由是 guard 回调按 rt.messages 现渲染的。
 */
function evaluateFactGate(
  rt: GuardRuntime,
  name: string,
  args: Record<string, unknown>,
  session: SessionLogFace | undefined,
  factGate: FactGate,
): FactGateOutcome | undefined {
  const { cfg } = rt;
  const target = editTargetPath(name, args) ?? undefined;
  let outcome: FactGateOutcome | undefined;
  if (target !== undefined) {
    // 风险事实：creatable（新建豁免 read）、riskyPath、sigChanged、写面大小。
    const facts = riskFactsOf(name, args, target);
    const tier = tierOf({
      ...facts,
      strictMode: cfg.strictMode,
      smallChars: numOf(cfg.smallEditChars, DEFAULT_SMALL_EDIT_CHARS),
      bigChars: numOf(cfg.bigEditChars, DEFAULT_BIG_EDIT_CHARS),
    });
    const input = evidenceFor(session, target, facts.creatable, {
      tier,
      // extraTestDirs 同样过 strArray：值面由条目的 Config schema 保证，但降级读取
      // 保留——闸门不能因为宿主给来的形状变化而抛在判定链里。
      extraTestDirs: strArray(cfg.extraTestDirs) ?? [],
      refPolicy: refPolicyOf(cfg),
      messages: rt.messages,
      ledger: rt.ledger.value,
    });
    // maxDenies 取 settings 运行时值；numOf 保证非法/0 一律回落内置默认
    // （0 会让"首拒即配额放行"，等于关掉事实门）。
    const decision = factGate.check(
      name,
      target,
      session?.id,
      input,
      numOf(cfg.maxDenies, DEFAULT_MAX_DENIES),
    );
    if (decision.kind === "allow" || decision.kind === "quota") {
      // 连续无证据拒绝达上限 → 配额放行警示（配额放行不算"遵守规则"，不报 pass）
      if (decision.kind === "quota") {
        console.warn(
          `[danger-guard] fact-gate: ${target} 连续无证据拒绝达上限，配额放行（maxDenies）`,
        );
        outcome = { kind: "pass", target, quota: true };
      } else {
        outcome = { kind: "pass", target };
      }
    } else if (decision.kind === "indeterminate") {
      outcome = { kind: "indeterminate", target };
    } else {
      outcome = { kind: "deny", target, tier, denial: decision.denial };
    }
  }
  return outcome;
}

/**
 * apply 接线出来的运行面：宿主服务面 + fact-gate 实例。
 * 判定链上的四个函数原本长在 apply 体内，提到模块层后它们仍要读这两个值——打包成一枚入参
 * 而不是各占一位，是为了守住 max-params=5（`factGateDenyOf` 已经有 exec/rt/name/args 四位）。
 */
interface GuardWiring {
  svc: HostCtx;
  gate: FactGate;
}

/** 一次 deny 上报的渲染输入：类别 + 签名 + 文案 + 取证。合成一枚对象同上一条理由
 *  （`reportDeny` 再收 wiring/exec 就六位了）。字段值与拆分前逐字一致。 */
interface DenyReportInput {
  category: string;
  signature: string;
  detail: string;
  evidence: Record<string, unknown>;
}

/** 总线上报（fire-and-forget）：拦截是可学习信号——全量 detail，不截断。
 *  cwd/sessionId 从守卫执行的 agent 链取（与取证同源），总线缺失直接跳过。 */
function reportDeny(wiring: GuardWiring, exec: GuardExecution, input: DenyReportInput): void {
  const busRaw: unknown = wiring.svc.get?.("lessonLoop");
  const bus = isLessonLoopReporter(busRaw) ? busRaw : undefined;
  if (bus === undefined || typeof bus.report !== "function") {
    return;
  }
  settleLessonCall(
    () =>
      bus.report({
        source: "danger-guard",
        category: input.category,
        cwd: exec.agent?.session?.header?.cwd,
        sessionId: exec.agent?.session?.id,
        signature: input.signature,
        detail: input.detail,
        evidence: input.evidence,
      }),
    (reason) => {
      console.warn("[danger-guard] lessonLoop report failed:", reason);
    },
  );
}

/** pass 信号上报：fact-gate 取证通过（场景触发且被遵守）。总线
 *  缺失或未实现 pass 时静默跳过——这是度量增强，不是守卫热路径的硬依赖。 */
function reportPass(
  wiring: GuardWiring,
  exec: GuardExecution,
  category: string,
  signature: string,
): void {
  const busRaw: unknown = wiring.svc.get?.("lessonLoop");
  const bus = isLessonLoopReporter(busRaw) ? busRaw : undefined;
  if (bus === undefined || typeof bus.pass !== "function") {
    return;
  }
  settleLessonCall(
    () =>
      // `?.` 不是第二道守卫（上面已判过）：TS 不把属性收窄带进闭包，回调里 pass 的
      // 可选性要重新面对——写成方法调用才保住接收方（不借 `.call`/`.bind` 改 this）。
      bus.pass?.({
        category,
        cwd: exec.agent?.session?.header?.cwd,
        sessionId: exec.agent?.session?.id,
        signature,
      }),
    (reason) => {
      console.warn("[danger-guard] lessonLoop pass failed:", reason);
    },
  );
}

/** 事实强制门单层判定 → 拒绝理由（含 pass 信号上报）。单 return + 浅嵌套
 *  （consistent-return / max-depth 双约束）：pass、indeterminate、deny 平坦分流。 */
function factGateDenyOf(
  wiring: GuardWiring,
  exec: GuardExecution,
  rt: GuardRuntime,
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  let deny: string | undefined;
  const { messages } = rt;
  if (rt.cfg.factGateEnabled) {
    // 缺项清单由 evidenceFor 现算：先按写面风险定档，再按档要求 read/refs/逐层。
    const outcome = evaluateFactGate(rt, name, args, exec.agent?.session, wiring.gate);
    if (outcome?.kind === "pass") {
      // 取证通过 = 规则场景被触发且被遵守 → pass 信号（配额放行除外）。
      if (outcome.quota !== true) {
        reportPass(wiring, exec, "factgate-deny", FACTGATE_SIGNATURE);
      }
    } else if (outcome?.kind === "indeterminate") {
      // 无法自动判定 → 交互式确认（模型会请用户拍板）
      deny = messages.indeterminate;
    } else if (outcome !== undefined) {
      // 状态机回传的是渲染输入（缺项/轮次/上下文），拒绝理由在此按当次语言现渲染。
      deny = renderDenyMessage(outcome.denial, messages);
      reportDeny(wiring, exec, {
        category: "factgate-deny",
        signature: FACTGATE_SIGNATURE,
        detail: deny,
        evidence: {
          tool: name,
          tier: outcome.tier,
          gaps: outcome.denial.gaps,
          target: outcome.target,
        },
      });
    }
  }
  return deny;
}

/** 密钥/凭据路径编辑闸 → 拒绝理由（含上报）。目标路径只取一次，判定与上报同一个键。
 *  词表配置在函数内现算（只依赖 rt.cfg），这样入参仍是五位、不必为 editOpts 再占一位。 */
function secretDenyOf(
  wiring: GuardWiring,
  exec: GuardExecution,
  rt: GuardRuntime,
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  const { messages, cfg } = rt;
  // 密钥词表也在函数内现读：strArray 兜住未经 schema 校验的值面，与调用点那两处同一口径。
  const secretPatterns = strArray(cfg.extraSecretPatterns);
  const editOpts: EditDangerOptions =
    secretPatterns === undefined ? {} : { extraSecretPatterns: secretPatterns };
  const target = editTargetPath(name, args);
  let reason: string | undefined;
  if (target !== null) {
    // 判定走 lib 的单一谓词 editDanger（"归一化路径 → 判密钥面"那两步就是它的本体），本函数不再
    // 抄第二份；上面那次 editTargetPath 只为本函数留下**上报签名**——判定与上报仍是同一个键。
    const denial = editDanger(name, args, editOpts);
    if (denial !== undefined) {
      // 规则键 → 当前语言的拒绝理由；`messages[denial]` 的取值类型让"加了规则没写文案"
      // 停在编译期，而不是运行时把 undefined 回给模型。
      reason = messages[denial];
      reportDeny(wiring, exec, {
        category: "secret-path",
        signature: target,
        detail: reason,
        evidence: { tool: name },
      });
    }
  }
  return reason;
}

/**
 * 装配闸门（**拦截半**，profile 条目 `danger-guard`）。
 *
 * 本条目**故意没有 `Config` 键**：0.1.7 的条目 config 由 cordis 在 apply 之前按条目的
 * `Config` schema 校验（vendor/cordis/src/fiber.ts:50、:641-664），越界值即 FAILED。
 * 用户可编辑的严格 schema 挂在安全闸门上，等于"一行笔误 = 闸门下线"（0.1.6 不是这样：
 * 注册抛错会被捕获、退回内置底座，闸门继续拦）。现在设置面独立成条目
 * `danger-guard-settings`（settings-host.ts），它炸只炸设置面；本条目永远装配成功，
 * 值面每次调用现读那个条目的投影（settingsConfig）。
 * @param ctx 宿主上下文
 */
export function apply(ctx: Context): void {
  // inject 服务面运行期保证存在；守卫理论不失败，失败即硬错快速暴露。
  if (!isDangerGuardHost(ctx)) {
    throw new Error("[danger-guard] required services (settings/effect) missing");
  }
  const svc: HostCtx = ctx;

  // 页面策略（configure({ auto: false })）归**设置条目**声明：它才是表单的 owner，
  // 而宿主按 fiber 记账页面策略（settings/index.ts:311 presentations.get(entry.fiber)）。
  // 拦截半不再碰 configure，服务面守卫也就只探 describe。

  // 回给模型的拒绝理由随官方 locale 偏好走：用户在「设置 → 常规」改语言后，下一次工具调用
  // 就是新文案（不重启、也不给本包另开一个 locale 设置项）。跨命名空间读在 0.1.7 只有
  // describe() 一条路（`settings.get(ns)` 已删除）：locale 偏好走它，官方 locale 条目不在
  // 组合里时找不到描述符 → value 为 undefined → 中文默认。本包自己的设置值面**不走**
  // describe()——值面由设置条目挂的读数口给（见 settingsConfig）。
  const localeMessages = (): DangerGuardMessages =>
    messagesFor(
      MESSAGES,
      resolveLocalePreference(
        svc.settings.describe().find((desc) => desc.ns === LOCALE_SETTINGS_NAMESPACE)?.value,
      ),
    );

  const factGate = new FactGate();

  // 取证台账投影：注册表在位时把单元挂上（注册是 effect，disposer 随注入子 fiber 回收），
  // 并把 `stateOf` 的同步水位读装进 ledgerBox。注册表缺席（未装 dsh-session-projection 的
  // profile）时回调根本不激活 ⇒ 读口留 undefined ⇒ 每次判定沿用回退扫描（wukil 的 rules
  // 判重、session-rescue 的回合事实同策）。**不**写进插件级 inject：那会让没装投影包的
  // profile 整个闸门不再激活——拦截面绝不能因为可选读面缺失而下线。
  const ledgerBox: GuardRuntime["ledger"] = { value: undefined };
  svc.inject?.(["sessionProjections"], (child) => {
    const registry = child.sessionProjections;
    registry.register(toolLedgerProjection);
    ledgerBox.value = (session) => asLedger(registry.stateOf(session, LEDGER_KEY));
  });

  // 会话销毁即释放 fact-gate 会话分片（ctx-observe/lesson-loop 同用官方 session/disposed）。
  // 幂等语义：同一 session id 重复 dispose 由 FactGate.dropSession 的 delete 天然幂等。
  svc.on?.("session/disposed", (sessionRaw) => {
    factGate.dropSession(sessionRaw.id);
  });

  // 判定链（bash 闸 / 密钥路径闸 / 事实门）与两路上报都已提到模块层，apply 只留接线。
  const wiring: GuardWiring = { svc, gate: factGate };

  // 谓词入参显式标注成本包的读取投影 `GuardExecution`（= 官方 ToolExecution 的 name/arguments
  // + SessionLogFace 会话面）：官方 `ToolGuard` 交出的是 `Readonly<ToolExecution>`，而
  // `SessionLogFace` 那三位（header / snapshotEvents / id）在官方是**必选**成员——它们说的是
  // 宿主 `new` 出来的 Session，跨进程边界送来的会话只能运行时判（见 buildEvalContext 的
  // typeof / Array.isArray 守卫）。不标注就等于让官方名义类一路渗到取证链里，那三道守卫会
  // 当场变成编译器眼里的死代码，而它们挡的是真实输入。标注错了也不会静默：把这支谓词的入参
  // 换成任何别的形状，官方 `guard` 那一侧立刻拒绝（编译器原话：`Argument of type
  // '(exec: …) => string | undefined' is not assignable to parameter of type 'ToolGuard'.
  //  Types of parameters 'exec' and 'execution' are incompatible`）。
  const dispose = svc.tools?.guard((exec: GuardExecution) => {
    // 每次调用现取 settings 运行时值 + 当前语言文案：设置卡改动与语言切换都不必重载插件。
    // 值面来自**另一个条目**的读数口（settingsConfig），所以设置条目炸了也只影响设置面。
    const rt: GuardRuntime = {
      cfg: settingsConfig(svc),
      messages: localeMessages(),
      ledger: ledgerBox,
    };
    let deny: string | undefined;
    if (rt.cfg.enabled) {
      const { cfg, messages } = rt;
      const { name } = exec;
      const args = isRecord(exec.arguments) ? exec.arguments : {};

      // 词表配置：strArray 兜住未经 schema 校验的值面（宿主组合层之外的形状变化）。
      // 条件展开：返回 undefined 即不传该键（与"缺省=内置词表"语义一致）。
      const devServerWords = strArray(cfg.extraDevServerWords);
      const devRunArgs = strArray(cfg.extraDevRunArgs);
      const bashOpts = {
        ...(devServerWords === undefined ? {} : { extraDevServerWords: devServerWords }),
        ...(devRunArgs === undefined ? {} : { extraDevRunArgs: devRunArgs }),
      };

      // 1) bash 危险命令（git 绕过 / rm -rf 灾难 / curl|sh / dev server）。
      // pwsh 与 bash 共用同一套规则，另在调用点声明 shell 方言（bashDenialOf）：pwsh 名下
      // Remove-Item / ri / rd / del 这些整树删除命令词与 Windows 字形目标都判得到。
      // 仍未覆盖：**包装词那一类**（段头是另一个解释器/包装器）——`cmd.exe /c rd /s /q …`、
      // `cmd /c …`（去 `.exe`）、`pwsh -c "…"`、`powershell -Command "…"` 四种活拼法同判放行，
      // 补的是同一层（跳包装词 = 新增命令词面），故按类登记、按类各钉一条现状用例。
      // 以及 pwsh 在 POSIX 宿主上真去删一个叫 `C:\Windows` 的相对目录
      // 这种罕见写法（方言带来的过拦，代价已写在 danger-rules 的 shellDialect 注释里）。
      const bashDenial = bashDenialOf(name, args, bashOpts);
      if (bashDenial === undefined) {
        // 2) 密钥/凭据路径编辑
        const editDeny = secretDenyOf(wiring, exec, rt, name, args);
        // 3) 事实强制门（强校验：持续拒绝到取证齐备为止）。目标路径经 editTargetPath
        //    归一化：edit/write 取 file_path ?? path，str_replace_editor 取 path（view 只读
        //    不过门）——与取证记账（callPathOf）同一个键形，模型照做的动作才记得上。
        //    上报签名用类别级稳定键：事实门教训是通用「先取证再编辑」，用目标路径当签名
        //    会把同一条规则拆成碎片卡、armed 后度量失效；目标路径改放 evidence。
        deny = editDeny ?? factGateDenyOf(wiring, exec, rt, name, args);
      } else {
        const { command, key } = bashDenial;
        // 同一道 bash 闸产出两种结论：命中危险模式（签名 = 命令原文，教训是改命令）
        // 与"体内命令没被检查过"（稳定签名 + evidence 标记，教训是先找用户确认）。
        // 判定只看规则键——lib 侧是唯一出处，不在这里再解析一遍命令，也不再比文案字符串。
        const unconfirmed = key === "nestedShellUnconfirmed";
        // 拒绝理由回给模型前才落到当前语言的文案上。
        deny = messages[key];
        reportDeny(wiring, exec, {
          category: "dangerous-bash",
          signature: unconfirmed ? NESTED_UNCONFIRMED_SIGNATURE : command,
          detail: deny,
          evidence: { tool: name, needsUserConfirmation: unconfirmed },
        });
      }
    }
    return deny;
  });

  if (dispose !== undefined) {
    svc.effect(() => dispose, "danger-guard: tools.guard");
  }
  // 会话隔离靠 FactGate 内部按 session 分片（seen: Map<sessionId, Set<file>>），不是靠 reset()。
  // 此 effect 仅在 apply 时对全新 gate 做一次清空（幂等 no-op），保留只为插件重装时状态归零。
  // 工厂**必须**交回一枚 disposer：官方 `Context["effect"]` 的返回域不收 `undefined`
  // （见 NOOP_DISPOSER 的注释——那是本次改绑官方后新撞出来的分歧，按官方补齐，语义不变）。
  svc.effect(() => {
    factGate.reset();
    return NOOP_DISPOSER;
  });
}

export default {
  inject: ["tools", "settings"],
  // ⚠ 这里**不能有 `Config` 键**——见 apply 的注释。设置面在 settings-host.ts。
  apply,
};
