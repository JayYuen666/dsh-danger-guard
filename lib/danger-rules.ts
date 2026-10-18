// lib/danger-rules.ts —— 危险命令识别：纯函数，无 ctx、无 I/O。
//
// 移植自 ECC（MIT, github.com/affaan-m/ECC）scripts/hooks 的四类拦截：
//   block-no-verify（git 钩子绕过）、dev-server-block（长驻进程）、
//   远程执行（curl|sh 家族）、rm -rf（灾难删除）。
// 按 dsh 语境重写：输入是 bash 工具的 command 字符串，输出命中的规则键。
//
// 设计原则：
// - 保守优先：认不准就放行（false negative 优于 false positive——
//   误拦正常工作流的代价高于漏拦罕见变体）；
// - **唯一例外：shell 的 `-c` 家族不享受"认不准就放行"**。那里"认不准"意味着
//   体内命令**一条都没被检查过**，静默放行等于把闸门交给嵌套 shell 自己决定，
//   故改判「需用户显式确认」（见 BashDenialKey 的 nestedShellUnconfirmed）；
// - 消息面向模型：拒绝理由就是给模型的指令，说明"为什么拦、怎么改"。**这些文案不在本文件**
//  （中英两份单源在 lib/messages.ts）：本文件只做判定、只回传规则键，宿主在 guard 调用点
//  用 `messagesFor(MESSAGES, locale)` 取当前语言的文案。纯函数既不读设置也不带文案，
//  于是"语言从哪来"只有一条路，测试也只需喂键；`DangerGuardMessages[BashDenialKey]`
//  的取值类型让"加了规则忘了写文案"停在编译期，而不是运行时回一个 undefined。
// - 引号感知：单/双引号内的分隔符不切分，避免误伤合法命令；
// - **词法按 POSIX 口径，不按空白**：`git commit "--no-verify"`、`rm "-rf" ~`、`"rm" -rf ~`
//   在真 shell 里都是生效写法（实测真 git 2.54 对前者**钩子未运行且提交成功**），故切词、
//   断段、结构视图三处共用 lib/command-segments.ts 的同一套词法器，不在判据里各自 `/\s+/` 直切；
// - 执行面同判：包装词（sudo/env/time/xargs…）与**嵌套 shell 的 `-c` 体**都不改变命令性质——
//   四类规则对递归取出的体内命令同样适用（下钻深度有界）；段头是 PowerShell 家族时，
//   它的 `-c`/`-Command` 体按 join 语义取出并**强制按 Windows 读法判**（段头就是执行器身份）；
// - 密钥面的目标按**键形**认（`file_path`/`path`/`notebook_path`…），不按工具名认；
//   真实路径（realpath / 后端进程路径）由本包的宿主侧（host.ts）解析后一并送进来，
//   lib 侧不 import `node:fs`——判定因此始终是纯函数，"解析这一步出过错"也算不进结论里。

import os from "node:os";
import path from "node:path";
// 段边界这一层单列在 lib/command-segments.ts：四类规则都只在"段"上判定，断在哪里与判成什么无关。
// 同一个模块也负责切词与结构视图——三处读法必须同源，否则"这一段里有哪些词"会随判据而变。
import { hasUnclosedQuote, lexTokens, splitSegments, structureView } from "./command-segments.ts";
import type { ShellToken } from "./command-segments.ts";
import type { Fix } from "./fix.ts";
// 出路形状住在零依赖的 ./fix.ts（为什么不在本文件：见那枚模块的头部注释）。
export type { Fix, FixRole } from "./fix.ts";

/**
 * 命中规则的标识 = lib/messages.ts 文案表的键（宿主按键取当前语言的拒绝理由，
 * 写清楚替代方案，模型可直接改写命令）。
 * `nestedShellUnconfirmed` 与其余四条的**性质**不同：其余四条 = 已确认命中危险模式
 * （改命令即可），本条 = 看不见里面那条命令（既不是危险也不是安全，只能找人拍板）。
 * 宿主据此把教训上报分成两种签名（危险形态 vs 认不准先确认），不再比对文案字符串。
 */
export type BashDenialKey =
  | "noVerify"
  | "rmrf"
  | "pipeShell"
  | "devServer"
  | "nestedShellUnconfirmed"
  // ── git 破坏族（A1）───────────────────────────────────────────────────────────
  // 与沙箱**零重叠**：这些操作要么动工作区**之内**的文件（沙箱恰恰允许），
  // 要么动远端（网络不在沙箱的 vocabulary 之内）。所以它们全是我们的判据，不让路。
  // 全部落 `ask` 档：官方自带的 `Blast Radius` 示例 mod 对同一批命令的处置也是
  // "量出爆炸半径 → 给用户看 → 用户拍板"，而不是一律拒。
  /** `git reset --hard`：丢弃工作区与索引的未提交改动。 */
  | "gitResetHard"
  /** `git checkout -- <path>` / `git checkout .`：丢弃这些路径的工作区改动。 */
  | "gitCheckoutDiscard"
  /** `git restore <path>`（非 `--staged` 单用）：丢弃工作区改动。 */
  | "gitRestoreDiscard"
  /** `git clean -f*`（无 `-n`）：删除未跟踪文件；带 `-x` 连 gitignore 的一起删。 */
  | "gitCleanForce"
  /** `git stash drop` / `git stash clear`：丢掉 stash 条目（找不回）。 */
  | "gitStashDrop"
  /** `git branch -D`：强删分支（未合并的提交会被挂空）。 */
  | "gitBranchDelete"
  /** `git push -f` / `--force` / `--force-with-lease`：重写远端历史。 */
  | "gitForcePush"
  // ── 基础设施破坏族（A2）───────────────────────────────────────────────────────
  // 与沙箱同样**零重叠**：它们动的是远端系统与本地之外的进程世界，而沙箱只管本机进程的
  // 文件效应（官方原话 "Network and process visibility are outside this vocabulary"）。
  // 全部落 `ask` 档：每一条都有正当用法（删开发环境、清 docker 缓存、发布迁移）。
  /** `terraform destroy`：删掉 state 里的全部资源。 */
  | "tfDestroy"
  /** `terraform apply -auto-approve`：跳过 terraform 自己的交互确认。 */
  | "tfAutoApprove"
  /** `docker * prune`：删未使用的镜像/容器/卷/网络（`-a` 扩到"没在跑的"）。 */
  | "dockerPrune"
  /** `kubectl delete`：删集群对象（`--dry-run` 除外）。 */
  | "kubectlDelete"
  /** 数据库迁移命令（`manage.py migrate` / `prisma migrate` / `rails db:migrate` …）：改 schema。 */
  | "dbMigrate";

/** 密钥/凭据面的判定结论：`secretPath` = 命中凭据形态；
 *  `opaqueTarget` = 目标长到没法判（超出 MAX_JUDGED_PATH_LENGTH），与 bash 侧
 *  `nestedShellUnconfirmed` 同一个道理——看不见就不静默放行。 */
export type EditDenialKey = "secretPath" | "opaqueTarget";

/**
 * 一条拒绝交回宿主的东西：规则键 + 可选的出路（见 `lib/fix.ts` 的 `Fix`）。
 *
 * 为什么 `fix` 是**结构化**的而不是一段中英 prose：本模块是语言无关的（只回规则键，
 * 文案单源在 `lib/messages.ts`）。把话写进 lib 就等于给同一件事开第二份语言面。
 * 形状本身住在那枚零依赖的 `lib/fix.ts` 里（收在那里的理由见该文件头）。
 */
export interface BashVerdict {
  key: BashDenialKey;
  /** 出口**省略键**而非写 `{ fix: undefined }`：本仓开了 exactOptionalPropertyTypes，
   *  两者语义不同，而下游要么整段渲染要么不碰，不必在每一处都判缺席。 */
  fix?: Fix;
}

/**
 * 一枚规则键的**处置档** —— "检测到了什么"（`BashVerdict`）与"该拿它怎么办"是两件事，
 * 这一枚说的是后者。
 *
 * - `deny`：**同步** `ctx.tools.guard` 硬拒，模型拿到 `Error: <理由>`。
 * - `ask`：`tools/pre-execute` 返回 `{ kind: 'ask' }`，宿主经 `ApprovalService` 弹审批，
 *   `allowed-once` 才放行（`dsh-tools` 的 `serviceAsk`）。
 *
 * 为什么必须是**一张表**而不是给 `BashVerdict` 加个字段：
 * 1. `tools.guard` 是**同步**谓词，而 `ApprovalService.request()` 返回 Promise ——
 *    需确认这一档在 guard 里**物理上做不到**，只能落在 pre-execute 瀑布上。
 * 2. 宿主在审批放行之后**仍会再跑一次 guard**（installed dsh-tools `lib/index.js:3239`：
 *    `decision.kind === 'allow' ? this.guardReason(exec) : decision.reason`）。于是只要
 *    同一枚键**同时**被两档认领，用户点了"允许"之后还是会被同步 guard 拒掉 —— 审批形同虚设。
 * 3. 这张表的类型是 `Record<BashDenialKey, RuleTier>`，两条性质由它**结构性**保证：
 *    **加了规则键却忘了定档** = 编译错误；**一枚键同时属于两档** = 同一格塞不进两个值。
 *    所以"硬拒集 ∩ 需确认集 = ∅"不必写一条运行时断言去比对两个投影 ——
 *    那种断言在新增规则时是可以被绕过的（改错一处、断言跟着改错，两边一起绿）。
 */
export type RuleTier = "deny" | "ask";

/**
 * 规则键 → 处置档。**这是唯一的归属面**：guard 与 pre-execute 各自只认自己那一档，
 * 两边读同一张表，因此不可能给出互相打架的结论。
 *
 * ⚠ 新增规则键时**必须**在这里补一格（完整性由 `Record` + tsc 强制）。补之前先问：
 * 这条判据是"已确认危险"（`deny`，出路是改写命令）还是"需用户拍板"（`ask`，
 * 既不是已确认危险也不是已确认安全）？—— 与 `BashDenialKey` 的分档纪律同源。
 *
 * ⚠ `ask` 档在**无 approval channel** 的部署（headless / CI）下**退化**为硬拒：宿主
 * `serviceAsk` 拿到 `unavailable` 就 deny（fail-closed）。方向是刻意的 —— 危险操作在
 * 无人可问时应当被拦下，而不是静默通过。
 */
/**
 * 这些规则键的**判据面**完全落在宿主沙箱的管辖之内（"目标包不住任何可写根"时），
 * 于是那条判据该让给沙箱 —— 它会给出官方认可的拒绝标记与 escalation 路径
 * （`sandbox_permissions` + `justification` → 用户审批），而我们的硬拒会**掐死那条路**
 * （guard 跑在 bash 工具之前，模型连申请的机会都没有）。
 *
 * ⚠ 这里只声明"**这一类判据**归沙箱管"，**实际是否让路由宿主判**：它要读
 * `ctx.shell.sandboxMode` 与 `ctx.sandboxPolicy.resolve()`，而那两枚是部署事实，
 * lib 侧看不到（见 host.ts 的 `sandboxDropsOf`）。两处分开是为了让"哪些判据"这个
 * 纯事实留在语言无关、无 I/O 的这一层。
 *
 * 为什么只有 `rmrf`：
 *  - `pipeShell` 的落点在工作区**之内**（下载到 workspace 是被允许的），网络又在沙箱的
 *    vocabulary 之外（官方原话 "Network and process visibility are outside this vocabulary"）；
 *  - `devServer` 是进程面，同样在 vocabulary 之外；
 *  - `noVerify` 与沙箱无关。
 */
export const SANDBOX_COVERED: ReadonlySet<BashDenialKey> = new Set(["rmrf"]);

export const RULE_TIER: Readonly<Record<BashDenialKey, RuleTier>> = {
  // 已确认危险：命令形态本身就是错的，出路是改写命令（各有 `Fix` 或文案里的静态指示）。
  noVerify: "deny",
  rmrf: "deny",
  pipeShell: "deny",
  devServer: "deny",
  // 认不准那一档 —— **真 `ask`**。它的文案本来就写着"把它贴给用户、由用户显式确认后再
  // 执行"，而旧机制只是把一段话丢回给模型：**模型完全可以无视它直接重试**。改档后变成
  // 宿主审批，模型绕不过去；无 approval channel 的部署下自动退化为硬拒（fail-closed），
  // 与改档前的可观测行为一致（都是"这次调用不执行"）。
  nestedShellUnconfirmed: "ask",
  // ── git 破坏族：**全部 `ask`** ────────────────────────────────────────────────
  // 这一族每一条都有正当用法（`git reset --hard` 是"我就要重来"、`git clean -fdx` 是
  // "清干净重来"、`git push -f` 是 rebase 之后的正常协作），所以按本包的档位纪律它们
  // 都属"需用户拍板"而不是"已确认危险"。官方自带的 `Blast Radius` 示例 mod 对同一批命令
  // 的处置也是"给用户看爆炸半径、用户拍板"—— 与本档同一条思路。
  gitResetHard: "ask",
  gitCheckoutDiscard: "ask",
  gitRestoreDiscard: "ask",
  gitCleanForce: "ask",
  gitStashDrop: "ask",
  gitBranchDelete: "ask",
  gitForcePush: "ask",
  // ── 基础设施破坏族：同样全部 `ask` ───────────────────────────────────────────
  // 删开发环境的 terraform / 清 docker 缓存 / 发布数据库迁移，都是**正当但不可逆**的操作；
  // 判断该不该做属于用户，不属于我们。
  tfDestroy: "ask",
  tfAutoApprove: "ask",
  dockerPrune: "ask",
  kubectlDelete: "ask",
  dbMigrate: "ask",
};

/** git 的命令词（大小写敏感：POSIX 宿主上 `GIT` 是另一个名字；`git.exe` 不判成 git，
 *  与本仓既定的保守口径一致——见测试「nO_VERIFY 前有 git 别名前缀组合」）。 */
const GIT_BIN_NAMES = new Set(["git"]);

/** 支持 --no-verify 的 git 子命令（对齐 ECC block-no-verify 清单）。 */
const GIT_NO_VERIFY_SUBS = new Set(["commit", "push", "merge", "cherry-pick", "rebase", "am"]);

/** `-n` 只对这两个子命令是 --no-verify 的短形式。本机 git 2.54 `git <sub> -h` 逐项实测：
 *  `git commit -n` 与 `git am -n` 都是 --no-verify（am 那栏明写 "bypass pre-applypatch and
 *  applypatch-msg hooks"——**是真钩子绕过**，必须拦）；`git push -n` 是 --dry-run、
 *  `git cherry-pick -n` 是"不提交"、`git rebase -n` 是 --no-stat（rebase 的 --no-verify
 *  没有短形式），都不构成钩子绕过——一并拦会误伤能正常工作的安全形态。 */
const SHORT_N_NO_VERIFY_SUBS = new Set(["commit", "am"]);

/** 长旗标缩写的最小长度：git 接受不歧义的 `--no-verify` 前缀（`--no-veri`/`--no-verif`
 *  实测确实跳过 pre-commit 钩子），缩写同样绕过钩子 → 一并拦。
 *  下限定在 `--no-v`：更短前缀歧义面太大（--no-edit/--no-commit 都以 `--no-` 开头）。
 *  产品决策（复核 + 真实 git 探针）：`--no-v`/`--no-ve`/`--no-ver` 在
 *  `git commit` 上与 `--no-verbose` 歧义、git 自身直接报错（那命令根本跑不起来），
 *  所以「拦下这段前缀」不会误伤任何**能正常工作**的命令——代价只是让模型改用全词。
 *  反向放开它们则要给每个子命令维护一份 option 表才能判歧义，收益为负。 */
const NO_VERIFY_ABBREV_MIN = "--no-v".length;

/** 运行前缀词：提权/包装命令，不改变命令实部（复用 devServer 前缀思路）。
 *  漏一个词就是一个逃逸口（`time npm run dev`、`doas rm -rf /` 曾因此放行）。
 *  `xargs`/`parallel` 也在这张表上：`xargs -I{} git commit --no-verify` 里 git 是**被 xargs
 *  执行的那条命令**，四类规则对它同样成立（此前它们只出现在下载即执行的正则里，与文件头
 *  "包装词同判"的宣称不一致）。 */
const RUN_PREFIX_WORDS = new Set([
  "sudo",
  "nohup",
  "command",
  "exec",
  "env",
  "time",
  "setsid",
  "pkexec",
  "doas",
  "noglob",
  "watch",
  "nice",
  "stdbuf",
  "timeout",
  "taskset",
  "chrt",
  "xargs",
  "parallel",
]);

/** 吃旗标的包装词 → 其**带独立取值**的旗标（跳名不跳值会让取值挡在命令实部前 →
 *  头匹配失败，`nice -n 10 npm run dev` 即此）。分表而非共用一份：`sudo -n`（非交互，
 *  无值）与 `nice -n 10`（有值）字形相同语义相反，共用会把 `sudo -n rm -rf /` 的 rm
 *  当成取值吃掉，反手造出新的逃逸口。
 *  sudo 那一行按本机 /usr/bin/sudo 实测补全：`sudo -p xrm rm -rf /` 与 `sudo -C 3 rm -rf /`
 *  都真的把下一词当取值并继续执行 `rm`（实测走到密码提示 ⇒ 命令词已就位），此前这两形放行。
 *  表**不声称完备**（`-h` 这类"报错退出"的旗标列进来反而会把命令词吃掉）：漏一枚的兜底是
 *  `wrapperHeadStarts` 的多点位扫描，不是这张表。 */
const PREFIX_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "--unset", "--unset-var"],
  nice: ["-n", "--adjustment"],
  stdbuf: ["-i", "-o", "-e"],
  sudo: [
    "-u",
    "-g",
    "-p",
    "-r",
    "-c",
    "-C",
    "-D",
    "-T",
    "-a",
    "--user",
    "--group",
    "--prompt",
    "--role",
    "--login-class",
    "--close-from",
    "--chdir",
    "--timeout",
    "--auth-type",
  ],
  taskset: ["-c", "--cpu-list"],
  timeout: ["-k", "-s", "--kill-after", "--signal"],
  watch: ["-n", "-t", "--interval", "--title"],
  xargs: ["-a", "-d", "-e", "-I", "-i", "-J", "-L", "-l", "-n", "-P", "-s", "-S"],
  parallel: ["-a", "-j", "-n", "-s", "--jobs", "--arg-file", "--max-args", "--sshlogin"],
};

/** 旗标之外还吃一个**位置**取值的包装词（`nice 10 …` / `timeout 5 …` / `taskset 0-3 …`）。
 *  chrt 不在此表：它的策略旗标是布尔且可连用、命令前必有一枚优先级词，走 stripRunPrefix
 *  里的专用分支。 */
const PREFIX_POSITIONAL_VALUE = new Set(["nice", "timeout", "taskset"]);

/** 时长词：`5` / `10s` / `5m` / `1h` / `2d`，以及 GNU timeout 承认的**小数与 MM:SS**
 *  形态（`timeout --signal TERM 1.5 npm run dev` 实测漏拦——只认整数就把 `1.5` 留成了命令头）。
 *  这一形只在"已经吃过旗标取值"时用于认位置取值，纯整数走 isPositionalValue 的另一支。 */
const DURATION_WORD_RE = /^(?:\d+(?:[.]\d+)?[smhd]?|\d+[:][0-5]?\d(?:[.]\d+)?)$/u;

/** 前导环境赋值（VAR=x），同样不改变命令实部。 */
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * 该词是不是**纯**环境赋值：`FOO=x rm -rf /` 的 rm 是命令实部（照剥）。
 * 但 `FOO=$(curl -s https://x | sh)` 不是——那枚赋值取值是命令替换，真 bash 会执行它
 * （实测 `echo "$(seq 3 | tail -1)"` 输出 `3`），把它整词当赋值剥掉等于把 `curl` 这枚词
 * 从管道判定的视野里删掉（实测这一形曾静默放行）。
 */
const isPlainEnvAssign = (word: string): boolean =>
  ENV_ASSIGN_RE.test(word) && !word.includes("$(") && !word.includes("`");

/** 命令头取 bin 名：路径前缀不是逃逸口（`/bin/rm -rf /`、`/usr/bin/git commit --no-verify`）。
 *  分隔符同时认正斜杠与反斜杠：pwsh / cmd 的头常写成 `C:\tools\rm`，只剥 `/` 会让它带着
 *  整条路径落到命令词表外面（等价于换个命令名逃逸）。不含反斜杠的词（POSIX 的全部写法）
 *  剥出来的结果与改动前逐字相同。
 *  引号也在这一步之外：词值已由 lexTokens 去过引号，`"git"` 到这里就是 `git`（实测
 *  `"git" --version` 正常执行，故引号包裹的命令头不是逃逸口）。 */
const binNameOf = (word: string): string => word.replace(/^.*[\\/]/u, "");

/** 一个词的两种读法各自剥出的 bin 名。
 *  反斜杠在这两形里意思不同：POSIX 读法当它是转义（`my\rm` 的值是 `myrm`），
 *  Windows 字形与 pwsh/cmd 写法当它是分隔符（`C:\tools\rm` 的头就是 `rm`）。
 *  判据不看 fs、也不看哪台机器在读，**两形都给**、任一命中即算——这与
 *  `isWindowsHost` 那条"由平台/方言说话而不是猜字形"是同一条纪律的另一半：
 *  这里猜错的方向只会多拦不会少拦。 */
const binForms = (token: ShellToken): readonly [string, string] => [
  binNameOf(token.value),
  binNameOf(token.raw),
];

/** 该词是否命中命令词表（大小写敏感的 POSIX 词，如 `git`/`npm`）。 */
const isExactBinIn = (token: ShellToken, names: ReadonlySet<string>): boolean =>
  binForms(token).some((name) => names.has(name));

/** 该词的包装词身份（两形任一即算，`/usr/bin/sudo` 与 `sudo` 同源）。 */
const wrapperBins = (token: ShellToken): readonly string[] => binForms(token);

/**
 * 消费包装命令自身的旗标，返回跳过的词数（调用方已把 start 指向旗标区起点）。
 * 带独立取值的旗标占两词，`-o0`/`--x=y` 这类附着值只占一词；第一个非旗标词即真实命令。
 */
