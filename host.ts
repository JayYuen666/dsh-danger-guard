// danger-guard host 半：危险命令物理拦截 + 首次编辑事实强制门。
//
// 两个防线都挂 ctx.tools.guard（同步谓词，返回字符串即拒绝）：
//   1. bashDanger  — ECC block-no-verify / dev-server-block / curl|sh / rm -rf 移植
//   2. editDanger  — 密钥/凭据路径拦截：目标按**键形**认（file_path/path/notebook_path…），
//     不按工具名认（工具名随 provider 与版本漂移，猜名字等于静默失效）；只读动词跳过。
//     宿主**不**替我们解析路径：guard 拿到的是模型字面量（深冻结的 arguments，官方明确排除
//     输入改写，installed dsh-tools `PreToolDecision` 注释），解析发生在工具体内
//     （`packages/fs/tool-fs/src/read-target.ts:25`），晚于整条策略链；全仓 grep `resolvedPaths`
//     零命中。所以真实路径由本包自己取，`resolvedFormsOf` 交出的是**并集**：
//       · 本机 `realpathSync`（`realpathOf`，同步——guard 是同步谓词，这是它当场唯一付得起的）；
//       · 官方后端那一形（`ctx.fs.resolve` + `processPath`）：预检 B 面在判定前 async 问一次，
//         `fs/observed` 顺手记后端自己报的那一枚，两处都写进 `officialPaths` 供同步侧读。
//     非本地执行世界（fs-sandbox / ssh / e2b）下只有后者说的是同一份盘；两形从不互相替换，
//     所以官方那一形缺席或陈旧只会少拦不会多放。软链面因此可见，TOCTOU 只是收窄，未消除。
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
// 值」），所以把 dsh-brand 落在 **peerDependencies**（并同步进 devDependencies 供本仓编译）、产物留裸说明符：
// 官方自述它不保留运行时身份，而只写 devDependencies（不进 peer）会被 rolldown 把函数体内联
// 进 host.js（等于每包各持一份官方实现）；写进 dependencies 更糟——消费方 profile 是 hoisted
// 安装，它会物化成第二份真实目录，见 test/publish-manifest.test.ts 的那条门禁。
// 其余 @deepseek-ai/* 一律 type-only。

import os from "node:os";
import path from "node:path";
import { statSync, readFileSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import type { Context, Events } from "@deepseek-ai/cordis";
// 官方工具契约（type-only）：`ctx.tools` 的服务面与 guard 谓词收到的执行面都直接从
// `ToolRuntime` / `ToolExecution` 上取（见下方 GuardService / GuardExecution），本文件一个字
// 都不再重述它们的签名。dsh-tools 是 devDependency，产物里不能出现对它的运行时引用。
import type { ToolExecution, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
// 官方文件系统面（type-only）：预检的取证 I/O 全部走它，不再假定"本地盘就是工具的那个执行世界"
//（理由见 lib/preflight-scan.ts 的 PreflightFs 注释）。本包只读六位，故连类型一起用投影；
// `FsTarget` 在这里出现只为了"同一次调用里复用的那枚已解析身份"与 `fs/observed` 的载荷形，
// **从不**解析 `targetKey`（官方明令它 opaque："Consumers MUST NOT parse it"）。
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
// 设置面 schema 单源在 lib/settings-schema.ts：设置条目（settings-host.ts）持有它，
// 本文件只读那个条目挂出的读数口（见 settingsConfig）。
import { BUILTIN_BASE, SETTINGS_READER } from "./lib/settings-schema.ts";
import type { Config } from "./lib/settings-schema.ts";
import {
  bashVerdictOf,
  declaredTargets,
  editDanger,
  editTargetPath,
  isSecretPath,
  partitionSecretPatterns,
} from "./lib/danger-rules.ts";
import type {
  BashDangerOptions,
  BashDenialKey,
  BashVerdict,
  EditDangerOptions,
  Fix,
} from "./lib/danger-rules.ts";
// 需确认档的判定与两句话构造（宿主无关的那一半，可脱离宿主单测）。
import { askRequestOf, AskDeduper, dedupKeyOf } from "./lib/confirm.ts";
// 爆炸半径预演：常量表与渲染是纯函数（可脱离宿主单测），跑子进程那一趟在本文件。
import { BLAST_COMMANDS, measureBlastOf, withBlast } from "./lib/blast-radius.ts";
// 设置值面的防御性读取（`strArray`）与两个判定入口共用的词表装配（`bashOptsOf`）。
import { bashOptsOf, strArray } from "./lib/settings-read.ts";
// 宿主沙箱的管辖面（哪些灾难目标该让给它拦）。规范化折法由本文件注入 —— lib 不 import
// `node:fs`，而 `realpathOf` 是同步判定链唯一付得起的那种解析。
import { sandboxModeOf } from "./lib/sandbox-scope.ts";
import { effectiveDispositionFactory } from "./lib/effective-disposition.ts";
import type { DispositionFactory } from "./lib/effective-disposition.ts";
import { presenceOfAttempt } from "./lib/fs-errors.ts";
import type { Presence } from "./lib/fs-errors.ts";
// 「模型读到的是哪一版」的记账（观测/失效点同一条记录、只在成功结果后提交）。
import {
  attributeExternalChange,
  clearReadBasis,
  clearStaleness,
  commitReadObservation,
  discardReadObservation,
  observeVersion,
  readBasisLedgers,
  settleVersion,
  stageReadObservation,
} from "./lib/read-basis.ts";
// 按权限档位分叉的处置表：同一枚规则键在不同预设下的结论不同，判据本体全在这一层。
import { decideRule } from "./lib/mode-policy.ts";
import type { PolicyFacts, RuleVerdict } from "./lib/mode-policy.ts";
// 档位事实的折法（宿主三个只读服务面 → PolicyFacts），纯形状守卫、可脱离宿主单测。
import { policyFactsOf as policyFactsOfIn } from "./lib/policy-facts.ts";
// 拒绝文案的三段拼法（纯函数）：降级来的 deny 要多一段换档出路，这条只有一处实现。
import { policyDenyFlags, policyDenyText } from "./lib/policy-deny.ts";
import {
  FactGate,
  renderDenyMessage,
  // 预检的跳过判据与门禁同源（见 lib/fact-gate.ts 那个导出的注释）：两处各写一份正则
  // 迟早会漂，漂了就是"门禁不判、预检却代跑一次扫描"或反过来。
  SKIP_EXT_RE,
  DEFAULT_MAX_DENIES,
  DEFAULT_SMALL_EDIT_CHARS,
  DEFAULT_BIG_EDIT_CHARS,
  NO_DELIVERY,
  undeterminable,
} from "./lib/fact-gate.ts";
import type {
  DeliveryWatermark,
  FactDenial,
  FactEvidenceInput,
  FactGap,
  FactNeed,
  LayerNeed,
  NeedWhy,
} from "./lib/fact-gate.ts";
// 预检的取证 I/O 与证据渲染单源在 lib/preflight-scan.ts（那边不碰会话键、不碰状态机）。
// 扫描起点与匹配词**不在**那边算：root 用本文件的 projectRootOf（与拒绝理由里的检索起点
// 同一枚），needles 用本文件的 buildStems/MIN_STEM（与门禁记账的引用签名同一条口径）——
// 这两处一旦各自另算，"预检扫的"与"门禁认的"就成了两套，模型照提示做也拿不到凭证。
import {
  readTargetContent,
  renderAttach,
  renderHandoff,
  scanReferences,
  targetOrResolveOf,
} from "./lib/preflight-scan.ts";
import type {
  LayerFinding,
  PreflightEvidence,
  PreflightFs,
  RefScan,
} from "./lib/preflight-scan.ts";
// 台账容量与 LRU 写入口径单源在 lib/lru.ts（host 这几张表与官方真实路径表共用一条上限）。
import { lruPut } from "./lib/lru.ts";
// 目标路径的归一形与**官方通道**那一形单源在 lib/target-paths.ts：写口在 async 的一侧
//（预检 B 面、`fs/observed`），读口在同步的 guard 谓词里，键形必须逐字同源，所以收在一处。
import {
  clearOfficialPaths,
  rememberObservedPath,
  rememberOfficialTargetsOf,
  resolveTarget,
  resolvedFormsOf,
} from "./lib/target-paths.ts";
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
// 判定成本的本地滚动统计（每面一窗）。抽到 lib 是为了给 host.ts 腾出 max-lines 预算，
// 顺带把它变成一条**可复用的运维读数**（设置卡那侧要展示的就是这份数据）。
import {
  noteAllowedHit,
  noteAskSkipped,
  noteQuotaRelease,
  noteRuleHit,
} from "./lib/judge-stats.ts";
import type { JudgeCost } from "./lib/judge-stats.ts";
// 判定统计的客户端读面（官方 Typert Remote；手写 descriptor 与理由见该模块头）。
import { installStatsRemote } from "./lib/stats-remote.ts";
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
// 预检注入用官方的消息构造器（**值导入**）：注入必须是一条真会话事件，自己拼一个
// `{role:"user", content, source}` 字面量等于绕开官方的 id 铸造与深冻结——那两件事都不是
// 本包该复刻的（`MessageId` 是幻影品牌，`createMessage` 才是它唯一的合法构造口）。
// 它是 @deepseek-ai/* 家族里本文件的**第二处**值导入：必须外部化（落 peerDependencies，
// 与 dsh-brand 同一口径），否则 rolldown 会把 createUserMessage 连同它引用的
// dsh-util-values / dsh-util-crypto / dsh-brand 一起内联进 host.js——每个消费方各持一份
// 官方实现，而 test/build-host.test.ts 有一条断言专门钉"裸说明符在、函数体不在"。
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextFormed, UserMessage } from "@deepseek-ai/dsh-llm";
// lesson-loop 上报面（deny/pass 两条信号与代价采样）：可选读 + 异步收口的纪律全在那一层。
import { reportDeny, reportPass, sampleJudge } from "./lib/lesson-report.ts";
import type { ReportContext } from "./lib/lesson-report.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 事实门教训的类别级稳定签名：lesson-loop 规则卡按
 *  该签名归并，而非按目标文件路径——值须与 lesson-store 的类别级稳定签名表保持同源
 *  （`dsh-lesson-loop/lib/rule-signature.ts` 的 `CATEGORY_SIGNATURES["factgate-deny"]`
 *  = "edit-before-factgate"；lesson-loop 写入侧经 `stableSignatureFor` 折叠
 *  （lesson-store.ts report 路径），本包上报原文即可）。target 路径在上报 evidence 里，
 *  不丢信息。 */
const FACTGATE_SIGNATURE = "edit-before-factgate";

// 旧版这里有一枚 `NESTED_UNCONFIRMED_SIGNATURE` 常量，给"`-c` 体未被检查"那一类当稳定签名
// （理由是命令原文会把同一条教训按套娃形态碎成无数张卡）。那条理由现在由 **lesson-loop 的
// 类别级归并**承担（`CATEGORY_SIGNATURES` 把 `dangerous-bash` 折成一个稳定键，命令原文改落
// `evidence.signature`），故上报侧不再需要它：一律传命令原文，既保住"一张卡"，又让人审时
// 看得见到底是哪条命令触发的。是否需用户确认由 `evidence.needsUserConfirmation` 承载。

/** 成本样本的上报类别：每次判定一条 pass，载荷只有面名/耗时/输入长度三枚数值。
 *  开关联动 `judgeStats`（默认开），关掉就一条都不出域。 */
const JUDGE_COST_CATEGORY = "judge-cost";

/** 危险 bash 的上报类别：deny /「需确认」/ 放行三条路共用。lesson-loop 按类别折成一张卡，
 *  三处各写字面量就会各记各的。 */
const DANGEROUS_BASH_CATEGORY = "dangerous-bash";

/** 官方 `ToolExecution.agent` 去掉可选后的 `Agent`。本包**未**声明 `@deepseek-ai/dsh-agent`
 *  依赖，故经官方成员索引访问取到它，而不 import 类名（zvec-grep 的 lib/routing.ts 同策）。 */
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
 *  （`ocr-review` / `zvec-grep` 还额外 `Pick` 了 `register`——它们注册工具；本包不注册。）
 *  ⚠ `get` 挂在 **Partial** 上而不是并列的 `Pick`：它只用于探测"这条工具名在不在"（见
 *  `toolPresentOf`），缺席不该让闸门少一条凭证。官方原文在同文件 `:164`
 *  `get(name: string, scope?: ScopeKey): ToolDefinition | undefined`。 */
type GuardService = Pick<ToolRuntime, "guard"> & Partial<Pick<ToolRuntime, "get">>;

/** 「这条检索工具名在这台宿主上注册着吗」的探测口（指令点名专用）。 */
export type ToolPresent = (name: string) => boolean;

/** 探测不了时的答复：一律算"在"。多点名一个名字只是让模型白烧一次调用，
 *  而少点名一个真存在的工具是把模型要走的门关上——两个错的方向不一样。 */
const TOOLS_UNKNOWN: ToolPresent = () => true;

/** 由 `ctx.tools` 的服务面造探测口。
 *  为什么需要它：默认名单里的 `grep`/`glob` 来自宿主 stock 目录（docs/tool-catalog.md +
 *  packages/fs/tool-fs-search），而 `zg_search`（连同它的 `root`/`query`/`fts`/`vector` 参数面）
 *  由**另一枚插件**注册——本仓同级包 `@jayyuen66/dsh-zvec-grep`。也就是说这一位**逐台不同**：
 *  装了它的人才走得通那条严格口径，没装的人照着拒绝理由去调只会撞"工具不存在"，缺项照旧——
 *  本包一直在防的就是这件事：**指令不可照做**。所以点名前先问一句"这台宿主注册着吗"。
 *  探测抛错（老宿主没有这枚成员）与探测不到一律回 true，判定面因此不受这一层影响：
 *  多点名一个名字只是让模型白烧一次调用，少点名一个真存在的工具则是把模型要走的门关上。 */
function toolPresentOf(tools: GuardService | undefined): ToolPresent {
  if (typeof tools?.get !== "function") {
    return TOOLS_UNKNOWN;
  }
  return (name: string): boolean => {
    try {
      return tools.get?.(name) !== undefined;
    } catch {
      return true;
    }
  };
}

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
 * 成员交出（installed :96）。口径同 ocr-review 与 zvec-grep 的 host.ts——区别只在
 * 那两包还用了 `configure`：本包的页面策略归**设置条目**声明（见 apply 上方注释），故不取。
 */
type SettingsFormsService = Pick<SettingsForms, "describe">;

/** 预检注入消息的 `source.kind`（本包自己的生产者名）。官方 `MessageSourceMap` 是**合并式
 *  可扩展**的和类型：每个生产者在自己模块里 `declare module` 声明自己的 kind
 *  （dsh-tool-jobs 就是这么声明 `tool-jobs` 的，见其 lib/types/index.d.ts:13-17）。
 *  `form: "notice"`（一次性发生的事）由官方的 `ContextFormed` 判别并要求带 `summary`
 *  ——那条 ≤120 字的一行说明会进 UI 折叠态，也是这条注入的"标题"。 */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "dangerguard-preflight": { readonly kind: "dangerguard-preflight" } & ContextFormed;
  }
}

/** `tools/pre-execute` 的两个实参面（官方 `Events` 增强出来的那一对：exec 与 next）。
 *  本文件不重述 [name/arguments/agent/signal] 的签名——官方任一环改名即在此编译不过。
 *  `Parameters` 会剥掉 `this`（与下面 `session/disposed` 那条读法同一个用法）。 */
type PreExecuteParams = Parameters<Events["tools/pre-execute"]>;
/** 瀑布的 `next`：把决定权交给后续监听器或默认放行。预检**永远先**调它，
 *  只在下游放行（`kind === 'allow'`）时才轮到我们递证据或拦一次——不去抢别人已经做的决定。 */
type PreflightNext = PreExecuteParams[1];
/** 本插件注册的预执行监听器面（B 面）：返回域即 `next()` 的返回域（`Promise<PreToolDecision>`），
 *  不写成 `Promise<ReturnType<…>>`（那会多套一层 Promise）。 */
type PreflightListener = (
  exec: PreExecuteParams[0],
  next: PreflightNext,
) => ReturnType<PreflightNext>;

/** `tools/post-execute` 的三个实参面（exec、**已冻结的那次结果**、next）；同上，不重述签名。 */
type PostExecuteParams = Parameters<Events["tools/post-execute"]>;
/** 结果面：官方给的是 `Readonly<ToolExecutionResult>` 判别联合，本包只读 `isError` 一位。 */
type PostExecuteResult = PostExecuteParams[1];
type PostflightNext = PostExecuteParams[2];
/** A 面的监听器面：把引用块并进下游的 `PostToolDecision`（accept 附 additionalContexts，
 *  block 也附——被改判成错误结果时，那块证据对模型仍然有用，与官方 repeat-tool-reminder 同策）。 */
type AttachListener = (
  exec: PostExecuteParams[0],
  result: PostExecuteResult,
  next: PostflightNext,
) => ReturnType<PostflightNext>;

/** 两条瀑布的返回域（各自 `next()` 的 awaited 结果）。写成别名而不是去 import
 *  官方的 `PreToolDecision` / `PostToolDecision`：本文件对官方签名一个字都不重述，
 *  官方任一处改名或换形状都会在这里当场编译不过，而不是让产物里留一份对不上的副本。 */
type PreDecision = Awaited<ReturnType<PreflightNext>>;
type PostDecision = Awaited<ReturnType<PostflightNext>>;

/** 把一枚附加上下文并进下游决定。三种形状各自**重建**，不做 `{...downstream}` 展开：
 *  官方 `PostToolDecision` 的 accept 是两个臂（`content?` 与 `value?`，另一臂标 `?: never`），
 *  展开出来的对象字面量在判别联合上不收（`exactOptionalPropertyTypes` 下"这一位是 undefined"
 *  与"没有这一位"是两回事）。
 *  `block` 也附：那次调用已经被改判成错误结果，但引用面对模型仍然是有用的事实——
 *  与官方 repeat-tool-reminder 同一条处理（其 src/index.ts:224-225）。 */
