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
// 形状单源在零依赖的 ./fix.ts（**不能**从 ./danger-rules.ts 借：那会把它拖进客户端的
// 类型程序，而它导的是 node:os/node:path —— 实测 TS2591 `Cannot find name 'node:os'`）。
// 这里只为了类型编译期绑住「角色 → 模板」那张表。
import type { Fix } from "./fix.ts";

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
  // ── 出路（`Fix` 的单行渲染；见 renderFix）────────────────────────────────────
  /** 绕过旗标档：点名命令里哪几枚（短旗标簇里则是其中哪个字母）越界（槽位 values）。 */
  readonly fixBypassFlag: string;
  /** 灾难目标档：点名哪几个目标触发判据（槽位 values）。 */
  readonly fixDisasterTarget: string;
  // ── bash / 编辑闸的拒绝理由（lib/danger-rules.ts）───────────────────────
  /** git 钩子绕过（--no-verify 及缩写 / core.hooksPath）。 */
  readonly noVerify: string;
  /** 灾难性 rm 目标（家目录 / 根 / 上跳）。 */
  readonly rmrf: string;
  /** 下载即执行管道（curl|sh 家族）。 */
  readonly pipeShell: string;
  /** 长驻开发服务器。 */
  readonly devServer: string;
  /** 执行面里那条命令没被检查到（嵌套 shell 的 `-c` 体、解释器的代码串、超出长度上限的输入）
   *  → 需用户确认。 */
  readonly nestedShellUnconfirmed: string;
  // ── git 破坏族（A1；全部 `ask` 档）─────────────────────────────────────────────
  /** `git reset --hard`（丢弃未提交改动）。 */
  readonly gitResetHard: string;
  /** `git checkout -- <path>` / `git checkout .`（丢弃路径改动）。 */
  readonly gitCheckoutDiscard: string;
  /** `git restore <path>`（丢弃工作区改动）。 */
  readonly gitRestoreDiscard: string;
  /** `git clean -f*`（删未跟踪文件）。 */
  readonly gitCleanForce: string;
  /** `git stash drop|clear`（丢 stash）。 */
  readonly gitStashDrop: string;
  /** `git branch -D`（强删分支）。 */
  readonly gitBranchDelete: string;
  /** `git push --force` 家族（重写远端）。 */
  readonly gitForcePush: string;
  // ── 基础设施破坏族（A2；全部 `ask` 档）─────────────────────────────────────────
  /** `terraform destroy`。 */
  readonly tfDestroy: string;
  /** `terraform apply -auto-approve`。 */
  readonly tfAutoApprove: string;
  /** `docker * prune`。 */
  readonly dockerPrune: string;
  /** `kubectl delete`。 */
  readonly kubectlDelete: string;
  /** 数据库迁移命令。 */
  readonly dbMigrate: string;
  // ── 爆炸半径预演（`ask` 档专属：把操作前的可确定状态量给用户看）──────────────────
  /** 预演块头（槽位 command/body）。文案要把探针定位成**操作前状态**，不是完整影响清单。 */
  readonly blastHead: string;
  /** 预演零输出：只说明探针没打印，**不能**证明原操作不会改动任何东西（槽位 command）。 */
  readonly blastEmpty: string;
  /** 预演输出被上限收紧（槽位 chars/lines）。 */
  readonly blastClip: string;
  /** 编辑目标是密钥/凭据文件。 */
  readonly secretPath: string;
  /** 编辑目标长到没法判（超出可判定长度上限）→ 需用户确认。 */
  readonly opaqueTarget: string;
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
  /** 配额被扣下时多一行（缺项里还有 `read`：配额只免上层探查，read 不在豁免内）。 */
  readonly quotaWithheld: string;
  /** 已确认项清单行（槽位 done）。 */
  readonly confirmedLine: string;
  /** 已确认项的可读名（`need` 内部键 → 当前语言）。 */
  readonly needLabelRead: string;
  readonly needLabelRefs: string;
  readonly needLabelTest: string;
  readonly needLabelE2e: string;
  readonly needLabelDocs: string;
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
  // ── 预检（Phase 2：证据在编辑**之前**就到模型手里，见 host.ts 的 A/B 两个触发点）──────
  // 这一组不是"缺什么"的指令，而是"已经补上了"的**证据正文**：它的读者是模型（改主意前先看
  // 事实），与上面那组指令共用同一份双语字典，理由也相同——host 侧没有官方 i18n 面。
  /** A 面头部：引用面随本次**读取结果**一起给出（post-execute 的 additionalContexts），
   *  于是模型下一次编辑前就看得见它，而不是被拒后再自己去查。 */
  readonly preflightAttach: string;
  /** B 面头部：盲改（没 read 过就写）被当场停下，正文与引用面写在这一次的拒绝理由里。
   *  尾句是"原样重试同一次编辑"——水位已记，重试即放行。 */
  readonly preflightHandoff: string;
  /** 引用块·有命中（槽位 root/scanned/hits）。 */
  readonly preflightRefsHead: string;
  /** 引用块·零命中且**整趟扫完**（槽位 root/scanned）：空列表不是结论，这句话才是。 */
  readonly preflightRefsNone: string;
  /** 引用块·零命中但**未扫完**（槽位 root/scanned/limit）：全称结论此刻不成立，
   *  说出来就是在骗模型——它据此删掉一个仍有引用者的文件比没给证据更糟。 */
  readonly preflightRefsNonePartial: string;
  /** 引用块的一行命中（槽位 file/line/text）。 */
  readonly preflightRefsLine: string;
  /** 引用块·遍历被文件/目录预算截断的说明行（槽位 limit）。 */
  readonly preflightRefsPartial: string;
  /** 引用块·命中条数达上限的说明行（槽位 limit）：列出的只是前若干处，不是全部。 */
  readonly preflightRefsCapped: string;
  /** 引用块·零命中但有凭据面文件被隔离未读（槽位 root/scanned/count）：
   *  这时"没有任何引用者"仍然不成立——结论的范围不包括被隔离的那几份。 */
  readonly preflightRefsNoneQuarantined: string;
  /** 引用块·零命中但**有走到了却没能读正文的文件**（超大 / 读不动；槽位 root/scanned/count）：
   *  这与隔离是两件事——那几份没被规则排除，只是这次没读到，里面完全可能写着引用。
   *  `complete` 只说明遍历没被预算截断，说明不了这件事。 */
  readonly preflightRefsNoneUnread: string;
  /** 引用块·有命中且有凭据面文件被隔离的说明行（槽位 count）：命中面可能不止这些。 */
  readonly preflightRefsQuarantined: string;
  /** 层探查一行（槽位 layer/dir/hits）：与引用面**同一次**扫描派生，不另花 I/O。 */
  readonly preflightLayerLine: string;
  /** 目标内容块头（槽位 name/bytes）。 */
  readonly preflightReadHead: string;
  /** 目标内容超单文件上限的说明行（槽位 bytes）。 */
  readonly preflightReadTruncated: string;
  /** A 面注入消息的 `source.summary`（官方要求 notice 形必须带一行说明，≤120 字）。 */
  readonly preflightSummary: string;
  // ── 权限档位说明（同一枚规则键在不同预设下成因不同，见 lib/mode-policy.ts）──────────
  /** 仅可查看档：沙箱拒一切写，我们只补沙箱盖不到的那些面。 */
  readonly noteReadOnly: string;
  /** 工作区内修改档：沙箱允许改工作区、但不提供原子性，于是包住可写根的删除要我们拦。 */
  readonly noteWorkspaceWrite: string;
  /** 完全权限档（带 reviewer）：只留两条确定性硬拦，其余交给 reviewer。 */
  readonly noteFullAccess: string;
  /** 读不到沙箱模式：按保守列处置，没有沙箱兜底。 */
  readonly noteUnknown: string;
  /** 本来要问、但这档问不了（审批策略为 never）时的降级说明：给换档出路。 */
  readonly askBlockedGeneric: string;
}