function consumeToolFlags(
  words: readonly string[],
  start: number,
  valueFlags: readonly string[],
): number {
  let consumed = 0;
  let i = start;
  for (;;) {
    const flag = words[i];
    if (flag === undefined || !flag.startsWith("-")) {
      break;
    }
    const step = valueFlags.includes(flag) ? 2 : 1;
    i += step;
    consumed += step;
  }
  return consumed;
}

/** chrt [-f|-r|-o|-b]… <优先级> <命令> 的跳词：策略旗标是**布尔**且可连用（`chrt -r -f 50 …`
 *  实测逃逸过），吃不得值；命令前**必**有一枚非旗标的优先级词——逐枚跳旗标后吃掉它。
 *  （`chrt -p 50 <pid>` 的 pid 被当优先级吃掉无害：pid 模式本就不执行命令。） */
function chrtSkip(words: readonly string[], i: number): number {
  let pos = i + 1;
  while (words[pos]?.startsWith("-") === true) {
    pos += 1;
  }
  return pos < words.length ? pos + 1 : pos;
}

/** 位置取值判定（runPrefixEnd 的收尾谓词）：没吃过旗标取值时吃一枚任意非旗标词；
 *  吃过时只认"长得像取值"的（时长形态由 DURATION_WORD_RE 给，含 `1.5`/`05:30`）——
 *  `nice -n 10 npm …` 的 npm 不是取值不能吃，而 `timeout -k 5 10 rm …` 的 10 是时长必须吃，
 *  否则 rm 整个落到头外（实测逃逸口）。 */
function isPositionalValue(bin: string, flags: number, positional: string | undefined): boolean {
  return (
    PREFIX_POSITIONAL_VALUE.has(bin) &&
    positional !== undefined &&
    !positional.startsWith("-") &&
    (flags === 0 || DURATION_WORD_RE.test(positional))
  );
}

/** 这几个包装词身份里，有任何一枚在"吃过旗标取值"之后还要吃一枚位置取值吗。 */
function takesPositional(
  bins: readonly string[],
  consumed: number,
  positional: string | undefined,
): boolean {
  return bins.some((bin) => isPositionalValue(bin, consumed, positional));
}

/**
 * 剥运行前缀：跳过 sudo/nohup/env/time/nice/watch/xargs… 与前导 VAR=x 赋值，返回命令实部的
 * **起始下标**。gitBypass/catastrophicRm/devServer/nestedShell 共用——前缀不能成为拦截逃逸口
 * （`sudo rm -rf /`、`doas rm -rf /`、`time npm run dev` 照拦）。
 * 包装词按 **bin 名**认（`/usr/bin/sudo rm -rf /` 实测放行过：整条路径落在词表外，
 * 等价于换个包装词逃逸）。
 */
function runPrefixEnd(tokens: readonly ShellToken[]): number {
  const words = tokens.map((token) => token.value);
  let i = 0;
  for (;;) {
    const token = tokens[i];
    if (token === undefined) {
      break;
    }
    const bins = wrapperBins(token);
    const valueFlags = bins.flatMap((bin) => PREFIX_VALUE_FLAGS[bin] ?? []);
    if (bins.includes("chrt")) {
      i = chrtSkip(words, i);
    } else if (valueFlags.length > 0) {
      const consumed = consumeToolFlags(words, i + 1, valueFlags);
      i += 1 + consumed;
      i += takesPositional(bins, consumed, words[i]) ? 1 : 0;
    } else if (bins.some((bin) => RUN_PREFIX_WORDS.has(bin)) || isPlainEnvAssign(token.value)) {
      i += 1;
    } else {
      break;
    }
  }
  return i;
}

/**
 * 一条段的**命令头候选起点**集合。
 * 段头不是包装词时集合就是单点 `[runPrefixEnd]`——既有判定域一个字都不加。
 * 是包装词时把其后每个"像命令"的词位都列为候选：option 表按定义补不完
 * （`sudo -p xrm rm -rf /` 就是这么漏的，实测该形真会执行 rm），
 * 所以这一层是**漏拦的兜底**而不是精度优化。
 * 候选面收在"非旗标、非空"的词上，因此 `xargs cat rm` 这类"参数恰好像命令词"的串
 * 至多多看一次头，仍需自己配齐旗标与灾难目标才成立——误拦面按构造是小的。
 */
function headStarts(tokens: readonly ShellToken[]): number[] {
  const start = runPrefixEnd(tokens);
  if (start === 0) {
    return [0];
  }
  const starts: number[] = [];
  for (let i = start; i < tokens.length; i += 1) {
    const word = tokens[i]?.value;
    if (word !== undefined && word.length > 0 && !word.startsWith("-")) {
      starts.push(i);
    }
  }
  return starts.length > 0 ? starts : [start];
}

/** 会整树删除的命令词：rm + pwsh 原生命令与别名 + cmd 内建。
 *  比对时一律小写 —— pwsh 与 cmd 的命令词不区分大小写；引号包裹的命令词由 lexTokens
 *  去过引号（`"rm" -rf ~` 实测是生效写法，不是逃逸口）。
 *  已知未覆盖（**类**，不是某一种拼法）：**另一个解释器当段头**那一层——段头是
 *  `cmd.exe /c rd /s /q …`、`cmd /c …`、`pwsh -c "…"`、`powershell -Command "…"` 时，
 *  其后的整树删除进不到本词表（`cmd`/`pwsh` 不在 RM_BIN_WORDS，也不在 shell 下钻名单里）。
 *  补这一层要定策「`.exe` 后缀算不算命令词」与「包装器的 `-c` 体用谁的方言读」，
 *  与本仓已明确的保守口径冲突（见「git.exe 不判成 git」那条），故留作登记的洞。
 *  提权/时间/二次执行那类包装词（sudo/env/time/nice/timeout/xargs…）**不**在此列：
 *  它们走 runPrefixEnd + headStarts 的多点位扫描，其后那条命令照常过四类规则。 */
const RM_BIN_WORDS: ReadonlySet<string> = new Set([
  "rm",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "rmdir",
]);

/** 该词命中 rm 词表时返回**用于分派旗标方言的那一形**（小写），否则空串。
 *  两形（词值 / 源文本）里任中即算：`\rm`、`my\rm`、`C:\tools\rm` 都是 rm 的头。 */
function rmBinOf(token: ShellToken): string {
  return (
    binForms(token)
      .find((name) => RM_BIN_WORDS.has(name.toLowerCase()))
      ?.toLowerCase() ?? ""
  );
}

/** 只有 cmd 内建才用 `/s` `/q` 旗标方言。
 *  `/s` 与 POSIX 绝对路径字面同形：把 `rm -rf /etc` 的 `/etc` 当旗标丢掉，
 *  会从"漏拦"翻成"判定失效"，所以方言必须由命令词决定，不能靠字面。 */
const CMD_BUILTINS: ReadonlySet<string> = new Set(["rd", "rmdir", "del", "erase"]);

/** cmd 旗标的**字形**：`/` + 单个字母。长度钉死在一个字母上，`/etc`、`/usr/local`
 *  这类 POSIX 绝对路径才不会因为「它也是斜杠打头」被当成旗标丢掉。
 *  形状与方言是两件事：本正则只在 `CMD_BUILTINS` 的命令词上启用。 */
const CMD_FLAG_WORD_RE = /^\/[a-z]$/iu;

/** rm 短旗标簇：单横线 + 全字母（`-rf`/`-drf`/`-RWx`/`-srf`）。与既有 POSIX
 *  判据同形——**故意不设封闭字母表**：表外字母只让旗标取不全，把"能跑的整树删除"放过去，
 *  所以宁可整簇宽松扫。`--` 长旗标不匹配（`-` 后紧跟 `-`），另由前面的等值分支处理。 */
const SHORT_FLAG_CLUSTER_RE = /^-[a-zA-Z]+$/u;

/** 一个选项词的"参数名"段：`-` 后紧跟的字母串（`-Recurse:$true` ⇒ `Recurse`、
 *  `-LiteralPath` ⇒ `LiteralPath`；不以 `-字母` 开头即不匹配，含 `--长旗标`）。 */
const PARAM_NAME_RE = /^-(?<name>[A-Za-z]+)/u;

/**
 * 该选项词是否为 pwsh 的 `-Recurse` / `-Force`？两头都比前缀：
 * - `name.startsWith(body)` 吃 PowerShell 的**无歧义前缀缩写**（`-rec`、`-fo`、`-r`）；
 * - `body.startsWith(name)` 保住改动前那条 `/^-recurse/i` 顺手覆盖的长写法（`-recursive`）。
 *
 * 为什么按"参数名"判，而不是逐字母扫任意 `-词`：pwsh 的参数名同样长成 `-字母…`，
 * `Remove-Item -Force -LiteralPath C:\Users\bob\notes.txt` 里 `-LiteralPath` 含一枚 `r`，
 * 簇扫描据此得出"递归"，与真 `-Force` 一配就把**删一个文件**判成灾难删除（当时的误拦；`-ErrorAction`、`-Filter` 同形）。改按参数名判之后，只有真是 Recurse/Force 的
 * 缩写才算旗标，其余参数名一律不进旗标面。
 *
 * **本函数与短簇那条的分工由命令词决定**（`hasForceRecursive` 的 `psParamTrack`），不是由
 * 词形猜：命令词是 `remove-item`/`ri` 时短簇分支整个不进，`-r`/`-R`/`-f` 也由这里按参数名
 * 缩写认下；命令词是 `rm`/`del`/`erase`/`rd`/`rmdir` 时两条**叠加**（簇扫大小写敏感，
 * `-Force` 这类 pwsh 长词只有这一面认得，簇分支不许把它挡掉）。
 * 所以两侧结论**并不逐字相同**，两处差异都是明写的取舍：POSIX 轨靠宽松簇拦下
 * `rm -drf /`、`rm -RW ~` 这一类"表外字母混在能跑的簇里"的写法（此前给字母表封口就是把
 * 它们放掉的），pwsh 轨则放掉 `Remove-Item -rf <树>`——`-rf` 不是参数名，pwsh 自己报参数找不到。
 */
function isPsParamAbbrev(word: string, name: string): boolean {
  const body = PARAM_NAME_RE.exec(word)?.groups?.["name"]?.toLowerCase();
  if (body === undefined) {
    return false;
  }
  return name.startsWith(body) || body.startsWith(name);
}

/** Windows 系统根的**未展开**形态，与既有 `$HOME`/`${HOME}` 判据同构。
 *  尾闸（分隔符或词尾）与 `HOME_EXPANSION_RE` 的 `(?![A-Za-z0-9_])` 同一条理由：
 *  少了它，`$env:windirx` 这类自定义变量会被当成系统根误拦。 */
const ENV_SYSTEM_ROOT_RE = /^(?:%systemroot%|%windir%|\$env:windir|\$env:systemroot)(?:[\\/]|$)/iu;

/** Windows **用户根**的未展开形态：`%USERPROFILE%` 与
 *  `$env:USERPROFILE` 展开后删的就是那棵树，未展开的字面串在任何读法下都不是一个
 *  合法的相对目标 ⇒ 与 ENV_SYSTEM_ROOT_RE 同理，不随轨道/平台退出。
 *  为什么另起一条而不是往系统根那条里加一枚 alternation：两条指的不是同一棵树，
 *  各自要说清自己拦的是什么（家目录在 POSIX 侧由 `$HOME`/`HOME_EXPANSION_RE` 闭合、
 *  Windows 侧由字面家目录比较闭合，此前唯独漏了这枚未展开写法）。 */
const ENV_USER_ROOT_RE = /^(?:%userprofile%|\$env:userprofile)(?:[\\/]|$)/iu;

/** 一枚选项词贡献的旗标面：递归 / 强制 / 大写 `R`（后者只在 POSIX 短簇上取得）。 */
interface FlagSet {
  force: boolean;
  recursive: boolean;
  upperR: boolean;
}

/** 整簇宽松扫一个短旗标词：只取三枚字母——`r`/`R` ⇒ 递归、`f` ⇒ 强制，大写 `R` 另记一条
 *  `upperR`。`-rf` ⇒ 强制+递归，`-R` ⇒ 递归且**灾难级**，`-drf`/`-srf`/`-RWx` ⇒ 与 `-rf`、`-RW`
 *  同判：簇里多出来的字母**一个也不取**，但也不撤销已取到的那几枚，更不会让整簇作废
 *  （"表外字母 ⇒ 少取一枚"是那套已撤销的封闭字母表的讲法；现状是宽松扫，`d`/`W`/`x`/`s`
 *  从来不在取值范围内，所以它们既不多取也不少取）。
 *  扫的是**原词**而不是 lower——小写之后 `includes("R")` 永不为真，
 *  `|| upperR` 那条灾难级判据会静默失效（`rm -R ~`）。 */
function scanShortFlagCluster(word: string): FlagSet {
  return {
    force: word.includes("f"),
    recursive: word.includes("r") || word.includes("R"),
    upperR: word.includes("R"),
  };
}
/** 非簇词（`remove-item`/`ri` 一律算这类，或形状就不是"单横线 + 全字母"）的零贡献。 */
const CLUSTER_NO_FLAGS: FlagSet = { force: false, recursive: false, upperR: false };

/** Remove-Item 系里**带独立取值**的参数名 → 取值角色：
 *  `path` 表示取值就是要删的路径（仍算目标），`skip` 表示取值只是模式/枚举（既非目标也非旗标）。
 *  实测 `Remove-Item -Exclude ~ -Recurse ./build` 曾因 `~` 被当目标而误拦——那枚 `~` 是
 *  `-Exclude` 的取值，不是删除对象。
 *  匹配口径见 `psValueRole`：**全名或四字母以上的前缀**，不收 `-f` 这类单字母缩写
 *  （`-f` 与 `-Filter` 撞前缀，认了就把 `rm -f ~` 的 `~` 当取值吃掉，反手造出漏拦）。 */
const PS_VALUE_PARAM_ROLES: Readonly<Record<string, "path" | "skip">> = {
  path: "path",
  literalpath: "path",
  exclude: "skip",
  include: "skip",
  filter: "skip",
  erroraction: "skip",
  warningaction: "skip",
  debugaction: "skip",
  informationaction: "skip",
  pipelinevariable: "skip",
  outbuffer: "skip",
};

/** 该词是否为带取值的 pwsh 参数名（全名，或长度 ≥4 的无歧义前缀）。 */
function psValueRole(word: string): "path" | "skip" | undefined {
  const body = PARAM_NAME_RE.exec(word)?.groups?.["name"]?.toLowerCase();
  let role: "path" | "skip" | undefined;
  for (const [name, valueRole] of Object.entries(PS_VALUE_PARAM_ROLES)) {
    if (body !== undefined && (name === body || (body.length >= 4 && name.startsWith(body)))) {
      role = valueRole;
      break;
    }
  }
  return role;
}

/** `-Recurse:$false` / `-Force:0` 这类**显式假值**：参数名对得上但开关是关的。
 *  实测旧判据只看参数名前缀，于是 `Remove-Item -Recurse:$false -Force ~` 被当递归删除拦下——
 *  pwsh 对这条根本不会递归。分隔符 `:` 是 pwsh 的写法，`=` 是同族变体，都要认。 */
const PS_SWITCH_VALUE_RE = /^-(?<name>[A-Za-z]+)[:=](?<value>.*)$/u;
const PS_FALSE_VALUES = new Set(["$false", "false", "0"]);

/** 该选项词是否把一枚开关显式置为假（`-Recurse:$false`）？ */
function isPsSwitchOff(word: string): boolean {
  const groups = PS_SWITCH_VALUE_RE.exec(word)?.groups;
  const value = groups?.["value"]?.toLowerCase();
  return value !== undefined && PS_FALSE_VALUES.has(value);
}

/**
 * 一枚选项词 → 旗标贡献（`hasForceRecursive` 循环体的判据）。
 * 三条面**按命中即止排序**，先长旗标、后短簇：
 * - 显式假值（`-Recurse:$false`）最先出局：参数名再对，开关关着就不算递归/强制。
 * - `--force`/`--recursive` 与 cmd 侧 `/q`/`/f`/`/s`：等值比较，命中即返回，**不再**走簇
 *   （`--force` 形状上也会被 `SHORT_FLAG_CLUSTER_RE` 拒掉，但 `/f` 在 POSIX 轨上不该进簇，
 *   两侧都靠这条顺序把"长旗标"与"短簇"隔开）。
 * - 短簇（`-rf`/`-RWx`）：只在**非 cmdlet 参数名轨**且字形匹配时扫（`psParamTrack` 的取舍
 *   写在 `hasForceRecursive` 的 doc 上）。
 * - PowerShell 参数名缩写（`-rec`/`-fo`）：叠在簇之后而不是簇的替代分支；`recurse` 与
 *   `force` 的参数名前缀互不相交（r- 系对 f- 系），故两条判据不会同时为真。
 */
function flagsOfWord(word: string, cmdDialect: boolean, psParamTrack: boolean): FlagSet {
  if (isPsSwitchOff(word)) {
    return CLUSTER_NO_FLAGS;
  }
  const lower = word.toLowerCase();
  if (lower === "--force" || (cmdDialect && (lower === "/q" || lower === "/f"))) {
    return { force: true, recursive: false, upperR: false };
  }
  if (lower === "--recursive" || (cmdDialect && lower === "/s")) {
    return { force: false, recursive: true, upperR: false };
  }
  const shortCluster =
    !psParamTrack && SHORT_FLAG_CLUSTER_RE.test(word)
      ? scanShortFlagCluster(word)
      : CLUSTER_NO_FLAGS;
  return {
    recursive: shortCluster.recursive || isPsParamAbbrev(word, "recurse"),
    force: shortCluster.force || isPsParamAbbrev(word, "force"),
    upperR: shortCluster.upperR,
  };
}

/**
 * 灾难级门槛（`hasForceRecursive` 扫完旗标后的收尾判据；抽成函数只是为了把圈复杂度留在
 *  lint 闸内，表达式本身与主函数 doc 一一对应，三条 disjunct 分属两轨、门槛**不同**）：
 * - `recursive && force`：两轨共用的基线，递归 + 强制必成灾。
 * - `upperR`：POSIX 轨既有口径——大写 `-R` 单独即灾难级。它**只由簇扫描喂**，而簇分支在
 *   cmdlet 轨上整个不进 ⇒ 这一项在 cmdlet 轨上恒为假（整条判据于是退化成"必须有 force"，
 *   这正是 `Remove-Item -R ~` 从拦转放的机理）。
 * - `psParamTrack && recursive`：补的就是上面那一格。cmdlet 轨上任何 Recurse 形态（`-R` ≡ `-r`
 *   ≡ `-rec` ≡ `-Recurse`，参数名不区分大小写 ⇒ 是一枚而不是四种拼法）**单独**命中灾难目标
 *   即灾难级，不要求 `-Force`。POSIX 轨拿不到这一项，`rm -r ~` 的既有结论一个字不变。
 */
function isDisasterGradeFlagSet(
  recursive: boolean,
  force: boolean,
  upperR: boolean,
  psParamTrack: boolean,
): boolean {
  return (recursive && force) || upperR || (psParamTrack && recursive);
}
/**
 * rm 递归+强制判定：短旗标簇整簇宽松扫字母、--recursive/--force 长旗标、
 * -f -r 分写都认。**"递归算不算单独成灾"按命令词轨分别说，不是无条件性质**：
 * - POSIX/cmd 轨（`psParamTrack` 为假）：递归**且**强制才成灾，唯一例外是簇里的大写 `-R`
 *   单独即灾难级（无 `-f` 也拦，仓内既有口径）⇒ `rm -r ~` 放行、`rm -R ~` 拦。
 * - cmdlet 轨（`remove-item`/`ri`）：**任何 Recurse 形态单独命中灾难目标即灾难级，不要求
 *   `-Force`**（`-R` ≡ `-r` ≡ `-rec` ≡ `-Recurse`，参数名不区分大小写 ⇒ 是一枚而不是四种拼法）。
 * 两条门槛的不对称是**语义不对称的镜像**，不是漏洞：`Remove-Item -Recurse ~` 不给 `-Force`
 * 也**静默删整树**（pwsh 只对只读/受保护项报错跳过，普通文件直接删）；POSIX `rm -r ~` 不给
 * `-f` 会在受保护项上逐个提示。所以"递归单独成灾"的门槛在两轨本来就不同，判据跟着不同才是
 * 照实描述（README 的"拦/放行"两格按轨分述，同一处口径）。
 * `--` 视为选项结束（后面全是路径，不再扫旗标）。
 * 两条旗标面**按命令词分派**（`psParamTrack`，由调用点从 bin 算好传进来）：
 * - `remove-item`/`ri` 是"只有 PowerShell 才这么写"的拼法 ⇒ 短簇分支不进，`-字母…` 词一律
 *   交给下面那两条 `isPsParamAbbrev`（参数名缩写，大小写不敏感，RM_BIN_WORDS 同源理由）。
 *   否则 `-LiteralPath`/`-Filter` 里那枚 `r` 会被当成递归（那处误拦的由来）。
 *   代价明写：`Remove-Item -rf <树>` 这类**非法 pwsh 写法**随之放行。
 *   反过来，参数名面认下的 Recurse 一律成灾（上面那条 cmdlet 门槛），于是 `-WhatIf` 这类
 *   dry-run 修饰**不识别**：`Remove-Item -WhatIf -Recurse <树>` 照拦。登记为现存局限——
 *   "判据不读 dry-run"不是本次改动引入的（`-WhatIf -Recurse -Force <树>` 一直照拦），
 *   暂不扩范围修（要修得先定策"dry-run 是否算一种独立的、可豁免的形态"）。
 * - `rm`/`del`/`erase`/`rd`/`rmdir` 同时存在于 POSIX/cmd 侧 ⇒ 短簇分支照走，且参数名两条
 *   **叠在它之后**（不是 else-if 的替代分支）：簇扫大小写敏感，`-Force -r`、`-Force --recursive`
 *   这类 pwsh 长词得靠参数名那一面补上 force，否则 POSIX 命令词上反而放出改动前拦着的
 *   整树删除（pwsh 里 `rm` 就是 Remove-Item 的别名）。POSIX 的 fail-closed 语义不为 pwsh 的
 *   便利让路：两种语义在这个命令词上重叠时宁可误拦。**这一侧的门槛一个字不变**：
 *   `rm -r ~` 仍放行、`rm -R ~` 仍拦，cmdlet 轨那条"递归单独即灾难级"不越轨到 `rm` 上。
 * @param flags 命令头**之后**的旗标词（目标与取值由 `partitionRmArgs` 分走，不在此列）
 * @param cmdDialect 命令词是否属 CMD_BUILTINS —— 决定 `/s` `/q` `/f` 算不算旗标
 * @param psParamTrack 命令词是否为 `remove-item`/`ri` 拼法 —— 决定 `-字母…` 词走参数名面还是走短簇面，
 *        并决定递归是否单独即灾难级（见上）
 */
