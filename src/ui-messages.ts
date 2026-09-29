// src/ui-messages.ts —— 设置卡 UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale 的**类型化**那两条重载：
// `ctx.locale.register(ns, dicts)`（两语一次交齐）+ `ctx.locale.bind(ns)`，语言切换由宿主
// 驱动、无需重载页面（见 client-entry.ts 的 apply）。本包命名空间已 merge 进官方
// `LocaleNamespaceMap`（下面那条 `declare module`），故键集与函数面都由官方表达式交出。
// 插值不放进字典正文之外的部分（官方字典是扁平字符串表）：带变量的整行由调用点用本表的
// `{tools}`/`{chars}` 占位 + 官方 Translate 的 params 填（占位符集合两语一致由测试比对）。
// host 半回给模型的拒绝理由是另一份字典（lib/messages.ts）——那边没有官方 i18n 面。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen666/dsh-plugin-shared/lib/locale";

/** 本包设置卡产出的全部界面文案。 */
export interface UiMessages {
  /** 卡片标题（设置页插件列表里的那一行）。 */
  readonly cardTitle: string;
  /** 卡片副标题：一句话说明本包做什么。 */
  readonly cardDescription: string;
  /** 作用域只读（非 loopback 页面）时的状态条文本。 */
  readonly statusReadOnly: string;
  /** 有未保存改动时的状态条文本。 */
  readonly statusDirty: string;
  /** 无未保存改动时的状态条文本。 */
  readonly statusClean: string;
  /** 保存按钮（空闲态）。 */
  readonly save: string;
  /** 保存按钮（写入中）。 */
  readonly saving: string;
  /** 撤销按钮。 */
  readonly revert: string;
  /** 保存失败前缀（后接错误摘要）。 */
  readonly saveFailed: string;
  /** 词表输入框的默认占位（未显式给 placeholder 的行）。 */
  readonly listPlaceholder: string;
  /** 引用取证名单为空时，事实门 hint 里的替代说明。 */
  readonly refToolsEmpty: string;
  readonly enabledLabel: string;
  readonly enabledHint: string;
  /** 事实门开关 hint（占位 tools = 生效的检索工具名单）。 */
  readonly factGateLabel: string;
  readonly factGateHint: string;
  readonly maxDeniesLabel: string;
  readonly maxDeniesHint: string;
  readonly strictLabel: string;
  readonly strictHint: string;
  /** 小改阈值 hint（占位 chars = 内置默认值）。 */
  readonly smallLabel: string;
  readonly smallHint: string;
  /** 大改阈值 hint（占位 chars = 内置默认值）。 */
  readonly bigLabel: string;
  readonly bigHint: string;
  /** 检索工具名单 hint（占位 tools = 内置默认名单）。 */
  readonly refToolsLabel: string;
  readonly refToolsHint: string;
  readonly refStrictLabel: string;
  readonly refStrictHint: string;
  readonly testDirsLabel: string;
  readonly testDirsHint: string;
  readonly devWordsLabel: string;
  readonly devWordsHint: string;
  readonly devRunArgsLabel: string;
  readonly devRunArgsHint: string;
  readonly secretLabel: string;
  readonly secretHint: string;
  /** 密钥模式 textarea 的占位（正则示例 + 每行一条的说明）。 */
  readonly secretPlaceholder: string;
}

/**
 * 本包的文案命名空间 merge 进官方的 `LocaleNamespaceMap`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts:23-30`「Dictionary owners extend via declaration
 * merging (exactly like SlotMap)」）。这不是可选的美化：不 merge 时
 * `ctx.locale.bind(NS)` 只能落到官方那条**未类型化**重载（installed
 * `dsh-client-locale/lib/types/client/index.d.ts:226`），返回 `Translate<string>`，而卡片
 * 要的是键集收窄的 `t`，于是本地只好自己声明一个官方给不出的函数形状。
 * 本包程序里实测到的红字（把键收窄的 `t` 投影回官方服务面 `LocaleRuntime['bind']`，
 * 也就是那条未类型化重载跟着进目标类型时）：
 *   TS2322 Type '(ns: string) => Translate' is not assignable to type
 *     '{ <N extends Extract<keyof LocaleNamespaceMap, string>>(ns: N): TranslateNS<N>;
 *        (ns: string): Translate; }'.
 *     … Type 'string' is not assignable to type 'LocaleKeysOf<"danger-guard">'.
 * 即：**没有任何单一实现能同时满足官方那两条重载**，所以 ClientCtx.locale 只能投影
 * 类型化那一条。merge 之后键集由官方 `TranslateNS<NS>` 表达，`t("拼错的键")` 在编译期红，
 * register 也走官方类型化那条（同文件 :199，字典参数 `Record<BuiltInLocaleId,
 * LocaleDictOf<N>>`）。
 * ⚠ 表键必须是字面量（interface 键位不接受计算属性），故下面的等式常量把它与
 * client-entry.ts 的 `NS` 钉在编译期：两边哪天分叉，那一位就红。
 * ⚠ `UiMessages` 仍是 `interface`（lint 的 `consistent-type-definitions` 禁 `type` 对象
 * 字面量），这不影响走有限键映射：`LocaleDictOf<N>` 展开成的是 `Record<本包键, string>`
 * 这一**有限**映射，不是官方的扁平 `LocaleDict = Record<string, string>`（interface 拿不到
 * 隐式索引签名，实测 `Index signature for type 'string' is missing in type 'UiMessages'`
 * 只出现在往扁平那条上塞的时候）。于是「少一门语言」「多一个键」都在编译期红。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** 本包设置卡的全部界面文案键（= client-entry.ts 的 `NS`）。 */
    "danger-guard": keyof UiMessages;
  }
}