function attachContext(downstream: PostDecision, context: UserMessage): PostDecision {
  const contexts = [context, ...(downstream.additionalContexts ?? [])];
  let merged: PostDecision;
  if (downstream.kind === "block") {
    merged = { kind: "block", feedback: downstream.feedback, additionalContexts: contexts };
  } else if (downstream.value === undefined) {
    merged = {
      kind: "accept",
      ...(downstream.content === undefined ? {} : { content: downstream.content }),
      additionalContexts: contexts,
    };
  } else {
    merged = { kind: "accept", value: downstream.value, additionalContexts: contexts };
  }
  return merged;
}

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
  /** 宿主事件回调，本插件用到三种形状：
   *   - `session/disposed`：接线 fact-gate 会话分片及时回收。载荷不再手抄成 `{ id?: unknown }`：
   *     它就是官方事件的第一个实参
   *     （`session/disposed(this: Scoped<Session>, session: Session): void`，installed
   *     `@deepseek-ai/dsh-session/lib/types/index.d.ts:51`，经 cordis `Events` 的官方增强），
   *     故 `Parameters<Events["session/disposed"]>[0]` = 官方 `Session` 类面，本包读的那三位
   *     （`id` / `header` / `snapshotEvents`）由 `SessionLogFace` 承接。
   *   - `settings/document-updated`：locale 偏好缓存的失效信号（见 localeMessages）。
   *   - `tools/pre-execute`：预检的 **B 面**（带证据拦一次）。它是**瀑布**事件
   *     （`(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>)`，
   *     installed dsh-tools :47），故监听器必须把 `next()` 的结果交回去。
   *   - `tools/post-execute`：预检的 **A 面**（引用面随读取结果出去）。同为瀑布，多一枚
   *     结果实参（`Readonly<ToolExecutionResult>`，installed dsh-tools :70），返回域是
   *     `PostToolDecision`——A 面只在下游 `accept` 上并 `additionalContexts`。
   *   - `fs/observed`：后端每观察一枚目标就报一次（`@deepseek-ai/dsh-fs` 的
   *     `'fs/observed'(target, observation, actor)`，**emit** 模式）。本包只读第一枚实参里
   *     后端自己解析出的 `displayPath`，把它经 `processPath` 换成该执行世界的绝对路径记进
   *     `officialPaths`——同步、零额外 I/O。⚠ 官方明说这类监听器"throws fail the tool call"，
   *     所以取值那一步整个包在 try 里（见 rememberObservedPath）。
   *  ⚠ 这里**不**换成 `Context["on"]`：那是全仓延后项（泛型 `on<K extends keyof Events>` 会
   *  重写每一枚监听器签名，ctx-observe 的 host.ts 记着同一条理由）。按重载逐枚点名，
   *  新增事件时加一条签名即可，不必把整张事件表拖进来。 */
  on?: {
    (
      event: "session/disposed",
      listener: (session: Parameters<Events["session/disposed"]>[0]) => void,
    ): unknown;
    (event: "settings/document-updated", listener: (ns: unknown) => void): unknown;
    (event: "tools/pre-execute", listener: PreflightListener): unknown;
    (event: "tools/post-execute", listener: AttachListener): unknown;
    (
      event: "fs/observed",
      listener: (target: Parameters<Events["fs/observed"]>[0]) => void,
    ): unknown;
  };
  /** 注入子上下文（用它挂投影单元的注册与读口）。按**可选**收：cordis 只在依赖到位时
   *  才激活回调，没装 dsh-session-projection 的 profile 上这条路径整体不存在，闸门沿用
   *  回退扫描——写进 `isDangerGuardHost` 的硬前置等于把闸门下线（同 session-rescue 的口径：
   *  探针只能探"真会直接调的方法"）。child 面按本包用到的那一位投影。 */
  /** 官方可选注入面。两枚重载按"具体在前"排：`["fs"]` 那一条的入参形状与通用条的
   *  `{ sessionProjections }` 不互相 assignable，写反了会被通用臂吃掉。 */
  inject?: {
    (deps: ["fs"], activate: (child: { fs: PreflightFs }) => void): unknown;
    (
      deps: readonly string[],
      activate: (child: { sessionProjections: ProjectionsRegistry }) => void,
    ): unknown;
  };
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

/** 官方工作目录服务的最小读面（`WorkingDirectoryService.get(session: Session): string`，
 *  `@deepseek-ai/dsh-working-directory` src/index.ts:122-124——同步、不做 fs I/O，
 *  所以能在 `ToolGuard` 这道同步谓词里读）。
 *  ⚠ 官方收的是名义类 `Session`，本包的会话面是 `SessionLogFace` 投影（理由见它自己的注释），
 *  两者在类型上对接不上，故入参按投影面写、返回按 `unknown` 收，形状由 `effectiveCwdOf`
 *  现判——与 `readSessionLog` 里那道 `Array.isArray` 是同一条纪律。 */
interface WorkingDirectoryFace {
  get?: (session: SessionLogFace) => unknown;
}

/** 工作目录服务在场守卫：不是记录 ⇒ 没有服务；`get` 存在但不是函数 ⇒ 也不认
 *  （`get` 缺席留给人值守卫 `raw.get?.()`，两种缺席都退回创建期目录）。 */
function isWorkingDirectory(value: unknown): value is WorkingDirectoryFace {
  if (!isRecord(value)) {
    return false;
  }
  return value["get"] === undefined || typeof value["get"] === "function";
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

/** 非法/超长的扩展密钥模式：**加载期就校验**（判定链走的是同一个谓词），并且点名报出来——
 *  静默跳过等于让用户以为这条保护已经生效。按模式字面去重，否则每次编辑判定都刷同一条日志。
 *
 *  去重表**必须有界**：模式串来自用户配置，长驻进程里反复改设置会持续往里加，而它只用于
 *  「这条已经报过别再刷」，丢一条旧记录最坏的后果是多打一行日志，不是漏掉一条保护。
 *  容量按一次设置的合理规模取，淘汰交给 `lruPut`（与其它台账同一条容量口径）。 */
const rejectedPatternsLogged = new Map<string, true>();

/** 去重表的容量：一次设置里的无效模式数远小于它；超出的旧记录被淘汰只意味着日志可能重复一次。 */
const REJECTED_PATTERNS_CAP = 64;
function reportRejectedPatterns(patterns: readonly string[]): void {
  for (const pattern of partitionSecretPatterns(patterns).rejected) {
    if (!rejectedPatternsLogged.has(pattern)) {
      lruPut(rejectedPatternsLogged, pattern, true, REJECTED_PATTERNS_CAP);
      console.warn(`[danger-guard] extraSecretPatterns 无效，本条未生效: ${pattern}`);
    }
  }
}

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
// `noteJudgeCost` 的实现搬去了 lib/judge-stats.ts（腾 max-lines 预算），但它一直是
// host.ts 导出面的一部分（`types/host.d.ts` 里有它，用例也从这里取）——转发一枚，
// 对外形状逐字不变，换代不打断任何消费方。
export { noteJudgeCost } from "./lib/judge-stats.ts";

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
 * 只能运行时判（`buildEvalContext` 里读出的 `typeof reader === "function"`、`effectiveCwdOf`
 * 里对 `session.header?.cwd` 的取值）。官方类型描述宿主**承诺**什么，守卫负责宿主**交付**
 * 什么，两者并存。
 * `SessionHeader.cwd` 官方即 `readonly cwd?: string`（types.ts:104-105），且从 0.2.1-alpha.2
 * 起语义收窄成**创建期**快照（活目录在 `ctx.workingDirectory`，见 `effectiveCwdOf`），
 * 故 `typeof cwdRaw === "string"` 那道守卫在迁移前后都仍然必要（空串另算：长度判定保留）。
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
/** 词干过短不做匹配（防 a.ts / ab.ts 这类两字母名到处顶包）。 */
const MIN_STEM = 4;
// 读取基线与失效点整组在 lib/read-basis.ts（观测/判据同一条记录、只在成功结果后提交、
// 失效点写进取值）：那三条不变式两处各写一遍就会静默失效，故不与其余台账混放在本文件。
/**
 * `会话|目标` → 该会话上次评估时的日志长度。
 * **必须按会话键**：存的是事件下标，跨会话复用会让新鲜度基准直接错位
 * （A 会话 len=50 写进台账，B 会话读到的 baseline 就是 A 的下标）。
 */
const seenLenBySessionPath = new Map<string, number>();

/** 项目根探测缓存（`会话目录|目标` → 根）。键里带 cwd 的理由见 `projectRootOf`：没有工程
 *  标记时回落值取决于"cwd 是不是目标的祖先"，只按目标缓存会让两个会话互相吃对方的根。 */
const rootCache = new Map<string, string>();

// ── 预检（Phase 2）的内存面：上界 + 台账 + 键形 ───────────────────────────────
// 逻辑在下面「预检」一节（A 面 attachRefsOnRead / B 面 runPreflight），这里只放"记忆与上界"，
// 与上面几张台账同一处——它们的生命周期一样（模块级、LRU 兜底、会话销毁时按会话键回收、
// 插件卸载时整表清空）。

/** 预检的墙钟上限（毫秒）。**必须存在**：平台不会放弃一枚挂起的 pre-execute promise
 *  （dsh-tools 的 `tools/pre-execute` 契约原话："the registry rechecks cancellation after
 *  they settle but never abandons their promise"），一次卡住的扫描会把整次工具调用永久挂死。
 *  这是工程上界、不是产品策略，故不落设置面（配置面只收紧凭证，不放宽成本）。
 *  大仓里的常态成本由 lib/preflight-scan.ts 的文件/目录**预算**先收住（截断即返），
 *  这一枚只兜"单枚 syscall 卡住"那种罕见形状。 */
const PREFLIGHT_TIMEOUT_MS = 3000;

/** 引用扫描缓存：`会话id|目标` → 结果 + 扫描时的目标版本位。
 *  version 是新旧判据（与 lib/read-basis.ts 的新鲜度同一条自校口径）：目标被会话外改过就重扫；
 *  否则紧接着的另一趟直接吃这份结果——被预算截断的那份也照用（`complete` 位随结果一起
 *  进缓存，读法侧据此决定给不给凭证）。 */
const preflightScans = new Map<
  string,
  { scan: RefScan | undefined; version: FsVersion | undefined }
>();
/** 预检投递水位：`会话id|目标` → 两项各自的投递位次。
 *  B 面写在 `tools/pre-execute`，而 guard 谓词**必然**在其之后同步跑（官方
 *  `prepareExecution` 只在 `decision.kind === 'allow'` 时才走 `guardReason`），所以那次投递
 *  它一定看得见。A 面写在 `tools/post-execute`：它的证据随读取结果一起被 loop 收下
 *  （`agent-loop/src/tool-calls.ts:157`，"for the next step boundary"），不靠会话日志里
 *  能不能看见——正因如此它比旧版那条 `agent.inject()` 可靠：inject 排在 next pre-step，
 *  官方明说可能被取消/丢弃，而水位却会把它记成"补过了"。 */
const preflightDelivered = new Map<string, DeliveryWatermark>();

/** 「这次调用没有已解析的 target」那一份共享表：没有声明目标的调用用它，而不是每次 new 一枚
 *  （pre-execute 是每次工具调用都要过的路）。只读用途，所以类型面就是 `ReadonlyMap`。 */
const NO_TARGETS: ReadonlyMap<string, FsTarget> = new Map();

/** 会话键前缀（`会话id|`）：read 的 mtime 基线、评估时的日志水位、预检的扫描缓存与投递水位
 *  四处共用这一枚构造。一旦有一处不同源，预检写下的水位就在评估侧读不到——静默退回"仍缺项"、
 *  整趟预检白做，而且没有任何报错（键形不同在类型上也看不出）。
 *  分隔符让 `s1` 吃不到 `s10|…`。 */
const sessionKeyPrefix = (sessionId: unknown): string => `${stringIdOf(sessionId)}|`;

/** 会话键的**完整**形状（`会话id|目标`）：上面那枚前缀加目标绝对形。五处读法共用它——
 *  mtime 基线（`recordReadObservation`）、外部改动水位（`evidenceFor`）、预检的扫描缓存
 *  （`refScanOf`）与两张投递水位（A/B 面）。把拼接本身单源化，是因为"只共用前缀"仍留下
 *  五处各自 `${prefix}${target}` 的机会：少一个分隔符、多一次 normalize 都不会编译报错，
 *  只会让预检写下的水位在评估侧永远读不到。lib/read-basis.ts 的键同样来自这里。 */
const sessionTargetKeyOf = (sessionId: unknown, targetN: string): string =>
  `${sessionKeyPrefix(sessionId)}${targetN}`;

/**
 * 丢掉一个会话在会话键台账里的分片。键形是 `会话id|目标`（`sessionKeyPrefix` 自带 `|`
 * 收尾），故按 `会话id|` 前缀匹配就够：分隔符让 `s1` 吃不到 `s10|…`。
 * 只扫这几张——`rootCache` / `layersByStart` 是路径键，与会话无关。
 * 预检那两张（扫描缓存、投递水位）是会话键，必须跟着走：留着的话下一个会话拿到前一个
 * 会话的投递水位就是**免检金牌**（门禁认的是 `会话id|目标`，但泄漏的是记忆本身）。
 * 读取基线/失效点/暂存观测同理（见 lib/read-basis.ts）：那份失效点说的是"本会话还没看过
 * 这一版"，跨会话复用等于替新会话判"这份证据还有效"。
 * 幂等：同一会话重复 dispose 是空操作。
 * @param sessionId 会话 id（与 buildEvalContext 同一个 stringIdOf 投影）。
 */
function dropSessionLedgers(sessionId: string): void {
  const prefix = `${sessionId}|`;
  for (const map of [
    ...readBasisLedgers(),
    seenLenBySessionPath,
    preflightScans,
    preflightDelivered,
  ]) {
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) {
        map.delete(key);
      }
    }
  }
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

/**
 * fs 存在性判定（tools.guard 同步契约，经 syncStat）。
 * **只把 ENOENT 认作"文件不存在"**：EACCES（目录无权限）、ENOTDIR（路径中间是文件）、
 * ELOOP（符号链接成环）下文件其实**存在**，一律归为"不可知"。调用方据此决定新建豁免——
 * 把任何 stat 失败都当"新文件"，等于让权限问题替模型免掉 read（正是这道豁免最不该失守的方向）。
 *
 * 分类判据在 `lib/fs-errors.ts`（读 `code` 优先，见那里的理由：message 措辞随平台变）。
 *
 * @param targetPath 待判目标。
 * @param statOf 取 stat 的函数。**默认 `syncStat`**；测试可注入一个抛指定 errno 的桩，
 *   于是"ENOTDIR 不给豁免 / ENOENT 才给"这两条能在**任何宿主**上确定性验证，
 *   不必依赖真实 fs 在该平台上恰好抛哪个码（那是平台行为，不是本包判据）。
 * @returns 三态结论与 mtime（unknown/absent 时 mtime 为 -1）。
 */
function presenceOf(targetPath: string): { presence: Presence; mtimeMs: number } {
  // 三态分类本身在 `lib/fs-errors.ts`（纯函数，可注入错误形状验证）；这里只负责"真的去 stat"。
  return presenceOfAttempt(() => syncStat(targetPath).mtimeMs);
}

/** 文件是否存在（经 syncStat 取 stat，为 tools.guard 同步契约）。
 *  这里只用于"层目录/mark 文件在不在"的存在性探测——探测不出即按不在处理，
 *  方向保守（少要求一层探查）；目标文件的存在性必须用 presenceOf 区分。 */
function pathExists(targetPath: string): boolean {
  return presenceOf(targetPath).presence === "present";
}

/** 项目根探测认的工程标记（与 quality-gate gate-detect 同一族标记）。 */
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
  // `dir` 是宿主真实路径 ⇒ 拼子项走平台实现（理由同 `probeLayersAt`：`/` 拼出混分隔符串，
  // Windows 上 fs 查不到那个文件，于是工程根标记全判"不存在"，项目根回落到父目录）。
  ROOT_MARKERS.some((marker) => pathExists(path.join(dir, marker)));

/** `candidate` 是否为 `target` 的**祖先目录**（目标自身不算）。
 *  这是「引用取证的作用域判据」与「项目根的回落取值」共用的**同一条不变式**，故单列一处：
 *  判定侧（`isProjectScopeOf`）只认"检索起点是目标的祖先"，而拒绝文案会把项目根当检索
 *  起点原样递给模型（`assembleGaps` 的 `ctx.searchPath`）。两处一旦不同源，就会出现
 *  「门禁教模型去搜的位置，门禁自己又不认」——模型怎么照做都攒不满凭证。 */
/**
 * `path` 是否就是 `root` 或落在它之下（照官方 `workspace-changes/src/paths.ts` 的 `isInside`）。
 *
 * 为什么不拼前缀再 `startsWith`：那要自己判"末尾有没有分隔符"，而分隔符在 Windows 上是
 * `\\`、混形还合法——每漏一种写法就多一条恒假的判据。`path.relative` 由平台实现同时解决
 * 分隔符与 `..` 归一：结果是空串（同一路径）或以 `..` 开头（在外面）都不是"在内部"。
 *
 * @param root     绝对目录。
 * @param candidate 待判的绝对路径。
 * @returns 自身与所有后代为 true。
 */