function hasForceRecursive(
  flags: readonly string[],
  cmdDialect: boolean,
  psParamTrack: boolean,
): boolean {
  let force = false;
  let recursive = false;
  let upperR = false;
  for (const word of flags) {
    // 单词的三条旗标面（长旗标 / 短簇 / PowerShell 参数名）在 `flagsOfWord` 里裁定，
    // 这里只做累积：簇扫大小写敏感，`-Force -r`、`-Force --recursive` 这类 pwsh 长词
    // 得靠参数名那一面补上 force，否则 POSIX 命令词上反而放出改动前拦着的整树删除
    // （`rm` 在 pwsh 里就是 Remove-Item 的别名）。叠加只往"多认旗标"的方向走，
    // 与簇同向，不会放出任何改动前拦着的写法。
    const contribution = flagsOfWord(word, cmdDialect, psParamTrack);
    recursive ||= contribution.recursive;
    force ||= contribution.force;
    upperR ||= contribution.upperR;
  }
  // 收尾门槛按命令词轨分派：三条 disjunct 的含义（含"cmdlet 轨上 Recurse 单独即灾难级"这条
  // 后来补的口径）逐条写在 `isDisasterGradeFlagSet` 的 doc 上，那里就是裁定原文的那条返回值，
  // 抽成函数只为把圈复杂度留在 lint 闸内，判据本身一字未动。
  return isDisasterGradeFlagSet(recursive, force, upperR, psParamTrack);
}

/** 执行端 shell 解释器（管道接收端；管道后 sudo/env sh 照拦）。
 *  允许 shell 名前的路径前缀（`curl x | /bin/bash`、`| /usr/bin/sh` 照拦）。
 *  包装词表除提权面外还含 **二次执行面** `xargs`/`parallel`：`curl x | xargs -I{} sh {}`
 *  里 shell 不是紧接管道符，但 xargs 把 stdin 逐条喂给它执行，与 `| sh` 同危
 *  （审查确认：旧实现只认 sudo/env 打头 → xargs 是一个现成的逃逸口）。
 *  包装词后只跳「旗标 / 数值 / `{}` 占位 / VAR=值」四类取值，不跳任意位置词——
 *  `xargs cat sh` 里的 sh 是文件名不是命令，一律当二次执行就是误伤。 */
const EXEC_WRAPPERS = "(?:sudo|env|nohup|exec|doas|pkexec|xargs|parallel)";
const WRAPPER_SKIP = String.raw`(?:-\S+|\d+|\{\}|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+`;
/** 接收端名单含 **PowerShell 家族**（`pwsh`/`powershell`）与 `iex`/`Invoke-Expression`：
 *  Windows 上的"下载即执行"就是 `curl x | iex`，与 `curl x | sh` 同危（本轮定的口径：
 *  PowerShell 家族按执行器对待，`.exe` 与大小写都不成为豁免理由）。 */
const SHELL_EXEC = new RegExp(
  `(?:^|\\||<\\(|\\$\\()\\s*` +
    `(?:(?:[^|\\s]*/)?${EXEC_WRAPPERS}\\s+(?:${WRAPPER_SKIP})*)*` +
    `(?:[^|\\s]*/)?(?:sh|bash|zsh|dash|ksh|pwsh|powershell|invoke-expression|iex)\\b`,
  "iu",
);

/** 进程替换的执行端命令头（`sh <(curl …)`、`source <(curl …)`、`. <(curl …)`）。
 *  `source`/`.` 与解释器同义——它们是"取回即执行"的常见写法，不是逃逸口。 */
const SHELL_HEAD_RE =
  /^(?:(?:sudo|env|nohup|exec|doas|pkexec)\s+)*(?:[^\s]*\/)?(?:sh|bash|zsh|dash|ksh|source)\b|^(?:(?:sudo|env)\s+)*\.(?=\s)/u;

/** 长驻开发服务器命令头（首 token 或 npm/pnpm/yarn/bun 的 run 参数）。 */
const DEV_SERVER_WORDS = new Set(["vite", "webpack", "next", "nuxt", "cargo-watch", "watchexec"]);
const DEV_RUN_ARGS = new Set(["dev", "watch", "serve", "start", "start:dev"]);
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** run 脚本名以 dev 为词根即视为长驻（dev / dev:web / dev-server / start:dev）。 */
const DEV_PREFIX = /^dev(?::|-|$)/u;

// 构建/服务双模式工具——同一命令头既有长驻（dev/serve）也有一次性（build）子命令。
// 旧实现只按命令头一刀切 → `vite build`/`next build`/`nuxt build`/`webpack --config x` 被误拦。
/** 双模式工具：需按子命令/旗标区分长驻与一次性构建。 */
const BUILD_SERVE_TOOLS = new Set(["vite", "webpack", "next", "nuxt"]);
/** 一次性构建子命令：出现即放行（即便命令头在长驻词表里）。 */
const BUILD_SUBS = new Set(["build"]);
/** 各工具**确认一次性**的子命令：执行完即退出，出现即放行。收录逐枚给了证据，不做
 *  "未知子命令一律放行"——三个工具对未识别子命令的处理各不相同（next/nuxt 直接报错，
 *  vite 把参数当 root 目录起 dev server），白名单才不会开新逃逸口：
 *  - `vite optimize`：vite 8 的 CLI 仍把它注册成真命令——"pre-bundle dependencies
 *    (deprecated, the pre-bundle process runs automatically …)"，预打包结束即退出
 *    （node_modules/vite/dist/node/cli.js:789）；
 *  - `next lint` / `nuxt prepare`：官方 CLI 的一次性子命令（lint 跑完即出、
 *    prepare 生成 .nuxt 类型后退出），都不是长驻服务。 */
const ONE_SHOT_SUBS: Readonly<Record<string, readonly string[]>> = {
  vite: ["optimize"],
  next: ["lint"],
  nuxt: ["prepare"],
};
/** 长驻子命令：dev/serve/start/preview/watch。 */
const SERVE_SUBS = new Set(["dev", "serve", "start", "preview", "watch"]);
/** 长驻旗标：--watch/-w/--hot 等（webpack 默认一次性，靠这些旗标转长驻）。
 *  附着值形态（`webpack --watch=true`）取 `=` 前的主名比对，实测这一形此前放行。 */
const WATCH_FLAGS = new Set(["--watch", "-w", "-watch", "--hot", "--live"]);

/** 该词是否一枚长驻旗标（长旗标的 `--flag=value` 附着值同样认下）。 */
function isWatchFlag(word: string): boolean {
  const cut = word.indexOf("=");
  return WATCH_FLAGS.has(cut === -1 ? word : word.slice(0, cut));
}

/** 双模式工具里**恒带取值**的旗标：其后那词是它的取值，不是子命令。
 *  证据来自 vite 8.3.1 的 CLI 声明与本机实测：`--host [host]` 虽写作可选值，解析器仍把
 *  下一词当取值吃掉——`vite --host build --help` 打出的是默认命令 `$ vite [root]`
 *  （"start dev server"），而 `vite build --help` 打出 `$ vite build [root]`
 *  ⇒ `vite --host build` 起的是**长驻 dev server**，`build` 根本不是子命令。 */
const TOOL_VALUE_FLAGS = new Set([
  "--host",
  "--port",
  "--mode",
  "-m",
  "--config",
  "-c",
  "--outDir",
  "--logLevel",
  "--filter",
  "-f",
  "--debug",
  "-d",
  "--target",
  "--platform",
  "--assetsDir",
  "--base",
  "--root",
  "--sourcemap",
  "--minify",
]);

/** 子命令位上的词：跳过旗标与其独立取值后的**第一枚位置参数**；没有则 undefined。 */
function toolSubcommand(rest: readonly string[]): string | undefined {
  let sub: string | undefined;
  let skipValue = false;
  for (const word of rest) {
    if (skipValue) {
      skipValue = false;
    } else if (word.startsWith("-")) {
      skipValue = TOOL_VALUE_FLAGS.has(word);
    } else {
      sub = word;
      break;
    }
  }
  return sub;
}

/** npx 的包名 → 命令名：`vite@5`、`vite@^7.1.1`、`vite@latest` 装的都是那个 bin，
 *  版本/标签只是选择器，不改变命令性质（实测 `npx vite@5 dev` 起 dev server，此前放行）。
 *  作用域包（`@vue/cli-service`）**不**剥尾段猜 bin 名——包名与 bin 名不同名是常态，
 *  猜了就是把误判面写进判据；这一形留作登记的洞。 */
const pkgBinName = (pkg: string): string => pkg.replace(/@[^/]*$/u, "");

/**
 * 判定"命令头/包名 pkg + 参数 rest"是否为长驻 dev server。
 * - webpack 默认一次性构建：仅当出现 serve/watch 子命令或旗标才长驻；
 * - vite/next/nuxt 默认长驻：只有**子命令位**上是 build 或确认一次性子命令（ONE_SHOT_SUBS）
 *   才放行——`vite --host build` 的 `build` 在取值位上，实测起的就是 dev server（见 TOOL_VALUE_FLAGS）；
 * - 其余长驻词（cargo-watch/watchexec/用户配置词）：一律长驻。
 */
function isLongRunningPkg(
  pkg: string,
  rest: readonly string[],
  serverWords: ReadonlySet<string>,
): boolean {
  if (!serverWords.has(pkg)) {
    return false;
  }
  if (BUILD_SERVE_TOOLS.has(pkg)) {
    if (pkg === "webpack") {
      return rest.some((word) => SERVE_SUBS.has(word) || isWatchFlag(word));
    }
    // 默认长驻；子命令位上是一次性构建/确认一次性子命令才放行，
    // 但放行子命令与 watch 旗标并存（`vite build --watch`）仍是长驻。
    const sub = toolSubcommand(rest);
    const oneShot =
      sub !== undefined &&
      (BUILD_SUBS.has(sub) ||
        Object.entries(ONE_SHOT_SUBS).some(([name, subs]) => name === pkg && subs.includes(sub)));
    return !oneShot || rest.some((word) => isWatchFlag(word));
  }
  return true;
}

/** shell 方言（BashDangerOptions.shellDialect 的取值面）。 */
export type ShellDialect = "posix" | "windows";

/** bashDanger 的可选配置（词表可配置化；缺省 = 内置词表）。 */
export interface BashDangerOptions {
  /** 额外长驻 dev server 命令头词（追加到内置 DEV_SERVER_WORDS）。 */
  extraDevServerWords?: readonly string[];
  /** 额外 dev run 脚本名（追加到内置 DEV_RUN_ARGS）。 */
  extraDevRunArgs?: readonly string[];
  /** **调用点上下文，不是用户配置**：这次工具调用的 shell 方言。宿主在 `tools.guard`
   *  里按**工具身份**给（`pwsh` → `"windows"`，`bash` → `"posix"`），因为"这段源是谁读的"
   *  在调用点是已知量，而字形不是（`\\home\bob` 折叠后与 UNC 逐字节同形）。
   *  `"windows"` 让 Windows 字形轨道参与判定（见 isWindowsHost 登记的代价：POSIX 宿主上
   *  跑 PowerShell Core 时平台不是 win32，但 pwsh 读 `C:\Windows` 读的就是那个树）。
   *  缺省 = POSIX 读法：「非 Windows 宿主上轨道退出」的结论一字不动。 */
  shellDialect?: ShellDialect;
}

/** git 里确实"旗标 + 空格 + 取值"分写的选项（全局 + 清单子命令的常见面，等值匹配）。
 *  只收"取值不该被当成旗标/路径"的那几枚：漏收的代价是把一枚取值当旗标看 → over-block
 *  （安全方向），而错收一枚布尔旗标会把紧跟的子命令当取值吃掉 → 漏拦（危险方向），
 *  所以这张表宁可少收。 */
const GIT_VALUE_FLAGS = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
  "-m",
  "--message",
  "-F",
  "--file",
  "--author",
  "--date",
  "--cleanup",
  "--template",
  "--pathspec-from-file",
  "-x",
  "--exec",
  "-o",
  "--push-option",
  "--repo-option",
  "--receive-pack",
]);

/** 短旗标簇里**恒带取值**的字母：`-m`/`-F`/`-C`/`-x`/`-u`。簇尾字母的取值是**下一词**
 *  （`-am "msg"` 的 msg），簇中非尾字母的取值是**同词余部**（`-mmassage`）。 */
const GIT_SHORT_VALUE_CHARS = "mFCxu";

/** `git config core.hooksPath <dir>`：钩子目录被永久改走，等价于永久关掉所有钩子。
 *  `--get/--unset/--list` 是读取或恢复默认，不构成绕过。 */
const HOOKS_PATH_KEY_RE = /^core\.hooksPath(?:$|=)/iu;
const HOOKS_PATH_READ_FORMS = /^--(?:get(?:-all|-regexp)?|list|unset(?:-all)?|remove-section)$/iu;

/** git 一次扫描的产出：子命令 + 两条独立结论（绕过旗标 / 钩子目录被改走）+ 越界词本身
 *  + **破坏性子命令判据要看的那几枚面**（旗标、位置参数、`--` 分界）。 */
interface GitFacts {
  sub: string | undefined;
  hooksSkipped: boolean;
  hooksPath: boolean;
  /** 触发 `hooksSkipped` 的**词面本身**（按首次出现序、去重）：出路要靠它点名，
   *  只回一个 `true` 的话模型得自己回去逐词比对是哪一枚。 */
  bypassWords: readonly string[];
  /** 子命令之后见到的**长旗标原词**（`--hard` / `--force` / `--staged`…），原样保留。 */
  longFlags: readonly string[];
  /** 子命令之后短旗标簇里的**字母**（`-fdx` 给 `f`/`d`/`x`；`-D` 给 `D`）。 */
  shortLetters: readonly string[];
  /** 子命令之后的位置参数（`--` 之后的也算进来）。 */
  positionals: readonly string[];
  /** 见过 `--`（之后一律 pathspec 的那条界）。 */
  sawSeparator: boolean;
}

/** 长旗标缩写：git 接受不歧义前缀（`--no-v`…`--no-verify`），缩写同样绕过钩子。 */
const isNoVerifyAbbrev = (word: string): boolean =>
  word.length >= NO_VERIFY_ABBREV_MIN && "--no-verify".startsWith(word);

/** git 参数走查的可变状态：当前位置 + 三条独立事实（子命令、绕过旗标、钩子目录被改走）。 */
interface GitWalk {
  words: readonly string[];
  pos: number;
  sub: string | undefined;
  hooksSkipped: boolean;
  hooksPathKey: boolean;
  hooksReadForm: boolean;
  /** 越界词面（见 GitFacts.bypassWords）。去重在这里做：同一枚旗标在一条命令里出现两次，
   *  给模型列两遍只是噪音，而模型改的时候要删的是**全部**出现处。 */
  bypassWords: string[];
  /** 破坏性判据看的三枚面（见 GitFacts 的对应字段）。与上面几枚**同一趟走查**里记，
   *  理由与 `bypassWords` 同源：另起一台走查两台迟早会漂。 */
  longFlags: string[];
  shortLetters: string[];
  positionals: string[];
  sawSeparator: boolean;
}

/** 第一个非旗标词就是子命令（git 的全局旗标都在它之前）。 */
const takeGitSub = (walk: GitWalk, word: string): void => {
  walk.sub = word;
  walk.pos += 1;
};

/** 长旗标：`--no-verify` 及其缩写是绕过；带独立取值的旗标吃掉下一词（那枚取值不是旗标）。 */
const takeGitLong = (walk: GitWalk, word: string): void => {
  walk.hooksReadForm ||= HOOKS_PATH_READ_FORMS.test(word);
  if (isNoVerifyAbbrev(word) && !walk.bypassWords.includes(word)) {
    walk.bypassWords.push(word);
    walk.hooksSkipped = true;
  }
  // 长旗标记**原词**（破坏性判据按等值比，`--force-with-lease` 不能被 `--force` 吃掉）。
  // `--flag=value` 的形状取等号前那一段：取值不是旗标的身份。
  // 用 `indexOf` + `slice` 而不是 `split("=")[0] ?? word` —— 后者那枚 `??` 是**死分支**
  //（`split` 必返回至少一个元素），只为过 `noUncheckedIndexedAccess` 而存在。
  const equals = word.indexOf("=");
  walk.longFlags.push(equals === -1 ? word : word.slice(0, equals));
  walk.pos += GIT_VALUE_FLAGS.has(word) ? 2 : 1;
};

/** 位置参数：`git config core.hooksPath <dir>` 的钩子目录键就长在这个位置上。 */
const takeGitPositional = (walk: GitWalk, word: string): void => {
  walk.hooksPathKey ||= walk.sub === "config" && HOOKS_PATH_KEY_RE.test(word);
  walk.positionals.push(word);
  walk.pos += 1;
};

/** `-c` 的取值单独判：实测 `git -c core.hooksPath=<dir> commit` 真能永久改走钩子目录。 */
const takeGitConfigPair = (walk: GitWalk): void => {
  const value = walk.words[walk.pos + 1];
  walk.hooksPathKey ||= value !== undefined && HOOKS_PATH_KEY_RE.test(value);
  walk.pos += value === undefined ? 1 : 2;
};

/**
 * 短旗标簇**逐字母**：实测 `git commit -an`/`-na` 钩子未运行且提交成功，而只等值比 `-n`
 * 的判据放过了它。带值字母（`m`/`F`/`C`/`x`/`u`）在簇尾时取值是**下一词**
 * （`git commit -m --no-verify` 实测钩子照跑——那串是提交说明，不是旗标），
 * 在簇中时取值就是同词余部（`-mmassage`）。
 */
function takeGitCluster(walk: GitWalk, word: string): void {
  const cluster = word.slice(1);
  let tailValue = false;
  for (let cursor = 0; cursor < cluster.length; cursor += 1) {
    const flag = cluster.charAt(cursor);
    // 破坏性判据按**字母**比（`-D` 与 `-d` 是两回事、`-fdx` 里 `f` 单独成判据），
    // 故这里存字母而不是整簇 —— 与 `bypassWords` 存整簇的理由正相反：
    // 那边要的是"删掉哪些词"，这边要的是"有没有出现某个开关"。
    if (!walk.shortLetters.includes(flag)) {
      walk.shortLetters.push(flag);
    }
    if (flag === "n" && walk.sub !== undefined && SHORT_N_NO_VERIFY_SUBS.has(walk.sub)) {
      // 点名**整枚簇**而不是 `-n`：簇里别的字母是真旗标（`-an` 的 `a` 是 stage all），
      // 让模型删掉整枚会顺手丢掉它们。文案侧写明"或词中的对应字母"，两种读法都在。
      if (!walk.bypassWords.includes(word)) {
        walk.bypassWords.push(word);
      }
      walk.hooksSkipped = true;
    }
    if (GIT_SHORT_VALUE_CHARS.includes(flag)) {
      tailValue = cursor === cluster.length - 1;
      break;
    }
  }
  walk.pos += tailValue ? 2 : 1;
}

/**
 * 按**参数角色**走一遍 git 参数（取代此前"对整条 body 打字面正则 + 逐词等值比"）：
 * 第一个非旗标词是子命令；`--` 之后一律 pathspec 不再当旗标；带值选项的**取值**
 * 既不是旗标也不是路径；短簇逐字母；词值已由 lexTokens 去过引号，实测
 * `git commit "--no-verify"` 与不带引号同判。
 */
function gitFacts(words: readonly string[]): GitFacts {
  const walk: GitWalk = {
    words,
    pos: 1,
    sub: undefined,
    hooksSkipped: false,
    hooksPathKey: false,
    hooksReadForm: false,
    bypassWords: [],
    longFlags: [],
    shortLetters: [],
    positionals: [],
    sawSeparator: false,
  };
  for (;;) {
    const word = words[walk.pos];
    if (word === undefined) {
      break;
    }
    // `--` = "之后一律 pathspec"。记下这条界**并继续收集**：`rmrf` 之外，
    // 破坏性判据要靠"子命令之后有没有真路径"来区分 `git checkout -b x` 与 `git checkout -- x`。
    if (word === "--") {
      walk.sawSeparator = true;
      walk.positionals.push(...words.slice(walk.pos + 1));
      break;
    }
    if (walk.sub === undefined && !word.startsWith("-")) {
      takeGitSub(walk, word);
    } else if (word.startsWith("--")) {
      takeGitLong(walk, word);
    } else if (!word.startsWith("-")) {
      takeGitPositional(walk, word);
    } else if (word === "-c") {
      takeGitConfigPair(walk);
    } else {
      takeGitCluster(walk, word);
    }
  }
  return {
    sub: walk.sub,
    hooksSkipped: walk.hooksSkipped,
    hooksPath: walk.hooksPathKey && !walk.hooksReadForm,
    bypassWords: walk.bypassWords,
    longFlags: walk.longFlags,
    shortLetters: walk.shortLetters,
    positionals: walk.positionals,
    sawSeparator: walk.sawSeparator,
  };
}

/** 单段（已按候选头切好）：git 钩子绕过？绕过只在清单子命令上成立。 */
function gitBypass(tokens: readonly ShellToken[]): BashVerdict | undefined {
  const [head] = tokens;
  let result: BashVerdict | undefined;
  // `\git`/`my\git` 的头与 `git` 同判（与 rm 词表同源，同一处判据）。
  if (head !== undefined && isExactBinIn(head, GIT_BIN_NAMES)) {
    const { sub, hooksSkipped, hooksPath, bypassWords } = gitFacts(
      tokens.map((token) => token.value),
    );
    if (hooksPath || (sub !== undefined && GIT_NO_VERIFY_SUBS.has(sub) && hooksSkipped)) {
      // 出路只给**绕过旗标**那一支：`core.hooksPath` 的机械解是删掉一个「键 值」二元组，
      // 而键与值的词位关系（`git config core.hooksPath <dir>` 的 `<dir>` 是哪个词）
      // 这条走查并没有记——硬造一个改法不如让模型照基础文案自己改（那条文案已写明
      // 「先修钩子或与用户确认豁免」）。
      result =
        bypassWords.length > 0
          ? { key: "noVerify", fix: { role: "bypassFlag", offending: bypassWords } }
          : { key: "noVerify" };
    }
  }
  return result;
}