/** 编译期契约：merge 里写死的命名空间键（`Translate` 用它取 `TranslateNS`）与卡片
 *  注册用的 `NS` 必须是同一个串——改任何一处都要动这一行才会红。 */
const LOCALE_NS_KEY = "danger-guard" as const;

/**
 * 本源只以**类型**形态对外流通：`client-entry.ts` 的 `const NS: LocaleNs = "danger-guard"` 把条目
 * id 钉在本源上（分叉即编译期红），而产物漂移针仍要按字面量形状从 bundle 里抓 `NS`，所以那里
 * 保留字面量、只加类型标注——值导出不必存在（用例侧同理：要断言运行时那串就写字面量）。
 */
export type LocaleNs = typeof LOCALE_NS_KEY;

/**
 * 卡片取文案的函数形状：官方 `TranslateNS<N>`（installed `dsh-client-ui-slots/lib/types/
 * index.d.ts:67` `= Translate<LocaleKeysOf<N>>`，而 `Translate<K> = (key: K, params?) =>
 * string`，同文件 :45）——键集就是上面 merge 的 `keyof UiMessages`（外加官方 `common`
 * 命名空间的共享词表，`LocaleKeysOf` 的查找链在 miss 之后会 consult 它），函数面完全归
 * 官方，本地不再声明。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    cardTitle: "danger-guard 危险拦截",
    cardDescription:
      "危险命令物理拦截（git 钩子绕过/灾难删除/下载即执行/长驻 dev server/密钥编辑）+ 首次编辑事实强制门（ECC gateguard 移植）",
    statusReadOnly: "当前作用域只读",
    statusDirty: "有未保存的修改，点「保存」生效",
    statusClean: "无未保存的修改",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    saveFailed: "保存失败：",
    listPlaceholder: "逗号分隔，如 turbopack, remix",
    refToolsEmpty: "（当前名单为空：任何检索都不计入引用取证）",
    enabledLabel: "启用危险拦截",
    enabledHint: "关闭后所有命令与编辑放行（不建议长期关闭）",
    factGateLabel: "首次编辑事实门（gateguard）",
    factGateHint:
      "每个文件首次编辑前强制取证：先成功 read 目标，再做项目级引用检索（计入取证的检索工具：{tools}），按写面风险分档补 test/e2e/docs 层探查。强校验：持续拒绝到取证齐备为止",
    maxDeniesLabel: "放行次数（强校验防死锁）",
    maxDeniesHint:
      "连续无证据拒绝 maxDenies 次后放行并警告（1-5，默认 2）。证据判定不可行时走交互式确认，不消耗此次数",
    strictLabel: "严格模式（每文件全探查）",
    strictHint:
      "开：忽略按写面风险分档，每个代码文件首次编辑都走全探查（read + 引用 + 所有存在的 test/e2e/docs 层）。关：小改只要求 read，大改/触及导出签名/配置装配面才升档",
    smallLabel: "小改阈值（字符）",
    smallHint: "写面 ≤ 此值且不含导出/签名关键字 → 判小改，只要 read（默认 {chars}，1-2000）",
    bigLabel: "大改阈值（字符）",
    bigHint: "写面 > 此值 → 判大段重写，升最高档全探查（默认 {chars}，2-100000）",
    refToolsLabel: "计入取证的检索工具",
    refToolsHint:
      "事实门承认哪些工具算「引用探查」凭证（默认 {tools}）。装了别的检索插件（rg_search…）就把工具名加进来；清空 = 任何检索都不计入（凭证面只收紧不放宽）",
    refStrictLabel: "其中走严格相对路径口径的工具",
    refStrictHint:
      "这些工具要起点用 root、签名（query/fts/vector）含目标相对路径或文件名才计入（语义检索命中面宽，防 index.ts 撞名顶包）；不在本名单里的按 pattern/include + path 口径认",
    testDirsLabel: "额外测试层目录名",
    testDirsHint:
      "并入内置 test 层词表（test/tests/__tests__/spec/…），逗号分隔。只有命中的目录存在时才要求该层探查",
    devWordsLabel: "额外 dev server 命令头",
    devWordsHint: "追加到内置词表（vite/webpack/next/…），逗号分隔",
    devRunArgsLabel: "额外 dev run 脚本名",
    devRunArgsHint: "追加到内置参数（dev/watch/serve/start/…），逗号分隔",
    secretLabel: "额外密钥路径模式",
    secretHint:
      "追加到内置正则（.ssh/私钥/证书/…）。每行一条正则片段（可含逗号，按行分隔不会被切碎）",
    secretPlaceholder: "/id_dsa$|\\.p12$/i（每行一条，可含逗号）",
  },
  en: {
    cardTitle: "danger-guard danger block",
    cardDescription:
      "Physical blocking of dangerous commands (git hook bypass / catastrophic delete / download-and-run / long-running dev server / secret edits) + first-edit fact gate (ported from ECC gateguard)",
    statusReadOnly: "This scope is read-only",
    statusDirty: "Unsaved changes - press Save to apply",
    statusClean: "No unsaved changes",
    save: "Save",
    saving: "Saving…",
    revert: "Revert",
    saveFailed: "save failed: ",
    listPlaceholder: "comma separated, e.g. turbopack, remix",
    refToolsEmpty: "(the list is empty: no search counts towards reference evidence)",
    enabledLabel: "Enable danger blocking",
    enabledHint: "When off, every command and edit goes through (not a long-term setting)",
    factGateLabel: "First-edit fact gate (gateguard)",
    factGateHint:
      "Before the first edit of a file, evidence is forced: read the target successfully, then run a project-level reference search (counted search tools: {tools}), and probe the test/e2e/docs layers according to the write's risk tier. Strict: the edit stays denied until the evidence is complete",
    maxDeniesLabel: "Release quota (deadlock guard for strict mode)",
    maxDeniesHint:
      "After maxDenies consecutive evidence-less denials the edit is allowed with a warning (1-5, default 2). When evidence cannot be determined the gate asks the user instead, which does not consume this quota",
    strictLabel: "Strict mode (full probe for every file)",
    strictHint:
      "On: risk tiers are ignored and the full probe (read + references + every existing test/e2e/docs layer) runs on the first edit of every code file. Off: a small edit only needs read; big rewrites, export-signature changes and config/assembly files escalate",
    smallLabel: "Small-edit threshold (chars)",
    smallHint:
      "A write of at most this many chars without export/signature keywords counts as small and only needs read (default {chars}, 1-2000)",
    bigLabel: "Big-edit threshold (chars)",
    bigHint:
      "A write above this size counts as a rewrite and escalates to the top tier full probe (default {chars}, 2-100000)",
    refToolsLabel: "Search tools counted as evidence",
    refToolsHint:
      "Which tools the fact gate accepts as a reference probe (default {tools}). Add names from other search plugins (rg_search, ...); clearing the list means no search counts (the evidence surface only ever tightens)",
    refStrictLabel: "Tools among them using the strict relative-path criterion",
    refStrictHint:
      "These only count when root is the search origin and the signature (query/fts/vector) contains the target's relative path or file name - semantic search hits broadly, so a bare index.ts could otherwise stand in for another. Tools off this list are judged by pattern/include + path",
    testDirsLabel: "Extra test-layer directory names",
    testDirsHint:
      "Merged into the built-in test-layer vocabulary (test/tests/__tests__/spec/...), comma separated. A layer is only required when the matched directory actually exists",
    devWordsLabel: "Extra dev server command heads",
    devWordsHint: "Appended to the built-in vocabulary (vite/webpack/next/...), comma separated",
    devRunArgsLabel: "Extra dev run script names",
    devRunArgsHint:
      "Appended to the built-in arguments (dev/watch/serve/start/...), comma separated",
    secretLabel: "Extra secret path patterns",
    secretHint:
      "Appended to the built-in regex (.ssh / private keys / certificates / ...). One regex fragment per line - commas survive because lines are the separator",
    secretPlaceholder: "/id_dsa$|\\.p12$/i (one per line, commas allowed)",
  },
};
