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
// - 执行面同判：包装词（sudo/env/time/xargs…）与**嵌套 shell 的 `-c` 体**都不改变
//   命令性质——四类规则对递归取出的体内命令同样适用（下钻深度有界）。

import os from "node:os";
import path from "node:path";
// 段边界这一层单列在 lib/command-segments.ts：四类规则都只在"段"上判定，断在哪里与判成什么无关。
import { splitTopLevel } from "./command-segments.ts";

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
  | "nestedShellUnconfirmed";

/** 密钥/凭据面的判定结论：`secretPath` 键（文案同样由宿主从消息表里取）。 */
export type EditDenialKey = "secretPath";

/** 支持 --no-verify 的 git 子命令（对齐 ECC block-no-verify 清单）。 */
const GIT_NO_VERIFY_SUBS = new Set(["commit", "push", "merge", "cherry-pick", "rebase", "am"]);

/** `-n` 只对这两个子命令是 --no-verify 的短形式。`git push -n` 是 --dry-run、
 *  `git am/cherry-pick -n` 是"不提交"，都不构成钩子绕过——一并拦会误伤安全形态。 */
const SHORT_N_NO_VERIFY_SUBS = new Set(["commit", "rebase"]);

/** 长旗标缩写的最小长度：git 接受不歧义的 `--no-verify` 前缀（`--no-veri`/`--no-verif`
 *  实测确实跳过 pre-commit 钩子），缩写同样绕过钩子 → 一并拦。
 *  下限定在 `--no-v`：更短前缀歧义面太大（--no-edit/--no-commit 都以 `--no-` 开头）。
 *  产品决策（复核 + 真实 git 探针）：`--no-v`/`--no-ve`/`--no-ver` 在
 *  `git commit` 上与 `--no-verbose` 歧义、git 自身直接报错（那命令根本跑不起来），
 *  所以「拦下这段前缀」不会误伤任何**能正常工作**的命令——代价只是让模型改用全词。
 *  反向放开它们则要给每个子命令维护一份 option 表才能判歧义，收益为负。 */
const NO_VERIFY_ABBREV_MIN = "--no-v".length;

/** 运行前缀词：提权/包装命令，不改变命令实部（复用 devServer 前缀思路）。
 *  漏一个词就是一个逃逸口（`time npm run dev`、`doas rm -rf /` 曾因此放行）。 */
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
]);

/** 吃旗标的包装词 → 其**带独立取值**的旗标（跳名不跳值会让取值挡在命令实部前 →
 *  头匹配失败，`nice -n 10 npm run dev` 即此）。分表而非共用一份：`sudo -n`（非交互，
 *  无值）与 `nice -n 10`（有值）字形相同语义相反，共用会把 `sudo -n rm -rf /` 的 rm
 *  当成取值吃掉，反手造出新的逃逸口。 */
const PREFIX_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "--unset", "--unset-var"],
  nice: ["-n", "--adjustment"],
  stdbuf: ["-i", "-o", "-e"],
  sudo: ["-u", "-g", "--user", "--group"],
  taskset: ["-c", "--cpu-list"],
  timeout: ["-k", "-s", "--kill-after", "--signal"],
  watch: ["-n", "-t", "--interval", "--title"],
};

/** 旗标之外还吃一个**位置**取值的包装词（`nice 10 …` / `timeout 5 …`）。 */
const PREFIX_POSITIONAL_VALUE = new Set(["nice", "timeout", "taskset", "chrt"]);

/** 前导环境赋值（VAR=x），同样不改变命令实部。 */
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** 按 `/\s+/` 切词并丢空词（命令实部的词序列）。 */
const wordsOf = (src: string): string[] => src.split(/\s+/u).filter((word) => word.length > 0);

/** 命令头取 bin 名：路径前缀不是逃逸口（`/bin/rm -rf /`、`/usr/bin/git commit --no-verify`）。
 *  分隔符同时认正斜杠与反斜杠：pwsh / cmd 的头常写成 `C:\tools\rm`，只剥 `/` 会让它带着
 *  整条路径落到命令词表外面（等价于换个命令名逃逸）。不含反斜杠的词（POSIX 的全部写法）
 *  剥出来的结果与改动前逐字相同。 */
const binNameOf = (word: string): string => word.replace(/^.*[\\/]/u, "");

/** 去一层配对引号（`rm -rf "$HOME"`、`npm run "dev"` 不逃逸）。 */
function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text.charAt(0);
    if ((first === '"' || first === "'") && text.endsWith(first)) {
      return text.slice(1, -1);
    }
  }
  return text;
}

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

/**
 * 剥运行前缀：跳过 sudo/nohup/env/time/nice/watch… 与前导 VAR=x 赋值，返回命令实部。
 * gitBypass/catastrophicRm/pipeToShell/devServer 共用——前缀不能成为拦截逃逸口
 * （`sudo rm -rf /`、`doas rm -rf /`、`time npm run dev` 照拦）。
 */
function stripRunPrefix(seg: string): string {
  const words = wordsOf(seg);
  let i = 0;
  for (;;) {
    const word = words[i];
    if (word === undefined) {
      break;
    }
    const valueFlags = PREFIX_VALUE_FLAGS[word];
    if (valueFlags !== undefined) {
      const flags = consumeToolFlags(words, i + 1, valueFlags);
      i += 1 + flags;
      // 位置取值（nice 10 / timeout 5）只在**没有**旗标取值可吃时才吃一词——
      // `nice -n 10 npm …` 的 10 已由 -n 吞掉，再吃就把 npm 当取值吞了。
      if (flags === 0 && PREFIX_POSITIONAL_VALUE.has(word) && words[i]?.startsWith("-") === false) {
        i += 1;
      }
    } else if (RUN_PREFIX_WORDS.has(word) || ENV_ASSIGN_RE.test(word)) {
      i += 1;
    } else {
      break;
    }
  }
  return words.slice(i).join(" ");
}