/**
 * 单段：**破坏性 git 子命令**？与 `gitBypass` 共用同一趟走查（`gitFacts`）与同一个 git
 * 词表入口 —— 两台走查迟早会漂，而漂的表现是"绕过拦得住、破坏看不见"。
 *
 * 逐子命令的判据（每条都只认**已确认会丢东西**的形态，含糊的一律不判、按已知边界登记）：
 *  - `reset --hard`：长旗标等值。（`--soft`/`--mixed` 保留工作区，不判。）
 *  - `checkout -- …` / `checkout .`：只认这两形。**裸 `git checkout <path>` 不判** ——
 *    它与 `git checkout <branch>` 在词法上不可分（要知道那名字是分支还是文件得读仓库，
 *    而本包不碰 fs）。见 README 已知边界。
 *  - `restore <path>`：`--staged` 单用时只动索引（可重做 `git add`），不判。
 *  - `clean -f`：带 `-n`/`--dry-run` 时 git 自己只打印，不判。
 *  - `stash drop|clear`：`pop`/`apply`/`list`/`show` 都不丢东西，不判。
 *  - `branch -D`：大写才强删；`-d` 在小写时 git 自己会拒绝未合并的分支，不判。
 *  - `push -f|--force|--force-with-lease`：`--force-with-lease` 一并算（它仍然是重写远端）。
 */
const hasLong = (facts: GitFacts, name: string): boolean => facts.longFlags.includes(name);
/** 短旗标簇里出现过这个字母。 */
const hasShort = (facts: GitFacts, letter: string): boolean => facts.shortLetters.includes(letter);

/** `git restore` 的**只动索引**形：`--staged` 单用时工作区不变，内容不丢（重做一次 `git add` 即回）。
 *  `--staged` 与 `--worktree` 并存时两边都动 ⇒ 不算"只动索引"。 */
const restoreStagedOnly = (facts: GitFacts): boolean =>
  (hasLong(facts, "--staged") || hasShort(facts, "S")) &&
  !hasLong(facts, "--worktree") &&
  !hasShort(facts, "W");

/** `git clean` 的**真删**形：有 force（短 `f` 或长 `--force`）且没有 dry-run。
 *  `-n` 赢过 `-f`（git 只打印清单），`--dry-run` 同理。 */
const cleanForces = (facts: GitFacts): boolean =>
  (hasShort(facts, "f") || hasLong(facts, "--force")) &&
  !hasShort(facts, "n") &&
  !hasLong(facts, "--dry-run");

/** `git push` 的**重写远端**形：`--force-with-lease` 一并算 —— 它比 `--force` 温和，
 *  但仍然是重写历史（"租约"保的是"别人没推过"，不是"历史不会变"）。 */
const pushForces = (facts: GitFacts): boolean =>
  hasShort(facts, "f") || hasLong(facts, "--force") || hasLong(facts, "--force-with-lease");

/** `git checkout` 的**丢弃**形：只认 `-- <path>` 与 `.`/`..` 两形。
 *  ⚠ 裸 `git checkout <path>` **刻意不判** —— 要与"那个名字是分支还是文件"才能分，
 *  而本包不碰 fs。见 README 已知边界。 */
const checkoutDiscards = (facts: GitFacts): boolean =>
  facts.sawSeparator || facts.positionals.some((word) => /^\.{1,2}$/u.test(word));

const GIT_DESTRUCTIVE: Readonly<Record<string, (facts: GitFacts) => BashDenialKey | undefined>> = {
  reset: (facts) => (hasLong(facts, "--hard") ? "gitResetHard" : undefined),
  restore: (facts) => (restoreStagedOnly(facts) ? undefined : "gitRestoreDiscard"),
  clean: (facts) => (cleanForces(facts) ? "gitCleanForce" : undefined),
  push: (facts) => (pushForces(facts) ? "gitForcePush" : undefined),
  stash: (facts) =>
    facts.positionals[0] === "drop" || facts.positionals[0] === "clear"
      ? "gitStashDrop"
      : undefined,
  branch: (facts) => (hasShort(facts, "D") ? "gitBranchDelete" : undefined),
  checkout: (facts) => (checkoutDiscards(facts) ? "gitCheckoutDiscard" : undefined),
};

function gitDestructive(facts: GitFacts): BashDenialKey | undefined {
  return facts.sub === undefined ? undefined : GIT_DESTRUCTIVE[facts.sub]?.(facts);
}

/** 单段（已按候选头切好）：破坏性 git 子命令？词表入口与 `gitBypass` **同源**
 *（同一个 `GIT_BIN_NAMES`、同一趟 `gitFacts` 走查）—— 两台走查迟早会漂。 */
function gitDestructiveOf(tokens: readonly ShellToken[]): BashVerdict | undefined {
  const [head] = tokens;
  let result: BashVerdict | undefined;
  if (head !== undefined && isExactBinIn(head, GIT_BIN_NAMES)) {
    const key = gitDestructive(gitFacts(tokens.map((token) => token.value)));
    if (key !== undefined) {
      result = { key };
    }
  }
  return result;
}

/** 长旗标等值（`--flag=value` 的取值在走查里已被切掉，这里只比旗标身份）。 */

/**
 * 这一串里有 dry-run 开关吗（`--dry-run` 或 `--dry-run=client`）——有它只打印、不动东西。
 * 官方 `kubectl delete --dry-run=client` 是这条命令**推荐**的预演写法，拦它就是把
 * 官方教给模型的正确姿势掐掉。
 */
const DRY_RUN_FLAG = "--dry-run";
const hasDryRun = (words: readonly string[]): boolean =>
  words.some((word) => word === DRY_RUN_FLAG || word.startsWith(`${DRY_RUN_FLAG}=`));

/** 段内**非旗标**词（`terraform -chdir=x apply` 的全局旗标要跳掉）。
 *  ⚠ 它不跳旗标的**取值**（`-n foo` 里的 `foo` 仍算位置参数）：各族的判据因此一律
 *  用"包含某词"而不是"第 n 枚是某词"——少一层取值表要维护，代价是极少数生僻写法
 *  会多问一句（`kubectl get pod delete` 那种），而多问一句是本族可接受的代价。 */
const positionalsOf = (words: readonly string[]): string[] =>
  words.filter((word) => !word.startsWith("-"));

/** `terraform`（与它的开源分支 `tofu`）的破坏性形态。 */
function terraformDanger(words: readonly string[]): BashDenialKey | undefined {
  const [sub] = positionalsOf(words.slice(1));
  let key: BashDenialKey | undefined;
  if (sub === "destroy") {
    // `terraform plan -destroy` **不是**这条：`plan` 只打印，`sub` 取到的是 `plan`。
    key = "tfDestroy";
  } else if (sub === "apply" && words.includes("-auto-approve")) {
    key = "tfAutoApprove";
  }
  return key;
}

/** `docker … prune` 的破坏性形态。`docker system df` / `docker image rm` 都不在此列。 */
const dockerDanger = (words: readonly string[]): BashDenialKey | undefined =>
  positionalsOf(words.slice(1)).includes("prune") ? "dockerPrune" : undefined;

/** `kubectl delete` 的破坏性形态（`--dry-run` 除外）。 */
const kubectlDanger = (words: readonly string[]): BashDenialKey | undefined => {
  const positional = positionalsOf(words.slice(1));
  return positional.includes("delete") && !hasDryRun(words) ? "kubectlDelete" : undefined;
};

/**
 * 能出现在迁移命令词之前的**启动器**：`python manage.py migrate`、`npx prisma migrate`、
 * `bundle exec rails db:migrate`。表的存在是为了把"命令位置"钉住 ——
 * 少了它，`grep manage.py migrate docs/` 这种**在文档里搜这串**的调用会假命中。
 */
const MIGRATE_LAUNCHERS: ReadonlySet<string> = new Set([
  "python",
  "python2",
  "python3",
  "pypy",
  "pypy3",
  "npx",
  "bunx",
  "exec",
  "bundle",
  "poetry",
  "uv",
  "pipenv",
]);

/**
 * 迁移命令的 `(命令词, 动作词)` 对：只收**公认会改 schema** 的动作。
 * 只读动作（`prisma migrate status`/`diff`、`flyway info`、`alembic history`）刻意不收 ——
 * 它们不改任何东西，问用户是纯噪音。
 */
/** 三个框架共用的动作词（Rails 系与 Sequelize 都写 `db:migrate`）。 */
const DB_MIGRATE_VERB = "db:migrate";

const MIGRATE_PAIRS: readonly (readonly [string, string])[] = [
  ["manage.py", "migrate"],
  ["prisma", "migrate"],
  ["rails", DB_MIGRATE_VERB],
  ["rake", DB_MIGRATE_VERB],
  ["alembic", "upgrade"],
  ["alembic", "downgrade"],
  ["flyway", "migrate"],
  ["flyway", "undo"],
  ["sequelize", DB_MIGRATE_VERB],
  ["typeorm", "migration:run"],
  ["typeorm", "migration:revert"],
  ["knex", "migrate:latest"],
  ["knex", "migrate:rollback"],
];

/** 动作词之后跟这些时表示**只读**（`prisma migrate status` 查状态而非发布迁移）。 */
const MIGRATE_READ_ONLY_TAILS: ReadonlySet<string> = new Set(["status", "diff", "list", "history"]);

/** 干跑旗标：有它时工具只打印将执行的语句（`manage.py migrate --plan`）。 */
const MIGRATE_DRY_RUN_FLAGS: ReadonlySet<string> = new Set(["--plan", "--sql", DRY_RUN_FLAG]);

/**
 * 数据库迁移命令？**按"命令位置 + 动作词"对**判，不按"段头等于某命令"判 ——
 * 这一族真正的命令词常常是 `python`/`npx`/`bundle` 的**参数**（`manage.py` 就是）。
 */
function migrateDanger(words: readonly string[]): BashDenialKey | undefined {
  const bins = words.map((word) => binNameOf(word));
  let key: BashDenialKey | undefined;
  const dryRun = words.some((word) => MIGRATE_DRY_RUN_FLAGS.has(word));
  for (let index = 0; index < bins.length - 1 && key === undefined; index += 1) {
    // 命令位置：它前面的每一枚词都得是启动器（`grep manage.py migrate` 就不成立了）。
    const atCommand = words.slice(0, index).every((word) => MIGRATE_LAUNCHERS.has(word));
    const head = bins[index];
    const action = bins[index + 1];
    const tail = bins[index + 2];
    const destructive =
      atCommand &&
      MIGRATE_PAIRS.some(([bin, verb]) => bin === head && verb === action) &&
      (tail === undefined || !MIGRATE_READ_ONLY_TAILS.has(tail)) &&
      !dryRun;
    if (destructive) {
      key = "dbMigrate";
    }
  }
  return key;
}

/** 基础设施破坏族的**命令词 → 判据**表（与 git 族同一形状：查表，不在一条长 if 链上堆）。 */
const INFRA_DESTRUCTIVE: Readonly<
  Record<string, (words: readonly string[]) => BashDenialKey | undefined>
> = {
  terraform: terraformDanger,
  tofu: terraformDanger,
  docker: dockerDanger,
  kubectl: kubectlDanger,
};

/** 单段（已按候选头切好）：基础设施破坏族？词表入口按**去路径前缀的命令词**认。 */
function infraDestructiveOf(tokens: readonly ShellToken[]): BashVerdict | undefined {
  const [head] = tokens;
  const words = tokens.map((token) => token.value);
  let key: BashDenialKey | undefined;
  if (head !== undefined) {
    // 命令词按**去路径前缀**认（`/usr/local/bin/kubectl` 与 `kubectl` 同判，与 git 族同口径）。
    const predicate = INFRA_DESTRUCTIVE[binNameOf(head.value)];
    key = predicate?.(words) ?? migrateDanger(words);
  }
  return key === undefined ? undefined : { key };
}

/** 系统关键前缀：整树删除不可逆。/var 与 /tmp **不在列**——它们是常见的缓存/临时
 *  目录清理目标，误拦代价高于漏拦（文件头保守原则），确需整删由用户确认。 */
const SYSTEM_PATH_PREFIXES = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib32",
  "/lib64",
  "/libexec",
  "/nix",
  "/opt",
  "/private",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/Volumes",
  "/Applications",
  "/Users",
  "/System",
  "/Library",
];

/** Windows 字面路径形态：盘符 + 任一分隔符，或 UNC 双反斜杠。
 *  只在这个前提下才做反斜杠归一 —— POSIX 文件名里 `\` 是合法字符，
 *  无条件归一会把 /tmp/we\ird 这类真实路径改判。
 *  注意 `\\\\` 在正则字面量里已是**两个字面反斜杠**，后面不可再接 `[\\/]`
 *  （那会变成要求第三个分隔符，UNC 就永不命中——本计划初稿即犯此错）。 */
const WINDOWS_SHAPE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

/** 归一为小写盘符 + 正斜杠；非 Windows 形态原样返回。
 *  **产物只喂 Windows 轨道**（下面的 UNC 根 / 盘符根 / 系统+用户树三条正则 + 家目录字面
 *  比较；这几条曾叫 `uncRoot` 那个局部量，现已内联成直接比 `shaped`/`winTarget`）：
 *  把它接进 POSIX 判据的入参会挪动既有 disjunct 的判定域——`\\etc` 归一成 `//etc`
 *  再被 path.posix.normalize 压成 `/etc`，于是 shell 源里那个名为 `\etc` 的相对
 *  删除会被**既有**系统前缀表拦下（本包口径下 `\` 是转义，见测试
 *  「引号外反斜杠转义形态」）。 */
function normalizeWindowsShape(raw: string): string {
  if (!WINDOWS_SHAPE_RE.test(raw)) {
    return raw;
  }
  // UNC 形态首字符是 `\`→`/`，toLowerCase 对其无作用，故这一句只降盘符字母。
  const slashed = raw.replaceAll("\\", "/");
  const head = slashed.charAt(0).toLowerCase();
  return `${head}${slashed.slice(1)}`;
}

/**
 * 无盘符的**当前盘绝对形态** `\Users\…`：Windows 读法里前导单枚 `\` 是"从当前盘根算起"
 * （`cd /d D:` 之后 `\Windows` 就是 `D:\Windows`），于是它与 `WINDOWS_SYSTEM_AND_USERS_RE`
 * 指的是同一批树，只是盘符字母未知 ⇒ 按树名判、不比字母。
 * 前置 `DRIVELESS_SHAPE_RE` 把这一形与两条既有形态隔开：`\\` 开头是 UNC（`normalizeWindowsShape`
 * 那条轨道自己管），`X:` 开头走盘符那两条——两条都不许被这条重复计一次。
 */
const DRIVELESS_SHAPE_RE = /^\\[^\\]/u;
const DRIVELESS_SYSTEM_AND_USERS_RE =
  /^\/(?:windows|programdata|program files(?: \(x86\))?|users)(?:\/|$)/iu;

/**
 * 把 `\` 全量折成 `/`（**不做**盘符小写、**不做** normalize）。只服务 `isWindowsShapeTarget`
 * 里那两条新 disjunct：`normalizeWindowsShape` 带 `WINDOWS_SHAPE_RE` 前置，对 `\Users\x` 与
 * `/data/bob\.ssh` 这类形态是恒等的（前者无盘符也非 UNC、后者混了两种分隔符），改它会牵动
 * 既有盘符/UNC/家目录三条的判定域。折全量分隔符在 POSIX 侧是**错**的（`\` 是转义符），
 * 所以这一层只存在于 Windows 轨道内。
 */
function foldWindowsSeparators(raw: string): string {
  return raw.replaceAll("\\", "/");
}

/** 盘符根下的**系统 + 用户**树：windows / programdata / program files / users。
 *  盘符不写死，系统盘可为任意字母；名字里的 `users` 一支同样吃进——那是家目录树，
 *  与 SYSTEM_PATH_PREFIXES 里并列着 /usr、/home、/root 是一个道理。
 *  必须带 `i`：归一只降盘符，`Windows` / `Users` / `Program Files` 的大小写
 *  来自用户输入（补全与 `cd` 历史常留原样大写），无 `i` 则永不命中。 */
const WINDOWS_SYSTEM_AND_USERS_RE =
  /^[a-z]:\/(?:windows|programdata|program files(?: \(x86\))?|users)(?:\/|$)/iu;

/** 盘符自身根（`c:/`）——整树删除不可逆。 */
const WINDOWS_DRIVE_ROOT_RE = /^[a-z]:\/?$/iu;

/** UNC 共享根 `//server/share`（不含其下子路径，避免扩大拦截面）。 */
const UNC_ROOT_RE = /^\/\/[^/]+\/[^/]+\/?$/u;

/** Win32 **逐字路径前缀** `\?\`：它指向去掉前缀后那棵树（`\\?\C:\Windows` 删的就是
 *  `C:\Windows`）。前导 `//` 是 `normalizeWindowsShape` 把 `\` 折成 `/` 之后的形态，
 *  所以这里匹配的是 `//?/` 而不是 `\\?\`。
 *  **`\.\` 那一支故意不吃**：`\\.\etc` 按现有口径是"两段共享根"（照拦），而设备命名空间下
 *  整树删除要先拿到卷句柄，不是 `rd`/`Remove-Item` 做得到的事——吃它换来的漏拦比收益大。 */
const VERBATIM_ROOT_PREFIX = "//?/";

/** `\?\UNC\server\share` 那一支：折回普通 UNC 时必须**留前导 `//`**——上面那条 `UNC_ROOT_RE`
 *  要求 `^//`，把前导丢了它就永不命中（与 `normalizeWindowsShape` 不接 `path.posix.normalize`
 *  是同一条理由：前导 `//` 在 Windows 轨道里是有意义的形状，不是可以顺手压掉的冗余）。 */
const VERBATIM_UNC_PREFIX = "//?/UNC/";

/** Windows 解析路径时吃掉组件尾部的 `.`（`\\srv\share\.` 就是共享根本身），而 `UNC_ROOT_RE`
 *  锚到词尾 ⇒ 不折这一枚点就绕过。只折**尾部**成串的 `/.`：中部的 `/.` 要折就得改写整串，
 *  而带中部点的位置串落在子路径上、按现口径本就放行。 */
const TRAILING_DOT_RE = /(?:\/\.)+$/u;

/** 吃掉逐字路径前缀（两支的差别只在要不要留前导 `//`），长度取自常量、不写死。 */
function stripVerbatimPrefix(shaped: string): string {
  let result = shaped;
  if (result.startsWith(VERBATIM_UNC_PREFIX)) {
    result = `//${result.slice(VERBATIM_UNC_PREFIX.length)}`;
  } else if (result.startsWith(VERBATIM_ROOT_PREFIX)) {
    result = result.slice(VERBATIM_ROOT_PREFIX.length);
  }
  return result;
}

/**
 * Windows 读法（pwsh）下的**波浪号家目录根** `~\…`：pwsh 里 `~` 处处等价家目录、`\` 是
 * 合法分隔符，于是 `Remove-Item -Recurse ~\notes.txt` 删的就是家目录下那个文件 ⇒ 与本文件
 * `winHome` 那两条前缀 disjunct 指的是**同一棵树**，只是根由 `~` 而不是字面家目录写出。
 * 形状只收在 `~` + 反斜杠上，这一条同时是**尾闸**：`~` 后既非分隔符也非词尾的词
 * （`~xyz`、`~mailbox\x`）在 pwsh 里就是名字带波浪号的相对文件，不该当家目录 ——
 * 与 `HOME_EXPANSION_RE` 的 `(?![A-Za-z0-9_])`、`ENV_USER_ROOT_RE` 的 `(?:[\\/]|$)` 同一条
 * 理由，少了它便是误拦。
 * `~` 与 `~/x` 两形走不到也不必走到这里：POSIX 轨那两条波浪号 disjunct 本来就拦，
 * 两种读法同判 ⇒ 本条只补反斜杠那一形，不重复既有面。
 * **只参与 Windows 轨道**（调用点在 `windowsTrack` 早退之后）：bash 不展开 `~\x`，实测
 * `printf '%s\n' ~\notes.txt` 给出 `~notes.txt`（相对文件名，`\n` 被当转义），那条轨道
 * 放行是**正确语义**而非漏拦，故不许为"看起来一致"把它改成拦。
 * 写成字面前缀 + `startsWith` 而不是正则：判据的全部内容就是"波浪号后紧跟一枚反斜杠"，
 * 尾闸由这一枚反斜杠自己给出（`~xyz` 之类的词首字符不是分隔符 ⇒ 天然不匹配）。
 */
const WINDOWS_TILDE_HOME_PREFIX = "~\\";

/**
 * 宿主是否 Windows —— Windows 字形轨道的**两个入口之一**（另一个是调用点的 shell 方言，
 * 见 BashDangerOptions.shellDialect；两者在 catastrophicRm 里合并）。
 *
 * 为什么必须由平台说话：受检串是 shell 源，`\\home\bob` 在 POSIX 源里读作转义字面量
 * `\home\bob`（删一个相对文件），在 Windows 上才是 UNC 路径；两者做反斜杠→正斜杠折叠后
 * **逐字节同形**，字形层面无从区分（此前 9 行 over-block 即出于此）。宿主平台在 guard
 * 时点不是未知量，故不猜字形。
 *
 * 为什么写成函数而非模块级 `const`：模块级常量在 import 时求值，测试打不进桩；
 * 每次判定读一次 `os.platform()`，两份 `node:os` 桩（`test/danger-rules.test.ts` 那份
 * 家目录 mock 顺带接的 `platform`，与 `test/host.test.ts` 里为「bash 名下走 POSIX 读法」
 * 那条接线断言单立的一份）才能同一份代码两边都验。两份是**已登记的重复**：出现第三份
 * 时应抽公共测试助手（已登记的延后项）。
 *
 * 平台**不是**唯一的入口：POSIX 宿主上跑 PowerShell Core（`pwsh`）时 `os.platform()`
 * 不是 win32，而同一条 `Remove-Item -Recurse -Force C:\Windows` 删的真的是那个树。
 * 补它的唯一 sound 口径是「这段源由谁读」——由调用点的**工具身份**说话
 * （`BashDangerOptions.shellDialect`，host.ts 按 `name === "pwsh"` 给），不是猜字形；
 * 本函数只回答「宿主自己是不是 Windows」这半边。
 */