export const MESSAGES: MessagesCatalog<DangerGuardMessages> = {
  zh: {
    fixBypassFlag:
      "出问题的是这几枚：{values}。把它们从命令里去掉后重试同一操作（若它在短旗标簇里，" +
      "去掉的是**簇内对应的那个字母**，其余字母是真旗标，别一起删）。",
    fixDisasterTarget:
      "被判灾难的是这几个目标：{values}。把**它们**换成项目内的相对路径（例如 ./build）后重试；" +
      "命令里其余目标是安全的，不必跟着改。",
    gitResetHard:
      "[danger-guard] `git reset --hard` 会丢弃工作区与索引里**所有未提交的改动**" +
      "（未跟踪文件不动），且不可撤销；带 `<ref>` 时还会把当前分支移到该提交、工作区随之回退。" +
      "先 `git stash push -u` 把改动收起来（之后 `git stash pop` 拿回来）再重置；" +
      "确实要重来时请用户确认，审批通过即执行。",
    gitCheckoutDiscard:
      "[danger-guard] 这条 `git checkout` 会**丢弃** `--` 之后那些路径的未提交改动。" +
      "先 `git diff <path>` 看清要丢的是什么，或 `git stash push <path>` 存一份再丢；" +
      "也可请用户确认。",
    gitRestoreDiscard:
      "[danger-guard] `git restore` 把工作区文件还原到 HEAD/索引的版本，**当前改动就此丢失**。" +
      "只想去掉暂存而不动工作区时用 `--staged` 单用（那条不丢内容）；" +
      "要丢内容时先 `git stash push` 或 `git diff` 看一眼，或请用户确认。",
    gitCleanForce:
      "[danger-guard] `git clean -f` 删除未跟踪文件；带 `-x` 连 `.gitignore` 里的一起删。" +
      "先跑 `git clean -nd`（`-n` 只打印清单、不删）确认无误会再执行，或请用户确认。",
    gitStashDrop:
      "[danger-guard] `git stash drop`/`clear` 永久丢掉 stash 条目，没有回收站。" +
      "先 `git stash list` 看清是哪一条、必要时 `git stash apply` 先落一份再删；" +
      "或请用户确认。",
    gitBranchDelete:
      "[danger-guard] `git branch -D` 强删分支：未合并的提交会失去那个分支引用" +
      "（reflog 里还能捞，但不该指望）。先 `git branch --merged` 看它是否已合并；" +
      "或请用户确认。",
    gitForcePush:
      "[danger-guard] 强制推送会**重写远端分支历史**，别人的本地副本会与它分叉。" +
      "只是不想覆盖别人的提交时用 `--force-with-lease`；确属 rebase 后的常规强推，" +
      "请用户确认后执行。",
    tfDestroy:
      "[danger-guard] `terraform destroy` 会删掉这个 state 里的**全部**资源，" +
      "而且删除顺序由依赖图决定、不可撤销。先 `terraform plan -destroy` 看清会删什么；" +
      "只删一部分用 `-target=`；确实要整体销毁时请用户确认后执行。",
    tfAutoApprove:
      "[danger-guard] `-auto-approve` 跳过 terraform 自己那道交互确认 —— " +
      "apply 的后果不再经过任何人过目。先 `terraform plan` 看一遍再决定；" +
      "或去掉该旗标，让 terraform 自己问你。",
    dockerPrune:
      "[danger-guard] `docker … prune` 删掉未使用的镜像/容器/卷/网络；`-a`/`--all` " +
      '把"未使用"扩到"没在跑的"（包含别人正在用的镜像层与数据卷）。' +
      "先 `docker system df` 看占用，支持 `--dry-run` 的版本先加它打印一遍；" +
      "或请用户确认。",
    kubectlDelete:
      "[danger-guard] `kubectl delete` 删集群对象（Pod/Deployment/PVC/Namespace…），" +
      "删 PVC 与 Namespace 会连带数据。先 `kubectl get <类型> <名字> -o yaml` 看清对象，" +
      "或用 `--dry-run=client` 预演；或请用户确认。",
    dbMigrate:
      "[danger-guard] 数据库迁移会改动 schema，而多数迁移不可逆（丢列/丢表尤其）。" +
      "先跑各工具自己的干跑看清将执行的语句：`manage.py migrate --plan`、" +
      "`prisma migrate diff`、`alembic upgrade --sql`、`flyway migrate` 前先 `flyway info`；" +
      "确认前先备份；或请用户确认。",
    blastHead: "[预演] 操作前状态参考 `{command}`（只读）：\n{body}",
    blastEmpty:
      "[预演] `{command}` 没有任何输出 —— 这只说明这条检查命令此刻没有可打印的内容，" +
      "**不能证明原操作不会改动任何东西**。请结合原命令判断。",
    blastClip: "（输出已按上限收紧到 {lines} 行 / {chars} 字符）",
    noVerify:
      "[danger-guard] 检测到 git 钩子绕过（--no-verify 及其缩写 -n / core.hooksPath 重定向）。" +
      "它会让提交跳过 pre-commit 质量与安全检查。请移除该旗标正常提交；" +
      "若钩子误报，先修钩子或与用户确认豁免，不要绕过。",
    rmrf:
      "[danger-guard] rm -rf 的目标是家目录本身、家目录直接子项、根或上跳路径，会灾难性删除用户数据。" +
      "请在目标项目目录内做相对路径清理（如 rm -rf ./build），或先与用户确认。",
    pipeShell:
      '[danger-guard] 检测到"下载即执行"管道（curl/wget | sh/bash）。' +
      "远程脚本未审计即执行有任意代码风险。请先下载到本地（curl -O），" +
      "审计内容并经用户确认后再执行。",
    devServer:
      "[danger-guard] 该命令会启动长驻开发服务器（dev/watch/vite 等）。" +
      "前台跑它会把这一回合挂住到超时为止。两条出路：①确需长驻服务时，**带 " +
      "`run_in_background: true` 重试**——宿主的作业面会立刻返回 job id 并施加 " +
      "`job_output` / `job_kill` 管它，不设时限；②改用一次性命令（build/check/test）。" +
      "（由用户在自己的终端启动当然也可以。）",
    nestedShellUnconfirmed:
      "[danger-guard] 这条命令真正要执行的那段内容**未被检查**：嵌套 shell 的 `-c` 体因引号不闭合被" +
      "截断、套娃层数超出下钻上限（嵌套 `-c` 与 `$( )` 命令替换各自有一道层数界）、段头是取代码串再" +
      "执行的解释器（python -c / node -e / perl -e 等，语言层的动作不在命令词法面上）、" +
      "或命令长度超出可判定上限。" +
      "这不是「已确认危险」也不是「已确认安全」——请勿原样重试，" +
      "把它贴给用户、由用户显式确认后再执行；" +
      '或改写成单层、引号闭合、直白可读的形态（如 bash -c "rm -rf ./build"）后重试。' +
      "若是解释器代码串那一类（python -c / node -e / perl -e），把代码写进文件再执行" +
      "（如 python3 script.py），或改用 read / grep / glob 这类本机工具完成同样的读取。",
    secretPath:
      "[danger-guard] 编辑目标是密钥/凭据文件（.ssh、私钥、证书、密钥库）。" +
      "凭据面不由模型直接改动；确需变更请让用户在终端手动操作。",
    opaqueTarget:
      "[danger-guard] 编辑目标的路径长到无法判定（超出可判定长度上限），既没确认为凭据文件、" +
      "也没确认不是。请勿原样重试，把目标路径贴给用户确认；或改用正常的短路径。",
    indeterminate:
      "[fact-gate] 无法自动验证取证（本会话历史不可得）。若确无法取证，请向用户确认是否放行本次编辑；" +
      "用户同意放行可在设置卡临时关闭「编辑事实门」，编辑完成后再开启。此路径不消耗放行次数。",
    declareTail:
      "动手前还需声明：受影响的公共函数/类型/导出、需同步改的测试/文档、以及逐字引用的用户指令原文。\n" +
      "补齐后重试同一编辑即可——门禁核对会话记录，缺哪几项说哪几项。",
    headRetry: "[fact-gate] 第 {attempt} 轮仍未放行——只缺这 {count} 项（已确认的不再要求）：",
    headNewFile: "[fact-gate] 新建文件免 read，但引用面仍须探（缺一项就一直拒）：",
    headFirst: "[fact-gate] 编辑前先取证（强校验：补齐才放行，缺一项就一直拒）：",
    quotaWithheld:
      "· 注意：配额放行只免**上层探查**（引用面与各层），read 不在豁免内——先读过目标原文再重试即可（读一次就够）。",
    confirmedLine: "✓ 已确认：{done}",
    needLabelRead: "read",
    needLabelRefs: "引用探查",
    needLabelTest: "test 层",
    needLabelE2e: "e2e 层",
    needLabelDocs: "文档层",
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
    preflightAttach:
      "[fact-gate] 本次读取的引用面已由插件一并探好，随这条结果一起给你——后续编辑该文件时" +
      "不必再自行检索引用。",
    preflightHandoff:
      "[fact-gate] 这次编辑先停下：以下是门禁本就要求你在改动**之前**看到的事实，插件已当场取到。" +
      "请**原样重试同一次编辑**（无需改动参数），重试即放行。",
    preflightRefsHead:
      "[引用探查] 起点 `{root}`，扫过 {scanned} 个文件，{hits} 处命中（按目标文件名与其词干匹配）：",
    preflightRefsNone:
      "[引用探查] 起点 `{root}`，扫过 {scanned} 个文件，零命中——即目标没有任何引用者。",
    preflightRefsNonePartial:
      "[引用探查] 起点 `{root}`，扫过 {scanned} 个文件（达 {limit} 上限即停，**未扫完**），" +
      "已扫范围内零命中——这并不等于「目标没有任何引用者」。",
    preflightRefsLine: "· {file}:{line}: {text}",
    preflightRefsPartial:
      "注意：遍历在 {limit} 处上限停下，未覆盖整个 `{root}`——以上只是已扫范围内的结论。",
    preflightRefsCapped: "注意：命中已达 {limit} 条上限，以上只是前若干处，不是全部。",
    preflightRefsNoneQuarantined:
      "[引用探查] 起点 `{root}`，扫过 {scanned} 个文件，另有 {count} 个凭据面文件按本包规则未读，" +
      "已读范围内零命中——这不等于「目标没有任何引用者」。",
    preflightRefsNoneUnread:
      "[引用探查] 起点 `{root}`，扫过 {scanned} 个文件，另有 {count} 个文件走到了但没能读正文" +
      "（超大 / 读不动），已读范围内零命中——这不等于「目标没有任何引用者」。",
    preflightRefsQuarantined:
      "注意：本次扫描按本包规则未读 {count} 个凭据面文件，命中面可能不止以上这些。",
    preflightLayerLine:
      "[层探查] {layer}：`{dir}` 内 {hits} 处命中（与上面同一次扫描，不必再去那层搜一遍）",
    preflightReadHead: "[目标内容] `{name}`（{bytes} 字节）：",
    preflightReadTruncated: "[已截断] 原文超过单文件上限 {bytes} 字节，以上仅是开头部分。",
    preflightSummary: "danger-guard 预检：随本次读取附上目标的引用面",
    noteReadOnly:
      "[档位] 当前是「仅可查看」：文件写入由宿主的只读沙箱统一拒绝，这一层不重复拦写。" +
      "上面那条属于沙箱管不到的面（命令形态、网络/进程、远端状态），所以由本插件补。",
    noteWorkspaceWrite:
      "[档位] 当前是「工作区内修改」：沙箱允许改工作区，但它是路径白名单、**不提供原子性**" +
      "——先落下的删除不会因为后面的越界被拒而回滚，所以「包住可写根」的删除由我们提前拦。",
    noteFullAccess:
      "[档位] 当前是「完全访问」：本档沙箱不拦文件效应，所以写面要靠别处兜。" +
      "这一层只保留少数几条与沙箱无关的确定性硬拦（如灾难删除、下载即执行、绕过 git 钩子），" +
      "其余动作交给下游——本档不逐条问，问了也不会有人答。",
    noteUnknown:
      "[档位] 认不出宿主的沙箱模式：这个部署没有可约束的执行器、服务形状不符，" +
      "或模式名不在本包认识的集合里（宿主新增了模式）。按最保守口径处置，不假设有沙箱兜底。",
    askBlockedGeneric:
      "[档位] 这条本应弹审批问你，但当前档位**不允许询问**（审批策略为 never，宿主会在任何应答者之前" +
      "直接拒绝）。要么把动作改写成不需要确认的形态（见上面每条给出的做法），" +
      "要么把审批策略改成会询问（或换到会询问的档位）再执行——请不要再原样重试这一类命令。",
  },
  en: {
    fixBypassFlag:
      "These are the offending flag(s): {values}. Remove them from the command and retry the same " +
      "operation (when one of them sits inside a short flag cluster, drop **that letter** — the " +
      "other letters are real flags, don't delete them too).",
    fixDisasterTarget:
      "These targets triggered the disaster rule: {values}. Replace **them** with " +
      "project-relative paths (e.g. ./build) and retry; the command's other targets are safe " +
      "and need no change.",
    gitResetHard:
      "[danger-guard] `git reset --hard` discards **every uncommitted change** in the working " +
      "tree and the index (untracked files stay), and it cannot be undone; with `<ref>` it also " +
      "moves the current branch to that commit and rolls the working tree back with it. Stash " +
      "first (`git stash push -u`, recover with `git stash pop`) and then reset; when the reset " +
      "really is wanted, ask the user — approval runs it.",
    gitCheckoutDiscard:
      "[danger-guard] This `git checkout` **discards** the uncommitted changes of the paths after " +
      "`--`. Look first with `git diff <path>`, or keep a copy with `git stash push <path>`; " +
      "asking the user works too.",
    gitRestoreDiscard:
      "[danger-guard] `git restore` puts working-tree files back to the HEAD/index version — " +
      "**the current changes are gone**. To only unstage without touching the working tree, use " +
      "`--staged` alone (that form keeps content); to discard content, look with " +
      "`git stash push` / `git diff` first, or ask the user.",
    gitCleanForce:
      "[danger-guard] `git clean -f` deletes untracked files; with `-x` it also deletes what " +
      "`.gitignore` covers. Run `git clean -nd` first (`-n` prints the list without deleting), " +
      "or ask the user.",
    gitStashDrop:
      "[danger-guard] `git stash drop`/`clear` throws stash entries away for good — there is no " +
      "trash bin. Check `git stash list` to see which one it is, land a copy with " +
      "`git stash apply` when in doubt, or ask the user.",
    gitBranchDelete:
      "[danger-guard] `git branch -D` force-deletes a branch: unmerged commits lose that " +
      "reference (reflog can still find them, but do not count on it). Check " +
      "`git branch --merged` first, or ask the user.",
    gitForcePush:
      "[danger-guard] A force push **rewrites the remote branch history**, so everyone else's " +
      "local copy diverges from it. Use `--force-with-lease` when the point is merely not to " +
      "clobber others' commits; for a plain post-rebase force push, ask the user first.",
    tfDestroy:
      "[danger-guard] `terraform destroy` deletes **every** resource in this state, in " +
      "dependency-graph order, and it cannot be undone. Look first with " +
      "`terraform plan -destroy`; narrow it with `-target=`; ask the user before destroying " +
      "the whole thing.",
    tfAutoApprove:
      "[danger-guard] `-auto-approve` skips terraform's own interactive confirmation — the " +
      "consequences of the apply pass nobody's eyes. Run `terraform plan` first, or drop the " +
      "flag and let terraform ask you.",
    dockerPrune:
      "[danger-guard] `docker … prune` deletes unused images/containers/volumes/networks; " +
      '`-a`/`--all` widens "unused" to "not currently running" (which includes image layers ' +
      "and volumes someone else is using). Check `docker system df` first, add `--dry-run` on " +
      "versions that support it, or ask the user.",
    kubectlDelete:
      "[danger-guard] `kubectl delete` removes cluster objects (Pod/Deployment/PVC/Namespace…), " +
      "and deleting a PVC or a Namespace takes data with it. Look first with " +
      "`kubectl get <kind> <name> -o yaml`, rehearse with `--dry-run=client`, or ask the user.",
    dbMigrate:
      "[danger-guard] A database migration changes the schema, and most migrations are " +
      "irreversible (dropped columns and tables especially). Run the tool's own dry run to see " +
      "the statements first: `manage.py migrate --plan`, `prisma migrate diff`, " +
      "`alembic upgrade --sql`, `flyway info` before `flyway migrate`. Back up before " +
      "confirming, or ask the user.",
    blastHead: "[rehearsal] Pre-operation state reference `{command}` (read-only):\n{body}",
    blastEmpty:
      "[rehearsal] `{command}` printed nothing — this only means the probe had nothing to print " +
      "right now; **it does not prove the original action changes nothing**. Judge it against " +
      "the original command.",
    blastClip: "(output clipped to the {lines}-line / {chars}-character cap)",
    noVerify:
      "[danger-guard] Git hook bypass detected (--no-verify, its abbreviations, or a " +
      "core.hooksPath redirect). It makes the commit skip the pre-commit quality and security " +
      "checks. Drop the flag and commit normally; if a hook cries wolf, fix the hook or agree an " +
      "exemption with the user instead of bypassing it.",
    rmrf:
      "[danger-guard] The target of this rm -rf is the home directory itself, a direct child of it, / or an upward path — it " +
      "would delete user data catastrophically. Clean up with relative paths inside the target " +
      "project (e.g. rm -rf ./build), or confirm with the user first.",
    pipeShell:
      "[danger-guard] Download-and-run pipe detected (curl/wget | sh/bash). Running a remote " +
      "script without auditing it means arbitrary code. Download it first (curl -O), audit the " +
      "content, and execute only after the user confirms.",
    devServer:
      "[danger-guard] This command starts a long-running dev server (dev/watch/vite, …). Run in " +
      "the foreground it blocks this turn until it times out. Two ways out: (1) when the server " +
      "really is needed, **retry with `run_in_background: true`** — the host's job surface returns " +
      "a job id immediately, imposes no deadline, and hands you `job_output` / `job_kill`; " +
      "(2) use a one-shot command instead (build/check/test). Having the user start it in their " +
      "own terminal works too.",
    nestedShellUnconfirmed:
      "[danger-guard] The part this command actually executes was never inspected: the `-c` body " +
      "of a nested shell was truncated by unbalanced quotes, the nesting went past the drill-down " +
      "limit (nested `-c` bodies and `$( )` substitutions each carry their own depth cap), the " +
      "segment head is an interpreter that runs a code string (python -c / node -e / " +
      "perl -e, … — what that language does is not visible at the command-lexer level), or the " +
      "command is longer than the judgable limit. This is neither 'confirmed dangerous' nor " +
      "'confirmed safe' — do not retry it verbatim. Paste it to the user and run it only after " +
      'they explicitly confirm; or rewrite it as one plain, quote-balanced layer (e.g. bash -c "rm -rf ./build") and retry. ' +
      "For the interpreter case (python -c / node -e / perl -e), put the code in a file and run it " +
      "(e.g. python3 script.py), or use a built-in tool (read / grep / glob) for the same read.",
    secretPath:
      "[danger-guard] The edit target is a secret/credential file (.ssh, private keys, " +
      "certificates, keystores). Credentials are not edited by the model; when one really must " +
      "change, have the user do it by hand in a terminal.",
    opaqueTarget:
      "[danger-guard] The edit target path is too long to judge (past the judgable length limit): " +
      "it is neither confirmed nor cleared as a credential file. Do not retry it verbatim — paste " +
      "the path to the user to confirm, or use a normal short path.",
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
    quotaWithheld:
      "· Note: the release quota only waives the **higher probes** (references and each layer); read is never waived - read the target once, then retry.",
    confirmedLine: "✓ confirmed: {done}",
    needLabelRead: "read",
    needLabelRefs: "references",
    needLabelTest: "test layer",
    needLabelE2e: "e2e layer",
    needLabelDocs: "docs layer",
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
    preflightAttach:
      "[fact-gate] The plugin has probed the reference surface for the file you just read and " +
      "attaches it to this result — you will not need to search for references again before " +
      "editing it.",
    preflightHandoff:
      "[fact-gate] This edit is paused: below are the facts the gate requires you to see " +
      "**before** changing anything; the plugin gathered them for you on the spot. Retry the " +
      "exact same edit (do not change the arguments) — the retry will be allowed.",
    preflightRefsHead:
      "[reference probe] root `{root}`, {scanned} file(s) scanned, {hits} hit(s) (matched " +
      "against the target's file name and stems):",
    preflightRefsNone:
      "[reference probe] root `{root}`, {scanned} file(s) scanned, zero hits — i.e. nothing " +
      "references the target.",
    preflightRefsNonePartial:
      "[reference probe] root `{root}`, {scanned} file(s) scanned (the {limit}-file budget was " +
      "exhausted, so the tree is NOT fully covered), zero hits within what was scanned — which " +
      "does not mean nothing references the target.",
    preflightRefsLine: "· {file}:{line}: {text}",
    preflightRefsPartial:
      "Note: the walk stopped at its {limit} budget and did not cover all of `{root}` — the " +
      "above only describes what was scanned.",
    preflightRefsCapped:
      "Note: the hit list reached its {limit}-entry cap; the lines above are not all of them.",
    preflightRefsNoneQuarantined:
      "[reference probe] root `{root}`, {scanned} file(s) scanned; {count} credential-path " +
      "file(s) were deliberately not read, and there were zero hits among what was read — which " +
      "does not mean nothing references the target.",
    preflightRefsNoneUnread:
      "[reference probe] root `{root}`, {scanned} file(s) scanned; {count} file(s) were reached " +
      "but their text could not be read (too large / unreadable), and there were zero hits among " +
      "what was read — which does not mean nothing references the target.",
    preflightRefsQuarantined:
      "Note: this scan skipped {count} credential-path file(s) by design, so the surface above " +
      "may not list every reference.",
    preflightLayerLine:
      "[layer probe] {layer}: {hits} hit(s) under `{dir}` (from the same scan as above — no " +
      "separate search needed there)",
    preflightReadHead: "[target content] `{name}` ({bytes} bytes):",
    preflightReadTruncated:
      "[truncated] the original is larger than the {bytes}-byte per-file limit; only its head is " +
      "shown above.",
    preflightSummary: "danger-guard preflight: reference surface attached to this read result",
    noteReadOnly:
      '[mode] This is "read-only": the host\'s read-only sandbox refuses every file write, so this ' +
      "layer does not re-block writes. The rule above covers a face the sandbox cannot reach " +
      "(command shape, network / process, remote state), which is why this package still judges it.",
    noteWorkspaceWrite:
      '[mode] This is "workspace-write": the sandbox permits writing inside the workspace, but it ' +
      "is a path allow-list and provides **no atomicity** - a deletion that already happened is not " +
      "rolled back because a later part was refused outside the boundary. So a deletion that " +
      "encloses a writable root is stopped here first.",
    noteFullAccess:
      "[mode] This is full access: this mode's sandbox does not restrict file effects, so the " +
      "write surface has to be caught elsewhere. This layer keeps only a few deterministic hard " +
      "stops that have nothing to do with the sandbox (catastrophic deletion, " +
      "download-and-execute, bypassing git hooks); everything else is left to the downstream " +
      "sandbox - this preset does not ask per action, and asking would reach nobody.",
    noteUnknown:
      "[mode] The host's sandbox mode is unrecognised: this deployment has no confining executor, " +
      "the service shape differs, or the mode name is outside the set this package knows (the host " +
      "added one). The conservative column applies and no sandbox is assumed to be backing this " +
      "layer.",
    askBlockedGeneric:
      "[mode] This should have prompted the user, but the current preset does **not allow asking** " +
      "(the approval policy is never, so the host rejects before any answerer runs). Either rewrite " +
      "the action into a form that needs no confirmation (see the guidance above for each rule), or " +
      "change the approval policy to one that asks (or switch to a preset that asks) before running " +
      "it - do not retry this kind of command verbatim.",
  },
};