function isInside(root: string, candidate: string): boolean {
  // 食宿主的 `path`：`host.ts` 里这条判据只服务"检索作用域是否覆盖目标"这一件事，
  // 而入参都来自宿主服务（`workingDirectory` / `session header`），随平台走是对的。
  // 需要按 Windows 规则验证的那两处（`lib/sandbox-scope.ts`、`lib/preflight-scan.ts`）
  // 已改成**注入 `pathApi`**，测试可以显式交 `path.win32`。
  const rel = path.relative(root, candidate);
  // ⚠ 判"是否上跳出根"必须比**路径组件边界**，不能只看 `rel.startsWith("..")`：
  // `relative()` 对根内名为 `..cache` 的目录返回 `..cache`，那个前缀判断会把它误判成
  // "跑到根外面" —— 方向是**放行**（"沙箱盖不住"为真 ⇒ 灾难删除让路给同样管不了它的沙箱）。
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const isAncestorDirOf = (candidate: string, target: string): boolean =>
  candidate !== target && isInside(candidate, target);

/** 项目根：向上找工程标记（与 quality-gate gate-detect 同一族标记）。
 *  **找不到标记时退到目标自己的父目录，不是会话 cwd** —— 回落值必须满足
 *  `isAncestorDirOf(回落值, targetN)`，见上一枚函数的说明。会话 cwd 与目标分处两棵树时
 *  （最典型的是 /tmp 下的草稿脚本：整条祖先链上没有任何 ROOT_MARKER）它不是目标的祖先，
 *  于是拒绝理由里的检索起点成了模型**无论怎么做都够不到**的位置——照着提示搜不算数，
 *  只能连拒到 maxDenies 换一次配额放行，外加一条 stderr 警告。
 *  cwd 只在**确实是祖先**时才用（会话就在目标所在目录树里时，它的范围比目标父目录更大、
 *  层探查也更准）；否则一律用目标父目录——那是唯一必然仍是祖先的取值。代价仅是项目外
 *  目标不再越过自身目录去问"有没有 tests/"（对着 /tmp 问这个本来就没有意义）。 */
function projectRootOf(targetN: string, cwd: string | undefined): string {
  // 键含 cwd：回落那一步问的正是"cwd 是不是目标的祖先"，于是**同一枚 targetN 在两个会话
  // 目录下会得到两个不同的根**。只按 targetN 缓存的话，第二个会话吃到第一个的根——而根同时
  // 是扫描起点、拒绝理由里递给模型的检索起点、以及层相对形（toPosixRelative）的基准，
  // 错位就让"这层没被覆盖"变成常态（方向保守，但那是白给的摩擦）。
  const key = `${cwd ?? ""}|${targetN}`;
  const cached = rootCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const parent = path.dirname(targetN);
  let root = cwd !== undefined && isAncestorDirOf(cwd, targetN) ? cwd : parent;
  let dir = parent;
  for (let depth = 0; depth < 12; depth += 1) {
    if (hasRootMarker(dir)) {
      root = dir;
      break;
    }
    const next = path.dirname(dir);
    if (next === dir) {
      break;
    }
    dir = next;
  }
  lruPut(rootCache, key, root);
  return root;
}

/**
 * 波及面层目录（「机械探查 + 文字声明双轨」的机械半轨）。
 * 层**存在**才要求探查——不存在由 fs 判定直接豁免，比让模型 grep 一次空目录便宜且
 * 零作弊面；存在的层要求至少一次**可归因**动作落在其中（符号级结论仍归文字声明）。
 */
const LAYER_DIRS: { need: LayerNeed; names: string[] }[] = [
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
  // 同上：混分隔符串在 Windows 上 fs 判定恒假 ⇒ 所有层都判成"不存在"（层要求整片失效）。
  names.find((name) => isDir(path.join(dir, name)));

/** 一条被探测到的层：need + 实际目录绝对路径（提示与归因都要具体路径）。 */
interface FactLayer {
  need: LayerNeed;
  dir: string;
}

/** 层存在性缓存（`起点目录|追加测试目录` → 该链上存在的层）。 */
const layersByStart = new Map<string, FactLayer[]>();

/** 卸载兜底：插件换代（配置重载/重装）时把派生台账清空，不让上一代的缓存活过这一代——
 *  可换代时工作树已经变了，上一代的层探查结论是错的。预检那两张（扫描缓存、投递水位）
 *  同理：它们记的是上一代看到的引用面与投递事实，换代后一并作废。官方真实路径那张也清：
 *  它喂的是**密钥面判定**，换代之间软链可能被重新指向，留着旧形等于拿上一代的盘判这一代。
 *  读取基线那组同样要清（见 lib/read-basis.ts）："上一代要求的失效点"与"上一代看到、
 *  还没确认落地的观测"都没有资格跨代生效。
 *  `rootCache` 不在此列：它是纯路径→根映射（只决定扫描起点），留着无副作用，交给 lruPut 兜底。 */
function clearDerivedLedgers(): void {
  clearReadBasis();
  seenLenBySessionPath.clear();
  layersByStart.clear();
  preflightScans.clear();
  preflightDelivered.clear();
  clearOfficialPaths();
}

/** 一个目录上的层探查（`existingLayersOf` 上走链的循环体）：对**尚未命中**的每一层，
 *  按层名表（test 层追加用户配置的 extraTestDirs）取第一条实际存在的目录记入 `found`。
 *  判定顺序与抽前逐字相同：先按 `LAYER_DIRS` 声明序、层名表内序，首次命中即占位。 */
function probeLayersAt(dir: string, found: Map<FactNeed, string>, extraTestDirs: string[]): void {
  for (const layer of LAYER_DIRS) {
    if (!found.has(layer.need)) {
      const names = layer.need === "test" ? [...layer.names, ...extraTestDirs] : layer.names;
      const hit = firstExistingLayer(dir, names);
      if (hit !== undefined) {
        // ⚠ 必须用 `path.join`：`dir` 是**宿主真实路径**（Windows 上是 `C:\...`），
        // 用 `/` 拼会产出 `C:\...\\dg-tier-x/test` 这种混分隔符串 —— 实测两个后果：
        //   ① 文案里点名的层目录写成了混合形，测试拿 `path.join` 的期望值匹配不上
        //     （Windows runner 上这条红）；
        //   ② 这个混形随后参与包含性比较，与真实路径不同源。
        found.set(layer.need, path.join(dir, hit));
      }
    }
  }
}

/**
 * 目标文件所属包链上**实际存在**的层（机械半轨的存在性判定）。
 * 从目标父目录一路向上到项目根逐级找层名——monorepo 里 `packages/foo/test/` 才是
 * 该文件的真实测试层，只在项目根找会漏。层不存在 → 直接豁免（不必让模型 grep 空目录
 * 自证"没有"）。缓存键含 extraTestDirs：词表变化时旧缓存必须失效；**也必须含 root**——
 * 上溯的终点由它决定，而它对同一枚目标可以不是同一个值（`projectRootOf` 的回落分支取决于
 * 会话 cwd）。键里少这一位时，包根里开的会话与仓库根里开的会话会互相复用对方的层集合：
 * 窄根先评估就把宽根会话的 test 层要求整片吃掉，宽根先评估则给窄根会话要一层它够不到的目录。
 */
function existingLayersOf(targetN: string, root: string, extraTestDirs: string[]): FactLayer[] {
  const start = path.dirname(targetN);
  const cacheKey = `${start}|${root}|${extraTestDirs.join(",")}`;
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
  return root !== undefined && isInside(root, layer.dir);
}

/** 触及导出面/签名的关键字：改动文本含这些词 → 波及面大概率超出文件自身，升档。 */
const SIG_KEYWORD_RE =
  /\b(?:export|default|declare|pub|fn|func|def|class|interface|type|enum|struct|trait|impl|public|protected)\b/u;

/** 高风险路径：manifest / lockfile / 构建配置 / CI / cordis 装配——改一个字符也能全局波及。 */
// ⚠ 前缀必须容**两种**分隔符（`[/\\]`）：宿主真实路径在 Windows 上是 `C:\\proj\\package.json`，
// 只认 `(?:^|\/)` 时 `package.json` 前面是 `\\` ⇒ 恒不匹配 ⇒ 改版本号不再升档
//（实测 Windows runner 上该用例红：`denied` 为 undefined，落到了最低档）。
const RISKY_PATH_RE =
  /(?:^|[/\\])(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|bun\.lockb?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|uv\.lock|requirements\.txt|setup\.py|tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?js|cordis\.(?:ya?ml|json)|Makefile|Dockerfile|docker-compose\.ya?ml|\.env(?:\.[\w-]+)?$|schema\.sql)$/u;

/**
 * 取证档位（定稿：按写面风险分档，配 strictMode 回到"每文件全探查"）。
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
 * 定档。缺信息一律**升档**：宁可多要一次探查，不可少要。
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
 * 从一次写调用提取风险事实。缺信息一律留 undefined → tierOf 保守升档：
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
    // 恰好把「缺信息一律要更多」反过来——被自家接线测试抓到。
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
 * 以 `nc:<seq>` 为键**单独放着**——第二遍结算只认能配到结果的那些键（见 resolveResultLedger）。
 * 前缀不是"成功"的标记，恰恰相反：它标记的是**等不到成败回填**、因此不算证据的那一类。
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
 *  1. **新鲜度只认外部改动**（定稿）：模型自己连续编辑同一目标**不再反复
 *     过门**——edit 的返回本身就带着改动后的内容，再逼一次 read 是纯仪式。故基准
 *     `staleBase` 只在"确属外部改动"时才抬升，否则为 -1（任何一次成功 read 即满足）。
 *     本次编辑的 tool/call 虽已在日志（appendToolCall 先于 dispatch），但其结果未
 *     回填 → 不入任何统计 → 不会自我否证。引用证据同样不失效（谁引用它不由本文件决定）。
 *  2. **引用探查必须项目级**：搜文件自身只算内容探查，看不到"谁引用它"；
 *     故 path 必须是目标的祖先目录，且 pattern/query 命中文件名或足够长的词干。
 *     签名比对两侧同形归一（见 flattenSig），否则正则转义会误判"未取证"。
 *  3. **失败调用不算证据**：grep 路径打错报错 ≠ 做过探查；被门禁拒掉的编辑
 *     也不算（它同样不推进 lastEditSeq，而 lastEditSeq 用于第 4 条的归因）。
 *  4. **外部改动识别**（与第 1 项配套）：mtime 比上次评估更晚**且**该跳变无法
 *     被本会话解释时才算 external。基线在**两处**建立——read/view 的 guard 时点
 *     （recordReadObservation，闭合"首次评估盲区"）与编辑评估时点；归因两步——(a) 那次成功编辑的**结果事件位**不早于
 *     跳变位；(b) **内容自证**：当时写进去的文本此刻仍在文件中。文本不在了说明自己
 *     那份已被覆盖 → 判外部（保守方向）。旧实现拿 tool/call 下标比长度：call 早已在
 *     日志里，必然更小 → 自有编辑被恒判"外部改动"（实测连番冤枉我自己）。
 *  5. **新建豁免**：write/create 且目标 fs 不存在 → 免 read 要求。
 *     不解析报错文本（"报错也算数"会给假证据开门）；edit 打在不存在的文件上本就
 *     会失败，不需要门禁假装那算取证。
 *  6. **逐层波及面**（机械半轨）：test/e2e/docs 由 fs 探测存在性——不存在即
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
  // 判据与「项目根回落」同源（isAncestorDirOf）——两处必须给出同一个答案，否则门禁
  // 会教模型去搜一个它自己随后不认的位置。
  return isAncestorDirOf(targetPath, ctx.targetN);
};

/** 路径显示形态：有 cwd 则相对（提示里更短更可读），否则原样。 */
const relOf = (ctx: EvalCtx, targetPath: string): string =>
  ctx.cwd !== undefined && isInside(ctx.cwd, targetPath)
    ? path.relative(ctx.cwd, targetPath).split(path.sep).join("/")
    : targetPath;

/** 非空字符串读数：`undefined` / 空串 / 非字符串一律按"这一项没有"处理（cwd 只认非空串，
 *  空串解析出来的路径会把相对目标顶到根上，比缺失更危险）。 */
const nonEmptyStr = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** 会话**当前**的工作目录。
 *
 *  `SessionHeader.cwd` 从宿主 0.2.1-alpha.2 起只是**创建期**快照（官方注释
 *  "Absolute working directory the session was created in"，dsh-session types.ts:104-105；
 *  同文件 :533 把 header 整体定性为 detached creation metadata），活目录搬到了
 *  `ctx.workingDirectory`：宿主侧 bash 已改读它（tool-bash src/index.ts:487
 *  `await ctx.workingDirectory.ensure(exec.agent, exec.signal)`），换目录由
 *  `working_directory` 工具与该服务的 `set` 提交（src/index.ts:160-172）。
 *  于是"继续读 header.cwd"不是风格问题而是判据错位：会话 `cd` 之后，相对目标会被
 *  归一到**旧**目录，`<当前目录>/.ssh/config` 这枚密钥路径会按
 *  `<建会话目录>/.ssh/config` 去判——该拦的拦不住；反向也有，`presenceOf`/`realpathOf`
 *  会 stat 到另一条路径上，把没读过的文件当成已读或反之。
 *  取法次序：服务在场且给出非空串 ⇒ 用它；否则退回 `header.cwd`（没换过目录的会话
 *  两者同值，宿主没装那个 bundle 时这是唯一读数）。整趟 guard 调用只算一次（见
 *  `GuardRuntime.cwd`），上报侧另算的那次落在拒绝/通过这种低频路径上。 */
function effectiveCwdOf(svc: HostCtx, session: SessionLogFace | undefined): string | undefined {
  const raw: unknown = svc.get?.("workingDirectory");
  if (session === undefined || !isWorkingDirectory(raw)) {
    return nonEmptyStr(session?.header?.cwd);
  }
  return nonEmptyStr(raw.get?.(session)) ?? nonEmptyStr(session.header?.cwd);
}

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
  // 为 this → TypeError（quality-gate 的 host.ts 在 0.1.6 上有同款实证）。
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

/** 投递位次：读**当下**的会话事件数（投影优先、快照回落，与 guard 判定同一条读法）；
 *  读不到（两者皆不可得）时回落本轮 `evidenceFor` 已经算出的 `logSeq`——两者同源同值，
 *  而 `assembleGaps` 的比对正是拿它跟 `staleBase` 比。
 *  A 面不必等这条消息落进日志：additionalContexts 随本次结果一起被 loop 收下
 *  （`agent-loop/src/tool-calls.ts:157`「for the next step boundary」），位次取当刻即可。 */
const deliverySeqOf = (req: PreflightRequest, input: FactEvidenceInput): number =>
  ledgerRows(req.session, req.ledger)?.logSeq ?? input.logSeq;

/** 把这次覆盖到的层盖上投递位次（其余沿用旧值）。写成函数而不是 `Array#reduce` 累积展开：
 *  后者是本仓 lint 明令避免的形状（oxc/no-accumulating-spread），而这里要的只是"逐层赋值"。 */
function liftLayers(
  prev: Readonly<Partial<Record<LayerNeed, number>>>,
  layers: readonly LayerNeed[],
  seq: number,
): Partial<Record<LayerNeed, number>> {
  const next = { ...prev };
  for (const need of layers) {
    next[need] = seq;
  }
  return next;
}

/** 记一次投递：只抬自己那一格的位次，另一格沿用旧值（见 DeliveryWatermark 的拆位理由）。
 *  `patch` 里为 false 的那一项**不写**——投递失败绝不能把对方已挣到的位次清掉。 */
function noteDelivery(
  key: string,
  seq: number,
  patch: { read?: boolean; refs?: boolean; layers?: readonly LayerNeed[] },
): void {
  const prev = preflightDelivered.get(key) ?? NO_DELIVERY;
  const layers = patch.layers ?? [];
  lruPut(preflightDelivered, key, {
    readSeq: patch.read === true ? seq : prev.readSeq,
    refsSeq: patch.refs === true ? seq : prev.refsSeq,
    // 层位只抬不清：这一趟没覆盖的层沿用上一次投递到的位次（覆盖过就是覆盖过）。
    layerSeqs: liftLayers(prev.layerSeqs, layers, seq),
  });
}

/** 预检的投递水位读口（`会话id|目标`，与写侧共用 sessionTargetKeyOf）。
 *  两条路都要读它：台账可得时挂在 EvalCtx 的键上（`evidenceFor` 里那一格），
 *  台账**不可得**时（undeterminable 那条路）也要能读到——水位是插件自己的记录，
 *  不依赖会话日志，否则"预检补完 → guard 仍按不可判定缺项拒"就成了死循环。 */
function deliveredOf(
  session: SessionLogFace | undefined,
  target: string,
  cwd: string | undefined,
): DeliveryWatermark {
  return (
    preflightDelivered.get(sessionTargetKeyOf(session?.id, resolveTarget(target, cwd))) ??
    NO_DELIVERY
  );
}

/** 构造只读评估环境；会话不可得/两条读法都拿不到台账 → undefined（复用 undeterminable 保守输入）。
 *  `cwd` 由调用方（guard 回调经 `GuardRuntime.cwd`）传进来，不在这里现取：读时基线
 *  （`recordReadObservation`）与评估侧必须吃**同一枚**目录值，键形才逐字同源。 */
function buildEvalContext(
  session: SessionLogFace | undefined,
  target: string,
  gating: {
    cwd: string | undefined;
    refPolicy: RefSearchPolicy;
    messages: DangerGuardMessages;
    ledger: LedgerReader | undefined;
  },
): EvalCtx | undefined {
  let result: EvalCtx | undefined;
  const rows = session === undefined ? undefined : ledgerRows(session, gating.ledger);
  if (session !== undefined && rows !== undefined) {
    const { cwd } = gating;
    const norm = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? resolveTarget(value, cwd) : undefined;
    const targetN = resolveTarget(target, cwd);
    const base = path.basename(targetN);
    result = {
      ...rows,
      sessKey: sessionKeyPrefix(session.id),
      cwd,
      targetN,
      base,
      stems: buildStems(base),
      norm,
      refPolicy: gating.refPolicy,
      messages: gating.messages,
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
 *  四个字段**全部**从 shared 的 `ToolCallRecord`（`@jayyuen66/dsh-plugin-shared/lib/tool-events`）
 *  取形，本文件不再各自重述：
 *  - `callId` / `seq` 直接 `Pick`。台账键**故意不是**官方 `ToolCallId` / `SessionSeq`：
 *    shared 的 `usableCallId` 把空串归一为 `undefined`，空 callId 因此永远冒充不了一枚键
 *    （理由记在 shared 的 `usableCallId` 注释里）；`seq` 是**入参数组的切片下标**，shared 在
 *    `ToolCallRecord["seq"]` 的注释里明写它不是官方 `SessionSeq`（消费方按窗口切片读流，
 *    切片下标才是它们的游标语义）。
 *  - `name` 直接取 `ToolCallRecord["name"]`：shared 侧已收窄为必选 `string`（官方两个事件
 *    分支都这么声明，见 shared 的 `lib/tool-events.ts`）。原先这里得写 `NonNullable<>`、并在
 *    scanToolCalls 里先判一次 `call.name !== undefined`，只因为 shared 把一个从不做运行时
 *    校验的字段放成了可空——那道判空恒真，白白逼消费方多写一道。
 *  - `a` 即 `ToolCallRecord["arguments"]`（已解析的 `Record<string, unknown>`）。 */
type ToolCall = Pick<ToolCallRecord, "callId" | "seq"> & {
  name: ToolCallRecord["name"];
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
  return nonEmptyStr(candidate);
}

/**
 * read/view 的**读时基线**：外部改动检测靠 mtime 差分，差分需要一个先验观测点。评估侧
 * （evidenceFor）只在编辑判定时写基线 ⇒ 每个新会话对每个文件的**首次评估**存在盲区：
 * read 之后、首次编辑之前的外部改动没有任何可比基线，改动前的旧 read 直接过门
 * （三场景探针实测：无任何基线 ALLOW / 改动前有他会话基线 DENY / 改动后基线被他会话
 * 的评估刷掉 ALLOW）。guard 对 read/view 调用同样在跑（同步谓词，且 read 不可能被
 * 三条防线拒绝）——借这一步把基线前移到 read 时点：改动发生在 read 之后必被检出；
 * 常规路径（无外部改动）只多一次 statSync，判定零变化。非 read/view 的调用在此直接
 * 返回（写类与 bash 等其余工具的基线由编辑评估自己建立）。
 * 残余窗口（明记）：这里看到的是 **guard 时点**的 mtime，早于 read 真正执行——两刻之间
 * 的改动会被判"外部"（多要求一次重读），方向保守。门禁关闭（enabled=false）时不记账，
 * 与其余判定同口径；重开后首个 read 重建基线。
 *
 * **只暂存不提交**：guard 跑在执行之前，这一次读成不成此刻未知。直接把观测写进基线，
 * 一次失败/被拦的读就会把基线推到新版本，从而让下一次编辑判定看不出中间发生过外部改动
 * （探针实测：成功 read → 外部改 → 失败 read → 编辑放行）。提交点在 post-execute。
 */
function recordReadObservation(
  name: string,
  session: SessionLogFace | undefined,
  args: Record<string, unknown>,
  cwd: string | undefined,
): void {
  if (name !== "read" && !(name === "str_replace_editor" && args["command"] === "view")) {
    return;
  }
  const target = callPathOf(name, args);
  if (target === undefined) {
    return;
  }
  // 键形与评估侧（buildEvalContext）逐字同源：同一 cwd 归一、同一 sessKey 前缀，
  // 否则 read 时写的基线编辑评估时读不到。cwd 由 guard 回调那**同一趟**调用算好传来
  // （`GuardRuntime.cwd`），不在这里再读一遍会话面——两处各自现取，中间夹一次 `cd`
  // 就会把基线写到另一个键上。
  const targetN = resolveTarget(target, cwd);
  // 只**暂存**：这一趟还没执行，成功与否此刻未知（见 lib/read-basis.ts 的文件头第 2 条）。
  stageReadObservation(
    sessionTargetKeyOf(session?.id, targetN),
    presenceOf(targetN).mtimeMs,
    targetN,
  );
}

/** 提交/丢弃一次读取的暂存观测（`tools/post-execute` 报回真实成败之后才走到这里）。
 *  提交 = 基线落定并解除失效点；丢弃 = 两样都不动（没拿到的内容不能替后来者证明"看过"）。
 *  键形与暂存那一步**逐字同源**：两处的 cwd 都来自同一枚 `GuardRuntime.cwd`。 */
function settleReadOf(
  session: SessionLogFace | undefined,
  target: string,
  cwd: string | undefined,
  isError: boolean,
): void {
  const targetN = resolveTarget(target, cwd);
  const key = sessionTargetKeyOf(session?.id, targetN);
  if (isError) {
    discardReadObservation(key);
    return;
  }
  commitReadObservation(key, targetN, presenceOf(targetN).mtimeMs);
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
    if (!call.badArguments) {
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
  // 无 callId 的调用等不到成败回填：**状态未知**，不是成功。
  //
  // 这里曾经"按成功计"，方向是 fail-open：真宿主先 append tool/call 再 dispatch（见
  // agent-loop 的 appendToolCall），所以一条**还没执行**（或执行失败、被取消、被别的插件
  // block 掉）的调用在日志里长得和成功的一模一样。整条按成功收编，等于让"准备读"变成
  // "读过"——证据链上最不该失守的那一格。
  //
  // 反方向的代价（模型真读过却被判未取证）确实存在，但它的终点是**可见的**：门禁拒一次
  // 并把"从未 read"写进理由，模型照做一次带 callId 的读取就解开了。而 fail-open 的终点
  // 是一条静默放行的编辑。两者不对称，取保守那一侧。
  //
  // 无 ID 的**编辑**同样不收编：lastEditSeq 是外部改动归因的依据，把一条来路不明的调用
  // 算成"自己改的"，会让真正的外部改动被自证销账。
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
  /** 预检刚刚投递的证据水位（`会话id|目标` 命中时给出，否则 NO_DELIVERY）。
   *  由 evidenceFor 现读，不让下游自己去查表——缺项裁定与投递水位的键形必须同源。 */
  delivered: DeliveryWatermark;
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

/** read 侧裁定并落清单（判据与抽前逐字相同）：已满足的三种形态记 done —— 新建文件
 *  （无旧内容可 read）、**成功** read 晚于目标最近一次成功编辑（新鲜度）、或预检的 B 面
 *  刚把目标正文当场递给过模型（`delivered.readSeq` 晚于 `staleBase`——外部改动之后的投递
 *  才算数，与 read 自己那条新鲜度判据逐字同源）。
 *  缺项成因优先级：外部改动 > read 失败 > 从未 read。 */
function collectReadVerdict(input: GapInput, gaps: FactGap[], done: FactNeed[]): void {
  if (
    input.newFile ||
    input.readSeq > input.staleBase ||
    input.delivered.readSeq > input.staleBase
  ) {
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

/** refs 侧裁定并落清单（已满足 = 有过一次**成功**的名单内检索 `refsSeq ≥ 0`，或预检投递过
 *  一份**扫完了整趟遍历**的引用扫描——被预算截断的那种不给凭证，见 `RefScan.capped`）。
 *  引用面不由本文件内容决定，故预检那条也不参与新鲜度比对——
 *  与 read 那条**刻意不同源**，理由见 fact-gate.ts 第 1 条硬原则。
 *  成因优先级：窄落点未覆盖 > refs 失败 > 从未 refs；只有 narrow 带落点 hint。 */
function collectRefsVerdict(
  messages: DangerGuardMessages,
  input: GapInput,
  gaps: FactGap[],
  done: FactNeed[],
): void {
  if (input.refsSeq >= 0 || input.delivered.refsSeq >= 0) {
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
    // 模型自己搜过（layerSeq）或预检从同一次扫描派生过结论（layerSeqs）都算这项已补。
    if (input.layerSeq.has(layer.need) || (input.delivered.layerSeqs[layer.need] ?? -1) >= 0) {
      done.push(layer.need);
    } else {
      gaps.push({ need: layer.need, why: "never", hint: layerDirHint(ctx, layer.dir) });
    }
  }
}

/**
 * 引用面在这个目标上**不可能凑齐**吗——只在这一形下不再要求 refs：那是死锁，不是一条
 * 可执行的行动。
 *
 * 判据只覆盖死锁那一形：**名单里只剩严格口径**（pattern 工具不在本机，或名单被收得只剩
 * 它）**且目标落在会话工作区之外**。严格口径除签名外还要 `root`，而 root 的授权面归
 * zvec-grep——只接受本会话工作区之内的 root（实测工作区外的 root 当场被拒：
 * `root 未获授权 … 不在本会话可操作范围内`）。此时把这条路点出来，模型照着做也会被拒，
 * 缺项永远凑不齐。
 *
 * 名单**整条为空**不在这里：那一种由 host 侧的「无法记账」指令明说，并留着 deny 配额
 * 上限当出口（既有行为，不因本判据放宽）。
 * @param policy 生效的检索取证口径（已按 present 筛过名单）
 * @param cwd 会话工作区
 * @param targetN 目标绝对路径（已归一）
 * @returns refs 这一面是否已被判为不可凑齐
 */
function refsUnsatisfiable(
  policy: RefSearchPolicy,
  cwd: string | undefined,
  targetN: string,
): boolean {
  return (
    policy.patternTools.length === 0 &&
    policy.strictTools.length > 0 &&
    !(cwd !== undefined && isAncestorDirOf(cwd, targetN))
  );
}

/** 产出带成因的缺项清单（决策面：read/refs/逐层三面的裁定各在 `collectReadVerdict`/
 *  `collectRefsVerdict`/`collectLayerVerdicts` 里，本函数按抽前的 read → refs → 层顺序
 *  依次组装同一对清单）。 */
function assembleGaps(ctx: EvalCtx, input: GapInput): FactEvidenceInput {
  const gaps: FactGap[] = [];
  const done: FactNeed[] = [];
  collectReadVerdict(input, gaps, done);
  if (input.tier !== "low" && !refsUnsatisfiable(ctx.refPolicy, ctx.cwd, ctx.targetN)) {
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
    externalChangeSeq: input.staleBase,
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
 *  - 路径按会话 cwd 归一化后比较（resolve——模型常报相对路径）。
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
    /** 会话当前工作目录（guard 每次调用算一次，见 `effectiveCwdOf`）。 */
    cwd: string | undefined;
    refPolicy: RefSearchPolicy;
    messages: DangerGuardMessages;
    /** 台账读口（注册表缺席时为 undefined ⇒ 走回退扫描；见 lib/tool-ledger.ts）。 */
    ledger: LedgerReader | undefined;
  },
): FactEvidenceInput {
  const ctx = buildEvalContext(session, target, gating);
  if (ctx === undefined) {
    // 台账不可得 ≠ 什么都没做过：预检的水位是插件本地记录，这一支也要剔除（见 undeterminable）。
    return undeterminable(deliveredOf(session, target, gating.cwd));
  }
  // fs：存在性（三态，见 presenceOf）+ 外部改动检测
  const { presence, mtimeMs } = presenceOf(ctx.targetN);
  // 键形单源在 sessionTargetKeyOf（与 `ctx.sessKey` 同源同值：buildEvalContext 那侧就是
  // 用它拼的）。预检的投递水位与上面两张台账**同键**（`会话id|目标`）：键形一旦不同源，
  // 预检写下的水位就在评估侧读不到——静默退回"仍缺项"，整趟预检白做。
  const lenKey = sessionTargetKeyOf(session?.id, ctx.targetN);
  const delivered = preflightDelivered.get(lenKey) ?? NO_DELIVERY;
  // ⚠ 取观测基线会**写下本次观测**：那只表示"这次看见了这一版"，不表示"这一版下的证据
  // 已经作废或已补上"——后者是 staleBase 的事（见 lib/read-basis.ts 的文件头第 1、3 条）。
  const observed = observeVersion(lenKey, ctx.targetN, mtimeMs);
  const { mtimeJump } = observed;
  // 外部改动的水位取**真实事件下标**（不是 evs.length）：用长度会让任何 read 都显得更早，
  // 从而在 mtime 跳变后死锁。这里用"本会话上次评估时的日志长度"当作那次改动的位置。
  // 本会话没有历史位时保守取当前末尾：本轮判"需重读"，重读后下一轮凭更大下标通过——
  // 自愈，代价最多一次重读。**旧写法 ?? -1 是 fail-open**（完全漏判）。
  const jumpSeq = seenLenBySessionPath.get(lenKey) ?? ctx.logSeq;
  lruPut(seenLenBySessionPath, lenKey, ctx.logSeq);
  // 波及面层（机械半轨）：fs 探测该文件所属包链上**实际存在**的层。
  // 不存在的层直接豁免——不必让模型去 grep 空目录自证"这里没有测试"。
  const projectRoot = projectRootOf(ctx.targetN, ctx.cwd);
  const layers = existingLayersOf(ctx.targetN, projectRoot, gating.extraTestDirs);
  const ledger = scanToolCalls(ctx, layers);
  const resolved = resolveResultLedger(ctx, ledger);

  // 归因（"这一版是谁改的"）整条判据在 lib/read-basis.ts：内容自证只对**本轮** mtime 跳变
  // 有效，已落定的失效点不因"我写过"而销账（它问的是"我读过没有"）。
  const written =
    resolved.lastEditKey === undefined ? undefined : ledger.editTexts.get(resolved.lastEditKey);
  const selfTextPresent =
    written === undefined || written.length === 0
      ? undefined
      : selfWritesStillPresent(ctx.targetN, written);
  const { externallyChanged, staleBase } = attributeExternalChange({
    lastEditSeq: resolved.lastEditSeq,
    selfTextPresent,
    mtimeJump,
    pendingStaleBase: observed.staleBase,
    jumpSeq,
  });
  // 观测到的版本与"这一版还欠不欠一次重读"写回**同一条记录**：下一次评估读的就是它，
  // 淘汰与会话回收也按它整条走（见 lib/read-basis.ts 的文件头第 1 条）。
  settleVersion(lenKey, mtimeMs, staleBase);
  // 新建豁免：目标**确凿不存在**（ENOENT）**且**本次调用有能力创建它（write/create）。
  // 两个条件都不能少：① 对已存在文件执行 write 是全量覆盖，恰恰最需要先 read（否则会
  // 无声清掉没看过的内容）；② presence 为 "unknown"（EACCES/ENOTDIR/ELOOP，或会话目录
  // 缺失时相对路径按进程 cwd 解析）不等于"新文件"——把读不到的文件当新的，
  // 等于让权限问题替模型免掉 read，是这道豁免最不该失守的方向。
  const newFile = presence === "absent" && creatable;
  // 档位：缺省一律 **high**——缺信息要更多取证，不要更少。
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
    delivered,
  });
}

/** 一次 bash 危险判定的产出：命中的规则键 + **被判定的那条命令**（上报与判定同一个值，
 *  不让上报侧再解析一次参数——两处解析就会漂移，且 `key` 有值时命令必是字符串，
 *  上报侧再写一次 `typeof === "string"` 兜底就是一道永远测不到的死分支）。
 *  规则键有两种性质：命中危险模式（拦）与 `-c` 体未被检查（需用户确认），
 *  调用方按键把后者标进 `evidence.needsUserConfirmation`（签名两者一律用命令原文）。 */
interface BashDenial extends Omit<BashVerdict, "fix"> {
  command: string;
  /** 形状见 lib/fix.ts。本条**必选但可为 undefined**（省掉调用点的条件展开）；渲染在
   *  host 侧按当次语言进行，lib 那边是语言无关的。 */
  fix: BashVerdict["fix"];
}

/** 一次判定的产出：结论（undefined = 放行）+ 这轮判定的成本样本（耗时/输入规模）。
 *  样本与结论分开带：放行也要有耗时，否则"长度上限该不该调"永远只有被拦的样本。 */
interface BashJudge {
  denial: BashDenial | undefined;
  cost: JudgeCost;
}

/** 密钥面的同形产出（结论是一句当前语言的拒绝理由，不是规则键）。 */
interface SecretJudge {
  reason: string | undefined;
  cost: JudgeCost;
}

/** `fs.realpathSync` 的"解析不了就没有这一形"包装：ENOENT/EACCES/循环链接都只表示解析不出来。 */
function tryRealpath(absolute: string): string | undefined {
  let result: string | undefined;
  try {
    result = realpathSync(absolute);
  } catch {
    result = undefined;
  }
  return result;
}

/**
 * 目标的**真实路径**：整条解析失败时（新建文件是常态，realpath 在目标不存在时必 ENOENT）
 * 退到最深存在的祖先目录，再把剩余段接回去——于是「项目根是指向别处的软链」与
 * 「`~/.ssh/authorized_keys` 是指向别处的符号链接」都能露形。
 * 一段都解析不出来 ⇒ undefined：缺席这一形只是没看到软链面，声明形照判（不是放行）。
 * 深度由路径段数给出（每轮至少去掉一段），循环必然终止。
 */
function realpathOf(target: string, cwd: string | undefined): string | undefined {
  const missing: string[] = [];
  let current = path.resolve(cwd ?? process.cwd(), target);
  let result: string | undefined;
  // 终止条件必须是"已经到根"，**不能**用 `current.length > 1`：那假设根的长度是 1，
  // 而 Windows 的盘根是 `C:\`（长度 3）⇒ 循环会多走一轮，对盘根做 realpath 并把
  // 虚构路径拼成一个「看起来存在」的结果。实测后果：一条"祖先全不存在 ⇒ 不该有解析形"
  // 的用例在 Windows runner 上拿到了 `D:\w\proj\.ssh\id_rsa`（POSIX 上是 undefined）。
  while (result === undefined && current !== path.dirname(current)) {
    const real = tryRealpath(current);
    if (real === undefined) {
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    } else {
      result = path.join(real, ...missing);
    }
  }
  return result;
}

/** bash 危险命令闸（git 绕过 / rm -rf / curl|sh / dev server）；非 bash/pwsh 或无危险 ⇒
 *  `denial` 为 undefined。shell 方言按**工具身份**给：`pwsh` 调用点知道这段源由 PowerShell 读，
 *  于是 Windows 字形轨道在该调用点参与判定（POSIX 宿主上跑 PowerShell Core 时 `os.platform()`
 *  不是 win32，而 `Remove-Item -Recurse -Force C:\Windows` 删的确实是那个树）。`bash` 调用点
 *  保持 POSIX 读法，「非 Windows 宿主上轨道退出」的结论一字不动 —— 方言不从字形反推，
 *  猜字形就是此前 over-block 的来源。 */
function bashJudgeOf(
  name: string,
  args: Record<string, unknown>,
  opts: BashDangerOptions | undefined,
  severityOf: (verdict: BashVerdict) => RuleVerdict,
): BashJudge {
  let denial: BashDenial | undefined;
  // 非 bash/pwsh 的调用在这一面没有判定发生 ⇒ 零长度样本（采样处据此不发）。
  const cost: JudgeCost = { face: "bash", ms: 0, length: 0 };
  const startedAt = performance.now();
  // **调用点入口**（工具名 + 参数 + 配置）：方言、命令原文读取、后台执行的让路
  // 都在 lib 那一层收好了（见 `bashVerdictOf`）—— guard 与需确认档走同一个入口，
  // 于是"guard 拦得住、审批看不见"（或反过来）那种漂在结构上不成立。
  const hit = bashVerdictOf(name, args, { ...opts, severityOf });
  if (hit !== undefined) {
    cost.ms = performance.now() - startedAt;
    cost.length = hit.command.length;
    denial = { command: hit.command, key: hit.verdict.key, fix: hit.verdict.fix };
  }
  return { denial, cost };
}

/** 事实门单次判定的产出（由 guard 回调翻译成 return/report）。 */
type FactGateOutcome =
  | { kind: "pass"; target: string; quota?: boolean }
  | { kind: "indeterminate"; target: string }
  | { kind: "deny"; target: string; tier: FactTier; denial: FactDenial };

/**
 * 读这次调用的档位事实（判据与缺席口径全在 `lib/policy-facts.ts` 的文件头）。
 *
 * 本文件只负责把宿主的三样东西送进去：可选服务读法、会话、以及沙箱模式的读法
 * （`sandboxModeOf` —— lib 侧的 `policy-facts` 不 import `node:fs`，模式读法由这里注入）。
 */
function policyFactsOf(
  svc: HostCtx,
  session: SessionLogFace | undefined,
  sandboxCovers: boolean,
): PolicyFacts {
  return policyFactsOfIn({
    get: (name) => svc.get?.(name),
    session,
    sandboxCovers,
    sandboxMode: sandboxModeOf,
  });
}

/** 一次 guard 评估的运行时输入：settings 运行时值 + **当前语言的文案表**。
 * 两个都由 guard 回调现取（用户改了设置卡/切了语言，下一次调用即生效），
 * 下游判定链因此既不读设置也不自带某一种语言。合成一个对象也是为守住 max-params=5。
 */
interface GuardRuntime {
  cfg: Config;
  messages: DangerGuardMessages;
  /** 会话**当前**工作目录（每趟 guard 调用算一次，口径见 `effectiveCwdOf`）。
   *  放在这里而不是各判定点现取：相对目标归一化、密钥面 realpath、事实门台账键形
   *  三处必须吃同一枚值，否则 read 时记的基线与编辑时算的键会错开。 */
  cwd: string | undefined;
  /** 投影台账读口的装箱：`ctx.sessionProjections` 到位时由 inject 回调装上，
   *  缺席/迟到 ⇒ undefined ⇒ 每次判定走回退扫描（迁移前行为）。装箱而不是直接字段：
   *  rt 每次 guard 调用现构造（cfg/messages 都要现读），读口只在 apply 期装一次。 */
  ledger: { value: LedgerReader | undefined };
  /** 检索工具名的在位探测（apply 期由 `toolPresentOf(svc.tools)` 造一次，随 rt 每趟带上）。 */
  present: ToolPresent;
}

/** 宿主 **stock 目录**里的检索工具名（`docs/tool-catalog.md` + `packages/fs/tool-fs-search`）。
 *  它们随宿主出厂，不因插件装配而缺席，故**免探**。探测口是给「逐台不同的插件工具」准备的
 *  （典型：`zg_search` 归 @jayyuen66/dsh-zvec-grep，装不装逐台不同）。
 *
 *  为什么必须免探（实测缺陷）：探测面在有的部署下看不见原生工具——program 模式下
 *  `ctx.tools.get("grep")` 返回 undefined。把 stock 名字也丢给它筛，grep/glob 会被整体摘掉，
 *  于是引用证据只剩严格口径：门禁被窄化成「必须 zg_search」，而目标落在会话工作区之外时
 *  严格口径的 root 又不被授权 ⇒ 缺项永远凑不齐（死锁）。
 *  代价方向与 `toolPresentOf` 的注释一致：多点名一个名字只是白烧一次调用。 */
const STOCK_SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "glob"]);
/**
 * 生效的「检索工具名 → 引用取证判据」映射（记账与拒绝指令共用这一份）。
 * 与 extraTestDirs 那类"空数组=没追加"的字段**不同**，这里的空数组是用户的显式选择：
 *  - 值缺失/非数组（降级注册后持久段未经 schema 校验）→ 回落内置默认名单；
 *  - 显式 `[]` → 任何检索都不计入引用取证（凭证面只收紧不放宽；配额上限仍是防死锁出口）。
 * `present` 只筛**名单**、不筛判据：没注册的工具本来就被调用不到，筛与不筛对记账同解；
 * 而它决定模型在拒绝理由里看到几个可走的路，所以这里必须筛（见 `toolPresentOf`）。
 */
const refPolicyOf = (cfg: Config, present: ToolPresent): RefSearchPolicy => {
  const names = strArray(cfg.refSearchTools) ?? DEFAULT_REF_SEARCH_TOOLS;
  const strict = strArray(cfg.refSearchStrictTools) ?? DEFAULT_REF_SEARCH_STRICT_TOOLS;
  return refSearchPolicyOf(
    names.filter((name) => STOCK_SEARCH_TOOLS.has(name) || present(name)),
    strict,
  );
};

/**
 * 取证认定链的读数面：现读的设置、当次语言、当次目录、台账读口。
 * **两个入口共用它**——guard 回调（经 `readingsOf` 从 `GuardRuntime` 取）与预检
 * （pre-execute 里现构），于是"门禁会看到哪些缺项"与"预检补了哪些缺项"不可能不一致。
 */
interface EvidenceReadings {
  readonly cfg: Config;
  readonly messages: DangerGuardMessages;
  readonly cwd: string | undefined;
  readonly ledger: LedgerReader | undefined;
  /** 检索工具名在不在宿主上（指令点名用，见 `toolPresentOf`）。 */
  readonly present: ToolPresent;
}

/** 从 guard 调用的运行时面取读数（`ledger` 那格从装箱里现读，见 GuardRuntime.ledger）。 */
const readingsOf = (rt: GuardRuntime): EvidenceReadings => ({
  cfg: rt.cfg,
  messages: rt.messages,
  cwd: rt.cwd,
  ledger: rt.ledger.value,
  present: rt.present,
});

/** 一次认定链的查询面：哪次调用、改哪枚目标、在哪个会话里。 */
interface FactEvidenceQuery {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly session: SessionLogFace | undefined;
  /** 只有一种场合用：预检的 A 面（读检视）此刻**还没有**写参数，无从按写面风险定档，
   *  只能按"要 refs 的最低必要档"（mid）问一次——按 high 问会顺带要层证据（那不是 A 面的
   *  职责，也答不出证据），按 low 问则根本没有 refs 这项要求。
   *  guard 与预检的 B 面都不传这一位，档位照旧由 `tierOf` 现算。
   *  收在查询对象里而不是函数末位可选参：本函数连同读法面已经是五位上限（max-params），
   *  再塞一位就越线；把"查什么"装箱成一位也让三个入口的调用形状一致。 */
  readonly tierOverride?: FactTier;
}

/**
 * 用户追加的测试层目录名（值面由条目的 Config schema 保证，但降级读取保留——闸门不能因为
 * 宿主给来的形状变化而抛在判定链里）。
 * 收成一处不是省事：门禁算缺项与预检派生层结论**必须**吃同一份词表，两边各写一遍
 * `strArray(...) ?? []` 时，任何一侧改了读法就会让"门禁要一层、预检查不到那层"变成死结
 * （预检永远让路，模型永远拿不到层证据）。
 */
const extraTestDirsOf = (cfg: Config): string[] => strArray(cfg.extraTestDirs) ?? [];

/**
 * 一次调用的档位与取证缺项：同步判定（`evaluateFactGate`）与预检的两个触发点走**同一条**
 * 认定链，三个入口因此不可能看到不同的缺项、预检也就不会"补错项"。
 * 缺信息一律升档（`tierOf`）、层目录一律现探（`existingLayersOf`）：两条口径都不在这里重述。
 */
function factEvidenceOf(
  readings: EvidenceReadings,
  query: FactEvidenceQuery,
): { tier: FactTier; input: FactEvidenceInput } {
  const { name, args, target, session, tierOverride } = query;
  // 风险事实：creatable（新建豁免 read）、riskyPath、sigChanged、写面大小。
  const facts = riskFactsOf(name, args, target);
  const tier =
    tierOverride ??
    tierOf({
      ...facts,
      strictMode: readings.cfg.strictMode,
      smallChars: numOf(readings.cfg.smallEditChars, DEFAULT_SMALL_EDIT_CHARS),
      bigChars: numOf(readings.cfg.bigEditChars, DEFAULT_BIG_EDIT_CHARS),
    });
  const input = evidenceFor(session, target, facts.creatable, {
    tier,
    extraTestDirs: extraTestDirsOf(readings.cfg),
    cwd: readings.cwd,
    refPolicy: refPolicyOf(readings.cfg, readings.present),
    messages: readings.messages,
    ledger: readings.ledger,
  });
  return { tier, input };
}

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
    // 状态键与证据键同源（归一化目标）；档位与缺项由同一条认定链现算。
    const { tier, input } = factEvidenceOf(readingsOf(rt), { name, args, target, session });
    // maxDenies 取 settings 运行时值；numOf 保证非法/0 回落内置默认（0 等于关掉事实门）。
    const decision = factGate.check(
      name,
      resolveTarget(target, rt.cwd),
      session?.id,
      input,
      numOf(cfg.maxDenies, DEFAULT_MAX_DENIES),
    );
    if (decision.kind === "allow" || decision.kind === "quota") {
      // 连续无证据拒绝达上限 → 配额放行警示（配额放行不算"遵守规则"，不报 pass）
      if (decision.kind === "quota") {
        noteQuotaRelease();
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

/** 密钥面判定所需的**入参组装**（扩展词表 + 会话 cwd + realpath 解析形 + 参与判定的目标清单）。
 *  单源这一枚的原因不是省事：guard 的密钥闸与预检的 B 面必须对同一枚目标给出同一个"会不会
 *  被拦"的答案——两处各自组装迟早会漂，漂了就是预检抢在密钥闸前面把拒绝理由换成"请重试"，
 *  等于替那道闸做决定（顺序依据：官方 `prepareExecution` 只在瀑布放行后才走 `guardReason`）。
 *  返回 `undefined` = 这次调用没有任何声明形目标（密钥闸不会判它）。
 *  相对目标按会话 cwd 解析（与事实门用的 `resolveTarget` 同源）：模型给 `.ssh/config` 这种
 *  相对路径时，判据要看到它落地后的样子，而不是只判输入字符串的字面形状。cwd 由调用方送
 *  进来（guard 每趟调用算一次的当前工作目录，见 `effectiveCwdOf`）——本函数与事实门因此共用
 *  同一枚目录基准，不会一个跟到 `cd` 之后、一个停在创建时。
 *  目标由**键形**认（`declaredTargets`），不按工具名认——代价与理由写在
 *  lib/danger-rules.ts 的 TARGET_PATH_KEYS 注释与 README「已知边界」里。 */
/** 密钥面判定的入参面：`resolvedPaths` 在这一枚类型里是**必选**——`secretOptsOf` 必然装上它，
 *  于是读侧（判定与上报）不必再写一遍 `?.`：那会养出一条永远走不到的分支，而本包的覆盖率
 *  阈值是 100%（测不到的分支就是可读性与覆盖率的双份负债）。 */
type SecretFaceOpts = EditDangerOptions & {
  resolvedPaths: Readonly<Record<string, readonly string[]>>;
};

function secretOptsOf(
  args: Record<string, unknown>,
  cfg: Config,
  cwd: string | undefined,
): { targets: readonly string[]; opts: SecretFaceOpts } | undefined {
  const targets = declaredTargets(args);
  // 密钥词表在这里现读：strArray 兜住未经 schema 校验的值面，与调用点那两处同一口径。
  const secretPatterns = strArray(cfg.extraSecretPatterns);
  return targets.length === 0
    ? undefined
    : {
        targets,
        opts: {
          ...(secretPatterns === undefined ? {} : { extraSecretPatterns: secretPatterns }),
          ...(cwd === undefined ? {} : { cwd }),
          // 解析形只在真要判目标时才取（每枚目标至多两形：本机 realpath + 官方后端那一形，
          // 热路径上没有无谓 I/O——官方那一形读的是缓存，写它的 I/O 在预检与 fs/observed 那两处）。
          resolvedPaths: resolvedFormsOf(targets, cwd, realpathOf),
        },
      };
}

/** 这一次调用会不会被密钥/凭据面拦下来（预检的 B 面据此整趟让路）。
 *  与密钥闸同一条谓词（lib 的 `editDanger`），只差没把结论渲染成文案。 */
function secretFaceWouldDeny(
  args: Record<string, unknown>,
  cfg: Config,
  cwd: string | undefined,
): boolean {
  const built = secretOptsOf(args, cfg, cwd);
  return built !== undefined && editDanger(args, built.opts) !== undefined;
}

// ══ 预检（Phase 2）══════════════════════════════════════════════════════════════
// 取代"先拒绝、再让模型自己去补证"的 block-then-prompt。"前置"在这里有**两个面**，
// 各挂一条官方瀑布，分工按"证据在什么时刻才真的算被看见"来定，不是按方便定：
//   A) 只读检视（read / view / str_replace_editor view）挂 `tools/post-execute`：
//      门禁要的引用面（谁 import/引用这个文件）随**这次读取的结果**一起交出去
//      （官方 `PostToolDecision.accept{additionalContexts}`，agent-loop 在 commit 那条
//      结果时收下、排到下一个 step 边界）。模型读文件的那一刻就看见"它被谁引用"，
//      于是它下一次动手编辑时证据已经在上下文里——这是真前置。
//   B) 写类调用（edit / write / str_replace_editor 的写动词）挂 `tools/pre-execute`：
//      模型**没读就改**（read 缺项）时，当场取到的目标正文与引用面写进这一次的拒绝理由，
//      模型在**这一次调用**的结果里就看到事实，原样重试即凭水位放行。物理停止仍在
//      dispatch 之前，所以"改之前先看清它"这条不变式一个字没让。
// 为什么不是"注入一条消息"（本节的旧形态）：官方 `Agent.inject()` 把消息排在 **next
// pre-step**，而模型的上下文按 step 推进——它在第 N 步决定这次编辑，只能看见第 N-1 步
// 为止的内容。pre-execute 注入的证据因此是**编辑生效之后**才读到的，那叫事后补证；
// inject 还明说排队可能被取消/丢弃，水位却已经把它记成"补过了"。两个面都改走
// "结果/拒绝理由"这两条**必然落地**的通道，水位因此不再欠一次赌注。
// 三条硬边界（任一不成立就整趟跳过，退回今天的拒绝路径）：
//   · 绝不抢别人的决定：两条瀑布都先 `await next()`，下游已 deny/cancel/ask 就原样交回；
//     B 面还额外让路给密钥闸与配额放行态（它若不让，就等于替那两道做决定，见其函数注释）。
//   · 绝不无界：扫描有文件数/目录数/单文件字节/命中数四道上限，读取**定长**；取消信号与
//     墙钟上限合流（平台不会放弃挂起的 pre-execute promise，没有期限的一次卡死会挂掉
//     整次工具调用）。墙钟到点的那一趟进负缓存，于是这份成本只付一次。
//   · 绝不只看一半：扫描没跑成（取消/超时）整趟作罢；被预算**截断**的扫描可以说，但不能
//     当凭证——"扫过一部分"不顶替"探过引用面"（见 RefScan.capped）。

/** 预检用到的调用方 agent 面：**只剩会话这一位**。
 *  ⚠ 这里曾有第二位 `inject`（官方 `Agent.inject(message: UserMessage): void`，installed
 *  dsh-agent/lib/types/runtime-types.d.ts:241）——撤掉的理由写在上面那一段"为什么不是注入"。
 *  仍是同一条例：`@deepseek-ai/dsh-agent` **不是本仓依赖**（dsh-tools 的声明 import 它，
 *  `skipLibCheck` 下解析不到就退化成 any），直接把 `OfficialAgent` 搬进来会让每一次成员访问
 *  都撞 lint 的 no-unsafe-* 家族，所以这一位只按**形状**收。 */
interface PreflightAgent {
  readonly session: SessionLogFace;
}

/** 调用方 agent 的形状守卫（象限判据，与 isSettingsReader / isLessonLoopReporter 同款，
 *  不经任何类型断言）：`session` 是记录才认。会话不可得（或这一位根本不是 agent）时预检
 *  整趟跳过——**这正是硬要求里"exec.agent/session 不可用时跳过"那条**（官方声明说 agent
 *  可选、session 必选，但那说的是宿主自己 new 出来的对象；跨边界送来的形状只能运行时判）。 */
function isPreflightAgent(value: unknown): value is PreflightAgent {
  return isRecord(value) && isRecord(value["session"]);
}

/** 预检的运行面：`GuardRuntime` 的四位现读值（与 guard 回调同一份）+ 执行面 + 会话 + 闸门。 */
interface PreflightRequest extends EvidenceReadings {
  /** 待执行调用（官方 `ToolExecution` 的三位投影：名字、参数、调用方取消信号）。
   *  不复用 `GuardExecution`：那是 guard 谓词的读法投影（无 signal），而预检必须绑取消信号。 */
  readonly exec: Pick<ToolExecution, "name" | "arguments" | "signal">;
  /** 调用方会话（已过 `isPreflightAgent` 的那一位里取出来的）。 */
  readonly session: SessionLogFace;
  /** 状态机本体：B 面要先问一句"这目标是不是已经配额放行了"（只读，不改状态）。 */
  readonly gate: FactGate;
  /** 宿主 fs 面（由工厂保证到位：缺席时整趟就不会装配出请求）。 */
  readonly fs: PreflightFs;
}

/** 宿主 fs 面的装箱（与 `GuardRuntime["ledger"]` 同一手法：可选服务由 inject 回调装上，
 *  工厂每趟现读，所以晚到的后端也能被下一趟看见）。 */
interface PreflightFsBox {
  value: PreflightFs | undefined;
}

/** 预检请求工厂的装配面：一次 apply 要现读的东西全在这（六枚位置参会顶破 max-params，
 *  而且它们本来就是一件事——"这一代插件实例的读数口集合"）。 */
interface PreflightWiring {
  readonly svc: HostCtx;
  readonly gate: FactGate;
  readonly ledgerBox: GuardRuntime["ledger"];
  readonly messages: () => DangerGuardMessages;
  readonly present: ToolPresent;
  readonly fsBox: PreflightFsBox;
}

/** 预检的取消信号 = 调用方信号 ⊕ 墙钟上限。两者合流而不是取其一：`exec.signal` 让用户取消
 *  立刻落地，`AbortSignal.timeout` 让"没人取消但扫描卡住了"也有终点；两个来源经同一枚
 *  `signal.aborted` 出口被读到，所以每一趟读之前只判一次。
 *
 *  ⚠ 调用方信号**收 `undefined`**：官方 `ToolExecution` 把它标为必填，但本包的读取一律按
 *  **形状**收（守卫纪律），而这里不宽容的代价特别大 —— 它抛在 `confirmFactory` 里、**不在**
 *  任何 try 之内，于是"宿主送来一枚没带 signal 的执行面"会变成"整次工具调用成异常"。
 *  一句可选的测量读数不该有那个权力。缺席时只留墙钟。 */
const preflightSignalOf = (caller: AbortSignal | undefined): AbortSignal =>
  caller === undefined
    ? AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS)
    : AbortSignal.any([caller, AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS)]);

/** 只读检视面：`read` / `view`，以及并存编辑器 `str_replace_editor` 的 view 动词。
 *  与 `recordReadObservation` 认的读面刻意不同源：那里只管读时基线，这里还多认 `view`
 *  这个独立工具名（dsh 两套编辑器并存）。 */
const isInspectCall = (name: string, args: Record<string, unknown>): boolean =>
  name === "read" ||
  name === "view" ||
  (name === "str_replace_editor" && args["command"] === "view");

/** 两个触发点共用的前置筛查：三个开关、有没有目标、文档扩展名（门禁自己也不判的那一枚，
 *  同源导出见 lib/fact-gate.ts）。命中任何一条就整趟不参与。 */
const preflightSkipped = (cfg: Config, target: string | undefined): boolean =>
  !cfg.enabled ||
  !cfg.factGateEnabled ||
  !cfg.preflightEnabled ||
  target === undefined ||
  SKIP_EXT_RE.test(target);

/** 目标文件名与它足够长的词干（与门禁记账的 `sigHitsOf` 同一条口径：全名命中，或任一词干
 *  ≥ MIN_STEM 命中——否则 `ab.ts` 这类短词干会让 `grab.ts` 到处顶包）。 */
const refNeedlesOf = (base: string): string[] => [
  base,
  ...buildStems(base).filter((stem) => stem.length >= MIN_STEM),
];

/**
 * 扫描侧的凭据面隔离判据：与密钥闸**同一把词表**（`lib/danger-rules.ts` 的 `isSecretPath`），
 * 只问"这枚路径像不像凭据"。为什么扫描也要问一遍：一条引用命中会把那一行**原文**抄进模型
 * 上下文，而"凭据正文不外泄"正是本包存在的理由之一——编辑面上拦得住、扫描面上抄出去，等于
 * 自己给自己开了个洞。纯词法判定、不碰 fs（扫到谁判谁），所以它不可能被"文件读不到"带偏。
 * 这里**不传 cwd**：送进来的每一枚扫描路径都是绝对形，`cwd` 只服务于"模型给的相对目标"那一面
 * （isSecretPath 的相对补形对绝对路径是恒等），传它等于多养一条永远走不到的分支。
 */
const scanQuarantineOf = (cfg: Config): ((file: string) => boolean) => {
  const extra = strArray(cfg.extraSecretPatterns);
  const opts: EditDangerOptions = extra === undefined ? {} : { extraSecretPatterns: extra };
  return (file: string): boolean => isSecretPath(file, opts);
};

/**
 * 目标的版本位（后端给的 opaque token，本包不解析也不比较内容，只判"变没变"）。
 * `undefined` 把"目标缺席"与"探不到"并成一档：两者都意味着下一次还要重新问一遍，
 * 而不是拿旧结果充数。
 * `resolved` = 调用方（预检 B 面）已经 resolve 过的同一枚 target；给了就不再问一次身份
 *（远端后端上那是一次往返）。缺席时按旧路径自己解一次，失败仍只落进下面那个 catch。
 */
async function targetVersionOf(
  fs: PreflightFs,
  targetN: string,
  signal: AbortSignal,
  resolved?: FsTarget,
): Promise<FsVersion | undefined> {
  let version: FsVersion | undefined;
  try {
    // 调用方给过身份就不再问一次（复用规则与"为什么不用 `??`"都写在 targetOrResolveOf 上）。
    const target = await targetOrResolveOf(fs, targetN, signal, resolved);
    const info = await fs.stat(target, signal);
    version = info?.version;
  } catch {
    // 与 readTargetContent 同一条纪律：任何失败都只表示"这一趟探不到"，不写错误码白名单
    // （覆盖率 100% 的门禁下，按码分支必然留下一条永远走不到的支路）。
  }
  return version;
}

/**
 * 引用扫描（两个触发点共用）：同会话同目标、且目标版本未变时吃缓存，否则现扫并回填。
 * 只有**跑成的**那一趟进缓存（被预算截断的也算跑成，完成度位随结果一起存）；取消/墙钟
 * 掐断的一趟不进——缓存它等于把一次取消扩散成后续所有读取的降级。
 * `resolved` 透传给版本探针；扫描起点是**根**而不是目标，那一枚身份仍需现解（一次即可）。
 */
async function refScanOf(
  req: PreflightRequest,
  targetN: string,
  signal: AbortSignal,
  resolved?: FsTarget,
): Promise<RefScan | undefined> {
  const key = sessionTargetKeyOf(req.session.id, targetN);
  // 失效判据用后端给的 version（opaque），而不是宿主侧 mtime：后者正是"本地盘就是执行世界"
  // 那层假定的一部分——远程后端下它要么探不到、要么探到的是**另一份**同名文件的时间。
  const version = await targetVersionOf(req.fs, targetN, signal, resolved);
  const cached = preflightScans.get(key);
  // 判"命中"必须同时确认三件事：条目在、**这一趟探到了版本**、且与缓存版本相同。
  //  `undefined === undefined` 在版本位上是**会成立**的（目标缺席、后端拒绝、探针抛错时
  //  两侧都是 undefined）——把"都不知道是哪一版"当成"版本没变"，就是让一份无法自证新旧的
  //  扫描结果冒充可复用。探不到就重扫：代价是一次多余扫描，方向保守。
  if (cached !== undefined && version !== undefined && cached.version === version) {
    return cached.scan;
  }
  // root 与 needles 都在**这一侧**算（理由见文件头那条 import 注释）。
  const scan = await scanReferences({
    targetN,
    root: projectRootOf(targetN, req.cwd),
    needles: refNeedlesOf(path.basename(targetN)),
    signal,
    isQuarantined: scanQuarantineOf(req.cfg),
    fs: req.fs,
  });
  // **只缓存跑成的那一趟**（含被预算截断的那种，`complete` 位随结果一起进缓存）。
  // 取消/墙钟掐断的一趟不缓存：那是罕见形状（单枚 syscall 卡住，或调用方整体取消），
  // 缓存它等于把一次取消扩散成后续所有读取的降级。
  // 大仓里"扫不完"的常态走的是**预算截断**而不是墙钟——256 个文件 / 256 层目录的预算
  // 会先命中，于是它很快就带 `complete: false` 返回并被缓存，墙钟只是最后一道保险。
  if (scan !== undefined) {
    lruPut(preflightScans, key, { scan, version });
  }
  return scan;
}

/** 这份扫描能不能当 refs 的凭证。
 *
 *  **判据是"遍历没被截断"或"找到了引用"** —— 后者是这次修的第二个点：门禁认可模型自己
 *  那次**作用域正确**的检索当凭证，而那次检索**也不是穷尽的**（它有自己的结果上限与截断）。
 *  要求我们这趟扫描穷尽，比门禁自己对模型的标准还严，而代价落在最需要预检的大仓上：
 *  那里遍历必然被预算截断 ⇒ 凭证永远给不出 ⇒ 预检白做。
 *
 *  为什么"零命中 + 被截断"仍然不给凭证：**假阴性**全部住在那一种里 —— 半份"没有引用者"
 *  会让模型删掉一个仍有引用者的文件，那比不给证据更糟（文案那条"已扫范围内零命中"正是
 *  为它准备的）。而找到了引用就是**实证**：模型已经看见了"谁在用"，凭证要它提供的
 *  那件事已经发生。
 *
 *  写成类型谓词而不是布尔：调用方随后就要用那一枚结果，返回值收窄省掉第二次判。 */
function refsCreditable(scan: RefScan | undefined): scan is RefScan {
  return scan !== undefined && (scan.complete || scan.findings.length > 0);
}

/** 一次预检的作用域：目标的声明形、归一后的绝对形、合流后的取消信号。 */
interface PreflightScope {
  readonly target: string;
  readonly targetN: string;
  readonly signal: AbortSignal;
}

/** 预检入参里"这一趟要不要跑"的那一段：三个开关、目标形状、文档扩展名，然后归一目标、
 *  合流取消信号。两个触发点共用一处，免得"一侧漏了某道筛查"。
 *  取消信号在这里合流而不是更早：墙钟计时器不为 bash 之类的无关调用空转。
 *  `undefined` = 这一趟预检不参与。 */
function preflightScopeOf(
  req: PreflightRequest,
  target: string | undefined,
): PreflightScope | undefined {
  return preflightSkipped(req.cfg, target) || target === undefined
    ? undefined
    : {
        target,
        targetN: resolveTarget(target, req.cwd),
        signal: preflightSignalOf(req.exec.signal),
      };
}

/** 参数面归一（官方 `arguments` 深冻结但形状跨边界而来）：非记录按 `{}` 走——
 *  两个入口各自只判这一次，不留"调用方判过、被调方再判一遍"的死分支。 */
const preflightArgsOf = (req: PreflightRequest): Record<string, unknown> =>
  isRecord(req.exec.arguments) ? req.exec.arguments : {};

/** 预检能当场补上的那两种缺项（其余一律交回 guard 的行动清单）。 */
const HANDED_NEEDS = new Set<FactNeed>(["read", "refs", "test", "e2e", "docs"]);

/** 层类缺项（test/e2e/docs）：它们的证据**从引用面那一次扫描里派生**，不另花 I/O。 */
const LAYER_NEEDS: readonly LayerNeed[] = ["test", "e2e", "docs"];

/** 这一趟的缺项是不是"预检当场给得出"的那一种：非空，且全落在 read/refs/三层里。
 *  空清单 = 门禁自己也会放行，一个字符都不必多给。
 *  层缺项只是**候选**：能不能真给取决于同一次扫描有没有走到那层目录（覆盖判定在
 *  handoffEvidenceOf 里，没覆盖就整趟让路给行动清单——半份"这层我探过了"最糟）。 */
const handedOnly = (gaps: readonly FactGap[]): boolean =>
  gaps.length > 0 && gaps.every((gap) => HANDED_NEEDS.has(gap.need));

/** B 面的作用域：目标按 `editTargetPath` 的严格写类口径取（与门禁随后的判定目标**同源**），
 *  再过一道密钥面让路——那一站不花 I/O 之外的成本（词法判定 + realpath），却决定了
 *  "这次调用本来就该被密钥闸拦下"，预检不许替它做决定。 */
function handoffScopeOf(
  req: PreflightRequest,
  args: Record<string, unknown>,
): PreflightScope | undefined {
  const scope = preflightScopeOf(req, editTargetPath(req.exec.name, args) ?? undefined);
  return scope !== undefined && !secretFaceWouldDeny(args, req.cfg, req.cwd) ? scope : undefined;
}

/** B 面挣到的证据 + 各自能不能记账（`credit*` 决定是否写水位，见 handoffReasonOf）。 */
interface HandoffEvidence extends PreflightEvidence {
  readonly creditRead: boolean;
  readonly creditRefs: boolean;
  /** 层缺项是否**全部**被这次扫描覆盖：漏一层就整趟让路，不半份投递。 */
  readonly creditLayers: boolean;
}

/** 这次扫描是不是也用来答层缺项（refs 与层共用同一趟走树，层不再另花一次 I/O）。 */
function needsScan(gaps: readonly FactGap[]): boolean {
  return gaps.some((gap) => gap.need === "refs" || LAYER_NEEDS.some((need) => need === gap.need));
}

/** 还缺哪几层（保持 `LAYER_NEEDS` 的顺序，写进文案与水位都按它）。 */
const missingLayers = (gaps: readonly FactGap[]): LayerNeed[] =>
  LAYER_NEEDS.filter((need) => gaps.some((gap) => gap.need === need));

/** 起点内的层目录 → 相对起点的 POSIX 形（结果里的 `file` 用的就是这一形，比对才不用两边各 normalize）。 */
function toPosixRelative(root: string, dir: string): string {
  return path.relative(root, dir).split(path.sep).join("/");
}

/** 这一项是不是那层（或层更深）里的命中。层就是起点自身时（rel = ""）整棵都在层内。 */
function underLayer(rel: string, file: string): boolean {
  return rel.length === 0 || file === rel || file.startsWith(`${rel}/`);
}

/** 层结论：目标所属包链上**实际存在**的层目录（`existingLayersOf`，与门禁算缺项同一个函数、
 *  同一枚缓存、同一份 extraTestDirs 读法）本次扫描有没有走到，走过去就报该层内的命中数。
 *  回 undefined = 有一层没被覆盖：预算截断、那层在扫描起点之外、或那层是软链（门禁的层探查
 *  跟链，扫描按官方 lstat 口径不跟）。那时"这层零命中"根本不成结论，半份投递会让门禁与模型
 *  都以为探过了——调用方据此整趟让路。 */
function layerConclusionsOf(
  req: PreflightRequest,
  targetN: string,
  scan: RefScan,
  needs: readonly LayerNeed[],
): LayerFinding[] | undefined {
  const root = projectRootOf(targetN, req.cwd);
  const relByNeed = new Map(
    existingLayersOf(targetN, root, extraTestDirsOf(req.cfg)).map((layer): [LayerNeed, string] => [
      layer.need,
      toPosixRelative(root, layer.dir),
    ]),
  );
  const conclusions: LayerFinding[] = [];
  for (const need of needs) {
    const rel = relByNeed.get(need);
    // 查不到那层（门禁本来不该要求它）或这一趟没走到那层，一律按"没覆盖"收口：
    // 让路给行动清单，而不是猜一个结论给模型。
    if (rel === undefined || !scan.dirs.includes(rel)) {
      break;
    }
    const hits = scan.findings.filter((finding) => underLayer(rel, finding.file)).length;
    // 「这层零命中」是全称结论，只有**那棵子树真的读完**才成立：
    //  · 遍历被预算截断时不成立——截断可能正好发生在这一层中间（`dirs` 只说明进去过，
    //    没说明里面走完了；实测：test/ 里 300 个文件、引用者在末尾，扫描在 test/ 内部截断，
    //    仍会报"test 内 0 处命中"并记进投递水位，门禁从此不再要求那一层）；
    //  · 层里还有按规则没读的文件（超大 / 凭据面 / 读不动）时同样不成立。
    // 找到了命中则不受这两条限制：实证本身不需要穷尽（与 refsCreditable 同一条理由），
    // 而层结论的正文本来就把命中数列出来。
    const exhaustive = scan.complete && !scan.unread.some((file) => underLayer(rel, file));
    if (hits === 0 && !exhaustive) {
      break;
    }
    conclusions.push({ layer: need, dir: rel, hits });
  }
  return conclusions.length === needs.length ? conclusions : undefined;
}

/** 取"当场给得出"的证据。返回 undefined = 什么都没挣到或只挣到一半，这一趟不该拦：
 *  要 read 却没读到正文（不存在 / 无权限 / 二进制）时，拦它只有拒绝、没有前置；
 *  缺 refs / 层而扫描没跑成或被预算截断时同理——"扫过一部分"不顶替"探过引用面"。 */
async function handoffEvidenceOf(
  req: PreflightRequest,
  input: FactEvidenceInput,
  scope: PreflightScope,
  resolved?: FsTarget,
): Promise<HandoffEvidence | undefined> {
  // 顺序先正文后扫描：读取是一次定长 syscall，扫描可能吃掉整个墙钟预算——反过来会把
  // 唯一挣得到手的那一半也赔进去。
  const needRead = input.gaps.some((gap) => gap.need === "read");
  const content = needRead
    ? await readTargetContent(scope.targetN, scope.signal, req.fs, resolved)
    : undefined;
  const scan = needsScan(input.gaps)
    ? await refScanOf(req, scope.targetN, scope.signal, resolved)
    : undefined;
  const creditRead = content !== undefined;
  const creditRefs = refsCreditable(scan);
  // 层结论只在**扫描跑完**时才谈得成（creditRefs 就是那枚"跑完了"），于是它与引用面共用同一趟
  // 走树：high 档不再为此多花一次 I/O。三态要分清：没有层缺项 = 空清单（不影响拦不拦）；
  // 有层缺项但有一层没覆盖 = undefined（整趟让路）——把后者也写成空清单，就等于拿"半份证据"
  // 拦人一次，而那层根本没探。
  const layerNeeds = missingLayers(input.gaps);
  let derived: LayerFinding[] | undefined;
  if (layerNeeds.length === 0) {
    derived = [];
  } else if (creditRefs) {
    derived = layerConclusionsOf(req, scope.targetN, scan, layerNeeds);
  } else {
    derived = undefined;
  }
  const creditLayers = derived !== undefined;
  const evidence: HandoffEvidence = {
    scan,
    content,
    layers: derived ?? [],
    creditRead,
    creditRefs,
    creditLayers,
  };
  // 挣到了才拦：read 缺项必须有正文；层缺项必须全被覆盖；refs 与 read 至少挣到一项
  // （两项都空 = 这一趟本来就该放行，那是 guard 的事，不是这里）。
  return (!needRead || creditRead) && (creditRead || creditRefs) && creditLayers
    ? evidence
    : undefined;
}

/** B 面拿到作用域之后的那一半：现算缺项 → 两道让路 → 取证据 → 挣到了才拦并记水位。
 *  `resolved` 是本次调用开头那一次身份解析的结果（同一枚目标不再被读正文与探版本各问一遍）。 */
async function handoffReasonOf(
  req: PreflightRequest,
  args: Record<string, unknown>,
  scope: PreflightScope,
  resolved?: FsTarget,
): Promise<string | undefined> {
  const { input } = factEvidenceOf(req, {
    name: req.exec.name,
    args,
    target: scope.target,
    session: req.session,
  });
  let reason: string | undefined;
  if (handedOnly(input.gaps) && !req.gate.releasedFor(req.session.id, scope.targetN, input)) {
    const evidence = await handoffEvidenceOf(req, input, scope, resolved);
    if (evidence !== undefined) {
      noteDelivery(sessionTargetKeyOf(req.session.id, scope.targetN), deliverySeqOf(req, input), {
        read: evidence.creditRead,
        refs: evidence.creditRefs,
        // 只有真被覆盖到的层才记投递：记早了等于替模型宣称"这层我探过了"。
        layers: evidence.layers.map((layer) => layer.layer),
      });
      // 正文确实随这次拒绝交出去了 ⇒ 那枚"还没看过这一版"的失效点到此为止。
      // 不能靠投递位次判：水位与失效点取的是同一个下标（见 lib/read-basis.ts 的 clearStaleness）。
      if (evidence.creditRead) {
        clearStaleness(sessionTargetKeyOf(req.session.id, scope.targetN));
      }
      reason = renderHandoff(req.messages, scope.targetN, evidence);
    }
  }
  return reason;
}

/**
 * B 面（写类调用，挂 `tools/pre-execute`）：门禁当场给得出证据的那次缺项，用**带证据的拒绝**
 * 拦下来——目标正文与引用面写进这一次的拒绝理由，模型在**这次**调用的结果里就看到事实，
 * 原样重试即凭水位放行。返回 `undefined` = 不拦（照旧交回 `next()`，走今天的行动清单路径）。
 * 让路有三道，每一道都对应"预检抢了别人的决定"的一个具体形态：
 *  - 密钥/凭据面（handoffScopeOf）：正文不许经预检外泄（那是本插件存在的理由之一），而我们的
 *    deny 会抢在密钥闸之前把拒绝理由换成"请重试"。判定与密钥闸共用 secretOptsOf。
 *  - 配额放行态（releasedFor）：目标已熬满 maxDenies 拿到免检，再停一次就把"防死锁"换成了
 *    插件自己新加的拒绝。
 *  - 什么都没挣到（handoffEvidenceOf）：正文读不出、扫描没跑成或被预算截断，或**层缺项里有
 *    一层没被这次扫描覆盖**（层结论与引用面共用同一趟走树，覆盖不到就不成结论，半份最糟）。
 *  （`handedOnly` 那一道如今只在"缺项为空"时命中：五枚 FactNeed 全在预检给得出的集合里，
 *   于是它退化成"门禁自己也会放行，一个字符都不必多给"。）
 * 已知代价（刻意的口径变化，写在 CHANGELOG）：这一趟 deny 走的是 pre-execute，同步 guard
 * 因此**不会**跑到——事实门那次的 `reportDeny`（lesson-loop）与拒绝计数都不再发生；换来的是
 * 模型没有被"拒一次再去查"，而取证通过时的 `reportPass` 照旧在重试那一趟上报。
 */
async function runPreflight(req: PreflightRequest): Promise<string | undefined> {
  const args = preflightArgsOf(req);
  const targets = declaredTargets(args);
  // 官方通道那一形先问到手（async 只有这一站付得起，同步 guard 付不起）：写进缓存之后，
  // ① 紧接着这道密钥面让路判定吃到并集，② 同一次调用随后同步跑的 guard 也吃到
  //（官方保证 pre-execute 整趟跑完才轮到 guard）。
  // 没有声明目标的调用（bash / 缺路径键）一枚 resolve 都不发，**也不造那枚 3 秒墙钟信号**：
  // pre-execute 是每次工具调用都要过的路，白烧一个定时器加一次 AbortSignal.any 就是白烧。
  // 顺带交回的"声明形 → 已 resolve 的 target"给下面的正文读取与版本探针复用：一次盲改对
  // 同一枚目标只问一次身份（远端后端上那是省掉两次往返）。
  const resolvedByTarget =
    targets.length === 0
      ? NO_TARGETS
      : await rememberOfficialTargetsOf(
          req.fs,
          targets,
          req.cwd,
          preflightSignalOf(req.exec.signal),
        );
  const scope = handoffScopeOf(req, args);
  return scope === undefined
    ? undefined
    : handoffReasonOf(req, args, scope, resolvedByTarget.get(scope.target));
}

/** A 面那条附加上下文：`notice` 形（一次性发生的事），`source.kind` 是本包声明的生产者名。
 *  官方要求 notice 必带一行 `summary`（≤120 字，见 dsh-llm 的 `boundContextSummary`）。 */
const refsMessage = (messages: DangerGuardMessages, scan: RefScan): UserMessage =>
  createUserMessage({
    content: [{ type: "text", text: renderAttach(messages, scan) }],
    source: {
      kind: "dangerguard-preflight",
      form: "notice",
      summary: messages.preflightSummary,
    },
  });

/**
 * A 面（只读检视，挂 `tools/post-execute`）：门禁要的引用面随**这次读取的结果**一起交出去
 * （官方 `PostToolDecision.accept{additionalContexts}`；agent-loop 在 commit 那条结果时收下，
 * 排到下一个 step 边界）。于是模型下一次动手编辑前就看得见"它被谁引用"——这是真前置。
 * 返回 `undefined` = 不附加（下游决定原样交回）。
 * 三条收口的理由：
 *  - 只在门禁确实会要 refs 的那次读上附加（按 mid 档问，见 FactEvidenceQuery.tierOverride），
 *    且附加过就有水位、下一趟不再重复——否则每次 read 都塞一块引用面，那就是上下文 flooding。
 *  - 扫描被预算截断（`capped`）时**不附加**：A 面是"一次性把这项补全"的通道，给半份既换不到
 *    凭证、又会让模型以为探过了；那种缺项交给 guard 的行动清单去教它自己搜。
 *  - 目标正文不在这里给（见 renderAttach）。
 * 副作用（明记）：判定走的 `evidenceFor` 会顺带刷新 read 的 mtime 基线——判在读取**之后**，
 *  于是基线比 guard 那次更准，但"读取与本次附加之间发生的外部改动"会被并成一次观测。
 * 这与 `recordReadObservation` 那条残余窗口同源，方向保守（最多一次重读）。
 */
async function attachRefsOnRead(req: PreflightRequest): Promise<UserMessage | undefined> {
  const args = preflightArgsOf(req);
  const scope = preflightScopeOf(
    req,
    isInspectCall(req.exec.name, args) ? callPathOf(req.exec.name, args) : undefined,
  );
  let context: UserMessage | undefined;
  if (scope !== undefined) {
    const { input } = factEvidenceOf(req, {
      name: req.exec.name,
      args,
      target: scope.target,
      session: req.session,
      tierOverride: "mid",
    });
    const scan = input.gaps.some((gap) => gap.need === "refs")
      ? await refScanOf(req, scope.targetN, scope.signal)
      : undefined;
    if (refsCreditable(scan)) {
      noteDelivery(sessionTargetKeyOf(req.session.id, scope.targetN), deliverySeqOf(req, input), {
        refs: true,
      });
      context = refsMessage(req.messages, scan);
    }
  }
  return context;
}

/** 预检两面共用的一条告警：整趟被兜底 catch 吞掉时出声。预检失败必须退化成"今天的拒绝
 *  路径"，绝不能变成"这次编辑没了"；当然也不能静默——所以留一条日志（模板进
 *  test/log-templates.ts 的清单，文案漂了就红）。 */
const PREFLIGHT_WARN = "[danger-guard] 预检失败，本轮不递证据、交回下游决定:";

/** 预检运行面的装配口（两个监听器共用一位入参，见下面那两枚监听器体的签名）。 */
type PreflightRequestOf = (exec: PreExecuteParams[0]) => PreflightRequest | undefined;

/** 造一枚"按当次现读值装配预检运行面"的工厂（apply 里因此只留接线）。
 *  设置 / 语言 / cwd / 台账读口都必须每趟现读（改设置卡与切语言都不必重载插件），
 *  所以收的是**读数口**而不是值。`exec.agent` 是官方可选位，而 dsh-agent 不是本仓依赖
 *  （该类型在 skipLibCheck 下退化成 any）——这一位只能按**形状**收（isPreflightAgent），
 *  会话不可得就整趟跳过、只放行。 */
function preflightRequestFactory(wiring: PreflightWiring): PreflightRequestOf {
  const { svc, gate, ledgerBox, messages, present, fsBox } = wiring;
  return (exec) => {
    const agentRaw: unknown = exec.agent;
    const session = isPreflightAgent(agentRaw) ? agentRaw.session : undefined;
    // `fs` 与 `session` 两条都是"没有就不要装"：预检给得出证据的唯一前提是**能读到工具
    // 实际用的那份盘**，读不到就一句证据都不编（而不是拿宿主本地盘的内容冒充）。
    const fs = fsBox.value;
    return session === undefined || fs === undefined
      ? undefined
      : {
          exec,
          session,
          gate,
          cfg: settingsConfig(svc),
          messages: messages(),
          cwd: effectiveCwdOf(svc, session),
          ledger: ledgerBox.value,
          present,
          fs,
        };
  };
}

/** 需确认档的返回域：`ask` 那一臂（官方 `PreToolDecision` 是判别联合，写成整条联合的话
 *  取值处过不了类型检查 —— 那正是"不许猜契约"的编译期体现）。判定与文案的构造在
 *  `lib/confirm.ts`，预演在 `lib/blast-radius.ts`，这里只留"翻成官方那一臂"。 */
type AskDecision = Extract<PreDecision, { kind: "ask" }>;

/** 需确认档的接线口（`apply` 只留一行接线）。异步：`ask` 档还要跑一趟只读预演。 */
type ConfirmOf = (exec: PreExecuteParams[0]) => Promise<AskDecision | undefined>;

/**
 * 下游放行后本插件要做的补充决定 —— 需确认档优先（零 I/O），其次才是 B 面预检；
 * 下游已经 deny/cancel/ask 就原样交回（预检不去抢别人做过的决定，见调用点注释）。
 */
async function preflightOnPreExecute(
  exec: PreExecuteParams[0],
  next: PreflightNext,
  reqOf: PreflightRequestOf,
  confirmOf: ConfirmOf,
): Promise<PreDecision> {
  // oxlint-disable-next-line node/callback-return -- 官方 next() 是瀑布的下游执行口，不是错误优先回调：它的**结果**要参与本层的合并决定（B 面还可能把 allow 换成 deny），所以必须接住变量而不是直接 `return next()`
  const downstream: PreDecision = await next();
  let decision = downstream;
  if (downstream.kind === "allow") {
    // 需确认档先判：命中就**不再跑 B 面预检** —— 那一趟取证是给"马上就能改"的调用省往返的，
    // 对"等人拍板"的这趟没有意义。而它自己那一趟**只读预演**（量爆炸半径）在下面 await。
    const confirm = await confirmOf(exec);
    if (confirm === undefined) {
      const req = reqOf(exec);
      if (req !== undefined) {
        try {
          const reason = await runPreflight(req);
          decision = reason === undefined ? downstream : { kind: "deny", reason };
        } catch (error: unknown) {
          console.warn(PREFLIGHT_WARN, error);
        }
      }
    } else {
      decision = confirm;
    }
  }
  return decision;
}

/** A 面监听器体：引用面并进下游决定。这次读取本身没成（isError：路径不存在 / 无权限 /
 *  被别的策略 block）时什么都不附——模型并没有拿到它以为拿到了的内容，这时候要它
 *  "别再检索引用"更是错的。 */
async function preflightOnPostExecute(
  exec: PostExecuteParams[0],
  result: PostExecuteResult,
  next: PostflightNext,
  reqOf: PreflightRequestOf,
  settleRead: SettleReadObservation,
): Promise<PostDecision> {
  // 读取基线的结算**先于**一切：它是证据链的前提，而下面的附加会因为"预检没装 fs"整趟跳过
  // （reqOf 返回 undefined）——用 req 当守卫会让基线在那些 profile 上永不提交。
  settleRead(exec, result.isError);
  // oxlint-disable-next-line node/callback-return -- 同 pre-execute 那一处：next() 的结果要和本次附加合并，不能直接交回
  const downstream: PostDecision = await next();
  const req = result.isError ? undefined : reqOf(exec);
  let decision = downstream;
  if (req !== undefined) {
    try {
      const context = await attachRefsOnRead(req);
      decision = context === undefined ? downstream : attachContext(downstream, context);
    } catch (error: unknown) {
      console.warn(PREFLIGHT_WARN, error);
    }
  }
  return decision;
}

/** 预检两面的监听器接线（两条都是瀑布，顺序见各自的函数注释）。 */
function wirePreflightListeners(
  svc: HostCtx,
  reqOf: PreflightRequestOf,
  confirmOf: ConfirmOf,
  settleRead: SettleReadObservation,
): void {
  svc.on?.("tools/pre-execute", (exec, next) =>
    preflightOnPreExecute(exec, next, reqOf, confirmOf),
  );
  svc.on?.("tools/post-execute", (exec, result, next) =>
    preflightOnPostExecute(exec, result, next, reqOf, settleRead),
  );
}

/** read/view 读时基线的结算口：`tools/post-execute` 拿到**真实成败**之后才调。
 *  与预检的请求工厂分开装：后者在"没有会话 / 没有 fs"时整趟不装配，而这件结算不依赖 fs
 *  （只用执行面自己的参数与 agent 会话），那两样缺席时照样必须做——否则在没装 fs 后端的
 *  profile 上，读取基线永远停在暂存态，等于把"首次评估盲区"那一条又放回来。 */
type SettleReadObservation = (exec: PreExecuteParams[0], isError: boolean) => void;

/** 造一枚结算口（值面每趟现读，与其余工厂同一条纪律：`apply` 不持有状态）。 */
function readObservationSettler(svc: HostCtx): SettleReadObservation {
  return (exec, isError) => {
    const agentRaw: unknown = exec.agent;
    const session = isPreflightAgent(agentRaw) ? agentRaw.session : undefined;
    const args = isRecord(exec.arguments) ? exec.arguments : {};
    const target = callPathOf(exec.name, args);
    if (target === undefined) {
      return;
    }
    // cwd 与 guard 时点那次（recordReadObservation）**必须同源**：两处各自现取时，中间夹
    // 一次 `cd` 就会把提交写到另一个键上，暂存永远配不上（见 effectiveCwdOf 的注释）。
    const cwd = effectiveCwdOf(svc, session);
    settleReadOf(session, target, cwd, isError);
  };
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

/** 上报上下文（总线读数口 + 会话 cwd + 会话 id）：判定链与上报共用同一份来源，
 *  于是"拦了这条"与"报的是哪个会话/目录"不可能对不上。 */
const reportContextOf = (wiring: GuardWiring, exec: GuardExecution): ReportContext => ({
  get: (name) => wiring.svc.get?.(name),
  cwd: effectiveCwdOf(wiring.svc, exec.agent?.session),
  sessionId: exec.agent?.session?.id,
});

/** `denyFromPolicy` 的输入：一枚已被档位表判成 `deny` 的命中，加上上报要用的上下文。 */
interface PolicyDenyInput {
  wiring: GuardWiring;
  exec: GuardExecution;
  name: string;
  key: BashDenialKey;
  command: string;
  fix: Fix | undefined;
  facts: PolicyFacts;
  messages: DangerGuardMessages;
  cost: JudgeCost;
}

/**
 * 把档位表判出的 `deny` 落成回给模型的文案 + 教训上报。
 *
 * 文案本体在 `lib/policy-deny.ts`（纯函数、可脱离宿主单测）；本函数只负责两件宿主才有的事：
 * 记一格统计、把这次命中报进教训总线。
 *
 * @param input 命中与上下文。
 * @returns 回给模型的拒绝理由。
 */
function denyFromPolicy(input: PolicyDenyInput): string {
  const { wiring, exec, name, key, command, fix, facts, messages, cost } = input;
  noteRuleHit(key, "deny");
  const deny = policyDenyText({ key, fix, facts, messages });
  reportDeny(reportContextOf(wiring, exec), {
    category: DANGEROUS_BASH_CATEGORY,
    // 签名**一律**用命令原文：类别级归并在 lesson-loop 侧完成（`CATEGORY_SIGNATURES`
    // 把 `dangerous-bash` 折成一个稳定键），原文因此落进 `evidence.signature`，不再被
    // 常量吃掉——那张卡里人审时要看得见是哪条命令。
    signature: command,
    detail: deny,
    evidence: {
      tool: name,
      // 两种 deny 不是一回事：一部分是"确认危险"，另一部分是"这档问不了"。
      // 后者仍不是用户拍板过的动作，所以这两位分开写，别让统计把它们混成一种。
      needsUserConfirmation: policyDenyFlags(facts, key).policyDenied,
      mode: facts.mode,
      // 耗时与输入规模一起发：长度上限该不该调，看的是这两枚的真实分布。
      judgeMs: Math.round(cost.ms),
      judgeLength: cost.length,
    },
  });
  return deny;
}

/**
 * 需确认档的接线工厂（与 `preflightRequestFactory` 同型：值面每趟现读，apply 不持有状态）。
 *
 * 每趟现读设置与语言 —— 与 guard 同一条纪律，改设置卡/切语言不必重载插件；
 * `enabled: false` 时整条通道静默（与三类判定一致的语义）。
 * 命中时顺手进教训总线：与 guard 那条路**同一个类别**（`dangerous-bash`），
 * 靠 `needsUserConfirmation: true` 把"需用户拍板"与"已确认危险"分开 ——
 * 判别标记在 evidence 里而不是靠文案字符串比对（旧实现也是这个口径）。
 */
function confirmFactory(
  svc: HostCtx,
  wiring: GuardWiring,
  messages: () => DangerGuardMessages,
  deduper: AskDeduper,
  dispositionFactory: DispositionFactory,
): ConfirmOf {
  return async (exec) => {
    const cfg = settingsConfig(svc);
    const args = isRecord(exec.arguments) ? exec.arguments : undefined;
    const table = messages();
    // 档位事实每趟现读（用户随时能换预设）：`confirm` 只在这些档位上被问到，
    // 而"这一档还能不能问"由 `lib/mode-policy.ts` 的 `askable` 位决定。
    const facts = policyFactsOf(svc, exec.agent?.session, false);
    const cwd = effectiveCwdOf(svc, exec.agent?.session);
    // 覆盖后的 `rmrf` 可能从 `deny` 降成 `allow`；扫描与过滤必须吃**同一份**实际处置，
    // 否则这里会选出一枚 `deny` 键而不问，guard 随后又把它放行，后段没人看。guard 那一侧
    // 用同一个工厂、同一组服务面与同一条 `effectiveCwdOf` 口径，所以两处结论一致。
    const effective = dispositionFactory(exec.agent?.session, cwd, facts);
    const ask = cfg.enabled
      ? askRequestOf(
          exec.name,
          args,
          { ...bashOptsOf(cfg), severityOf: effective.dispositionOf },
          facts,
          table,
        )
      : undefined;
    // 同一会话 + 同一规则键 + 同一命令原文只**上报**一次：模型重试同一串是常态，
    // 而重复把同一份证据塞进教训总线只会把卡炸成碎片（被去重的那次只记统计，不改变判定）。
    const fresh =
      ask !== undefined &&
      deduper.shouldReport(exec.agent?.session.id, dedupKeyOf(ask.key, ask.command));
    if (ask !== undefined) {
      if (fresh) {
        noteRuleHit(ask.key, "ask");
        reportDeny(reportContextOf(wiring, exec), {
          category: DANGEROUS_BASH_CATEGORY,
          // 签名用**被判定的那条命令原文**（`lib/confirm.ts` 与规则键一起交回的同一份输入）：
          // 再从参数里读一遍就是第二处读法，"判的是这串、报的是另一串"没有任何运行期信号。
          // 与 guard 那条路同口径：类别级归并在 lesson-loop 侧完成。
          signature: ask.command,
          detail: ask.reason,
          evidence: { tool: exec.name, needsUserConfirmation: true },
        });
      } else {
        noteAskSkipped(ask.key);
      }
    }
    // **量爆炸半径**：`ask` 档专属，量不出来就盲问（边界见 lib/blast-radius.ts 的文件头）。
    // 去重掉的那次**照样量**：它仍然会弹给用户（判定是 `ask`），没有证据的卡比有证据的卡更难判。
    const blast =
      ask === undefined
        ? undefined
        : await measureBlastOf({
            shellRaw: svc.get?.("shell"),
            policyRaw: svc.get?.("sandboxPolicy"),
            command: BLAST_COMMANDS[ask.key],
            sourceCommand: ask.command,
            cwd,
            session: exec.agent?.session,
            signal: preflightSignalOf(exec.signal),
          });
    // 翻成官方那一臂：`lib/confirm.ts` 交的是宿主无关形态（它不 import 官方决定类型）。
    // 去重只压掉**重复上报**（教训卡不会为同一条命令炸成碎片）；判定与证据一个字不改 ——
    // 宿主该问的仍然问，`.shouldReport()` 换来的"少上报"不能变成偷偷放行或偷偷撤掉证据。
    return ask === undefined ? undefined : { kind: "ask", ...withBlast(ask, blast, table) };
  };
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
        reportPass(reportContextOf(wiring, exec), "factgate-deny", FACTGATE_SIGNATURE);
      }
    } else if (outcome?.kind === "indeterminate") {
      // 无法自动判定 → 交互式确认（模型会请用户拍板）
      deny = messages.indeterminate;
    } else if (outcome !== undefined) {
      // 状态机回传的是渲染输入（缺项/轮次/上下文），拒绝理由在此按当次语言现渲染。
      deny = renderDenyMessage(outcome.denial, messages);
      reportDeny(reportContextOf(wiring, exec), {
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

/** 密钥/凭据路径编辑闸 → 拒绝理由 + 这轮判定的成本样本（含上报）。目标路径只取一次，
 *  判定与上报同一个键。词表配置在函数内现算（只依赖 rt.cfg），这样入参仍是五位、
 *  不必为 editOpts 再占一位。 */
function secretJudgeOf(
  wiring: GuardWiring,
  exec: GuardExecution,
  rt: GuardRuntime,
  name: string,
  args: Record<string, unknown>,
): SecretJudge {
  const { messages, cfg, cwd } = rt;
  // 非法/超长的扩展模式要在这一层点名上报（值面判定本身在 lib 的 partition 里）。
  const secretPatterns = strArray(cfg.extraSecretPatterns);
  if (secretPatterns !== undefined) {
    reportRejectedPatterns(secretPatterns);
  }
  const built = secretOptsOf(args, cfg, cwd);
  let reason: string | undefined;
  const cost: JudgeCost = { face: "secret", ms: 0, length: 0 };
  if (built !== undefined) {
    // 判定走 lib 的单一谓词 editDanger（"取目标 → 判密钥面"就是它的本体），本函数不再抄第二份；
    // 它回给的 `target` 同时是**上报签名**，判定与上报仍是同一个键。
    const startedAt = performance.now();
    const denial = editDanger(args, built.opts);
    cost.ms = performance.now() - startedAt;
    cost.length = built.targets.join("|").length;
    if (denial !== undefined) {
      // 规则键 → 当前语言的拒绝理由；`messages[key]` 的取值类型让"加了规则没写文案"
      // 停在编译期，而不是运行时把 undefined 回给模型。
      reason = messages[denial.key];
      const forms = built.opts.resolvedPaths[denial.target] ?? [];
      reportDeny(reportContextOf(wiring, exec), {
        category: "secret-path",
        signature: denial.target,
        detail: reason,
        // 解析形一起进上报：被拦的是"声明路径"还是"它背后的那棵树"，看教训时要有这一格。
        // 交**清单**而不是单值：判定吃的就是并集（本机 realpath 形 + 官方后端形），只报一枚
        // 等于把"哪一形命中的"这件事藏起来——而非本地执行世界里恰恰只有官方那一形说得准。
        evidence: {
          tool: name,
          judgeMs: Math.round(cost.ms),
          ...(forms.length === 0 ? {} : { resolvedPaths: forms }),
        },
      });
    }
  }
  return { reason, cost };
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
/** 可选读面的接线：台账投影、宿主 fs 面、观察到的真实路径、会话销毁、卸载兜底。抽出来只是为
 *  `apply` 的行数预算；这几件同属一类——**都是可选读面**，缺席只让判定退回声明形 / 本机形。 */
function wireReadFaces(
  svc: HostCtx,
  factGate: FactGate,
  ledgerBox: GuardRuntime["ledger"],
  fsBox: PreflightFsBox,
  askDeduper: AskDeduper,
): void {
  svc.inject?.(["sessionProjections"], (child) => {
    const registry = child.sessionProjections;
    registry.register(toolLedgerProjection);
    ledgerBox.value = (session) => asLedger(registry.stateOf(session, LEDGER_KEY));
  });

  svc.inject?.(["fs"], (child) => {
    fsBox.value = child.fs;
  });

  // 后端每观察一枚目标就报一次 ⇒ 把它自己解析出的真实路径记进 officialPaths（同步、零额外
  // I/O，于是同会话随后那次盲改的密钥面判定就吃得到官方那一形）。fs 缺席时箱子是空的。
  svc.on?.("fs/observed", (target) => {
    rememberObservedPath(fsBox.value, target);
  });

  // 会话销毁即释放该会话的全部记账：fact-gate 分片 + 四张会话键台账（ctx-observe / lesson-loop
  // 同用官方 session/disposed）。幂等：同一 session id 重复 dispose 由 delete 天然幂等。
  svc.on?.("session/disposed", (sessionRaw) => {
    factGate.dropSession(sessionRaw.id);
    // 去重表按会话分片，键形与 `shouldReport(exec.agent?.session.id, …)` 同源。
    askDeduper.drop(stringIdOf(sessionRaw.id));
    dropSessionLedgers(stringIdOf(sessionRaw.id));
  });

  // 卸载兜底：换代时清空派生台账，disposer 随插件卸载跑，下一代从空表起算。
  svc.effect((): (() => void) => (): void => {
    clearDerivedLedgers();
  });
}

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
  //
  // 偏好读一次即缓存，靠宿主推送失效：describe() 不便宜（installed dsh-settings 对**每个**
  // 活跃条目做 schema.toJSON() + JSON.stringify 算 revision，再投影 value/base/user 三份），
  // 而 tools.guard 是全仓最热的路径——每次 bash/edit/write 都过这道谓词。失效链：写配置
  // → emit('app-boot/config-reload') → SettingsForms 监听它并 invalidate() → 微任务里
  // describe() → 对 raw 变化的条目 emit('settings/document-updated', ns, revision)。
  let cachedPreference: unknown = undefined;
  let hasCachedPreference = false;
  svc.on?.("settings/document-updated", (ns: unknown) => {
    if (ns === LOCALE_SETTINGS_NAMESPACE) {
      hasCachedPreference = false;
    }
  });

  /** locale 条目的偏好值；未投影出来 → undefined（中文默认）。**缺席不缓存**：locale 条目
   *  可能晚于本条目才到位，缓存一次缺席就把语言跟随永久钉死——代价只是缺席时每次判定多
   *  一次 describe()。 */
  const localePreferenceOf = (): unknown => {
    if (!hasCachedPreference) {
      const row = svc.settings.describe().find((desc) => desc.ns === LOCALE_SETTINGS_NAMESPACE);
      if (row !== undefined) {
        cachedPreference = row.value;
        hasCachedPreference = true;
      }
    }
    return hasCachedPreference ? cachedPreference : undefined;
  };

  const localeMessages = (): DangerGuardMessages =>
    messagesFor(MESSAGES, resolveLocalePreference(localePreferenceOf()));

  const factGate = new FactGate();
  // 判定统计的客户端读面（**可选**：探不到注册口就什么都不装）。挂在**这一半**而不是设置半，
  // 理由与"缺席只少一栏展示、绝不拖闸门"都在 `lib/stats-remote.ts` 的 installStatsRemote 上。
  installStatsRemote(ctx);

  // 两个可选读面（投影台账 / fs）走 inject 回调而不是插件级 inject：见 wireReadFaces 的注释。
  const fsBox: PreflightFsBox = { value: undefined };
  const ledgerBox: GuardRuntime["ledger"] = { value: undefined };
  // 去重表在读面接线之前建：`session/disposed` 那条监听要顺手回收它按会话分的片。
  const askDeduper = new AskDeduper();
  wireReadFaces(svc, factGate, ledgerBox, fsBox, askDeduper);

  // ── 预检（Phase 2）的两个触发点 ──────────────────────────────────────────────
  // A 面挂 `tools/post-execute`（引用面随读取结果出去），B 面挂 `tools/pre-execute`
  // （带证据拦一次）。两条都是瀑布，都**先** `await next()`：下游任何插件已经 deny/cancel/ask
  // 就原样交回——预检只补充证据，不抢别人已经做出的决定。
  // 官方契约保证 pre-execute 瀑布整体跑完之后才轮到 `ctx.tools.guard` 的同步判定
  // （installed dsh-tools `prepareExecution`：只在 `decision.kind === 'allow'` 时才走
  // `guardReason`），所以 B 面写下的投递水位 guard 一定看得见。
  // ⚠ 两面都**永不抛错**：任何异常只记一条告警，随后照常交回下游。预检失败必须退化成
  //   "今天的拒绝路径"，绝不能变成"这次编辑没了"；当然也不能静默——所以留一条日志。
  // 检索工具的在位探测：`ctx.tools.get` 是官方成员，装配期造一次即可（注册表在一条会话里
  // 不太可能每趟都变，而探测本身只读一张表）。它只影响拒绝理由里点名的工具，见 toolPresentOf。
  const present = toolPresentOf(svc.tools);
  const preflightReqOf = preflightRequestFactory({
    svc,
    gate: factGate,
    ledgerBox,
    messages: localeMessages,
    present,
    fsBox,
  });

  // 判定链（bash 闸 / 密钥路径闸 / 事实门）与两路上报都已提到模块层，apply 只留接线。
  // ⚠ 它要在**预检/需确认接线之前**定义：需确认那一档也要进教训总线（见 confirmFactory）。
  const wiring: GuardWiring = { svc, gate: factGate };

  // 逐命中实际处置的宿主面：guard 与审批通道共用同一份工厂（见 lib/effective-disposition.ts）。
  const dispositionFactory = effectiveDispositionFactory({
    shellRaw: () => svc.get?.("shell"),
    policyRaw: () => svc.get?.("sandboxPolicy"),
    canonicalize: (absolute: string) => realpathOf(absolute, undefined),
    tempDir: os.tmpdir(),
  });

  const confirmOf = confirmFactory(svc, wiring, localeMessages, askDeduper, dispositionFactory);
  wirePreflightListeners(svc, preflightReqOf, confirmOf, readObservationSettler(svc));

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
      // 工作目录每趟调用取一次（服务读数本身是同步的，见 effectiveCwdOf 的注释）：
      // 宿主 `cd` / `working_directory` 之后这里就跟到新的目录，相对目标的归一化才不会
      // 停在会话创建时那一级。
      cwd: effectiveCwdOf(svc, exec.agent?.session),
      ledger: ledgerBox,
      present,
    };
    let deny: string | undefined;
    if (rt.cfg.enabled) {
      const { cfg, messages } = rt;
      const { name } = exec;
      const args = isRecord(exec.arguments) ? exec.arguments : {};

      // 词表配置：**单源**在 bashOptsOf（guard 与需确认档共用一份——两处各写一遍迟早会漂，
      // 而漂的表现是"guard 拦得住、审批却看不见"那种静默失效）。
      const bashOpts = bashOptsOf(cfg);

      // read/view 的读时基线（首次评估盲区闭合，见 recordReadObservation）：
      // 无条件调用、函数内部按工具面自筛——read 永远不会被拦，记账先行不影响任何判定。
      recordReadObservation(name, exec.agent?.session, args, rt.cwd);

      // 1) bash 危险命令（git 绕过 / rm -rf 灾难 / curl|sh / dev server）。
      // pwsh 与 bash 共用同一套规则，另在调用点声明 shell 方言（bashDenialOf）：pwsh 名下
      // Remove-Item / ri / rd / del 这些整树删除命令词与 Windows 字形目标都判得到。
      // 仍未覆盖：**cmd 当段头那一类**——`cmd.exe /c rd /s /q …`、`cmd /c …`（去 `.exe`）与
      // 带路径前缀的三种拼法同判放行（引号/转义规则差得太远，按类登记、按类各钉一条现状用例）。
      // **PowerShell 家族已收**：`pwsh`/`powershell`（含 `.exe`、任意大小写）的 `-c`/`-Command`
      // 体在下钻时强制开 Windows 轨道，`-File`/`-EncodedCommand` 归"看不见"→ 需确认。
      // 以及 pwsh 在 POSIX 宿主上真去删一个叫 `C:\Windows` 的相对目录
      // 这种罕见写法（方言带来的过拦，代价已写在 danger-rules 的 shellDialect 注释里）。
      // 档位事实与逐命中实际处置先算：扫描层按后者排序，否则串行命令里"本档已放行的前段"
      // 会吞掉"仍要拦的后段"；沙箱覆盖的 rmrf 尤其如此（排序时 deny、处置时 allow）。
      const facts = policyFactsOf(svc, exec.agent?.session, false);
      const effective = dispositionFactory(exec.agent?.session, rt.cwd, facts);
      const judge = bashJudgeOf(name, args, bashOpts, effective.dispositionOf);
      const sample = (cost: JudgeCost): void => {
        sampleJudge(
          () => reportContextOf(wiring, exec),
          cost,
          rt.cfg.judgeStats,
          JUDGE_COST_CATEGORY,
        );
      };
      sample(judge.cost);
      const bashDenial = judge.denial;
      if (bashDenial === undefined) {
        // 2) 密钥/凭据路径编辑
        const secret = secretJudgeOf(wiring, exec, rt, name, args);
        sample(secret.cost);
        // 3) 事实强制门（强校验：持续拒绝到取证齐备为止）。目标路径经 editTargetPath 归一化，
        //    与取证记账（callPathOf）同一个键形；上报签名用类别级稳定键（目标路径改放 evidence）。
        deny = secret.reason ?? factGateDenyOf(wiring, exec, rt, name, args);
      } else {
        // 处置由**档位表**与**逐命中实际处置**共同给（`lib/mode-policy.ts` + 沙箱覆盖）：
        // 同一枚规则键在不同权限预设下结论不同，而 `ask` 档由 `tools/pre-execute` 的审批
        // 通道收口 —— 两条路用同一个工厂、同一份实际处置规则，所以同一枚命中不会在两处得到
        // 不同结论，也不会被"排序时 deny、处置时 allow"的空档吞掉。
        const { command, key, fix } = bashDenial;
        const covered = effective.coveredFactsOf(key, fix);
        // 三档收口：allow 只记读数（沙箱让路不算"放过"——那是交给宿主拦），
        // deny 交给下面的工厂出文案与上报，ask 什么都不做。
        const verdict = decideRule(covered, key);
        if (verdict === "allow") {
          // 沙箱让路那格交给宿主收口，不计入"本档放过了什么"，也不算规则被遵守。
          if (!(key === "rmrf" && covered.sandboxCovers)) {
            noteAllowedHit(key, facts.mode);
            // 放行也是「规则被遵守」：这张 armed 卡唯一能拿到 suppressed 的来源。
            reportPass(reportContextOf(wiring, exec), DANGEROUS_BASH_CATEGORY, command, judge.cost);
          }
        } else if (verdict === "deny") {
          deny = denyFromPolicy({
            wiring,
            exec,
            name,
            key,
            command,
            fix,
            facts: covered,
            messages,
            cost: judge.cost,
          });
        }
      }
    }
    return deny;
  });

  if (dispose !== undefined) {
    svc.effect(() => dispose, "danger-guard: tools.guard");
  }
  // 会话隔离靠 FactGate 内部按 session 分片（sessions: Map<会话键, {pending, released}>，
  // 见 lib/fact-gate.ts），不是靠 reset()。
  // 此 effect 仅在 apply 时对全新 gate 做一次清空（幂等 no-op），保留只为插件重装时状态归零。
  // 工厂**必须**交回一枚 disposer：官方 `Context["effect"]` 的返回域不收 `undefined`
  // （见 NOOP_DISPOSER 的注释——那是本次改绑官方后新撞出来的分歧，按官方补齐，语义不变）。
  svc.effect(() => {
    factGate.reset();
    askDeduper.reset();
    return NOOP_DISPOSER;
  });
}

export default {
  inject: ["tools", "settings"],
  // ⚠ 这里**不能有 `Config` 键**——见 apply 的注释。设置面在 settings-host.ts。
  apply,
};
