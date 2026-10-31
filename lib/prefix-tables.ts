// lib/prefix-tables.ts —— 运行前缀（提权/包装命令）的**纯数据表**。
//
// 为什么单列：这几张表是 `runPrefixEnd` 与 `headStarts` 的判定输入，行数却占了
// lib/danger-rules.ts 的相当大的比例，而该文件的 `eslint/max-lines` 预算是 2000 行
// （shared 的 oxlint 基线，skipBlankLines + skipComments）。把纯数据搬出来是
// **只改位置、不改判定**的最小切分：表里每一枚词/正则的语义仍由 danger-rules 的
// 调用点与 test/danger-rules.test.ts 的用例共同钉住。
//
// 纪律：这里只放数据。任何需要读词、判形、做分支的逻辑都留在 danger-rules ——
// 否则「表」与「用法」之间会多出一层没人钉的中间态。
/** 运行前缀词：提权/包装命令，不改变命令实部（复用 devServer 前缀思路）。
 *  漏一个词就是一个逃逸口（`time npm run dev`、`doas rm -rf /` 曾因此放行）。
 *  `xargs`/`parallel` 也在这张表上：`xargs -I{} git commit --no-verify` 里 git 是**被 xargs
 *  执行的那条命令**，四类规则对它同样成立（此前它们只出现在下载即执行的正则里，与文件头
 *  "包装词同判"的宣称不一致）。 */
export const RUN_PREFIX_WORDS = new Set([
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
  // 下面这组是「段头是包装词、实部在其后」的其它形态。漏一个就是一条现成的逃逸口：
  // 它们都接受「后面跟一条命令」的位置，而 `headStarts` 的多点位扫描只有在段头被认出
  // 是包装词时才会启动——认不出时整条兜底**不参与**，`su -c "rm -rf ~"` 就直接放行。
  "su",
  "runuser",
  "ssh",
  "busybox",
  "chroot",
  "unshare",
  "nsenter",
  "ionice",
  "flock",
  "strace",
  "ltrace",
  "gdb",
  "script",
  "systemd-run",
  "firejail",
  "bwrap",
  "proot",
  "torsocks",
  "proxychains",
  "proxychains4",
]);

/** 吃旗标的包装词 → 其**带独立取值**的旗标（跳名不跳值会让取值挡在命令实部前 →
 *  头匹配失败，`nice -n 10 npm run dev` 即此）。分表而非共用一份：`sudo -n`（非交互，
 *  无值）与 `nice -n 10`（有值）字形相同语义相反，共用会把 `sudo -n rm -rf /` 的 rm
 *  当成取值吃掉，反手造出新的逃逸口。
 *  sudo 那一行按本机 /usr/bin/sudo 实测补全：`sudo -p xrm rm -rf /` 与 `sudo -C 3 rm -rf /`
 *  都真的把下一词当取值并继续执行 `rm`（实测走到密码提示 ⇒ 命令词已就位），此前这两形放行。
 *  表**不声称完备**（`-h` 这类"报错退出"的旗标列进来反而会把命令词吃掉）：漏一枚的兜底是
 *  `wrapperHeadStarts` 的多点位扫描，不是这张表。 */
export const PREFIX_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  env: ["-u", "--unset", "--unset-var"],
  // `su -c "<命令>"` 的体是一枚取值：不认它，`su -c "rm -rf ~"` 里的 rm 就落到头外。
  su: [
    "-c",
    "--command",
    "-s",
    "--shell",
    "-g",
    "--group",
    "-G",
    "--supp-group",
    "-w",
    "--whitelist-environment",
  ],
  runuser: [
    "-c",
    "--command",
    "-s",
    "--shell",
    "-g",
    "--group",
    "-G",
    "--supp-group",
    "-u",
    "--user",
  ],
  // `ssh -p 22 host "<命令>"`：旗标带值，host 是位置取值，其后才是命令体。
  ssh: [
    "-p",
    "-i",
    "-o",
    "-l",
    "-F",
    "-J",
    "-L",
    "-R",
    "-D",
    "-W",
    "-b",
    "-c",
    "-e",
    "-m",
    "-O",
    "-Q",
    "-S",
    "-w",
  ],
  ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"],
  flock: ["-w", "--timeout", "-E", "--conflict-exit-code", "-c", "--command"],
  chroot: ["--userspec", "--groups"],
  // `-F/--no-fork` 与 `-r/--root`（可选值）都不吃下一词：吃掉命令词就是一条现成的逃逸口。
  nsenter: ["-t", "--target", "-S", "--setuid", "-G", "--setgid", "-w", "--wd"],
  "systemd-run": [
    "-u",
    "--unit",
    "-p",
    "--property",
    "-E",
    "--setenv",
    "--uid",
    "--gid",
    "--working-directory",
  ],
  script: [
    "-c",
    "--command",
    "-O",
    "--output-limit",
    "-I",
    "--log-in",
    "-B",
    "--log-io",
    "-T",
    "--log-timing",
  ],
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
  // `-t/--no-title` 是布尔；把 `-t` 当取值会吞掉后面的命令词。
  watch: ["-n", "--interval", "-q", "--equexit", "-s", "--signal"],
  xargs: ["-a", "-d", "-e", "-I", "-i", "-J", "-L", "-l", "-n", "-P", "-s", "-S"],
  parallel: ["-a", "-j", "-n", "-s", "--jobs", "--arg-file", "--max-args", "--sshlogin"],
};

/** 旗标之外还吃一个**位置**取值的包装词（`nice 10 …` / `timeout 5 …` / `taskset 0-3 …`）。
 *  chrt 不在此表：它的策略旗标是布尔且可连用、命令前必有一枚优先级词，走 stripRunPrefix
 *  里的专用分支。 */
export const PREFIX_POSITIONAL_VALUE = new Set([
  "nice",
  "timeout",
  "taskset",
  // `su <user> -c "…"` / `ssh <host> "…"` / `runuser <user> -c "…"`：旗标之后（或之前）
  // 的那一枚是目标名，不是命令词。不吃它，`ssh box "rm -rf ~"` 里的 box 会被当成命令头。
  "su",
  "runuser",
  "ssh",
  // `chroot <newroot> <命令>`：新根是位置取值。
  "chroot",
  // `flock <file> <命令>`：锁文件是位置取值。
  "flock",
]);

/** 时长词：`5` / `10s` / `5m` / `1h` / `2d`，以及 GNU timeout 承认的**小数与 MM:SS**
 *  形态（`timeout --signal TERM 1.5 npm run dev` 实测漏拦——只认整数就把 `1.5` 留成了命令头）。
 *  这一形只在"已经吃过旗标取值"时用于认位置取值，纯整数走 isPositionalValue 的另一支。 */
export const DURATION_WORD_RE = /^(?:\d+(?:\.\d+)?[smhd]?|\d+:[0-5]?\d(?:\.\d+)?)$/u;

/** 前导环境赋值（VAR=x），同样不改变命令实部。 */
export const ENV_ASSIGN_RE = /^[A-Za-z_]\w*=/u;
