// lib/messages.ts —— host 半文案字典（中英双语）。
//
// 只管 host 半（tools.guard 回给模型的拒绝理由与取证指令）：设置卡的 UI 文案走官方
// @deepseek-ai/dsh-client-locale 类型化那两条重载（client 侧
// `ctx.locale.register(ns, dicts)` 一次交齐两语 + `bind`/`t`，见 src/client-entry.ts）。
// host 侧没有官方 i18n 面，注入给模型的文本只能
// 自带字典；语言取官方 settings 的 `locale.preference`（shared 的 resolveLocalePreference），
// 未注册即中文。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 DangerGuardMessages 类型，少键多键都在编译期红。
// console.* 的日志文案不在此列——那是给排障的人看的，不随界面语言切换。
//
// 带变量的文案用 `{name}` 占位符（与官方 client-locale 同字形），由本模块的 fillTemplate 填充；
// 两语模板的占位符集合是否一致由测试比对（翻译漏掉插值是这类改造最容易静默发生的错）。
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/**
 * 模板槽位：占位符名 → 已文本化的替换值。
 * 值一律先转成字符串再传进来——填模板因此不需要任何类型分支（覆盖率不添不可达分支）。
 */
export type MessageSlots = Readonly<Record<string, string>>;

/**
 * `{key}` 占位符填充：逐个槽位做全量字面替换。
 * 不用正则也不用 `params[key]` 取值（后者在 noUncheckedIndexedAccess 下要写 `?? ""`，
 * 而"模板里出现了字典没有的占位符"这种错既测不到也不该被静默兜住——写错占位符时
 * 原文照出，肉眼可见）。
 * @param template - 含 `{key}` 占位符的文案。
 * @param slots - 槽位表；未出现的占位符不受影响。
 * @returns 填充后的文本。
 */