function isWindowsHost(): boolean {
  return os.platform() === "win32";
}

/** 参数展开形态的家目录：`${HOME}`、`${HOME:-/}`、`${HOME:?}`、`${HOME#/x}`、
 *  `${HOME%/*}`、`${HOME/new/old}` 一律先取 $HOME 的值（默认值/修饰只在缺值或做
 *  字符串运算时生效）。bash 展开后删的就是家目录，故与 `$HOME` 同判。
 *  下一字符必须非词字符，否则 `${HOMEBACKUP}` 这类自定义变量会被误当家目录。 */
const HOME_EXPANSION_RE = /^\$\{HOME(?![A-Za-z0-9_])/u;

/** 裸变量形态的家目录 `$HOME`、`$HOME/…`。尾闸与上面那条 `${…}` 形**同一条纪律**：
 *  少了它就是 `startsWith("$HOME")` 那个漏网的写法——实测 `rm -rf "$HOME_BACKUP"`、
 *  `"$HOMEBACKUP"` 全被当家目录拦下，而仓内测试早已裁定 `${HOMEBACKUP}` 这类
 *  "以 HOME 起头的别的变量"属纯误拦。两形现在同判。 */
const HOME_VAR_RE = /^\$HOME(?![A-Za-z0-9_])/u;

/**
 * `~user/…` 与 `~user`：**别人**的家目录（本机实测 `/bin/bash` —— `~someone/x` 展开成
 * `/Users/<user>/x`、`~root` 展开成 `/var/root`、`~SOMEONE/x` 也展开成同一个树，
 * 用户名大小写不敏感）。展开后就是**别人**的家目录树——注意它**不一定**撞系统前缀表
 * （`~root/.ssh` → `/var/root/.ssh`、`~nobody/x` → `/var/empty/x`，而 `/var` 是本包刻意不收进
 * 前缀表的那一条），所以这一形只能自己判，不能指望前缀表兜。
 * **已知的误拦代价**：账号不存在时 bash 原样不展开，
 * `~bob/x` 就真是个以 `~` 开头的相对路径名 ⇒ 本判据按"宁可误拦"处理（与 `rm -rf "$HOME"`
 * 那族同样：引号里的 `$HOME` 永不展开，也照拦）。
 * 尾闸是那个 `/`：`~bob\x` 在 bash 里**不**展开（波浪号前缀只取到 `/` 或词尾，带 `\`
 * 的用户名查不到，实测原样得 `~bobx`），拦它就是误拦——与 `HOME_EXPANSION_RE` 的
 * `(?![A-Za-z0-9_])`、`ENV_USER_ROOT_RE` 的 `(?:[\\/]|$)` 同一条尾闸纪律。
 * **裸 `~user`（词尾无 `/`）不收**，是已登记局限而不是漏网：本机实测 `~root` →
 * `/var/root`（该用户存在即展开）、`~bob`/`~backup` → 原样（用户不存在则不展开，macOS 只有
 * `_backup`）。也就是说这一形的结论取决于"这台机器上有没有这个账号"，判据既不碰 fs 也不查
 * 口令表（查它 = 新依赖 + 新设计决定，与 MSYS 挂载表同族）⇒ 收它会误拦以 `~` 开头的相对
 * 文件名，不收它则放过 `rm -rf ~root` 这一形。见 danger-guard/README「已知边界」。
 * 吃 **raw** 而不是 `posixTarget`：`path.posix.normalize` 会把 `~bob/../.ssh` 折成 `.ssh`，
 * 挂归一值上等于一边修洞一边开洞（与 `WINDOWS_TILDE_HOME_PREFIX` 那条同一理由）。
 * 与既有 `~`/`~/` 两条一样**不随方言退出**：pwsh 里 `~bob/x` 也拦，见测试「方言不放松 POSIX 判据」。
 */
const USER_HOME_RE = /^~[A-Za-z_][A-Za-z0-9_-]*\//u;

/**
 * Windows 字形轨道的判据体：**只在轨道参与时被调用**（`windowsTrack` 那道门留在调用方），
 * 吃 shell 源里的原词 `raw` 与 `os.homedir()` 的原值。
 *
 * 两步"照 Windows 自己的解析习惯改写输入"必须在比较之前完成——逐字路径前缀 `\?\` 吃掉、
 * 组件尾部的 `.` 折掉，否则 `\?\C:\Windows` 与 `\\srv\share\.` 这两形撞不到任何一条树正则，
 * 而那几条正是**锚到词尾**写的。**两条轨道各读各的形**这条纪律不变：这里只改 Windows 侧的
 * 入参，POSIX 判据仍吃词值。
 */
function isWindowsShapeTarget(raw: string, home: string): boolean {
  // ── Windows 轨道（win32 宿主或 Windows 方言抵达）：只有识别出 Windows 字形后才归一，且**只**驱动
  //    下面这几条。glob 剥离不在这条轨道上：盘符两条分别要求 `^[a-z]:`、UNC 那条要求
  //    `^//`，折不折 glob 都得不出新结论。
  const shaped = stripVerbatimPrefix(normalizeWindowsShape(raw));
  // 组件尾部的 `.` 由 Windows 自己吃掉，折完才是它指的那棵树（UNC 那条锚到词尾，不折就绕过）。
  const pointed = shaped.replace(TRAILING_DOT_RE, "");
  // 结构归一（`c://` 与 `c:/` 同物、`e:/work/bob/.` 与家目录同形），**但 UNC 形态保留
  // 前导 `//`**：path.posix.normalize 会把 `//x` 压成 `/x`，压完这条轨道就拿到一串
  // POSIX 绝对路径去比家目录（`\\Users\x` → `//Users/<user>` → `/Users/<user>` === 家目录），
  // 那正是此前拆掉的污染换了个 disjunct 复活的形状。盘符两条吃的是 `^[a-z]:`，
  // 压不压都撞不到；UNC 那条本来就判 shaped（前导 `//` 一压即失，判不得归一值）。
  const winTarget = pointed.startsWith("//") ? pointed : path.posix.normalize(pointed);
  // 家目录在这一侧要过字形归一：Windows 上 os.homedir() 是 `C:\Users\x`，与折过斜杠的
  // winTarget 不同形，原样比较则永不成立（POSIX 侧那条字面比较用的仍是原值）。
  const winHome = normalizeWindowsShape(home);
  return (
    UNC_ROOT_RE.test(pointed) ||
    WINDOWS_DRIVE_ROOT_RE.test(winTarget) ||
    WINDOWS_SYSTEM_AND_USERS_RE.test(winTarget) ||
    winTarget === winHome ||
    winTarget.startsWith(`${winHome}/`) ||
    // 波浪号根 `~\…`：家目录在 Windows 读法下就是 `~`，于是这一形落在 winHome 之内，
    // 与上面两条字面比较同一结论、同一条轨道（形状与尾闸的理由见 WINDOWS_TILDE_HOME_PREFIX）。
    // 吃 **raw** 而不是 shaped/winTarget：`~\x` 不匹配 WINDOWS_SHAPE_RE（无盘符、非 UNC），
    // 归一对它是恒等，把它折进 winHome 再比等于给这条轨道多加一次形状改写。
    raw.startsWith(WINDOWS_TILDE_HOME_PREFIX) ||
    // 无盘符的当前盘绝对形态 `\Windows\System32`：盘符字母未知 ⇒ 只比树名，且树名集合与
    // WINDOWS_SYSTEM_AND_USERS_RE 严格同族（**不**扩到 SYSTEM_PATH_PREFIXES 那 24 条——
    // `\etc`、`\usr` 这类相对删除在本包口径里是转义字面量，扩过来就是把 `\etc` 变成误拦，
    // 那条边界在 normalizeWindowsShape 的文件头里已写明）。
    (DRIVELESS_SHAPE_RE.test(raw) &&
      DRIVELESS_SYSTEM_AND_USERS_RE.test(foldWindowsSeparators(raw))) ||
    // 混分隔符的家目录后代：家目录写成 POSIX 字形（`/data/bob`）再用 `\` 下钻。pwsh 两种
    // 分隔符都吃，折全量之后比家目录前缀；POSIX 侧不折（`\` 是转义），故这条只在轨道内。
    foldWindowsSeparators(raw).startsWith(`${foldWindowsSeparators(home)}/`) ||
    // 单独一枚 `\` 在 Windows 读法里就是**当前盘的根**（`cd /d D:` 之后 `D:\`），与
    // WINDOWS_DRIVE_ROOT_RE 判的是同一类目标；轨道开着时这一形此前两头都不撞 ⇒ 补上。
    raw === "\\"
  );
}

/** 家目录下的**深层普通后代**（相对部分形如 `a/b/…` 且不含 `..`）：日常清理目标。 */
function isDeepHomeDescendant(target: string, home: string): boolean {
  if (!target.startsWith(`${home}/`)) {
    return false;
  }
  const rest = target.slice(home.length + 1);
  return rest.includes("/") && !rest.split("/").includes("..");
}

/**
 * 家目录形态的灾难判据：**家目录本身**、**直接子项**、或路径里出现 `..`（上跳可能落到
 * 别处）都算；更深的普通后代不算——`rm -rf ~/.cache/x/y`、
 * `rm -rf /Users/<user>/project/build` 是日常清理，把整棵家目录树一律拦下等于让 `rm -rf`
 * 不可用（实测误拦：`rm -rf /Users/<user>/.cache/plugin-review/probe-dir` 被当成
 * "目标是家目录"）。
 * 变量形态（`$HOME/…`、`${HOME}/…`）由 `isHomeVarDisaster` 接到同一把尺子上判：`$HOME`、
 * `$HOME/`、`$HOME/Documents` 拦，`$HOME/.cache/x/y` 放行；展开形状不可判时保守拦下。
 * @param target 待判路径（词值或归一值）
 * @param home `os.homedir()`
 * @returns 是否属于「删了就是灾难」的家目录目标
 */
function isHomeDisasterPath(target: string, home: string): boolean {
  if (target === home) {
    return true;
  }
  if (!target.startsWith(`${home}/`)) {
    return false;
  }
  const rest = target.slice(home.length + 1);
  return rest.length === 0 || !rest.includes("/") || rest.split("/").includes("..");
}

/** 波浪号形态映射成家目录绝对形态（`~`→home、`~/x`→home/x），供同一把尺子复用。 */
function tildeHomePath(value: string, home: string): string {
  return value === "~" ? home : `${home}${value.slice(1)}`;
}

/** 变量形态（`$HOME` / `${HOME}`）标记之后的尾巴：`$HOME/x` → `/x`、`${HOME}` → 空串。
 *  标记后没有闭合花括号（畸形输入）按空尾处理——那形退回「家目录本身」，保守。 */
function homeVarTail(value: string): string {
  if (HOME_EXPANSION_RE.test(value)) {
    const end = value.indexOf("}");
    /* v8 ignore next 1 —— 未闭合形态在 lexer 那一层已升格为"需确认"，到不了这里；
       留着是纯函数自己的兜底（畸形输入按空尾 = 家目录本身处理）。 */
    return end === -1 ? "" : value.slice(end + 1);
  }
  return value.slice("$HOME".length);
}

/** 变量形态的灾难判据：与字面 / 波浪号两形**同一把尺子**（家目录本身、直接子项、含 `..`）。
 *  尾巴不以 `/` 开头时（`${HOME:-/}x` 这类展开形状不可判）保持保守拦下。 */
function isHomeVarDisaster(value: string, home: string): boolean {
  const tail = homeVarTail(value);
  if (tail !== "" && !tail.startsWith("/")) {
    return true;
  }
  return isHomeDisasterPath(`${home}${tail}`, home);
}

/** 目标里出现未展开的 glob 元字符：shell 会先展开它，判据该看展开后的那批路径。 */
const GLOB_METACHAR_RE = /[*?[]/u;

/** 正则元字符：glob 模式的字面部分进 `new RegExp` 前必须转义。 */
const REGEX_METACHARS: ReadonlySet<string> = new Set(String.raw`\^$.|+()[]{}*?`);

/**
 * 把 glob 模式编译成**同段匹配**的正则：`*` → `[^/]*`、`?` → 一枚非分隔符、`[...]` 整类 →
 * 一枚非分隔符（字符类内容不解析：判据只问"能否落到受保护前缀上"，取超集是安全方向）。
 * 未闭合的 `[` 在真实 shell 里是字面量，故按字面转义。
 *
 * 为什么不枚举展开结果：条目数由目录内容决定，而这是一条同步纯函数判定。
 * 花括号展开（`{a,b}`）**不在**此列——它不是 glob，且要解析嵌套与不配对形态；
 * 见 README 的「不拦」列，登记为已知洞而不是猜着收。
 */
function globRegExp(pattern: string): RegExp {
  let src = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "*") {
      src += "[^/]*";
    } else if (ch === "?") {
      src += "[^/]";
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      src += close === -1 ? String.raw`\[` : "[^/]";
      i = close === -1 ? i : close;
    } else {
      src += REGEX_METACHARS.has(ch) ? `\\${ch}` : ch;
    }
    i += 1;
  }
  return new RegExp(`^${src}$`, "u");
}

/**
 * 一枚绝对 glob 目标**能否**落到受保护前缀上——根到系统前缀各试"前缀本身"与"其下一层"
 * （`/etc/*` 展开的是 `/etc/<项>`，不是 `/etc` 本身）。
 * 判"能否"而不是"会"：命中即拦，方向与 `rm` 那一族"看不见就不放行"一致。
 */
function globCouldHitProtected(pattern: string, home: string): boolean {
  // 尾斜杠不改变展开结果（`/e*/` 与 `/e*` 都展开成 `/etc`），但会让同段正则多要一格。
  const re = globRegExp(pattern.replace(/\/+$/u, ""));
  return [home, ...SYSTEM_PATH_PREFIXES].some((probe) => re.test(probe) || re.test(`${probe}/x`));
}

/** 花括号展开的预算：超过即按"形状不可判"处理（绝对路径 fail-closed）。 */
const BRACE_EXPANSION_BUDGET = 64;

/** 第一个参与花括号展开的 `{`；跳过 `${…}`（参数展开不归这条判据管）。 */
function braceOpenIndex(word: string): number {
  let found = -1;
  for (let i = 0; i < word.length && found === -1; i += 1) {
    const ch = word.charAt(i);
    if (ch === "$" && word.charAt(i + 1) === "{") {
      const skip = word.indexOf("}", i + 2);
      if (skip === -1) {
        break;
      }
      i = skip;
    } else if (ch === "{") {
      found = i;
    }
  }
  return found;
}

/** 词里是否还有不属于 `${…}` 的花括号（字面花括号或残缺形态）。 */
function hasLiteralBrace(word: string): boolean {
  let found = false;
  for (let i = 0; i < word.length && !found; i += 1) {
    const ch = word.charAt(i);
    if (ch === "$" && word.charAt(i + 1) === "{") {
      const skip = word.indexOf("}", i + 2);
      if (skip !== -1) {
        i = skip;
      }
    } else if (ch === "{" || ch === "}") {
      found = true;
    }
  }
  return found;
}

/** 与 `open` 处配对的 `}`；不配对返回 -1。 */
function matchingBrace(word: string, open: number): number {
  let depth = 0;
  let found = -1;
  for (let i = open; i < word.length && found === -1; i += 1) {
    const ch = word.charAt(i);
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        found = i;
      }
    }
  }
  return found;
}

/** 按顶层逗号切备选项（嵌套花括号里的逗号不切）。 */
function splitBraceAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner.charAt(i);
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      parts.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  if (parts.length === 0) {
    return [inner];
  }
  parts.push(inner.slice(from));
  return parts;
}

/** 闭区间序列（含降序）；跨度超预算返回 null。 */
function rangeWords(
  start: number,
  end: number,
  render: (current: number) => string,
): string[] | null {
  let out: string[] | null;
  if (Math.abs(end - start) + 1 <= BRACE_EXPANSION_BUDGET) {
    out = [];
    const step = start <= end ? 1 : -1;
    for (let current = start; step > 0 ? current <= end : current >= end; current += step) {
      out.push(render(current));
    }
  } else {
    out = null;
  }
  return out;
}

/** `{a..c}` 序列；没匹配上返回 null。 */
function expandAlphaSequence(alpha: RegExpExecArray | null): string[] | null {
  return alpha === null
    ? null
    : rangeWords(
        /* v8 ignore start —— 正则已经保证两个分组存在；?? 只是类型层兜底 */
        alpha.groups?.["start"]?.codePointAt(0) ?? 0,
        alpha.groups?.["end"]?.codePointAt(0) ?? 0,
        /* v8 ignore stop */
        String.fromCodePoint,
      );
}

/** `{1..3}` / `{a..c}` 序列；没有序列（含只有一组字面花括号）一律返回 null。 */
function expandBraceSequence(inner: string): string[] | null {
  const numeric = /^(?<start>-?\d+)\.\.(?<end>-?\d+)(?:\.\.-?\d+)?$/u.exec(inner);
  const alpha = /^(?<start>[A-Za-z])\.\.(?<end>[A-Za-z])$/u.exec(inner);
  return numeric === null
    ? expandAlphaSequence(alpha)
    : rangeWords(Number(numeric.groups?.["start"]), Number(numeric.groups?.["end"]), String);
}

/**
 * 展开一个词的第一组花括号。返回替换后的词（可能还含后面的花括号）；形状不可判返回 null
 * ——没有逗号也没有序列的字面花括号（`{a}`）同样算不可判：bash 不展开它，而把带花括号的
 * 名字当普通路径判会给出"安全"的假象。
 */
function expandOne(word: string): string[] | null {
  let out: string[] | null;
  const open = braceOpenIndex(word);
  if (open === -1) {
    // 调用方只在「没有可展开的 `{`、但还有字面花括号」时才把词交到这里。
    out = null;
  } else {
    const close = matchingBrace(word, open);
    if (close === -1) {
      out = null;
    } else {
      const prefix = word.slice(0, open);
      const suffix = word.slice(close + 1);
      const inner = word.slice(open + 1, close);
      const choices = splitBraceAlternatives(inner);
      const expanded = choices.length > 1 ? choices : expandBraceSequence(inner);
      out = expanded === null ? null : expanded.map((choice) => `${prefix}${choice}${suffix}`);
    }
  }
  return out;
}

/**
 * bash 花括号展开的纯词法子集（`{a,b}`、序列、嵌套）。返回 null 表示形状不可判：
 * 超出预算、残缺花括号、不认识的序列，或 bash 本就不展开的字面花括号。
 *
 * 词值是 lexer 去过引号的一形，所以引号里的花括号也会被展开——方向是**多拦**，
 * 与文件头"宁可多抹"的保守原则一致。
 */
function expandBraces(word: string, budget = BRACE_EXPANSION_BUDGET): string[] | null {
  const pending = [word];
  const out: string[] = [];
  let failed = false;
  for (const current of pending) {
    if (failed) {
      break;
    }
    const settled = braceOpenIndex(current) === -1 && !hasLiteralBrace(current);
    if (settled) {
      out.push(current);
      failed = out.length > budget;
    } else {
      const next = expandOne(current);
      if (next === null) {
        failed = true;
      } else {
        pending.push(...next);
        failed = pending.length > budget;
      }
    }
  }
  return failed ? null : out;
}

/**
 * **POSIX 轨道**的灾难性删除目标：根 / 家目录（**变量与字面路径同判**）/ 系统前缀 / 上跳 /
 * 当前目录，绝对路径的 glob 形态（`/*`、`/usr/**`）等价于其目录本身。
 * 家目录取 `os.homedir()`（只读 HOME 环境变量，无 fs 访问）——`rm -rf /Users/<user>`
 * 与 `rm -rf $HOME` 是同一场灾难，只认变量形态等于给字面路径开了逃逸口。
 * Windows 形态（盘符根 / 系统+用户树 / UNC 共享根 / 反斜杠家目录 / `~\…` 波浪号根）不住在这里，
 * 住在 `isWindowsShapeTarget`，由 `catastrophicRm` 按 `windowsTrack` 另加一条 disjunct——
 * **两条轨道各读各的形**：本函数读词值（转义已落地），那条读源文本（反斜杠还在原位）。
 * 轨道不参与时（宿主非 Windows 且调用点不是 pwsh），`rm -rf C:\Windows` 删的是那个字面名的
 * 相对文件、`rm -rf ~\notes.txt` 删的是 `~notes.txt` 那样的相对文件（bash 实测把 `\n` 当转义、
 * 波浪号不展开）⇒ 一律回到本函数的结论，这是**正确语义**而不是漏拦。
 * @param value 词值（`lexTokens` 去过引号、落过转义的那一形）
 */