/**
 * 丢弃引号内的字面内容（保留引号外结构与引号本身）。用于 pipe / --no-verify 等
 * "结构旗标"检测：`echo "curl x | sh"`、`git commit -m "...--no-verify..."`
 * 里的字面文本不是真实管道/旗标，剥掉后不再误判；而真实结构（引号外的 | sh、--no-verify）保留。
 */
function stripQuotedSpans(src: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (const ch of src) {
    if (quote !== null) {
      // 引号内字面内容丢弃（结构保留）：只保留闭合引号本身。
      if (ch === quote) {
        quote = null;
        out += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** 会整树删除的命令词：rm + pwsh 原生命令与别名 + cmd 内建。
 *  比对时一律小写 —— pwsh 与 cmd 的命令词不区分大小写。
 *  已知未覆盖（**类**，不是某一种拼法）：**包装词那一层**——段头是"另一个解释器/包装器"
 *  时，它后面的整树删除进不到本词表。同一类的活拼法至少有 `cmd.exe /c rd /s /q …`、
 *  `cmd /c …`（去 `.exe`）、`pwsh -c "…"`、`powershell -Command "…"` 四条，测试按类各钉
 *  一条现状（见「包装词那一类」组）；补这一层要跳包装词 + 定策「`.exe` 后缀算不算
 *  命令词」，与本仓已明确的保守口径冲突（见「git.exe 不判成 git」那条），故留作登记的洞。 */
const RM_BIN_WORDS: ReadonlySet<string> = new Set([
  "rm",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "rmdir",
]);

/** 只有 cmd 内建才用 `/s` `/q` 旗标方言。
 *  `/s` 与 POSIX 绝对路径字面同形：把 `rm -rf /etc` 的 `/etc` 当旗标丢掉，
 *  会从"漏拦"翻成"判定失效"，所以方言必须由命令词决定，不能靠字面。 */
const CMD_BUILTINS: ReadonlySet<string> = new Set(["rd", "rmdir", "del", "erase"]);

/** cmd 旗标的**字形**：`/` + 单个字母。长度钉死在一个字母上，`/etc`、`/usr/local`
 *  这类 POSIX 绝对路径才不会因为「它也是斜杠打头」被当成旗标丢掉。
 *  形状与方言是两件事：本正则只在 `CMD_BUILTINS` 的命令词上启用。 */
const CMD_FLAG_WORD_RE = /^\/[a-z]$/iu;

/** rm 短旗标簇：单横线 + 全字母（`-rf`/`-drf`/`-RWx`/`-srf`）。与 76ba2da 的既有 POSIX
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

/**
 * 一枚选项词 → 旗标贡献（`hasForceRecursive` 循环体的判据，逐条与抽前同形）。
 * 三条面**按命中即止排序**，先长旗标、后短簇：
 * - `--force`/`--recursive` 与 cmd 侧 `/q`/`/f`/`/s`：等值比较，命中即返回，**不再**走簇
 *   （`--force` 形状上也会被 `SHORT_FLAG_CLUSTER_RE` 拒掉，但 `/f` 在 POSIX 轨上不该进簇，
 *   两侧都靠这条顺序把"长旗标"与"短簇"隔开）。
 * - 短簇（`-rf`/`-RWx`）：只在**非 cmdlet 参数名轨**且字形匹配时扫（`psParamTrack` 的取舍
 *   写在 `hasForceRecursive` 的 doc 上）。
 * - PowerShell 参数名缩写（`-rec`/`-fo`）：叠在簇之后而不是簇的替代分支；`recurse` 与
 *   `force` 的参数名前缀互不相交（r- 系对 f- 系），故两条判据不会同时为真 ——
 *   与抽前那条 `if/else if` 的结论逐字等价。
 */
function flagsOfWord(word: string, cmdDialect: boolean, psParamTrack: boolean): FlagSet {
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
 *   "判据不读 dry-run"这件事 `6978fc7` 也一样（那里 `-WhatIf -Recurse -Force <树>` 照拦），
 *   暂不扩范围修（要修得先定策"dry-run 是否算一种独立的、可豁免的形态"）。
 * - `rm`/`del`/`erase`/`rd`/`rmdir` 同时存在于 POSIX/cmd 侧 ⇒ 短簇分支照走，且参数名两条
 *   **叠在它之后**（不是 else-if 的替代分支）：簇扫大小写敏感，`-Force -r`、`-Force --recursive`
 *   这类 pwsh 长词得靠参数名那一面补上 force，否则 POSIX 命令词上反而放出改动前拦着的
 *   整树删除（pwsh 里 `rm` 就是 Remove-Item 的别名）。POSIX 的 fail-closed 语义不为 pwsh 的
 *   便利让路：两种语义在这个命令词上重叠时宁可误拦。**这一侧的门槛一个字不变**：
 *   `rm -r ~` 仍放行、`rm -R ~` 仍拦，cmdlet 轨那条"递归单独即灾难级"不越轨到 `rm` 上。
 * @param args 命令头**之后**的参数词序列（调用方已剥运行前缀与 bin 路径）
 * @param cmdDialect 命令词是否属 CMD_BUILTINS —— 决定 `/s` `/q` `/f` 算不算旗标
 * @param psParamTrack 命令词是否为 `remove-item`/`ri` 拼法 —— 决定 `-字母…` 词走参数名面还是走短簇面，
 *        并决定递归是否单独即灾难级（见上）
 */
function hasForceRecursive(
  args: readonly string[],
  cmdDialect: boolean,
  psParamTrack: boolean,
): boolean {
  let force = false;
  let recursive = false;
  let upperR = false;
  for (const word of args) {
    if (word === "--") {
      break;
    }
    // 单词的三条旗标面（长旗标 / 短簇 / PowerShell 参数名）在 `flagsOfWord` 里裁定，
    // 这里只做累积：簇扫大小写敏感，`-Force -r`、`-Force --recursive` 这类 pwsh 长词
    // 得靠参数名那一面补上 force，否则 POSIX 命令词上反而放出改动前拦着的整树删除
    // （`rm` 在 pwsh 里就是 Remove-Item 的别名）。叠加只往"多认旗标"的方向走，
    // 与簇同向，不会放出任何改动前拦着的写法。
    const flags = flagsOfWord(word, cmdDialect, psParamTrack);
    recursive ||= flags.recursive;
    force ||= flags.force;
    upperR ||= flags.upperR;
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
const SHELL_EXEC = new RegExp(
  `(?:^|\\||<\\(|\\$\\()\\s*` +
    `(?:(?:[^|\\s]*/)?${EXEC_WRAPPERS}\\s+(?:${WRAPPER_SKIP})*)*` +
    `(?:[^|\\s]*/)?(?:sh|bash|zsh|dash|ksh)\\b`,
  "u",
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
/** 长驻子命令：dev/serve/start/preview/watch。 */
const SERVE_SUBS = new Set(["dev", "serve", "start", "preview", "watch"]);
/** 长驻旗标：--watch/-w/--hot 等（webpack 默认一次性，靠这些旗标转长驻）。 */
const WATCH_FLAGS = new Set(["--watch", "-w", "-watch", "--hot", "--live"]);

/**
 * 判定"命令头/包名 pkg + 参数 rest"是否为长驻 dev server。
 * - webpack 默认一次性构建：仅当出现 serve/watch 子命令或旗标才长驻；
 * - vite/next/nuxt 默认长驻：出现 build 子命令才放行；
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
      return rest.some((word) => SERVE_SUBS.has(word) || WATCH_FLAGS.has(word));
    }
    // vite/next/nuxt 默认长驻；出现 build 子命令放行——但 build 与 watch 旗标并存
    // （`vite build --watch`）仍是长驻，不能因看到 build 就放行。
    if (rest.some((word) => BUILD_SUBS.has(word))) {
      return rest.some((word) => WATCH_FLAGS.has(word));
    }
    return true;
  }
  return true;
}

/** shell 方言（BashDangerOptions.shellDialect 的取值面）。 */
export type ShellDialect = "posix" | "windows";

/** bashDanger 的可选配置（v6 词表可配置化；缺省 = 内置词表）。 */
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

/** git 里确实"旗标 + 空格 + 取值"分写的全局旗标。 */
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-c", "-C"]);

/** `git config core.hooksPath <dir>`：钩子目录被永久改走，等价于永久关掉所有钩子。
 *  `--get/--unset/--list` 是读取或恢复默认，不构成绕过。 */
const HOOKS_PATH_KEY_RE = /^core\.hooksPath(?:$|=)/iu;
const HOOKS_PATH_READ_FORMS = /^--(?:get(?:-all|-regexp)?|list|unset(?:-all)?|remove-section)$/iu;

/**
 * 跳过 git 全局旗标，取第一个非旗标词作为子命令；无则 undefined。
 * 带值全局旗标占两词：-c/-C key=value 与 --flag value（亲审 C——只跳旗标
 * 不吞值会把 key 误判成子命令；但清单子命令本身永不被吞：先看下一词是否在清单里）。
 * 合写形态（`--flag=value`、`-cK=V`）天然只占一词，由 else 分支一并覆盖。
 */
function gitSubcommand(words: readonly string[]): string | undefined {
  let pos = 1;
  let sub: string | undefined;
  for (;;) {
    const word = words[pos];
    if (word === undefined) {
      // 全是全局旗标、没有子命令词（`git --paginate`）
      break;
    }
    if (!word.startsWith("-")) {
      sub = unquote(word);
      break;
    }
    const nxt = words[pos + 1];
    // 独立取值的旗标（-c/-C 与未知 --flag）吞下一词；但清单子命令永不被吞——
    // 误吞一个子命令的代价是漏拦一次，错判 sub 的代价是误拦正常命令。
    const takesValue =
      GIT_GLOBAL_VALUE_FLAGS.has(word) || (word.startsWith("--") && !word.includes("="));
    pos +=
      takesValue &&
      nxt !== undefined &&
      !nxt.startsWith("-") &&
      !GIT_NO_VERIFY_SUBS.has(unquote(nxt))
        ? 2
        : 1;
  }
  return sub;
}

function hooksPathConfigured(args: readonly string[]): boolean {
  if (args.some((word) => HOOKS_PATH_READ_FORMS.test(word))) {
    return false;
  }
  return args.some((word) => HOOKS_PATH_KEY_RE.test(word));
}

/** 长旗标缩写：git 接受不歧义前缀（`--no-v`…`--no-verify`），缩写同样绕过钩子。 */
const isNoVerifyAbbrev = (word: string): boolean =>
  word.length >= NO_VERIFY_ABBREV_MIN && "--no-verify".startsWith(word);

/** 钩子跳过旗标：`--no-verify` 及其缩写；commit/rebase 的短形式 `-n` 同义。 */
function hasHookSkipFlag(args: readonly string[], sub: string): boolean {
  return args.some(
    (word) => isNoVerifyAbbrev(word) || (SHORT_N_NO_VERIFY_SUBS.has(sub) && word === "-n"),
  );
}

/** 单段：git 钩子绕过？绕过旗标只在清单子命令上构成绕过（精确拦截）。 */
function gitBypass(seg: string): BashDenialKey | undefined {
  const body = stripRunPrefix(seg);
  const words = wordsOf(body);
  const [head] = words;
  let result: BashDenialKey | undefined;
  if (head !== undefined && binNameOf(head) === "git") {
    const sub = gitSubcommand(words);
    // 子命令判定用原词（引号包裹的子命令 `git "commit"` 仍要认），旗标判定用剥掉
    // 引号内容的词表：提交信息里的 `--no-verify` 是字面文本不是旗标（H6）。
    const args = wordsOf(stripQuotedSpans(body)).slice(1);
    if (
      // hooksPath 值可被引号分离（`git -c "core.hooksPath=..."`）→ 允许可选引号。
      /-c\s+["']?core\.hooksPath=/iu.test(body) ||
      (sub === "config" && hooksPathConfigured(args)) ||
      (sub !== undefined && GIT_NO_VERIFY_SUBS.has(sub) && hasHookSkipFlag(args, sub))
    ) {
      result = "noVerify";
    }
  }
  return result;
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

/**
 * `~user/…` 与 `~user`：**别人**的家目录（本机实测 `/bin/bash` —— `~yuanjiang/x` 展开成
 * `/Users/yuanjiang/x`、`~root` 展开成 `/var/root`、`~YUANJIANG/x` 也展开成同一个树，
 * 用户名大小写不敏感）。展开后就是**别人**的家目录树——注意它**不一定**撞系统前缀表
 * （`~root/.ssh` → `/var/root/.ssh`、`~nobody/x` → `/var/empty/x`，而 `/var` 是本包刻意不收进
 * 前缀表的那一条），所以这一形只能自己判，不能指望前缀表兜。
 * **已知的误拦代价（边界⑥b）**：账号不存在时 bash 原样不展开，
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
 * Windows 字形轨道的判据体：**只在轨道参与时被调用**（`windowsTrack` 那道门留在调用方
 * `isDisasterTarget`），吃 shell 源里的原词 `raw` 与 `os.homedir()` 的原值。
 *
 * 从 `isDisasterTarget` 抽出来是为了 oxlint 的 `eslint/complexity` 闸值，不是为了改行为：
 * 六条 disjunct 的操作数、顺序、结论与抽前逐字相同（`posixDisaster` 归调用方做首项短路），
 * 本包的既有用例一条没动。
 */
function isWindowsShapeTarget(raw: string, home: string): boolean {
  // ── Windows 轨道（win32 宿主或 Windows 方言抵达）：只有识别出 Windows 字形后才归一，且**只**驱动
  //    下面这几条。glob 剥离不在这条轨道上：盘符两条分别要求 `^[a-z]:`、UNC 那条要求
  //    `^//`，折不折 glob 都得不出新结论。
  const shaped = normalizeWindowsShape(raw);
  // 结构归一（`c://` 与 `c:/` 同物、`e:/work/bob/.` 与家目录同形），**但 UNC 形态保留
  // 前导 `//`**：path.posix.normalize 会把 `//x` 压成 `/x`，压完这条轨道就拿到一串
  // POSIX 绝对路径去比家目录（`\\Users\x` → `//Users/x` → `/Users/x` === 家目录），
  // 那正是此前拆掉的污染换了个 disjunct 复活的形状。盘符两条吃的是 `^[a-z]:`，
  // 压不压都撞不到；UNC 那条本来就判 shaped（前导 `//` 一压即失，判不得归一值）。
  const winTarget = shaped.startsWith("//") ? shaped : path.posix.normalize(shaped);
  // 家目录在这一侧要过字形归一：Windows 上 os.homedir() 是 `C:\Users\x`，与折过斜杠的
  // winTarget 不同形，原样比较则永不成立（POSIX 侧那条字面比较用的仍是原值）。
  const winHome = normalizeWindowsShape(home);
  return (
    UNC_ROOT_RE.test(shaped) ||
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

/**
 * 灾难性删除目标：根 / 家目录（**变量与字面路径同判**）/ 系统前缀 / 上跳 / 当前目录，
 * 绝对路径的 glob 形态（`/*`、`/usr/**`）等价于其目录本身。
 * 家目录取 `os.homedir()`（只读 HOME 环境变量，无 fs 访问）——`rm -rf /Users/x`
 * 与 `rm -rf $HOME` 是同一场灾难，只认变量形态等于给字面路径开了逃逸口。
 * Windows 形态（盘符根 / 系统+用户树 / UNC 共享根 / 反斜杠家目录 / `~\…` 波浪号根）作为**额外 disjunct**
 * 相加，走独立的字形归一轨道，并且**整条轨道由 `windowsTrack` 说话**：它的两个入口是
 * 「宿主是不是 Windows」（isWindowsHost，轨道参与的总闸）与「调用点是不是 Windows 方言」
 * （BashDangerOptions.shellDialect，工具身份），由 catastrophicRm 合并后传进来。
 * 两者都不是时，`rm -rf C:\Windows` 删的是那个字面名的相对文件、`rm -rf \\home\bob` 删的是
 * `\home\bob`、`rm -rf ~\notes.txt` 删的是 `~notes.txt` 那样的相对文件（bash 实测把 `\n`
 * 当转义，波浪号不展开），三者都回到 POSIX 判据的结论。
 * POSIX 判据吃的值恒为 `path.posix.normalize(raw)`（家目录恒为 `os.homedir()` 原值），
 * 即入参域与本函数改动前逐字相同，且在**任何**宿主、**任何**方言上都相同。
 * @param windowsTrack Windows 字形轨道今天参不参与判定
 *
 * Windows 那侧的六条 disjunct 住在 `isWindowsShapeTarget`（本函数只留 `windowsTrack` 这道门与
 * POSIX 段）：抽出去之前本函数压在 oxlint `eslint/complexity` 的闸值 20 上、加一条 disjunct 必然
 * 越闸，当时的取舍是挂一条带理由的 disable；后来把它改成一次**纯搬运**（表达式、
 * 操作数、结论一字未动），于是 disable 也随之撤掉。
 */
function isDisasterTarget(raw: string, windowsTrack: boolean): boolean {
  // ── POSIX 轨道：入参是 **raw 本身**（lexical 归一，无需 cwd），与 Windows 字形、
  //    与宿主平台都无关。这一段表达式与改动前逐字同形。
  const posixNormalized = path.posix.normalize(raw);
  // 绝对路径的 glob 形态等价于其目录本身（`/*` → `/`）。
  const posixTarget =
    posixNormalized.startsWith("/") && posixNormalized.includes("*")
      ? path.posix.join(posixNormalized.replace(/\/?\*+$/u, ""), ".")
      : posixNormalized;
  const home = os.homedir();
  const posixDisaster =
    posixTarget === "/" ||
    // 波浪号 / 变量 / 字面家目录这四形一律吃 **raw**：`path.posix.normalize` 会把标记后面的
    // `..` 段整段吃掉（实测 `~/../etc` → `etc`、`$HOME/../usr` → `usr`），挂在归一值上等于给
    // "带上一跳的灾难目标"留一条漏拦——复核实测：改动前 `rm -rf ~/../etc` 两种读法都放行，
    // 而 bash 展开它得到 `/etc`。归一值仍然参与（下面两条字面比较 + 系统前缀表），只是不再
    // 由它代言这四形。
    raw === "~" ||
    raw.startsWith("~/") ||
    posixTarget === home ||
    posixTarget.startsWith(`${home}/`) ||
    // 字面家目录也吃 raw：`/Users/x/../y` 归一后落到**别人**的树，归一值那条撞不到。
    raw === home ||
    raw.startsWith(`${home}/`) ||
    raw.startsWith("$HOME") ||
    HOME_EXPANSION_RE.test(raw) ||
    // `~user/…` 吃 raw（归一会吃掉 `..` 段，见 USER_HOME_RE 的注释）。
    USER_HOME_RE.test(raw) ||
    posixTarget === "." ||
    posixTarget === ".." ||
    posixTarget.startsWith("../") ||
    SYSTEM_PATH_PREFIXES.some(
      (prefix) => posixTarget === prefix || posixTarget.startsWith(`${prefix}/`),
    );
  // 轨道参与的**两个**入口（宿主是不是 Windows、调用点是不是 Windows 方言）由调用方合并后
  // 传进来（见 catastrophicRm）：这里只问「这一轨今天参不参与」。都不在时，
  // `rm -rf C:\Windows` 删的是那个字面名的相对文件、`rm -rf \\home\bob` 删的是 `\home\bob`，
  // 两者都回到 POSIX 判据的结论。
  if (!windowsTrack) {
    return posixDisaster;
  }
  return posixDisaster || isWindowsShapeTarget(raw, home);
}

/** 单段：灾难删除？目标含家/根/系统前缀/上跳即拦；项目内相对路径放行。
 *  命令词面（RM_BIN_WORDS）覆盖 rm + pwsh 原生命令/别名 + cmd 内建，比对一律小写；
 *  `/s` `/q` `/f` 旗标方言只在 CMD_BUILTINS 上启用（同形的 POSIX 绝对路径必须是目标）。
 *  @param windowsDialect 调用点是 Windows shell 方言（工具身份），与宿主平台合并后
 *         决定 Windows 字形轨道这一条参不参与
 */
function catastrophicRm(seg: string, windowsDialect: boolean): BashDenialKey | undefined {
  const words = wordsOf(stripRunPrefix(seg));
  const [head] = words;
  // bin 名一次取好（路径前缀已含反斜杠）；比对一律小写。
  const bin = head === undefined ? "" : binNameOf(head).toLowerCase();
  let result: BashDenialKey | undefined;
  if (RM_BIN_WORDS.has(bin)) {
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
    const args = words.slice(1);
    const isFlagWord = (word: string): boolean =>
      word.startsWith("-") || (cmdDialect && CMD_FLAG_WORD_RE.test(word));
    const targets = args
      .map((word) => unquote(word))
      .filter((word) => word.length > 0 && !isFlagWord(word));
    // 环境变量形态是**未展开**的字面判据，与 `$HOME` 同构：它不随轨道/平台退出，
    // 因为 `%SystemRoot%\System32`、`%USERPROFILE%\Documents` 在任何读法下都不是一个
    // 合法的相对目标，而展开后删的分别是系统根树与用户树。
    const disaster = (target: string): boolean =>
      ENV_SYSTEM_ROOT_RE.test(target) ||
      ENV_USER_ROOT_RE.test(target) ||
      isDisasterTarget(target, windowsTrack);
    if (
      hasForceRecursive(args, cmdDialect, psParamTrack) &&
      targets.some((target) => disaster(target))
    ) {
      result = "rmrf";
    }
  }
  return result;
}

/** 单段：下载即执行？执行端是 shell 解释器才拦；jq/grep 等接收端放行。 */
function pipeToShell(seg: string): BashDenialKey | undefined {
  const unprefixed = stripRunPrefix(seg);
  let result: BashDenialKey | undefined;
  // 快速门槛：段里有 curl/wget/fetch
  if (/\b(?:curl|wget|fetch)\b/u.test(unprefixed)) {
    const fetchIdx = unprefixed.search(/\b(?:curl|wget|fetch)\b/u);
    // 先取"管道/后台形态"里 shell 执行端的下标（模式一拿它和 fetchIdx 比先后）
    const match = SHELL_EXEC.exec(unprefixed);
    // 两条模式同一条结论（`result = "pipeShell"`），故并成一个条件（sonarjs/no-duplicated-branches）：
    // `||` 保留原短路顺序——模式二那两次 test() 仍只在模式一未命中时才跑。
    if (
      // 模式一：管道/后台喂给 shell（curl … | sh）——shell 在 fetch 之后
      (match !== null && match.index > fetchIdx) ||
      // 模式二：进程替换（sh <(curl …) / source <(curl …) / . <(curl …)）——shell 在前，
      // fetch 结果经 <() 喂给它。命令头允许路径前缀（`/bin/bash <(curl …)` 照拦）。
      (SHELL_HEAD_RE.test(unprefixed) && /<\(\s*(?:curl|wget|fetch)\b/u.test(unprefixed))
    ) {
      result = "pipeShell";
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

/** 跳包管理器自身旗标（-y / --yes / --silent / -w …），返回下一个非旗标词的下标。 */
function packageIndex(words: readonly string[], from: number): number {
  let pos = from;
  for (;;) {
    const word = words[pos];
    if (word === undefined || !word.startsWith("-")) {
      break;
    }
    pos += 1;
  }
  return pos;
}

/** npx/bunx/dlx/exec：跳包管理器自身旗标后取包名，再按包类型判长驻或一次性构建。 */
function npxDanger(
  words: readonly string[],
  start: number,
  serverWords: ReadonlySet<string>,
): BashDenialKey | undefined {
  // 旗标挡在包名前必须跳掉，否则 `npx -y vite` 旗标错位漏拦。
  const pos = packageIndex(words, start + 1);
  const pkg = words[pos];
  let result: BashDenialKey | undefined;
  if (pkg !== undefined) {
    result = isLongRunningPkg(pkg, words.slice(pos + 1), serverWords) ? "devServer" : undefined;
  }
  return result;
}

/** npm/pnpm/yarn/bun 系列：run 脚本 / exec / x / dlx 别名分级判定。 */
function pkgManagerDanger(
  words: readonly string[],
  start: number,
  serverWords: ReadonlySet<string>,
  runArgs: ReadonlySet<string>,
): BashDenialKey | undefined {
  const head = words[start];
  // 包管理器的全局旗标能挡在子命令**前**（`pnpm -w run dev`），也能挡在 run 与脚本名
  // **之间**（`npm run --silent dev`）→ 两处都跳旗标再定位，否则位置错位直接漏判。
  const subPos = packageIndex(words, start + 1);
  const sub = words[subPos];
  // npm/pnpm exec <pkg>、bun x <pkg>、pnpm dlx <pkg> 与 npx <pkg> 同义。
  const isTempPkg = sub === "exec" || sub === "dlx" || (head === "bun" && sub === "x");
  const rawScript = sub === "run" ? words[packageIndex(words, subPos + 1)] : sub;
  // 脚本名可被引号包裹（`npm run "dev"`）→ 去引号后再判，堵住引号绕过。
  const script = unquote(rawScript ?? "");
  let result: BashDenialKey | undefined;
  if (isTempPkg) {
    result = npxDanger(words, subPos, serverWords);
  } else if (runArgs.has(script) || DEV_PREFIX.test(script)) {
    // npm test 等脚本名不含 dev 词根才放行——上面已匹配即拦
    result = "devServer";
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
): BashDenialKey | undefined {
  let result: BashDenialKey | undefined;
  if (serverWords.has(head)) {
    // 直接调用 dev 服务器（按子命令/旗标区分长驻与一次性构建，不再一刀切）
    result = isLongRunningPkg(head, words.slice(1), serverWords) ? "devServer" : undefined;
  } else if (head === "cargo") {
    // watch 是长驻，run 是一次性执行
    result = words[1] === "watch" ? "devServer" : undefined;
  } else if (head === "npx" || head === "bunx") {
    result = npxDanger(words, 0, serverWords);
  } else if (PKG_MANAGERS.has(head)) {
    result = pkgManagerDanger(words, 0, serverWords, runArgs);
  }
  return result;
}

/** 单段：长驻开发服务器？opts 提供可配置词表（v6；由 bashDanger 统一收窄，不留缺省兜底分支）。 */
function devServer(seg: string, opts: BashDangerOptions): BashDenialKey | undefined {
  // 段头归一化：剥 ! / 大括号包裹，再剥运行前缀（time/nice/sudo/watch… 不能成为逃逸口，
  // 与另三类规则同源），最后取命令头。
  const words = wordsOf(stripRunPrefix(peelSeg(seg)));
  const [headWord] = words;
  let result: BashDenialKey | undefined;
  if (headWord !== undefined) {
    // bin 名（去路径）：`/usr/bin/vite`、`./.bin/next dev` 与裸名同判
    const head = binNameOf(headWord);

    // 内置 + 用户配置词表合并。热路径优化：无用户扩展词表时直接复用模块级常量 Set
    // （只读：isLongRunningPkg / runArgs.has 都不改写它），避免每次工具调用都 new Set。
    const extraServer = (opts.extraDevServerWords ?? []).filter((word) => word.length > 0);
    const extraRun = (opts.extraDevRunArgs ?? []).filter((word) => word.length > 0);
    const serverWords =
      extraServer.length > 0 ? new Set([...DEV_SERVER_WORDS, ...extraServer]) : DEV_SERVER_WORDS;
    const runArgs = extraRun.length > 0 ? new Set([...DEV_RUN_ARGS, ...extraRun]) : DEV_RUN_ARGS;

    result = devServerDangerOfHead(head, words, serverWords, runArgs);
  }
  return result;
}

// ── 执行面归一：包装词之后的二次执行与嵌套 shell 的 `-c` 体 ────────────────────
// 四类规则之外的兜底始终是"无"（未知即放行，保守），但**执行面**必须归一：
// 换一层 shell 或 xargs 就绕开全部四类，等于没有闸门。

/** 引号/转义感知的切词。与 wordsOf 的区别是本函数的**用途**决定的：
 *  `bash -c "rm -rf /"` 的命令体在 shell 眼里是**一个**词，按 `/\s+/` 直切会把引号
 *  内容撕成碎片（`"rm`、`-rf`、`/\""`），引号内的分隔符一旦被拆开就再也拼不回命令。
 *  近似：反斜杠在单引号内按 shell 语义应是字面量，这里一律当转义处理——
 *  只影响"嵌套体取哪几个字符"，不影响任何一类的头匹配方向。 */
function tokenizeArgs(src: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const flush = (): void => {
    if (cur.length > 0) {
      tokens.push(cur);
      cur = "";
    }
  };
  for (const ch of src) {
    if (escaped) {
      escaped = false;
      cur += ch;
    } else if (ch === "\\") {
      escaped = true;
    } else if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/u.test(ch)) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return tokens;
}

/** 可嵌套的执行面 shell 名（路径前缀形式 `/bin/bash` 同判）。与 SHELL_HEAD_RE 同族，
 *  但**不含** source/`.`——它们的参数是文件，不是待解析的命令串。 */
const SHELL_BIN_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** shell 的 `-c`，含与短选项的合写（`-lc` / `-ic` / `-xc`）：其后是命令串。 */
const SHELL_C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/u;

/** `-c` 体下钻的最大层数。每层至少吃掉 `bash -c ` 两词，故递归必然终止；但**终止≠有界**：
 *  栈深与每层 O(输入长度) 的成本都得由本上限给出。
 *  取 16 的依据是"真 bash 收得下的最深套娃"：POSIX 单引号套娃每加一层长度约 ×4
 *  （`'` → `'\''`），实测第 10 层 932KB、第 11 层 3.7MB，而本机 ARG_MAX=1MB（execve 参数
 *  上限），即第 10 层之外这种命令根本进不了进程——16 层已全部命中，留了余量。
 *  上限之上剩下的只可能是无引号套娃的词法形态（`bash -c bash -c …`，bash 语义上打不到
 *  内层）：它**不是**良性输入，而是"里面那条命令我一眼都没看到"——故按需确认处理，
 *  不再按放行（见文件头例外条款）。判定本身仍是每层 O(输入长度)、共 16 层，线性。 */
const NESTED_SHELL_MAX_DEPTH = 16;

/** 一次 `-c` 取体的三种结论（判别联合：不把"本就没有体"和"取不出体"塌成同一个
 *  undefined——前者是良性，后者要升格为需确认）。 */
type NestedShellVerdict =
  // 可靠取到命令体：交回 commandDanger 递归判定
  | { kind: "body"; body: string }
  // 段头不是 shell / 没有 `-c` / `-c` 后没有参数：本段没有下钻面（不是"取不出"）
  | { kind: "none" }
  // 有 `-c` 但体取不出可靠文本：整段引号未闭合（体被截断）或体内残留落单引号
  | { kind: "opaque" };

/**
 * 引号是否**未闭合**。扫描状态机与 tokenizeArgs 严格同套近似（`\` 一律当转义、
 * 另一种引号在引号内按字面收下），否则"切词"与"判闭合"会互相打脸。
 * 用途有两处：段级——未闭合意味着 shell 自己都解析不完，取出的体必然是残段；
 * 体级——tokenize 会吞掉配对引号字符，落单引号只可能来自引号内的字面量，
 * 重接出的字符串已与 shell 看到的词边界不等价（`bash -c 'echo " ; vite'` 即此：
 * 体内的 `"` 让 `vite` 从"另一个词"变成"引号内字面量"，切不开也就判不了）。
 * 结尾落单的 `\`（转义态未落地）**不算**未闭合：它只是吃掉一个不存在的字符，
 * 词边界仍然可信（`bash -c rm\` 的体就是 rm），按未闭合处理会白误伤这种写法。
 */
function hasUnclosedQuote(src: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of src) {
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
  }
  return quote !== null;
}

/**
 * 段头是 shell 且带 `-c` 时，取出那条**命令串**（`-c` 之后的全部词，去引号后重接）。
 * `bash -c 'cmd' extra` 里 extra 在 shell 语义中是 $0/$1，一并并入命令体不影响判定
 * （四类规则全部只看段头）。无 shell 头 / 无 `-c` / `-c` 后无参数 → kind "none"（不猜）；
 * 取出的文本不可靠（见 hasUnclosedQuote）→ kind "opaque"，由调用方升格为需确认。
 */
function nestedShellVerdictOf(seg: string): NestedShellVerdict {
  const normalized = stripRunPrefix(peelSeg(seg));
  const tokens = tokenizeArgs(normalized);
  const [head] = tokens;
  let verdict: NestedShellVerdict = { kind: "none" };
  if (head !== undefined && SHELL_BIN_NAMES.has(binNameOf(head))) {
    // 段头（index 0）不参与旗标匹配，与原实现一致：真实形态里 `-c` 必在命令名之后，
    // 而合写形态（`-lc` / `-ic`）同义，都要认。
    const flagIndex = tokens.findIndex((token, index) => index > 0 && SHELL_C_FLAG.test(token));
    if (flagIndex !== -1) {
      const rest = tokens.slice(flagIndex + 1);
      if (rest.length > 0) {
        const body = rest.join(" ");
        verdict =
          hasUnclosedQuote(normalized) || hasUnclosedQuote(body)
            ? { kind: "opaque" }
            : { kind: "body", body };
      }
    }
  }
  return verdict;
}

/**
 * 一条命令的完整判定：跨段 pipeToShell（管道是跨段结构）+ 逐段四类规则
 * + 嵌套 shell `-c` 体的**自递归**下钻（同一套判定，深度有界）。
 *
 * depth 只随嵌套层数增长（每层至少吃掉 `bash -c ` 两词），与输入长度无关，
 * 所以"10 万字自嵌套"这类畸形输入既不会栈爆、也不会白烧 CPU 去无限下钻：
 * 到界后**不再取体**，只把"里面还有没检查过的命令"这件事报成需确认，成本仍是常数层。
 * 合并成单函数而非 seg 级助手互调：两个函数互相引用会形成 use-before-define
 * 的环（严格档 lint 禁），自递归则天然合法。
 */
function commandDanger(
  command: string,
  opts: BashDangerOptions,
  depth: number,
): BashDenialKey | undefined {
  // 管道语义是跨段结构（下载→执行）：先在整命令视野里判 pipeToShell，再逐段判其余三类。
  // 先剥引号内容——`echo "curl x | sh"` 里的字面文本不是真实管道，不该误拦。
  let result = pipeToShell(stripRunPrefix(stripQuotedSpans(command)));
  // 方言取一次，随 opts 递归进嵌套 `-c` 体：换一层 shell **不换**方言的读法
  // （`pwsh` 调用点里的 `bash -c "rm -rf C:/Windows"` 内层按 Windows 轨道判 ⇒ 拦）。
  // 同一串的**反斜杠**写法在这一层判不到，且原因不在方言：tokenizeArgs 把 `\` 当转义
  // 吃掉，交给内层的已是 `rm -rf C:Windows`，那不再是任何 Windows 形状（`rm -rf C:Windows`
  // 直接给出同一结论）。这是与「包装词那一类」并列的**第二类和已知绕行**——转义折叠，
  // 现状各钉一条用例；补它要在取体前做一层"字面反斜杠 vs 转义"的判读，属新的设计决定。
  // 已登记的近似：嵌套层里换解释器是罕见写法，为它做逐层方言推断等于回到"猜字形"。
  const windowsDialect = opts.shellDialect === "windows";
  for (const seg of splitTopLevel(command)) {
    if (result !== undefined) {
      break;
    }
    result = gitBypass(seg) ?? catastrophicRm(seg, windowsDialect) ?? devServer(seg, opts);
    // `bash -c "rm -rf /"` / `zsh -lc "vite"`：段头本身无害，危险全在引号里那条命令上。
    // 旧实现完全不查 → 嵌套 shell 是四类规则共同的结构性旁路面（审查确认）。
    // 命中四类规则的"已确认危险"优先于"取不出体"——后者只在前三类与本体规则都
    // 无结论时才登场（此时它才是唯一诚实的答案）。
    if (result === undefined) {
      const nested = nestedShellVerdictOf(seg);
      if (nested.kind === "opaque") {
        result = "nestedShellUnconfirmed";
      } else if (nested.kind === "body") {
        result =
          depth < NESTED_SHELL_MAX_DEPTH
            ? commandDanger(nested.body, opts, depth + 1)
            : "nestedShellUnconfirmed";
      }
    }
  }
  return result;
}

/**
 * 编辑/写类工具的目标路径归一化（host 侧 fact-gate 与 editDanger 共用）：
 * - edit / write（dsh-tool-fs）→ args.file_path（兼容 args.path）；
 * - str_replace_editor（dsh-tool-str-replace-editor 并存编辑器）→ args.path，
 *   但 command=view 是只读，返回 null（不拦、不过事实门）；
 * - 其它工具 → null。
 */
export function editTargetPath(
  name: string | undefined,
  args: Record<string, unknown> | undefined | null,
): string | null {
  if (name !== "edit" && name !== "write" && name !== "str_replace_editor") {
    return null;
  }
  if (!args || typeof args !== "object") {
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
  // 1) 凭据目录：目录内任何文件都拦（编辑工具不应翻动凭据目录）
  String.raw`[\\/](?:\.ssh|\.gnupg|\.aws|\.kube|\.docker)(?=[\\/])`,
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

/** editDanger 的可选配置（v6 词表可配置化；缺省 = 内置正则）。 */
export interface EditDangerOptions {
  /** 额外密钥路径正则片段（追加到内置 SECRET_PATH_RE 的 OR 分支）。 */
  extraSecretPatterns?: readonly string[];
}

/** 合并内置 + 用户配置的密钥路径正则（每次调用构建，模式少、开销可忽略）。 */
function secretRe(opts: EditDangerOptions = {}): RegExp {
  const extra = (opts.extraSecretPatterns ?? []).filter((pat) => pat.length > 0);
  if (extra.length === 0) {
    return SECRET_PATH_RE;
  }
  // 用户正则逐条编译：非法 patterns 跳过并警告，不炸内置面
  const valid: string[] = [];
  for (const pat of extra) {
    try {
      // 编译探针：非法模式在 new RegExp 抛出即跳过；合法则用其 source 原样收集
      valid.push(new RegExp(pat, "u").source);
    } catch {
      console.warn(`[danger-guard] 跳过非法的 extraSecretPatterns 正则: ${pat}`);
    }
  }
  if (valid.length === 0) {
    return SECRET_PATH_RE;
  }
  const userBranches = valid.map((pat) => `(?:${pat})`).join("|");
  return new RegExp(`${SECRET_PATH_RE.source}|${userBranches}`, "iu");
}

/**
 * 对**已归一化的目标路径**做密钥面判定——`editDanger` 的内部一步：路径只由 `editTargetPath`
 * 归一化一次，判定与上报（宿主按 `secretPath` 键取拒绝理由、按同一个目标路径上报签名）因此
 * 共用同一个键，不必在调用处再写一个永不生效的 null 兜底。
 * 返回的是文案键（`secretPath`），拒绝理由由宿主按当前语言从消息表取。
 */
function secretPathDeny(targetPath: string, opts?: EditDangerOptions): EditDenialKey | undefined {
  let result: EditDenialKey | undefined;
  if (secretRe(opts).test(targetPath)) {
    result = "secretPath";
  }
  return result;
}

/** 编辑类工具（edit/write + str_replace_editor）的路径防线：编辑密钥/凭据文件即拦。 */
export function editDanger(
  name: string | undefined,
  args: Record<string, unknown> | undefined | null,
  opts?: EditDangerOptions,
): EditDenialKey | undefined {
  const targetPath = editTargetPath(name, args);
  let result: EditDenialKey | undefined;
  if (targetPath !== null) {
    result = secretPathDeny(targetPath, opts);
  }
  return result;
}

/**
 * bash 命令危险判定：逐段检查，任一段命中即返回该段命中的规则键。
 * 非字符串/空串放行。这是 host 侧 tools.guard 的 bash 部分谓词
 * （宿主拿键去 `messagesFor(MESSAGES, locale)` 的结果里取拒绝理由回给模型）。
 * @param opts 词表配置（v6：extraDevServerWords / extraDevRunArgs）+ 调用点的 shell 方言
 * （`shellDialect`，由宿主按工具身份给，缺省 = POSIX 读法）。
 */
export function bashDanger(
  command: string | undefined | null,
  opts?: BashDangerOptions,
): BashDenialKey | undefined {
  // 判定主体在 commandDanger（跨段 pipeToShell + 逐段四类 + 嵌套 `-c` 递归），
  // 本函数只做入参收窄：非字符串/空串 → result 保持 undefined（放行）。
  let result: BashDenialKey | undefined;
  if (typeof command === "string" && command.length > 0) {
    result = commandDanger(command, opts ?? {}, 0);
  }
  return result;
}