/**
 * 一条 `Fix` 渲染成**单独一行**（宿主把它接在拒绝理由之后）。
 *
 * 「角色 → 用哪句模板」这张表收在这里而不是调用点：调用点是 host，而角色集住在
 * `lib/danger-rules.ts`。收在中间这枚模块里，两边各改一处时会当场红——写死在 host
 * 的话，新增角色会静默落进 `fixDisasterTarget` 那一支（两支都是"点名 + 换掉"，
 * 读起来还挺通顺，于是测试也未必抓得住）。
 *
 * `offending` 恒非空：lib 侧两处产出点都在组装前判过长度（空名单交出的是
 * "没有 fix"，不是"有 fix 但没内容"）。
 */
export function renderFix(fix: Fix, messages: DangerGuardMessages): string {
  const template = fix.role === "bypassFlag" ? messages.fixBypassFlag : messages.fixDisasterTarget;
  return fillTemplate(template, { values: fix.offending.join(messages.listSeparator) });
}

/**
 * 一枚键在**全部语言**下的文案，交成官方 `ApprovalRequestEvent.displayReason` 的形状
 * （`{ readonly en: string; readonly [locale: string]: string }`）。
 *
 * 为什么不写 `{ en: MESSAGES.en[key], zh: MESSAGES.zh[key] }`：那与 `MessagesCatalog` 的
 * `Record<Locale, …>` 设计正相反 —— 它的注释明写「键集绑 Locale 而不是手写 `{ zh; en }`：
 * 宿主哪天加一门语言，这两处必须**一起**响」，否则新增那门语言会静默取不到文案
 *（库里的 `messagesFor` 就是为这条才按下标索引而不是二元分派）。这里逐 locale 取，
 * 语言集扩宽时自动跟上；`en` 单独显式写一次，是因为官方把它定成**必填**成员，
 * 而索引签名给不出必填保证。
 */
export const displayReasonOf = (
  key: keyof DangerGuardMessages,
): { en: string; [locale: string]: string } => {
  const out: { en: string; [locale: string]: string } = { en: MESSAGES.en[key] };
  for (const [locale, table] of Object.entries(MESSAGES)) {
    out[locale] = table[key];
  }
  return out;
};