function isPosixDisasterTargetWord(value: string): boolean {
  // ── 入参是词值本身（lexical 归一，无需 cwd），与 Windows 字形、与宿主平台都无关。
  const posixNormalized = path.posix.normalize(value);
  // 绝对路径的 glob 形态等价于其目录本身（`/*` → `/`）。
  const posixTarget =
    posixNormalized.startsWith("/") && posixNormalized.includes("*")
      ? path.posix.join(posixNormalized.replace(/\/?\*+$/u, ""), ".")
      : posixNormalized;
  const home = os.homedir();
  // 家目录下的深层普通后代（`~/.cache/x/y`、`/Users/<user>/project/build`）是日常清理目标：
  // 系统前缀表里的 `/Users`（macOS）与 `/home`（Linux）会把它们一并拦下，故在这里先放行。
  // 家目录本身、直接子项、含 `..` 的写法仍由下面的判据拦住；别人的家目录树不在豁免内
  // （`/Users/<other>/x/y` 照旧被 `/Users` 前缀拦）。
  if (isDeepHomeDescendant(posixTarget, home) && isDeepHomeDescendant(value, home)) {
    return false;
  }
  return (
    posixTarget === "/" ||
    // 波浪号 / 字面家目录这两形吃**原词值**：`path.posix.normalize` 会把标记后面的 `..`
    // 段整段吃掉（实测 `~/../etc` → `etc`），挂在归一值上等于给"带上一跳的灾难目标"留一条
    // 漏拦；归一值仍然参与（同一判据 + 系统前缀表）。
    isHomeDisasterPath(posixTarget, home) ||
    isHomeDisasterPath(value, home) ||
    // 波浪号形态映射成家目录绝对形态后按同一把尺子判（`~`、`~/`、`~/x`、`~/a/../b`）。
    ((value === "~" || value.startsWith("~/")) &&
      isHomeDisasterPath(tildeHomePath(value, home), home)) ||
    // 变量形态同样按那把尺子判（`$HOME`、`$HOME/`、`$HOME/Documents` 拦；
    // `$HOME/.cache/x/y` 放行）——展开形状不可判时 isHomeVarDisaster 自己保守拦下。
    ((HOME_VAR_RE.test(value) || HOME_EXPANSION_RE.test(value)) &&
      isHomeVarDisaster(value, home)) ||
    // `~user/…` 吃原词值（归一会吃掉 `..` 段，见 USER_HOME_RE 的注释）。
    USER_HOME_RE.test(value) ||
    // 绝对 glob 的**展开形态**同判：`rm -rf /e?c` 在真实 bash 里展开成 `/etc`（实测）、
    // `rm -rf /e*/` 展开成 `/etc/`。上面那支只剥尾部 `*`（把 `/e*/` 削成 `/e` 后不再成灾），
    // 于是 `?`/`[...]`/中缀 `*` 三族整片漏面——而这三族与 `/*` 是同一件事：shell 先展开、
    // rm 只看结果。读**归一值**而不是上面那支的转换结果：转换已经把命中形态削掉了。
    (GLOB_METACHAR_RE.test(posixNormalized) && globCouldHitProtected(posixNormalized, home)) ||
    posixTarget === "." ||
    posixTarget === ".." ||
    posixTarget.startsWith("../") ||
    SYSTEM_PATH_PREFIXES.some(
      (prefix) => posixTarget === prefix || posixTarget.startsWith(`${prefix}/`),
    )
  );
}

/**
 * 灾难目标判定：词值里含花括号时先按 shell 语义展开，任一展开结果命中受保护面即判灾难。
 * 展开形状不可判（超预算 / 残缺 / 不认识的序列）时，绝对路径与家目录/变量形态按灾难处理
 * ——"看不懂"落在多拦的一侧。
 */
function isPosixDisasterTarget(value: string): boolean {
  const expanded = expandBraces(value);
  if (expanded === null) {
    return value.startsWith("/") || value.startsWith("~") || value.startsWith("$");
  }
  return expanded.some((word) => isPosixDisasterTargetWord(word));
}

/** rm 一系参数走查的可变状态。 */
interface RmWalk {
  args: readonly ShellToken[];
  cmdDialect: boolean;
  pos: number;
  flags: string[];
  targets: ShellToken[];
  /** `--` 之后一律目标，不再按旗标形状过滤。 */
  literal: boolean;
}

/** 该词是不是旗标（POSIX/pwsh 的 `-…`，或 cmd 内建的 `/x` 方言）。 */
const isRmFlagWord = (walk: RmWalk, token: ShellToken): boolean =>
  token.value.startsWith("-") || (walk.cmdDialect && CMD_FLAG_WORD_RE.test(token.value));

/** 带值参数的处置：吃掉两格，取值按角色可能成为目标。 */
interface RmValueArg {
  consumed: number;
  target: ShellToken | undefined;
}

/**
 * 带取值的 pwsh 参数：`-Path ~` 的取值就是要删的路径（进目标），`-Exclude ~` 的取值
 * 只是模式（既不是目标也不是旗标）。下一词是旗标形（`-Filter -Force ~`）时不算取值——
 * pwsh 那里是"缺参数值"的报错形态，剩下的词继续按各自角色走。不是带值参数给 undefined。
 */
function rmValueArg(walk: RmWalk, pos: number, token: ShellToken): RmValueArg | undefined {
  const value = walk.args[pos + 1];
  const role = psValueRole(token.value);
  let out: RmValueArg | undefined;
  if (role !== undefined && value !== undefined && !value.value.startsWith("-")) {
    out = { consumed: 2, target: role === "path" ? value : undefined };
  }
  return out;
}

/** rm 的参数分区（`hasForceRecursive` 与目标判定的输入）：旗标面与目标面各取其一。
 *  `--` 之后一律目标（POSIX/pwsh 同规则），不再按旗标形状过滤——两侧口径此前不一致，
 *  `rm -rf ~ -- -weird` 里那枚 `-weird` 被当旗标丢了，而它其实是文件名。
 *  带取值的 pwsh 参数按 `PS_VALUE_PARAM_ROLES` 的角色处理：实测
 *  `Remove-Item -Exclude ~ -Recurse ./build` 把 `-Exclude` 的取值 `~` 当成了删除目标（误拦）。 */
function partitionRmArgs(
  args: readonly ShellToken[],
  cmdDialect: boolean,
): { flags: string[]; targets: ShellToken[] } {
  const walk: RmWalk = { args, cmdDialect, pos: 0, flags: [], targets: [], literal: false };
  for (;;) {
    const word = args[walk.pos];
    if (word === undefined) {
      break;
    }
    const valueArg = walk.literal ? undefined : rmValueArg(walk, walk.pos, word);
    if (!walk.literal && word.value === "--") {
      walk.literal = true;
      walk.pos += 1;
    } else if (valueArg !== undefined) {
      if (valueArg.target !== undefined) {
        walk.targets.push(valueArg.target);
      }
      walk.pos += valueArg.consumed;
    } else if (!walk.literal && isRmFlagWord(walk, word)) {
      walk.flags.push(word.value);
      walk.pos += 1;
    } else {
      // `--` 之后一律目标：这里不再按旗标形状过滤（`rm -rf ~ -- -weird` 的 `-weird` 是文件名）
      walk.targets.push(word);
      walk.pos += 1;
    }
  }
  return { flags: walk.flags, targets: walk.targets };
}

/**
 * 单段（已按候选头切好）：灾难删除？目标含家/根/系统前缀/上跳即拦；项目内相对路径放行。
 *  命令词面（RM_BIN_WORDS）覆盖 rm + pwsh 原生命令/别名 + cmd 内建，比对一律小写；
 *  `/s` `/q` `/f` 旗标方言只在 CMD_BUILTINS 上启用（同形的 POSIX 绝对路径必须是目标）。
 *  @param tokens 已剥包装词、以命令头起手的**词**（值与源文本两形都在，目标按轨道选形）
 *  @param windowsDialect 调用点是 Windows shell 方言（工具身份），与宿主平台合并后
 *         决定 Windows 字形轨道这一条参不参与
 */
function catastrophicRm(
  tokens: readonly ShellToken[],
  windowsDialect: boolean,
): BashVerdict | undefined {
  const [head] = tokens;
  // 两形里任一命中词表就用那一形（`\rm`、`my\rm`、`C:\tools\rm` 的头都是 rm）。
  const bin = head === undefined ? "" : rmBinOf(head);
  let result: BashVerdict | undefined;
  if (bin.length > 0) {
    const cmdDialect = CMD_BUILTINS.has(bin);
    // 旗标面按**命令词**分派（命令词在调用点是已知量，词形不是）：只有 `remove-item`/`ri`
    // 是"只有 PowerShell 才这么写"的拼法，它们的 `-字母…` 参数名交给 isPsParamAbbrev。
    // `rm`/`del`/`erase`/`rd`/`rmdir` 同时活在 POSIX/cmd 侧，那两侧宽松短簇的 fail-closed
    // 语义必须保住，不能为了 pwsh 的便利放开（代价：pwsh 里 `rm` 是 Remove-Item 的别名，
    // 两种语义在这个命令词上重叠 ⇒ 宁可误拦）。
    const psParamTrack = bin === "remove-item" || bin === "ri";
    // 轨道参与的**两个**入口在这一处合并：宿主自己是 Windows（总闸）**或**调用点
    // 声明这段源是 Windows 方言（工具身份 = pwsh，见 BashDangerOptions.shellDialect）。
    // 后者不是猜字形——方言由调用点说话，POSIX 宿主上的 bash 读法逐字不变。
    const windowsTrack = isWindowsHost() || windowsDialect;
    const { flags, targets } = partitionRmArgs(tokens.slice(1), cmdDialect);
    // 环境变量形态是**未展开**的字面判据，与 `$HOME` 同构：它不随轨道/平台退出，
    // 因为 `%SystemRoot%\System32`、`%USERPROFILE%\Documents` 在任何读法下都不是一个
    // 合法的相对目标，而展开后删的分别是系统根树与用户树。
    // POSIX 判据**两形都过**（词值与源文本），但空串不进：`path.posix.normalize("")` 得到 `.`，
    // 而那正是"删当前目录"这条灾难形状——`rm -rf ""` 与 `rm -rf \`（词值是空串）都不是。
    // 源文本也要过一遍：家目录是配置进来的字面串，`os.homedir()` 报成 `E:\work\bob` 时，
    // 那一串按两种读法都正是家目录本身（只读词值会折成 `E:workbob` 而放行）。
    // 反斜杠在 POSIX 判据里不是分隔符，`\etc`、`\\` 在两形下都不成灾 ⇒ 多这一遍没有误拦代价。
    // Windows 字形轨道只读源文本：词值 `C:WindowsSystem32` 已经不是任何 Windows 形状。
    const disaster = (token: ShellToken): boolean =>
      [token.value, token.raw]
        .filter((form) => form.length > 0)
        .some(
          (form) =>
            ENV_SYSTEM_ROOT_RE.test(form) ||
            ENV_USER_ROOT_RE.test(form) ||
            isPosixDisasterTarget(form),
        ) ||
      (windowsTrack && isWindowsShapeTarget(token.raw, os.homedir()));
    if (
      hasForceRecursive(flags, cmdDialect, psParamTrack) &&
      targets.some((target) => disaster(target))
    ) {
      // 点名**触发判据的那几枚目标**（去重、按首次出现序）：一条 `rm -rf ./build ~` 里
      // 真正成灾的是 `~`，而模型看到的拒绝理由若只说「目标是家目录」，它得回去自己
      // 逐个目标比对才知道该动哪一个——`./build` 删掉是安全的，误把它一起改掉反而更糟。
      // 取词面 `raw`（Windows 轨的判据读的也是它），故两条轨道共用同一份点名。
      //
      // ⚠ 这里**不需要**再兜一层空串：`disaster` 要求 `[value, raw]` 至少一形非空，
      // 而词法层保证 `rawContent` 是 `content` 的超集（转义只缩不增、`\`+换行两者都空），
      // 故 `raw === ""` 蕴含 `value === ""` —— disaster 为真时 raw 必非空。
      // 反向那条 Windows 臂同样自足：`isWindowsShapeTarget` 命中盘符/UNC 形，raw 必非空。
      // 于是名单恒非空，`Fix` 那条「offending 非空」的不变式由这里结构性地兑现，
      // 不必留一条测不到的空串兜底（那正是覆盖率与可读性的双份负债）。
      const offending = [
        ...new Set(targets.filter((target) => disaster(target)).map((target) => target.raw)),
      ];
      result = { key: "rmrf", fix: { role: "disasterTarget", offending } };
    }
  }
  return result;
}

/** 取回内容的命令词：POSIX 三家之外还有 PowerShell 家族的 `Invoke-WebRequest`/
 *  `Invoke-RestMethod` 及其别名（`iwr`/`irm`）——Windows 上"下载即执行"的标准写法是
 *  `iwr -useb https://x | iex`，只认 curl/wget 就是现成的漏拦面。大小写不敏感：cmdlet 名
 *  在真实脚本里大小写混写（文档常写 `Invoke-WebRequest`）。 */
const FETCH_VERBS = String.raw`\b(?:curl|wget|fetch|invoke-webrequest|invoke-restmethod|iwr|irm)\b`;
const FETCH_HEAD_RE = new RegExp(FETCH_VERBS, "iu");
const FETCH_IN_SUBST_RE = new RegExp(`<\\(\\s*${FETCH_VERBS}`, "iu");

/** 单段：下载即执行？执行端是 shell 解释器才拦；jq/grep 等接收端放行。
 *  入参是**结构视图**（引号内字面文本已清空、`$( )`/反引号体内保留），所以
 *  `echo "curl x | sh"` 放行而 `echo "$(curl x | sh)"` 照拦——后者实测真会执行。 */
function pipeToShell(unprefixed: string): BashVerdict | undefined {
  let result: BashVerdict | undefined;
  // 快速门槛：段里有取回内容的命令词
  if (FETCH_HEAD_RE.test(unprefixed)) {
    const fetchIdx = unprefixed.search(FETCH_HEAD_RE);
    // 先取"管道/后台形态"里 shell 执行端的下标（模式一拿它和 fetchIdx 比先后）
    const match = SHELL_EXEC.exec(unprefixed);
    // 两条模式同一条结论（`result = "pipeShell"`），故并成一个条件（sonarjs/no-duplicated-branches）：
    // `||` 保留原短路顺序——模式二那两次 test() 仍只在模式一未命中时才跑。
    if (
      // 模式一：管道/后台喂给 shell（curl … | sh）——shell 在 fetch 之后
      (match !== null && match.index > fetchIdx) ||
      // 模式二：进程替换（sh <(curl …) / source <(curl …) / . <(curl …)）——shell 在前，
      // fetch 结果经 <() 喂给它。命令头允许路径前缀（`/bin/bash <(curl …)` 照拦）。
      (SHELL_HEAD_RE.test(unprefixed) && FETCH_IN_SUBST_RE.test(unprefixed))
    ) {
      result = { key: "pipeShell" };
    }
  }
  return result;
}

/** 剥一层大括号包裹（`{ npm run dev; }`）：闭括号/分号可能是下一段的内容，按可选处理。 */
function peelBrace(src: string): string | undefined {
  const body = src.trim();
  let inner: string | undefined;
  if (body.startsWith("{")) {
    // 闭括号/分号可能是"下一个段"的内容（splitTopLevel 在 ; 处切开），故都按可选处理
    inner = body
      .slice(1)
      .replace(/[;\s}]*$/u, "")
      .trim();
  }
  return inner;
}

/**
 * 归一段：剥前导 `!`（取反不改变危险性质）与成对/残留的大括号包裹，返回命令体串。
 * 圆括号不再需要在此处理：splitTopLevel 已把 `(`、`)` 当段边界，
 * `(cd web && npm run dev)` 的内段本身就是独立段。
 */
function peelSeg(seg: string): string {
  let src = seg.trim().replace(/^!+\s*/u, "");
  for (;;) {
    const inner = peelBrace(src);
    if (inner === undefined) {
      break;
    }
    src = inner;
  }
  return src;
}

/** 包管理器"旗标 + 空格 + 取值"分写的全局旗标。只跳旗标不跳值会把取值误认成子命令：
 *  `pnpm --filter web run dev` 的 web 被当成子命令 ⇒ 后面的 run dev 整个不再被看（实测漏拦；
 *  `npm --prefix /x run dev` 同）。逐枚收录"在这些工具里**恒**带独立取值"的旗标，不做
 *  "未知旗标一律吞值"——吞错一个子命令的代价是漏拦（gitSubcommand 同一条纪律）。
 *  已登记的洞：`yarn workspaces foreach …` 是子命令链 + 旗标再 + 脚本，不在跳词表能
 *  表达的形状里，与「包装词那一类」同款登记。 */
const PKG_VALUE_FLAGS = new Set(["--filter", "--prefix", "--cwd", "-C", "--dir", "--registry"]);

/** 跳包管理器自身旗标（-y / --yes / --silent / -w …，含上表带值旗标的取值词），
 *  返回下一个非旗标词的下标。 */
function packageIndex(words: readonly string[], from: number): number {
  let pos = from;
  for (;;) {
    const word = words[pos];
    if (word === undefined || !word.startsWith("-")) {
      break;
    }
    // 带独立取值的旗标占两词（`--filter web`）；附着值（`--filter=x`）天然一词。
    pos += PKG_VALUE_FLAGS.has(word) && words[pos + 1] !== undefined ? 2 : 1;
  }
  return pos;
}

/** npx/bunx/dlx/exec：跳包管理器自身旗标后取包名，再按包类型判长驻或一次性构建。 */
function npxDanger(
  words: readonly string[],
  start: number,
  serverWords: ReadonlySet<string>,
): BashVerdict | undefined {
  // 旗标挡在包名前必须跳掉，否则 `npx -y vite` 旗标错位漏拦。
  const pos = packageIndex(words, start + 1);
  const pkg = words[pos];
  let result: BashVerdict | undefined;
  if (pkg !== undefined) {
    result = isLongRunningPkg(pkgBinName(pkg), words.slice(pos + 1), serverWords)
      ? { key: "devServer" }
      : undefined;
  }
  return result;
}

/** npm/pnpm/yarn/bun 系列：run 脚本 / exec / x / dlx 别名分级判定。 */
function pkgManagerDanger(
  words: readonly string[],
  start: number,
  serverWords: ReadonlySet<string>,
  runArgs: ReadonlySet<string>,
): BashVerdict | undefined {
  const head = words[start];
  // 包管理器的全局旗标能挡在子命令**前**（`pnpm -w run dev`），也能挡在 run 与脚本名
  // **之间**（`npm run --silent dev`）→ 两处都跳旗标再定位，否则位置错位直接漏判。
  let subPos = packageIndex(words, start + 1);
  // yarn 的 workspace 是"子命令 + 包名取值"（`yarn workspace @x/y run dev`）：包名不跳
  // 会被当子命令，与 --filter 那条漏判同根。
  if (head === "yarn" && words[subPos] === "workspace") {
    subPos = packageIndex(words, subPos + 2);
  }
  const sub = words[subPos];
  // npm/pnpm exec <pkg>、bun x <pkg>、pnpm dlx <pkg> 与 npx <pkg> 同义。
  const isTempPkg = sub === "exec" || sub === "dlx" || (head === "bun" && sub === "x");
  const isRun = sub === "run";
  const scriptPos = isRun ? packageIndex(words, subPos + 1) : subPos;
  const rawScript = isRun ? words[scriptPos] : sub;
  // 脚本名的引号已由 lexTokens 去掉（`npm run "dev"` 不逃逸，词值就是 `dev`）。
  const script = rawScript ?? "";
  // 隐式 exec：yarn/pnpm/bun 对**非内建**子命令回落到本地 .bin 二进制——`yarn vite dev`
  // / `pnpm vite dev` / `bun vite dev` 真的会启动 dev server（实测与 npx 同危，此前放行）；
  // npm 对未知子命令报错，多查无害。⇒ 解析出的子命令/脚本名本身也按命令头过一遍长驻判据，
  // 其后的词就是该二进制的参数（`yarn vite build` 的 build 照常给放行面用）。
  let result: BashVerdict | undefined;
  if (isTempPkg) {
    result = npxDanger(words, subPos, serverWords);
  } else if (runArgs.has(script) || DEV_PREFIX.test(script)) {
    // npm test 等脚本名不含 dev 词根才放行——上面已匹配即拦
    result = { key: "devServer" };
  } else if (
    script.length > 0 &&
    isLongRunningPkg(script, words.slice(scriptPos + 1), serverWords)
  ) {
    result = { key: "devServer" };
  }
  return result;
}

/**
 * 命令头 → 长驻判据的分派面（`devServer` 的下半，词表在这里已合并完毕）。
 * 四类命令头各走自己的口径，互斥：
 * - 长驻词表内置项 + 用户配置词（`serverWords`）：按子命令/旗标区分长驻与一次性构建。
 * - `cargo`：`watch` 是长驻，`run` 是一次性执行。
 * - `npx`/`bunx`：旗标后取包名再判。
 * - `npm`/`pnpm`/`yarn`/`bun`：run 脚本名与 exec/dlx/x 别名分级。
 */
function devServerDangerOfHead(
  head: string,
  words: readonly string[],
  serverWords: ReadonlySet<string>,
  runArgs: ReadonlySet<string>,
): BashVerdict | undefined {
  let result: BashVerdict | undefined;
  if (serverWords.has(head)) {
    // 直接调用 dev 服务器（按子命令/旗标区分长驻与一次性构建，不再一刀切）
    result = isLongRunningPkg(head, words.slice(1), serverWords) ? { key: "devServer" } : undefined;
  } else if (head === "cargo") {
    // watch 是长驻，run 是一次性执行
    result = words[1] === "watch" ? { key: "devServer" } : undefined;
  } else if (head === "npx" || head === "bunx") {
    result = npxDanger(words, 0, serverWords);
  } else if (PKG_MANAGERS.has(head)) {
    result = pkgManagerDanger(words, 0, serverWords, runArgs);
  }
  return result;
}

/** 一次判定调用内复用的上下文：词表合并与方言收窄都只做**一次**，
 *  而不是每段、每个候选命令头都重建一遍 Set。 */
interface DangerContext {
  serverWords: ReadonlySet<string>;
  runArgs: ReadonlySet<string>;
  /** 长驻一系认得的命令头（词表 + 包管理器 + npx/cargo），供两形选形用。 */
  devHeads: ReadonlySet<string>;
  windowsDialect: boolean;
}

function dangerContextOf(opts: BashDangerOptions): DangerContext {
  // 内置 + 用户配置词表合并。无扩展词表时直接复用模块级常量 Set
  // （只读：isLongRunningPkg / runArgs.has 都不改写它）。
  const extraServer = (opts.extraDevServerWords ?? []).filter((word) => word.length > 0);
  const extraRun = (opts.extraDevRunArgs ?? []).filter((word) => word.length > 0);
  const serverWords =
    extraServer.length > 0 ? new Set([...DEV_SERVER_WORDS, ...extraServer]) : DEV_SERVER_WORDS;
  return {
    serverWords,
    runArgs: extraRun.length > 0 ? new Set([...DEV_RUN_ARGS, ...extraRun]) : DEV_RUN_ARGS,
    devHeads: new Set([...serverWords, ...PKG_MANAGERS, "cargo", "npx", "bunx"]),
    windowsDialect: opts.shellDialect === "windows",
  };
}