export function fillTemplate(template: string, slots: MessageSlots): string {
  let out = template;
  for (const [key, value] of Object.entries(slots)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

/** 本包 host 侧产出的全部模型可读文案。 */
export interface DangerGuardMessages {
  // ── bash / 编辑闸的拒绝理由（lib/danger-rules.ts）───────────────────────
  /** git 钩子绕过（--no-verify 及缩写 / core.hooksPath）。 */
  readonly noVerify: string;
  /** 灾难性 rm 目标（家目录 / 根 / 上跳）。 */
  readonly rmrf: string;
  /** 下载即执行管道（curl|sh 家族）。 */
  readonly pipeShell: string;
  /** 长驻开发服务器。 */
  readonly devServer: string;
  /** 嵌套 shell `-c` 体**未被检查** → 需用户确认。 */
  readonly nestedShellUnconfirmed: string;
  /** 编辑目标是密钥/凭据文件。 */
  readonly secretPath: string;
  // ── 事实强制门（lib/fact-gate.ts + host.ts 的缺项 hint）─────────────────
  /** 证据不可判定 → 交互式确认。 */
  readonly indeterminate: string;
  /** 拒绝消息尾部的"同步声明"要求（机器核动作、结论归文字）。 */
  readonly declareTail: string;
  /** 第 N 轮仍未放行的头部（槽位 attempt/count）。 */
  readonly headRetry: string;
  /** 新建文件免 read 的头部。 */
  readonly headNewFile: string;
  /** 首次拒绝的头部。 */
  readonly headFirst: string;
  /** 已确认项清单行（槽位 done）。 */
  readonly confirmedLine: string;
  /** 已确认项与检索工具名清单的连接号。 */
  readonly listSeparator: string;
  /** 多条探查口径子句的连接号。 */
  readonly clauseSeparator: string;
  /** host 注入的具体补充（如层目录、落点）的外裹括号（槽位 hint）。 */
  readonly hintWrap: string;
  /** 上下文未带目标名时的占位。 */
  readonly defaultTargetName: string;
  /** 上下文未带探查起点时的占位。 */
  readonly defaultSearchPath: string;
  /** read 缺项 · 从未做过（槽位 name/hint）。 */
  readonly gapReadNever: string;
  /** read 缺项 · 被会话外改动（槽位 name/hint）。 */
  readonly gapReadExternal: string;
  /** read 缺项 · 调用失败过（槽位 name/hint）。 */
  readonly gapReadFailed: string;
  /** read 缺项 · 作用域过窄（read 不受作用域影响，与默认同形；槽位 name/hint）。 */
  readonly gapReadNarrow: string;
  /** pattern 口径的探查子句（槽位 tools/root/name）。 */
  readonly probePattern: string;
  /** 严格相对路径口径的探查子句（槽位 tools/root/name）。 */
  readonly probeStrict: string;
  /** refs 缺项 · 从未做过：子句清单 + 结论要求（槽位 clauses）。 */
  readonly gapRefsNever: string;
  /** refs 缺项 · 名单为空的真实原因（槽位 name）。 */
  readonly gapRefsToolsEmpty: string;
  /** 计入取证的工具名清单为空时的点名文案（narrow 指令用）。 */
  readonly countedToolsEmpty: string;
  /** refs 缺项 · 作用域过窄（槽位 name/tools/root/hint）。 */
  readonly gapRefsNarrow: string;
  /** refs 缺项 · 调用失败过（槽位 root/name/hint）。 */
  readonly gapRefsFailed: string;
  /** refs 缺项 · 目标被会话外改动（引用面不受影响，槽位 root/name/hint）。 */
  readonly gapRefsExternal: string;
  /** test 层触达探查（槽位 root/name/hint）。 */
  readonly gapTestBase: string;
  /** test 层探查落点不对（槽位 root/name）。 */
  readonly gapTestNarrow: string;
  /** e2e/集成层触达探查（槽位 root/name/hint）。 */
  readonly gapE2e: string;
  /** 文档层触达探查（槽位 root/name/hint）。 */
  readonly gapDocs: string;
  /** host：窄落点清单（槽位 paths）。 */
  readonly gapNarrowScope: string;
  /** host：层目录提示（槽位 dir）。 */
  readonly gapLayerDir: string;
}

export const MESSAGES: MessagesCatalog<DangerGuardMessages> = {
  zh: {
    noVerify:
      "[danger-guard] 检测到 git 钩子绕过（--no-verify 及其缩写 -n / core.hooksPath 重定向）。" +
      "它会让提交跳过 pre-commit 质量与安全检查。请移除该旗标正常提交；" +
      "若钩子误报，先修钩子或与用户确认豁免，不要绕过。",
    rmrf:
      "[danger-guard] rm -rf 的目标是家目录/根/上跳路径，会灾难性删除用户数据。" +
      "请在目标项目目录内做相对路径清理（如 rm -rf ./build），或先与用户确认。",
    pipeShell:
      '[danger-guard] 检测到"下载即执行"管道（curl/wget | sh/bash）。' +
      "远程脚本未审计即执行有任意代码风险。请先下载到本地（curl -O），" +
      "审计内容并经用户确认后再执行。",
    devServer:
      "[danger-guard] 该命令会启动长驻开发服务器（dev/watch/vite 等），" +
      "在 Agent 会话内会挂死当前回合或占住后台。请改用一次性命令（build/check/test），" +
      "确需长驻服务时请先与用户确认并由用户在独立终端启动。",
    nestedShellUnconfirmed:
      "[danger-guard] 嵌套 shell 的 `-c` 命令体未被检查：引号不闭合导致体被截断，" +
      "或套娃层数超出下钻上限（超界的部分根本没进到判定里）。" +
      "这不是「已确认危险」也不是「已确认安全」——请勿原样重试，" +
      "把这条命令贴给用户、由用户显式确认后再执行；" +
      '或改写成单层、引号闭合的形态（如 bash -c "rm -rf ./build"）后重试。',
    secretPath:
      "[danger-guard] 编辑目标是密钥/凭据文件（.ssh、私钥、证书、密钥库）。" +
      "凭据面不由模型直接改动；确需变更请让用户在终端手动操作。",
    indeterminate:
      "[fact-gate] 无法自动验证取证（本会话历史不可得）。若确无法取证，请向用户确认是否放行本次编辑；" +
      "用户同意放行可在设置卡临时关闭「编辑事实门」，编辑完成后再开启。此路径不消耗放行次数。",
    declareTail:
      "动手前还需声明：受影响的公共函数/类型/导出、需同步改的测试/文档、以及逐字引用的用户指令原文。\n" +
      "补齐后重试同一编辑即可——门禁核对会话记录，缺哪几项说哪几项。",
    headRetry: "[fact-gate] 第 {attempt} 轮仍未放行——只缺这 {count} 项（已确认的不再要求）：",
    headNewFile: "[fact-gate] 新建文件免 read，但引用面仍须探（缺一项就一直拒）：",
    headFirst: "[fact-gate] 编辑前先取证（强校验：补齐才放行，缺一项就一直拒）：",
    confirmedLine: "✓ 已确认：{done}",
    listSeparator: "、",
    clauseSeparator: "；",
    hintWrap: "（{hint}）",
    defaultTargetName: "目标文件",
    defaultSearchPath: "项目根",
    gapReadNever: "read {name}：看清当前内容与导出面{hint}",
    gapReadExternal:
      "⚠ {name} 被**本会话之外**改过（另一会话 / bash / sed）——先 read 并确认" +
      '那份改动与本次修改是否冲突再动手；这不是"补一次 read"就完事{hint}',
    gapReadFailed:
      "read {name} 的调用失败过：确认路径是否存在、有无权限（相对路径按会话 cwd 解析）{hint}",
    gapReadNarrow: "read {name}{hint}",
    probePattern: "{tools} 的 path 指向 `{root}`（祖先目录），pattern/include 含 `{name}`",
    probeStrict:
      "{tools} 的 root 指向 `{root}`（祖先目录），query/fts/vector 含 `{name}`（或目标相对路径）",
    gapRefsNever:
      '引用探查（满足任一即计入）：{clauses}，列出所有 import/引用者；无命中写明"无引用"',
    gapRefsToolsEmpty:
      "引用探查：当前设置里没有任何计入取证的检索工具（refSearchTools 为空）——对 {name} 的" +
      "引用探查无法记账，请在设置卡「计入取证的检索工具」里补齐工具名（或直接问用户怎么办）",
    countedToolsEmpty: "可计入的检索工具（refSearchTools 当前为空）",
    gapRefsNarrow:
      "探查作用域不对：你对 {name} 发起的检索只落在**文件自身或兄弟目录**——那只能看到内容，" +
      '看不到"谁引用它"。把 {tools} 的检索起点改指 `{root}` 这类祖先目录，' +
      "签名仍含 `{name}`{hint}",
    gapRefsFailed: "引用探查调用失败（路径不存在？拼错？）：改在 `{root}` 下搜 `{name}`{hint}",
    gapRefsExternal: "在 `{root}` 下探查 `{name}` 的引用者{hint}",
    gapTestBase:
      "test 层触达探查：在 `{root}` 的 tests/|__tests__/|*.test.*|*.spec.* 内搜 `{name}`；" +
      '零命中=确认"无测试触达"{hint}',
    gapTestNarrow:
      "test 层探查落点不对：检索起点需指向 `{root}` 下的 tests/|__tests__/|*.test.*|*.spec.*，" +
      "签名含 `{name}`",
    gapE2e:
      "e2e/集成层触达探查：在 `{root}` 的 e2e/|integration|cypress/|playwright/ 内搜 `{name}`；" +
      '零命中=确认"无此路径"{hint}',
    gapDocs:
      "文档层触达探查：在 `{root}` 的 docs/|*.md|README|CHANGELOG 内搜 `{name}`；" +
      '零命中=确认"文档未提及"{hint}',
    gapNarrowScope: "你此前落在 {paths} 的检索只覆盖局部，看不到引用面",
    gapLayerDir: "层目录：{dir}",
  },
  en: {
    noVerify:
      "[danger-guard] Git hook bypass detected (--no-verify, its abbreviations, or a " +
      "core.hooksPath redirect). It makes the commit skip the pre-commit quality and security " +
      "checks. Drop the flag and commit normally; if a hook cries wolf, fix the hook or agree an " +
      "exemption with the user instead of bypassing it.",
    rmrf:
      "[danger-guard] The target of this rm -rf is the home directory, / or an upward path — it " +
      "would delete user data catastrophically. Clean up with relative paths inside the target " +
      "project (e.g. rm -rf ./build), or confirm with the user first.",
    pipeShell:
      "[danger-guard] Download-and-run pipe detected (curl/wget | sh/bash). Running a remote " +
      "script without auditing it means arbitrary code. Download it first (curl -O), audit the " +
      "content, and execute only after the user confirms.",
    devServer:
      "[danger-guard] This command starts a long-running dev server (dev/watch/vite, …). Inside " +
      "an agent session it hangs the current turn or squats a background job. Use a one-shot " +
      "command instead (build/check/test); when a long-running server really is needed, have the " +
      "user start it in their own terminal.",
    nestedShellUnconfirmed:
      "[danger-guard] The `-c` body of this nested shell was never inspected: unbalanced quotes " +
      "truncated it, or the nesting went past the drill-down limit (the overflow never reached " +
      "the checks at all). This is neither 'confirmed dangerous' nor 'confirmed safe' — do not " +
      "retry it verbatim. Paste the command to the user and run it only after they explicitly " +
      'confirm; or rewrite it as one quote-balanced layer (e.g. bash -c "rm -rf ./build") and retry.',
    secretPath:
      "[danger-guard] The edit target is a secret/credential file (.ssh, private keys, " +
      "certificates, keystores). Credentials are not edited by the model; when one really must " +
      "change, have the user do it by hand in a terminal.",
    indeterminate:
      "[fact-gate] Evidence cannot be verified automatically (this session's history is " +
      "unavailable). If gathering it really is impossible, ask the user whether to allow this " +
      "edit; once they agree, temporarily turn off the fact gate on the settings card and turn it " +
      "back on after the edit. This path does not consume the release quota.",
    declareTail:
      "Before editing, also declare: the public functions/types/exports affected, the tests/docs " +
      "that must be updated in lockstep, and the user's instruction quoted verbatim.\nRetry the " +
      "same edit once those are in place — the gate checks the session record and names exactly " +
      "what is still missing.",
    headRetry:
      "[fact-gate] Attempt {attempt} still not allowed — only these {count} item(s) are missing " +
      "(confirmed ones are not asked again):",
    headNewFile:
      "[fact-gate] New files are exempt from read, but the reference surface still has to be " +
      "probed (denied while any item is missing):",
    headFirst:
      "[fact-gate] Gather the facts before editing (strict: allowed only when complete, denied " +
      "while any item is missing):",
    confirmedLine: "✓ confirmed: {done}",
    listSeparator: ", ",
    clauseSeparator: "; ",
    hintWrap: " ({hint})",
    defaultTargetName: "the target file",
    defaultSearchPath: "the project root",
    gapReadNever: "read {name}: review its current content and export surface{hint}",
    gapReadExternal:
      "⚠ {name} was changed **outside this session** (another session / bash / sed) — read it " +
      "first and check that change against this edit before you touch anything; a token re-read " +
      "is not what this is about{hint}",
    gapReadFailed:
      "The read of {name} failed before: check whether the path exists and is readable " +
      "(relative paths resolve against the session cwd){hint}",
    gapReadNarrow: "read {name}{hint}",
    probePattern:
      "point the path of {tools} at `{root}` (an ancestor directory) and put `{name}` in " +
      "pattern/include",
    probeStrict:
      "point the root of {tools} at `{root}` (an ancestor directory) and put `{name}` (or the " +
      "target's relative path) in query/fts/vector",
    gapRefsNever:
      "Reference probe (any one of these counts): {clauses} — then list every importer/" +
      'referrer; on zero hits, state "no references"',
    gapRefsToolsEmpty:
      "Reference probe: no search tool currently counts towards evidence (refSearchTools is " +
      "empty), so a reference probe of {name} can never be credited — add tool names under " +
      "'Search tools counted as evidence' on the settings card (or just ask the user what to do)",
    countedToolsEmpty: "a counted search tool (refSearchTools is currently empty)",
    gapRefsNarrow:
      "Wrong scope: the searches you ran for {name} only landed on **the file itself or a " +
      "sibling directory** — that shows content, not who references it. Point the search root of " +
      "{tools} at an ancestor directory such as `{root}` and keep `{name}` in the signature{hint}",
    gapRefsFailed:
      "The reference probe failed (path does not exist? typo?): search for `{name}` under " +
      "`{root}` instead{hint}",
    gapRefsExternal: "Probe who references `{name}`, searching from `{root}`{hint}",
    gapTestBase:
      "Test-layer probe: search `{name}` inside the tests/|__tests__/|*.test.*|*.spec.* of " +
      '`{root}`; zero hits = confirm "no test touches it"{hint}',
    gapTestNarrow:
      "The test-layer probe landed in the wrong place: the search root has to point at the " +
      "tests/|__tests__/|*.test.*|*.spec.* under `{root}`, with `{name}` in the signature",
    gapE2e:
      "E2E/integration-layer probe: search `{name}` inside the e2e/|integration|cypress/|" +
      'playwright/ of `{root}`; zero hits = confirm "no such path"{hint}',
    gapDocs:
      "Docs-layer probe: search `{name}` inside the docs/|*.md|README|CHANGELOG of `{root}`; " +
      'zero hits = confirm "the docs never mention it"{hint}',
    gapNarrowScope:
      "Your earlier searches only covered {paths}, which cannot show the reference surface",
    gapLayerDir: "layer directory: {dir}",
  },
};