/** 单段（已按候选头切好）：长驻开发服务器？词表来自上下文（合并只做一次）。 */
function devServer(tokens: readonly ShellToken[], ctx: DangerContext): BashVerdict | undefined {
  const [headWord] = tokens;
  let result: BashVerdict | undefined;
  if (headWord !== undefined) {
    // bin 名（去路径、已由 lexTokens 去引号）：`/usr/bin/vite`、`./.bin/next dev`、`"vite"` 与裸名同判
    const [valueForm, rawForm] = binForms(headWord);
    const head = ctx.devHeads.has(valueForm) ? valueForm : rawForm;
    result = devServerDangerOfHead(
      head,
      tokens.map((token) => token.value),
      ctx.serverWords,
      ctx.runArgs,
    );
  }
  return result;
}

// ── 执行面归一：包装词之后的二次执行与嵌套 shell 的 `-c` 体 ────────────────────
// 四类规则之外的兜底始终是"无"（未知即放行，保守），但**执行面**必须归一：
// 换一层 shell、一层 eval 就绕开全部四类，等于没有闸门。

/** 可嵌套的执行面 shell 名（路径前缀形式 `/bin/bash` 同判）。与 SHELL_HEAD_RE 同族，
 *  但**不含** source/`.`——它们的参数是文件，不是待解析的命令串。
 *  `fish`/`csh`/`tcsh` 也在这张表上：它们的 `-c` 体同样是要执行的命令串，
 *  不进名单就等于给"换一层冷门 shell"留了旁路（体内命令按 POSIX 形状判，
 *  这三家的**旗标**方言不同是已知近似，不为它猜方言）。 */
const SHELL_BIN_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);

/** shell 的 `-c`，含与短选项的合写（`-lc` / `-ic` / `-xc`）：其后第一词是命令串。 */
const SHELL_C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/u;

/** **PowerShell 家族**段头。`.exe` 形同判是本轮定的口径：`powershell.exe` 才是 Windows 上
 *  模型最常照抄的名字，而"`.exe` 算不算命令词"这条只在这一个家族上放宽——`cmd.exe` 仍
 *  按已登记边界处理（见 README 已知边界①）。名字比较一律先转小写：Windows 的命令名
 *  与旗标都大小写不敏感（`PowerShell`、`-COMMAND` 都合法），而 POSIX 那几张表按原形比。 */
const PSHELL_BIN_NAMES = new Set(["pwsh", "pwsh.exe", "powershell", "powershell.exe"]);

/** 取代码串的旗标：`-c`/`-Command` 与 Windows 传统的 `/c`、`/command` 分写形。 */
const PSHELL_CODE_FLAGS = new Set(["-c", "/c", "-command", "/command"]);

/** 体**注定看不见**的旗标：`-File` 的体在磁盘上、`-EncodedCommand` 的是 base64 ⇒ 需确认。
 *  不收的缩写：`-e` 在 Windows PowerShell 里是 `-ExecutionPolicy`（带值、不是代码），
 *  把它当不透明旗标会把 `powershell -ex bypass -Command "…"` 这类正常写法一起拖成需确认；
 *  `-f` 只在不与 `-Format`/`-fi` 冲突时才是 `-File`，这里保守收全名与 pwsh 官方短形 `-file`。 */
const PSHELL_OPAQUE_FLAGS = new Set([
  "-file",
  "/file",
  "-encodedcommand",
  "/encodedcommand",
  "-enc",
  "/enc",
]);

/** POSIX 的 `eval`：它的**全部**参数用空格接起来再当命令串执行（实测
 *  `eval "rm -rf /"` 直接跑），所以取体是 join 而非只取一枚——与 shell 的 `-c` 相反。 */
const EVAL_BIN_NAMES = new Set(["eval"]);

/** **取代码串再执行、但不是 shell** 的解释器 → 其"代码串"旗标（值旗标取紧跟的那一枚）。
 *  这些语言的动作不在词法层面可见（`python3 -c "import os; os.system('rm -rf ~')"` 里
 *  rm 是字符串的一个片段，不是段头），判据看不见就是真看不见——按文件头的例外条款
 *  一律升格为需确认，不享受"认不准就放行"。
 *  已知不收的同类写法：子命令形态（`deno eval …`）与 `sh -c` 之外的脚本文件
 *  （`bash deploy.sh`——文件内容不在输入里，判据不读 fs）。 */
const CODE_EVAL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"],
  python2: ["-c"],
  python3: ["-c"],
  pypy: ["-c"],
  pypy3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  perl5: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
  lua: ["-e", "-ex"],
  osascript: ["-e"],
};

/** `-c` 体下钻的最大层数。每层至少吃掉 `bash -c ` 两词，故递归必然终止；但**终止≠有界**：
 *  栈深与每层 O(输入长度) 的成本都得由本上限给出。
 *  取 16 的依据是"真 bash 收得下的最深套娃"：POSIX 单引号套娃每加一层长度约 ×4
 *  （`'` → `'\''`），实测第 10 层 932KB、第 11 层 3.7MB，而本机 ARG_MAX=1MB（execve 参数
 *  上限），即第 10 层之外这种命令根本进不了进程——16 层已全部命中，留了余量。
 *  上限之上的形态只剩"里面那条命令我一眼没看到"，故按需确认处理，不再按放行
 *  （见文件头例外条款）。判定本身仍是每层 O(输入长度)、共 16 层，线性。 */
const NESTED_SHELL_MAX_DEPTH = 16;

/** 一次执行面读取的三种结论（判别联合：不把"本就没有体"和"取不出体"塌成同一个
 *  undefined——前者是良性，后者要升格为需确认）。 */
type NestedShellVerdict =
  // 可靠取到命令体：交回 commandDanger 递归判定。`windowsFace` = 这体该按 Windows 读法判
  // （段头是 PowerShell 家族 ⇒ 不管外层调用点是 `bash` 还是 `pwsh`，那一层读源的就是 pwsh）
  | { kind: "body"; body: string; windowsFace: boolean }
  // 段头不是执行面 / 没有取体旗标 / 旗标后没有参数：本段没有下钻面（不是"取不出"）
  | { kind: "none" }
  // 看不见要做什么：体取不出可靠文本（引号未闭合、体内残留落单引号）、体在磁盘或 base64 里
  // （`-File`、`-EncodedCommand`），或段头是**非 shell 的代码串解释器**（语言层的动作不在词法面上）
  // ⇒ 由调用方升格为需确认
  | { kind: "opaque" };

/**
 * 引号是否未闭合读 `command-segments` 的 `hasUnclosedQuote`——它与切词、断段是**同一台**
 * 状态机，所以不会出现"这边判成闭合、那边判成未闭合"的两台机器互相打脸。
 * 两处用途：段级未闭合 ⇒ shell 自己都解析不完，取出的体必是残段；体里落单引号 ⇒
 * 切词吞掉的是配对引号，落单那枚只可能来自引号内的字面量，重接出的串与 shell 看到的
 * 词边界已不等价（`bash -c 'echo " ; vite'` 即此）。两种都由调用方升格为需确认。
 */
/** 执行面旗标的位置：段头不参与匹配（真实形态里 `-c`/`-e` 必在命令名之后），
 *  合写形态（`-lc`/`-ic`）同义。 */
function codeFlagIndex(words: readonly string[], isCodeFlag: (word: string) => boolean): number {
  return words.findIndex((word, index) => index > 0 && isCodeFlag(word));
}

/** 段头是不是"取代码串再执行"的非 shell 解释器（它的动作看不见 ⇒ 需确认）。 */
function codeInterpreterHead(words: readonly string[]): boolean {
  const [head] = words;
  const flags = head === undefined ? undefined : CODE_EVAL_FLAGS[binNameOf(head)];
  return flags !== undefined && codeFlagIndex(words, (word) => flags.includes(word)) !== -1;
}

/** shell 系段头的 `-c` 体：只取紧跟该旗标的**那一枚**参数；段头不是 shell 则 undefined。 */
function codeBodyOf(words: readonly string[], bin: string): string | undefined {
  let body: string | undefined;
  if (SHELL_BIN_NAMES.has(bin)) {
    const index = codeFlagIndex(words, (word) => SHELL_C_FLAG.test(word));
    body = index === -1 ? undefined : words[index + 1];
  }
  return body;
}

/** 段头是不是 PowerShell 家族（比较前先转小写：Windows 的命令名大小写不敏感）。 */
const isPshellHead = (bin: string): boolean => PSHELL_BIN_NAMES.has(bin.toLowerCase());

/** PowerShell 的取体旗标位（大小写与 `/` 分隔形都认）。 */
function pshellFlagIndex(words: readonly string[], flags: ReadonlySet<string>): number {
  return words.findIndex((word, index) => index > 0 && flags.has(word.toLowerCase()));
}

/**
 * PowerShell 的 `-Command` 体：其后**全部**参数以空格相接后执行（PowerShell 自己就把剩余
 * 参数 join 成一条命令），与 POSIX `-c`「只取紧跟那一枚、其余是 `$0`/`$1`」正相反。
 */
function powershellBody(words: readonly string[]): string | undefined {
  const index = pshellFlagIndex(words, PSHELL_CODE_FLAGS);
  return index === -1 ? undefined : words.slice(index + 1).join(" ");
}

/** 没有取体旗标、却点了 `-File`/`-EncodedCommand` ⇒ 要执行的东西不在输入里。 */
function powershellBodyHidden(words: readonly string[]): boolean {
  return pshellFlagIndex(words, PSHELL_OPAQUE_FLAGS) !== -1;
}

/** 三种执行面段头各自的取体法：PowerShell 与 `eval` 都把剩余参数空格相接，POSIX shell
 *  的 `-c` 只取紧跟的那一枚（其余是 `$0`/`$1`）。 */
function faceBodyOf(words: readonly string[], bin: string, pshell: boolean): string | undefined {
  if (pshell) {
    return powershellBody(words);
  }
  if (EVAL_BIN_NAMES.has(bin)) {
    return words.slice(1).join(" ");
  }
  return codeBodyOf(words, bin);
}

/**
 * shell / `eval` / PowerShell 段的取体：POSIX shell 的 `-c` 只取紧跟的那一枚参数（其余是
 * `$0`/`$1`，实测 `bash -c "true" "echo NOT-EXECUTED"` 第二枚没执行），`eval` 与 PowerShell
 * 的 `-Command` 都把**剩余参数空格相接**后执行。取不到体（没有旗标、体是空串）给 kind "none"，
 * 文本不可靠（段级或体内引号未闭合）给 kind "opaque"。
 */
function shellBodyVerdict(segText: string, words: readonly string[]): NestedShellVerdict {
  const [head] = words;
  const bin = head === undefined ? "" : binNameOf(head);
  const pshell = isPshellHead(bin);
  let verdict: NestedShellVerdict = { kind: "none" };
  const body = faceBodyOf(words, bin, pshell);
  if (body !== undefined && body.length > 0) {
    verdict =
      hasUnclosedQuote(segText) || hasUnclosedQuote(body)
        ? { kind: "opaque" }
        : { kind: "body", body, windowsFace: pshell };
  } else if (pshell && powershellBodyHidden(words)) {
    verdict = { kind: "opaque" };
  }
  return verdict;
}

/**
 * 段头是执行面时取出**要执行的那条命令串**。四条路分别是各自的 shell 语义：
 * - POSIX shell 的 `-c`：紧跟的那一枚参数才是命令串，其后是 `$0`/`$1`（实测 `bash -c "true"
 *   "echo NOT-EXECUTED"` 只跑 `true`）——把它们一并接进命令体会把无害命令判成危险
 *   （`bash -c 'true' 'x; npm run dev'` 即此）；
 * - `eval`：全部参数空格相接后执行 ⇒ join；
 * - PowerShell 家族：`-c`/`-Command`（含 `/c`、`/command`）之后**全部**参数空格相接后执行
 *   ⇒ join，且体按 Windows 读法判（`windowsFace`）；点了 `-File`/`-EncodedCommand` 而没有
 *   取体旗标 ⇒ 要执行的东西不在输入里，按"看不见"升格；
 * - 非 shell 解释器的 `-c`/`-e`：语言层动作不在词法面上 ⇒ kind "opaque"（需确认）。
 * 体为空串（`bash -c "" rm -rf /`）给 "none"：实测 bash 什么都不执行，后面的词是 `$0`。
 */
function nestedShellVerdictOf(segText: string, words: readonly string[]): NestedShellVerdict {
  return codeInterpreterHead(words) ? { kind: "opaque" } : shellBodyVerdict(segText, words);
}

/**
 * 四类规则里的三类（git 绕过 / 灾难删除 / 长驻服务）逐候选命令头点位判一遍。
 * 候选点位由 `headStarts` 给：段头不是包装词时就是单点（既有判定域一字不加），
 * 是包装词时把其后每个"像命令"的词位都列为候选——option 表按定义补不完，
 * 实测 `sudo -p xrm rm -rf /` 就是这么漏的（该形真会执行 rm）。
 */
function ruleAtCandidates(
  tokens: readonly ShellToken[],
  starts: readonly number[],
  ctx: DangerContext,
): BashVerdict | undefined {
  let denial: BashVerdict | undefined;
  for (const start of starts) {
    denial =
      gitBypass(tokens.slice(start)) ??
      gitDestructiveOf(tokens.slice(start)) ??
      infraDestructiveOf(tokens.slice(start)) ??
      catastrophicRm(tokens.slice(start), ctx.windowsDialect) ??
      devServer(tokens.slice(start), ctx);
    if (denial !== undefined) {
      break;
    }
  }
  return denial;
}

/** 一枚候选头的执行面结论：取不出体 / 体在磁盘或 base64 里 / 取代码串的非 shell 解释器 ⇒ 需确认；取到体 ⇒ 交回调下钻（并说明该按谁的方言读）。 */
function faceDenialOf(
  segText: string,
  words: readonly string[],
  drill: (body: string, windowsFace: boolean) => BashVerdict | undefined,
): BashVerdict | undefined {
  const verdict = nestedShellVerdictOf(segText, words);
  let denial: BashVerdict | undefined;
  if (verdict.kind === "opaque") {
    denial = { key: "nestedShellUnconfirmed" };
  } else if (verdict.kind === "body") {
    // 下钻与否（含"到界就不再取体、按需确认收口"）由调用方给的 drill 决定
    denial = drill(verdict.body, verdict.windowsFace);
  }
  return denial;
}

/**
 * 严重度择优：`deny` 档压过 `ask` 档；**同档先到先得**（先命中的那个更贴近模型写的那一段）。
 *
 * 为什么必须有它（引入 `ask` 档带出来的漏拦）：`commandDanger` 原本是"首命中即返回"，
 * 而一枚 `ask` 档命中会**让扫描提前收工**——`git push -f && rm -rf ~` 里第一段是 ask，
 * 函数当场返回，`rm -rf ~` **从未被判定**。宿主只在结论是 allow 时才 dispatch，而 guard
 * 读到的又正是这个 ask 结论（它按 `RULE_TIER` 让路，不拒），于是用户点了"允许"之后
 * 灾难照常执行。所以扫描要一直走到拿到 `deny` 为止，`ask` 只是记下来的备选。
 */
function preferSevere(
  current: BashVerdict | undefined,
  candidate: BashVerdict | undefined,
): BashVerdict | undefined {
  let result = current;
  if (candidate !== undefined && (result === undefined || RULE_TIER[candidate.key] === "deny")) {
    result = candidate;
  }
  return result;
}

/** 拿到 `deny` 了吗（拿到了就可以停止扫描——更严重的档已经确定，后续候选改变不了结论）。 */
const settled = (verdict: BashVerdict | undefined): boolean =>
  verdict !== undefined && RULE_TIER[verdict.key] === "deny";

/**
 * 一段命令的判定：三类规则逐候选命令头点位 + 执行面（shell 的 `-c`、`eval`、非 shell
 * 解释器的代码串）下钻。
 *
 * 下钻不在本函数里直接调 `commandDanger`，而是由调用方把递归**作为回调传进来**：
 * 直接互调会形成 use-before-define 的环（严格档 lint 禁），而回调把递归留在
 * `commandDanger` 自己的函数体内，自递归天然合法。
 */
function segmentDenial(
  segText: string,
  tokens: readonly ShellToken[],
  starts: readonly number[],
  ctx: DangerContext,
  drill: (body: string, windowsFace: boolean) => BashVerdict | undefined,
): BashVerdict | undefined {
  const rules = ruleAtCandidates(tokens, starts, ctx);
  if (settled(rules)) {
    return rules;
  }
  // 规则面只命中了 `ask` 档 ⇒ **仍要下钻**：`-c` 体里可能藏着一条 `deny` 档
  //（`git push -f && bash -c "rm -rf ~"` 那种形状在段内也一样成立）。原实现在这里
  // 直接 return，`ask` 档一进来就会把体内那条更严重的判据整个跳过。
  let best = rules;
  const words = tokens.map((token) => token.value);
  for (const start of starts) {
    // "已确认危险"排在前：看不见才升格为需确认，看得见危险就用危险那条。
    const face = faceDenialOf(segText, words.slice(start), drill);
    best = preferSevere(best, face);
    if (settled(best)) {
      break;
    }
  }
  return best;
}

/**
 * 体的读法收窄：段头是 PowerShell 家族时，那一层读源文本的是 pwsh/cmd 而不是外层 shell，
 * 所以 Windows 字形轨道必须在体内开着（`bash -c "pwsh -Command 'Remove-Item -Recurse C:\\Windows'"`
 * 里那串反斜杠路径是真分隔符）。这是**放宽到该读的那一侧**，不是从字形猜方言：段头本身就是
 * 执行器身份的证据，与「调用点方言由工具身份给」同一条纪律，只是把身份判据从工具名换成了段头名。
 */
const withWindowsFace = (ctx: DangerContext): DangerContext =>
  ctx.windowsDialect ? ctx : { ...ctx, windowsDialect: true };

/**
 * 一条命令的完整判定：跨段 pipeToShell（管道是跨段结构）+ 逐段 `segmentDenial`。
 * 两条界各自钉住一种成本，界外都不放行而是升格需确认：
 * - 嵌套 `-c` 的层数（`NESTED_SHELL_MAX_DEPTH`）：depth 只随层数增长（每层至少吃掉
 *   `bash -c ` 两词），与输入长度无关，所以"10 万字自嵌套"不会白烧 CPU 去无限下钻；
 * - 执行面区 `$( )`/反引号的层数（`REGION_MAX_DEPTH`，在词法层界住）：每多一层就要重扫
 *   一遍所在串的文本，长度上限只界得住单次扫描，界不住"层数 × 长度"。
 */
function commandDanger(
  command: string,
  ctx: DangerContext,
  depth: number,
): BashVerdict | undefined {
  // 管道语义是跨段结构（下载→执行）：先在整命令视野里判 pipeToShell，再逐段判其余三类。
  // 结构视图清空引号内的**字面**文本（`echo "curl x | sh"` 不该误拦），但保留 `$( )`/反引号
  // 体内内容——那一枚在真实 shell 里会执行（实测 `echo "$(seq 3 | tail -1)"` 输出 `3`），
  // 按字面丢弃就是 `echo "$(curl -s https://x | sh)"` 这类写法的静默放行面。
  let result = pipeToShell(structureView(command));
  // 方言在上下文里收窄一次，随嵌套 `-c` 体一路继承：换一层 shell **不换**方言的读法
  // （`pwsh` 调用点里的 `bash -c "rm -rf C:/Windows"` 内层按 Windows 轨道判 ⇒ 拦）。
  const segmentation = splitSegments(command);
  for (const seg of segmentation.texts) {
    // 只有拿到 `deny` 档才算"结论已定"：`ask` 档只是备选，扫描要继续（见 preferSevere）。
    if (settled(result)) {
      break;
    }
    const segText = peelSeg(seg);
    const tokens = lexTokens(segText);
    const starts = headStarts(tokens);
    result = preferSevere(
      result,
      segmentDenial(segText, tokens, starts, ctx, (body, windowsFace) =>
        depth >= NESTED_SHELL_MAX_DEPTH
          ? { key: "nestedShellUnconfirmed" }
          : commandDanger(body, windowsFace ? withWindowsFace(ctx) : ctx, depth + 1),
      ),
    );
  }
  if (segmentation.truncated) {
    // 执行面区（`$( )`/反引号）套得比界内更深 ⇒ 还有一批体没扫到。与 `-c` 超界同一条纪律：
    // 看不见的那部分要升格为需确认，不能拿"扫到的这些没危险"当放行依据。
    // 它**不压**已拿到的 `deny`（同级取先到，且 deny 更严重）——`preferSevere` 已经管住这点。
    result = preferSevere(result, { key: "nestedShellUnconfirmed" });
  }
  return result;
}

/** 一次调用**声明目标路径**的键形。密钥面按这里认，不按工具名认：工具名随 provider 与版本
 *  变（改名、加别名、换实现都在宿主侧发生），而"要动哪个文件"这件事在参数里就写着。
 *  换到键形口径 ⇒ 只读类工具读凭据文件也会被拒（模型不该翻凭据，这是本轮定的取舍，
 *  出路是把动作写成只读动词或让用户手动操作）；事实门**不跟着放宽**，仍走 `editTargetPath`
 *  的严格写类口径——给只读工具要求"先读后写"就是自相矛盾的死锁。 */
const TARGET_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "target_path",
  "targetPath",
];

/** 只读动词：这一类动作不改文件，密钥面跳过（`str_replace_editor` 的 `command:"view"` 就是它）。
 *  只认动词而不猜工具名，与上面同一口径。 */
const READ_ONLY_VERBS = new Set(["view", "read", "cat", "list", "search", "fetch", "get"]);

/** 这次调用的动作是不是只读动词（三个常见动词键位任取其一）。 */
function readOnlyAction(args: Record<string, unknown>): boolean {
  const verb = args["command"] ?? args["action"] ?? args["mode"];
  return typeof verb === "string" && READ_ONLY_VERBS.has(verb.toLowerCase());
}

/**
 * 一次工具调用声明的**全部**目标路径（键形口径，去重后按键位顺序给出）。
 * 只取非空字符串值：数组型多目标（`paths: [...]`）不在本轮口径内——宿主侧的批量写会逐条
 * 派发成单路径调用，认数组等于把"哪一条命中"这个上报签名丢掉。
 */
export function declaredTargets(args: Record<string, unknown> | undefined | null): string[] {
  const targets: string[] = [];
  if (args && typeof args === "object" && !readOnlyAction(args)) {
    for (const key of TARGET_PATH_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.length > 0 && !targets.includes(value)) {
        targets.push(value);
      }
    }
  }
  return targets;
}

/**
 * **事实门专用**的写类目标（严格工具名口径，与上面的键形口径刻意不同源）：
 * - edit / write（dsh-tool-fs）→ args.file_path（兼容 args.path）；
 * - str_replace_editor（dsh-tool-str-replace-editor 并存编辑器）→ args.path，
 *   但 command=view 是只读，返回 null（不拦、不过事实门）；
 * - 其它工具 → null。
 * 放宽到这里会让只读工具也过"首次编辑先给事实"的门，那是死锁而不是防护。
 */
export function editTargetPath(
  name: string | undefined,
  args: Record<string, unknown>,
): string | null {
  if (name !== "edit" && name !== "write" && name !== "str_replace_editor") {
    return null;
  }
  if (name === "str_replace_editor") {
    if (args["command"] === "view") {
      return null;
    }
    const candidate = args["path"];
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
  }
  const filePath = args["file_path"] ?? args["path"];
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
}

/**
 * 密钥类路径检测：编辑工具不应触碰凭据面。
 * 目录分隔同时认正斜杠与反斜杠（Windows 路径 `C:\Users\x\.ssh\id_rsa` 照拦）。
 * 扩展名后缀用 `(?![\w.])` 而非 `\b`——`\b` 会让 `api.key.ts`/`main.pem.tsx` 等
 * 合法源码（扩展名后还有 `.ts`）被当密钥误拦；新写法要求扩展名处于词尾（后不接词字符/点）。
 *
 * 内置词表补高频凭据位置。旧版只认 `.ssh/.gnupg/.aws/.kube`
 * + `id_*` + 扩展名白名单，导致 `.env` 全族（现代项目最高频凭据存放处：API key /
 * DB 连接串 / 第三方 token）、`.npmrc`/`.pypirc`/`.netrc`、`credentials.json`/
 * `service-account*.json`（GCP 服务账号密钥）、`.docker/config.json`、`secrets.yaml`
 * 等全部放行——正是"硬编码固定值"漏面的典型后果。
 *
 * 写成「分支数组 + String.raw + join('|')」而非单条正则字面量：
 *   - 每段可独立审计与单测（旧单行 200 字符正则无法逐段核对）；
 *   - `String.raw` 免掉一层转义陷阱——`new RegExp(string)` 里 `\\` 表示单反斜杠，
 *     字面量里的 `[\\/]`（反斜杠+斜杠类）在字符串里必须写成 `[\\\\/]` 才对，
 *     少一层就是只含 `/` 的类，Windows 路径全部漏拦（本分支已踩过）。
 * 误拦可通过卡片「额外密钥路径模式」自服务扩展（只能追加不能白名单，
 * 故示例/模板类 `.env.example` 等已用负向前瞻显式排除）。
 */
const SECRET_PATH_BRANCHES = [
  // 1) 凭据目录：目录内任何文件都拦（编辑工具不应翻动凭据目录）。
  //    `^` 支路与同表其余分支**同一条纪律**：少了它，相对写法 `.ssh/config`、
  //    `.aws/credentials`、`.kube/config`、`.docker/config.json` 全都撞不到
  //    （实测这四形逐条放行，而同表的 `.git/config` 相对形却拦得住——分支之间自相矛盾）。
  String.raw`(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker)(?=[\\/])`,
  // 2) 私钥主名（路径分隔或词尾；`id_rsa.pub` 公钥、`id_rsa_backup`/`id_rsa-old`
  //    等拷贝一并拦——后缀允许 `.`/`_`/`-`，与索引面 SECRET_EXCLUDE_GLOBS 的
  //    `id_rsa*` 对齐；`id_rsaX` 这类连续字母名不算（非拷贝命名））
  String.raw`(?:^|[\\/])(?:id_rsa|id_ed25519|id_ecdsa)(?:$|[\\/._-])`,
  // 3) 密钥/证书扩展名：要求处词尾（后不接词字符或点），防 `api.key.ts` 误拦
  String.raw`\.(?:pem|key|p12|pfx|keystore|jks)(?![\w.])`,
  // 4) `.env` 全族（`.env` / `.env.local` / `.env.production` / `.env-x` …）；
  //    负向前瞻排除示例模板（`.env.example/.sample/.template/.dist/.defaults`）——
  //    这类文件常提交进仓库、可安全编辑，且 extraSecretPatterns 只能追加不能白名单，
  //    误拦将无 UI 出路。后缀段可重复（`.env.production.backup`）。
  String.raw`(?:^|[\\/])\.env(?![.-](?:example|sample|template|dist|defaults)(?:$|[\\/]))(?:[.-][A-Za-z0-9_]+)*(?:$|[\\/])`,
  // 5) 凭据类 dotfile：包管理器/语言/协议级凭据文件
  String.raw`(?:^|[\\/])\.(?:envrc|npmrc|pypirc|netrc|pgpass|git-credentials)(?:$|[\\/])`,
  // 6) 服务账号与凭据 JSON（GCP service-account*.json、通用 credentials.json）
  String.raw`(?:^|[\\/])(?:credentials|service-account(?:[-_][A-Za-z0-9_-]+)?)(?:\.json)(?:$|[\\/])`,
  // 7) secrets / secret 配置（yaml/yml/json）
  String.raw`(?:^|[\\/])secrets?(?:\.(?:ya?ml|json))(?:$|[\\/])`,
  // 8) token 文件
  String.raw`(?:^|[\\/])token\.json(?:$|[\\/])`,
  // 9) git 配置（可内嵌 `http.<url>.username`/`password`）；要求 `.git/` 分隔，
  //    故 `.gitignore` 不受影响
  String.raw`(?:^|[\\/])\.git[\\/]config(?:$|[\\/])`,
];
const SECRET_PATH_RE = new RegExp(SECRET_PATH_BRANCHES.join("|"), "iu");

/** 判定输入的规模上限。成本本身是线性的（实测 20 万字符命令 22.6ms），设上限是为了
 *  给"用户可扩展的正则"这一面一个硬界：模式由设置面注入，一条 `(a+)+$` 配 46 字符
 *  路径就能把 guard 挂死两分钟以上（实测），而 guard 跑在工具调用主路径上。
 *  超限的结论是**需确认**，不是放行——判不完就是没判完。 */
const MAX_JUDGED_COMMAND_LENGTH = 1_000_000;
const MAX_JUDGED_PATH_LENGTH = 4096;

/** editDanger 的可选配置（词表可配置化；缺省 = 内置正则）。 */
export interface EditDangerOptions {
  /** 额外密钥路径正则片段（追加到内置 SECRET_PATH_RE 的 OR 分支）。 */
  extraSecretPatterns?: readonly string[];
  /** 会话工作目录：相对目标先按它解析成绝对路径再判。
   *  **调用点上下文，不是用户配置**——宿主从 `session.header.cwd` 拿（host 侧已有
   *  `resolveTarget` 同一来源），lib 侧不碰 `process.cwd()`，纯函数口径不变。 */
  cwd?: string;
  /** 宿主给的**解析形清单**（`目标 → 真实路径们`；解析留在 host.ts 那一层，lib 侧不 import
   *  `node:fs`，纯函数口径守住）。一枚目标可能同时有两形：本机 `realpathSync` 解出的那一形，
   *  以及官方后端交出的那一形（`ctx.fs.resolve` + `processPath`，或 `fs/observed` 里后端自己
   *  报的 target）——非本地执行世界（sandbox / ssh / e2b）下只有后者说的是同一份盘。
   *  判定取**并集**：声明形与每一枚解析形各自过一遍词法形态，任一命中即拒。多一形只可能多拦，
   *  方向与本包口径一致；少一形才是漏（所以两形从不互相替换）。
   *  有这一位，"目录本身是软链"与"`~/.ssh/authorized_keys` 是指向别处的符号链接"就不再是
   *  覆盖外。缺席时判定退回词法侧（少的是软链面，不是全部）。
   *  注意 TOCTOU 只是**收窄**而不是消除：解析与真实写入之间仍可能被换目标。 */
  resolvedPaths?: Readonly<Record<string, readonly string[]>>;
}

/** 用户扩展模式的编译结果（合法的要能用、非法的要知道是哪条——静默跳过等于让用户以为保护已生效）。 */
export interface SecretPatternPartition {
  accepted: string[];
  rejected: string[];
}

/** 单条扩展模式的长度上限：正则本身的病（灾难回溯）没法静态判定，但"超长"是配置写错的
 *  最强信号，先按长度收一道，剩下的口径写在 README 的「扩展模式由配置者自负」。 */
const MAX_SECRET_PATTERN_LENGTH = 512;

/**
 * 逐条试编译用户给的密钥模式：`new RegExp(pat, "u")` 抛错、或长度超限的进 `rejected`。
 * 这是**加载期校验**的谓词（host 侧读配置时调用并把 rejected 报出来）；判定链里
 * `secretRe` 也走同一个函数，两侧不可能给出不一致的模式集合。
 */
export function partitionSecretPatterns(patterns: readonly string[]): SecretPatternPartition {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const pattern of patterns) {
    if (pattern.length === 0 || pattern.length > MAX_SECRET_PATTERN_LENGTH) {
      rejected.push(pattern);
    } else {
      try {
        accepted.push(new RegExp(pattern, "u").source);
      } catch {
        rejected.push(pattern);
      }
    }
  }
  return { accepted, rejected };
}

/** 合并内置 + 用户配置的密钥路径正则（每次调用构建；实测开销可忽略，不必缓存）。 */
function secretRe(opts: EditDangerOptions = {}): RegExp {
  const { accepted } = partitionSecretPatterns(opts.extraSecretPatterns ?? []);
  if (accepted.length === 0) {
    return SECRET_PATH_RE;
  }
  // 每条用户模式**自带边界**再进 OR：不包 `(?:…)` 的话，`a|b` 这种模式会和内置分支
  // 抢同一层 alternation，等价于把内置面也改写了一遍。
  const userBranches = accepted.map((pat) => String.raw`(?:${pat})`).join("|");
  return new RegExp(`${SECRET_PATH_RE.source}|${userBranches}`, "iu");
}

/**
 * 目标的待判形态：原串 + 两种分隔符方言的词法归一（`.git/x/../config` 归一后就是
 * `.git/config`，实测此前撞不到分支 9），外加"宿主给了 cwd 时的绝对解析形态"。
 * 两个方言都算而不是"猜哪一个对"：判据不看 fs，无从知道 `a\b` 是 Windows 路径还是
 * POSIX 上带反斜杠的文件名——多算一种形态只可能**多拦**，方向与本包口径一致。
 */
function targetForms(target: string, cwd: string | undefined): string[] {
  const forms = new Set([target, path.posix.normalize(target), path.win32.normalize(target)]);
  if (cwd !== undefined && cwd.length > 0 && !path.isAbsolute(target)) {
    const joined = path.resolve(cwd, target);
    forms.add(joined);
    forms.add(path.win32.normalize(joined));
  }
  return [...forms];
}

/** 一枚目标的全部待判形态：声明形与宿主给的每一枚解析形（缺席时只有声明形），各自再过一遍词法形态。 */
function formsToJudge(targetPath: string, opts: EditDangerOptions | undefined): string[] {
  const resolved = opts?.resolvedPaths?.[targetPath] ?? [];
  return [targetPath, ...resolved].flatMap((candidate) => targetForms(candidate, opts?.cwd));
}

/**
 * 对**已归一化的目标路径**做密钥面判定——`editDanger` 的内部一步：判定与上报共用同一个键，
 * 不必在调用处再写一个永不生效的 null 兜底。
 * 待判的是**声明形 + 宿主给的解析形**（`resolvedPaths`）各自的全部词法形态：软链指向凭据
 * 时声明形看不出来，解析形看得出来；反过来解析失败（目标尚不存在）时声明形仍然要判。
 * 返回的是文案键（`secretPath` / `opaqueTarget`），拒绝理由由宿主按当前语言从消息表取。
 */
function secretPathDeny(targetPath: string, opts?: EditDangerOptions): EditDenialKey | undefined {
  let result: EditDenialKey | undefined;
  if (targetPath.length > MAX_JUDGED_PATH_LENGTH) {
    result = "opaqueTarget";
  } else {
    const re = secretRe(opts);
    if (formsToJudge(targetPath, opts).some((form) => re.test(form))) {
      result = "secretPath";
    }
  }
  return result;
}

/** 编辑类工具的路径防线产出：命中的文案键 + **哪一枚目标**命中的（拒绝文案与上报都指着它）。 */
export interface EditDenial {
  key: EditDenialKey;
  target: string;
}

/**
 * 单枚路径的密钥面判定（`editDanger` 的同一把词表，只是不收整份调用参数）。
 * 为什么单独出口：预检的**引用扫描**要按路径决定"这份文件的正文能不能抄给模型"，
 * 而它手上只有一枚磁盘路径，没有 `file_path`/`path` 那层参数形状。两处必须同源——
 * 否则"编辑时算凭据、扫描时把它的正文当引用证据抄出去"就是同一把词表的两个读数，
 * 而那正是本包最不该有的那种漂。
 * @param target - 待判路径（绝对或相对；相对形按 `opts.cwd` 补一种绝对形态）。
 * @param opts - 与密钥闸同一份配置（用户追加的模式 + 会话目录）。
 * @returns 命中密钥面（含"长到判不了"那一档保守结论）时为 true。
 */
export function isSecretPath(target: string, opts?: EditDangerOptions): boolean {
  return secretPathDeny(target, opts) !== undefined;
}

/**
 * 编辑/写类调用的密钥面判定：对 `declaredTargets` 给的每一枚目标判，第一个命中即返回。
 * 入参不再有工具名——目标由**键形**认（见 `declaredTargets` 那条取舍）。
 */
export function editDanger(
  args: Record<string, unknown> | undefined | null,
  opts?: EditDangerOptions,
): EditDenial | undefined {
  let denial: EditDenial | undefined;
  for (const target of declaredTargets(args)) {
    const key = secretPathDeny(target, opts);
    if (key !== undefined) {
      denial = { key, target };
      break;
    }
  }
  return denial;
}

/**
 * bash 命令危险判定：**带出路**的出口——逐段检查，任一段命中即返回该段命中的规则键
 * 与「哪几枚词/哪几个目标触发了判据」（见 `Fix`）。非字符串/空串放行。
 *
 * 这是 host 侧 `tools.guard` 的 bash 部分谓词用的出口（它拿 `key` 去
 * `messagesFor(MESSAGES, locale)` 的结果里取拒绝理由，再按当次语言渲染 `fix`）。
 * 只关心"判不判"的那一侧走 `bashDanger`（同一份判定，本函数是它唯一的实现）。
 *
 * @param opts 词表配置（extraDevServerWords / extraDevRunArgs）+ 调用点的 shell 方言
 * （`shellDialect`，由宿主按工具身份给，缺省 = POSIX 读法）。
 */

export function bashVerdict(
  command: string | undefined | null,
  opts?: BashDangerOptions,
): BashVerdict | undefined {
  // 判定主体在 commandDanger（跨段 pipeToShell + 逐段四类 + 嵌套 `-c` 递归），
  // 本函数只做入参收窄：非字符串/空串 → result 保持 undefined（放行）。
  let result: BashVerdict | undefined;
  if (typeof command === "string" && command.length > 0) {
    // 超限 = 没判完，与"嵌套体看不见"同一结论：交给用户拍板，不静默放行。
    result =
      command.length > MAX_JUDGED_COMMAND_LENGTH
        ? { key: "nestedShellUnconfirmed" }
        : commandDanger(command, dangerContextOf(opts ?? {}), 0);
  }
  return result;
}

/**
 * bash 命令危险判定（**只回规则键**的老出口，签名与判定逐字未变）。
 * 为什么留着它而不是把 `bashVerdict` 顶上：它是本包随包发布的声明面的一部分
 * （`types/lib/danger-rules.d.ts`），改返回形状是一次破坏性变更，而消费侧要的往往
 * 只是"判不判"。本函数是 `bashVerdict` 的一行投影，两条路共用同一份判定 ——
 * 判定只有一份实现，所以"两出口给出不同结论"这件事结构上不成立。
 */
export function bashDanger(
  command: string | undefined | null,
  opts?: BashDangerOptions,
): BashDenialKey | undefined {
  return bashVerdict(command, opts)?.key;
}

/**
 * 工具名 → shell 方言。这是**调用点身份**，不是从字形猜（`\\home\bob` 折叠后与 UNC
 * 逐字节同形，字形本身说明不了谁在读它）：`bash` 名下按 POSIX 读法、`pwsh` 名下按
 * Windows 字形轨道。其余工具名返回 `undefined`（本闸不判它们）。
 *
 * 为什么必须单源：guard 的 bash 闸与需确认档都要这个映射，两处各写一遍 `name === "pwsh" ? …`
 * 时，任何一侧改了而另一侧没改，表现是"guard 拦得住、审批看不见"或反过来 ——
 * 那种不一致没有任何运行期信号，正是本包最不该有的那种漂。
 */
export const dialectOfTool = (name: string | undefined): ShellDialect | undefined => {
  if (name === "bash") {
    return "posix";
  }
  return name === "pwsh" ? "windows" : undefined;
};

/**
 * 宿主 bash 的**后台执行**参数名（官方 `tool-bash` 的 schema：`run_in_background`
 * "Run in the background and return a job id immediately (collect with `job_output`,
 * stop with `job_kill`). **No timeout applies.**"）。
 *
 * 为什么这一枚要进判据：长驻命令**曾经**会挂死会话，那正是 `devServer` 规则的由来；
 * 而宿主现在自己管得住它（job id / `job_output` / `job_kill`，且不设时限）。
 * 于是"后台执行的长驻命令"不再是我们该拦的形态 —— 拦它就是**把宿主的正确写法一起拦掉**。
 */
const RUN_IN_BACKGROUND_KEY = "run_in_background";

/** 这次调用要求后台执行吗（只认严格 `true`，与宿主官方的判据同形）。 */
const isBackgroundCall = (args: Record<string, unknown> | undefined): boolean =>
  args?.[RUN_IN_BACKGROUND_KEY] === true;

/**
 * 一次调用命中的事实：结论 + **被判定的那条命令原文**。
 *
 * 为什么原文一起交回而不是让调用方再从参数里读一遍：两处各读一次时，"判的是这串、
 * 报的是另一串"这种错没有任何运行期信号。而调用方为了把 `unknown` 收成 `string`，
 * 还得再写一道 `typeof command === "string"` —— 那是**死分支**（本函数返回非空蕴含
 * 它必是字符串），留着就是覆盖率与可读性的双份负债。
 */
export interface BashHit {
  verdict: BashVerdict;
  command: string;
}

/**
 * **调用点入口**：工具名 + 参数 + 配置 → 这次调用的判定结论。
 *
 * 它是 `bashVerdict`（只吃命令文本）之上的一层，收三件调用点才有的东西：
 *  1. **方言**由工具身份给（`dialectOfTool`，不从字形猜）；
 *  2. 命令原文从参数里读一次并**随结论交回**（见 `BashHit`）；
 *  3. **后台执行的让路**：`devServer` 在 `run_in_background === true` 时不拦 ——
 *     宿主的作业面自己管生命周期，长驻不再挂死会话（理由见 `RUN_IN_BACKGROUND_KEY`）。
 *
 * 判据本体仍在 `bashVerdict`（与 `bashDanger` 同一份实现），所以三个出口不可能给出
 * 互相打架的结论。
 */
export function bashVerdictOf(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  opts?: BashDangerOptions,
): BashHit | undefined {
  const dialect = dialectOfTool(name);
  const { command } = args ?? {};
  let hit: BashHit | undefined;
  if (dialect !== undefined && typeof command === "string" && command.length > 0) {
    const { key, fix } = bashVerdict(command, { ...opts, shellDialect: dialect }) ?? {};
    const backgroundLongRun = key === "devServer" && isBackgroundCall(args);
    if (key !== undefined && !backgroundLongRun) {
      // 条件展开：`fix` 缺席时**不写该键**（exactOptionalPropertyTypes 下两者语义不同）。
      hit = { verdict: { key, ...(fix === undefined ? {} : { fix }) }, command };
    }
  }
  return hit;
}

/**
 * 灾难目标词面 → **绝对路径**，供宿主做包含性判断（"这枚目标包不包含任何可写根"）。
 *
 * 只处理 `catastrophicRm` 会点名的那几类形态，**归一不出来的一律 `undefined`**，
 * 调用方据此**保守地不让路**。刻意不处理的：
 *  - **glob**（`/*`、`/usr/**`）：落点要展开才知道，猜它就是在给误放行开口子；
 *  - **Windows 字形**（盘符 / UNC / `~\`）：要过一张盘符表才知道它指向哪棵树；
 *  - **`~user/…`**：要查口令表（本包明令不查，见 `USER_HOME_RE`）；
 *  - **`${HOME:-…}` 的带默认值形**：展开规则带分支，取最保守的那种不猜。
 *
 * @param word - `Fix.offending` 里的词面。
 * @param cwd  - 会话工作目录（相对形按它归一）；缺席时相对形交回 `undefined`。
 * @returns 归一后的绝对路径；判不出来时 `undefined`。
 */
export function disasterTargetPathOf(word: string, cwd: string | undefined): string | undefined {
  const home = os.homedir();
  const homeItself = word === "~" || word === "$HOME";
  const homeChild = word.startsWith("~/") || word.startsWith("$HOME/");
  // **判不出来的一律不归一**（调用方据此不让路）：glob 与反斜杠形的落点要过展开或盘符表，
  // 而"以 `~`/`$` 开头却不属于上面两族"的是 `~user`、`${HOME:-…}`、别的变量形 ——
  // 它们要过口令表或展开规则的分支（本包明令不猜）。少了这两条排除，它们会掉进下面的
  // cwd 分支被拼成一个**看起来合理**的路径，那是这条判据最危险的那种错。
  const opaque =
    word.includes("*") || word.includes("\\") || (!homeItself && !homeChild && /^[~$]/u.test(word));
  let result: string | undefined;
  if (!opaque) {
    if (homeItself) {
      result = home;
    } else if (homeChild) {
      result = path.posix.join(
        home,
        word.startsWith("~/") ? word.slice(2) : word.slice("$HOME/".length),
      );
    } else if (path.posix.isAbsolute(word)) {
      result = word;
    } else if (cwd !== undefined) {
      result = path.posix.resolve(cwd, word);
    }
  }
  return result === undefined ? undefined : path.posix.normalize(result);
}
