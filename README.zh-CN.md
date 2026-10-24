<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-danger-guard@main/icon.svg" width="96" height="96" alt="dsh-danger-guard logo" />
</p>

<h1 align="center">dsh-danger-guard</h1>

<p align="center"><em>危险命令与凭据路径编辑，在下发之前就被物理拒绝。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-danger-guard"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-danger-guard?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-danger-guard"><img src="https://img.shields.io/npm/dm/@jayyuen66/dsh-danger-guard?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/JayYuen666/dsh-danger-guard/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-danger-guard/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

**一个 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的前置守卫：危险 shell 命令与凭据路径编辑在下发之前就被物理拒绝，而模型拿到的是理由加一条真能走通的出路。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [ 目录](#-目录)
- [ 它做什么](#-它做什么)
  - [判定是怎么做出来的](#判定是怎么做出来的)
- [ 安装](#-安装)
  - [shared 的版本下限](#shared-的版本下限)
- [ 确认它真的在工作](#-确认它真的在工作)
- [ 它不提供什么](#-它不提供什么)
- [ 在 dsh 里启用](#-在-dsh-里启用)
- [ 规则拦什么](#-规则拦什么)
- [ 设置项](#-设置项)
- [ 四个权限预设各拦什么](#-四个权限预设各拦什么)
  - [与沙箱的让路，以及为什么只有 `rmrf` 有](#与沙箱的让路以及为什么只有-rmrf-有)
- [ 已知边界](#-已知边界)
- [ 数据与隐私](#-数据与隐私)
- [ 常见问题](#-常见问题)
- [ 开发](#-开发)
- [ 许可](#-许可)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- **它拦截，不是建议。** 判定挂在 `ctx.tools.guard` 的同步谓词上：返回字符串即拒绝该次调用。宿主把理由变成这次调用的错误结果，所以模型读到的是"为什么被拒、改成什么写法"，不是静默失败。
- **三条防线：**
  - `bash` / `pwsh` 危险命令（`lib/danger-rules.ts` 的 `bashVerdictOf`）：git 钩子绕过、灾难性 `rm`、下载即执行、长驻 dev server、git 破坏族、基础设施破坏族。
  - 编辑/写类工具上的凭据与密钥路径（`secretPathDeny`）——按**参数键形**识别，**不看工具名**，因为工具名会随 provider 漂移。
    - 编辑面还有**第二枚**拒绝键 `opaqueTarget`：目标路径长到超出可判定上限时，既没确认为凭据、也没确认不是，所以判拒绝，文案是"别原样重试、把路径贴给用户确认"。与 bash 侧 `nestedShellUnconfirmed` 同一个原则——**判不了不等于安全**。（超长的**命令**走的是 `nestedShellUnconfirmed`。）
  - 首次编辑事实门（`lib/fact-gate.ts`）：没读过目标就改，或碰了高风险面却没有层证据，会被拒，并把缺的证据一并附上。
    - 「读过」只认**成功的**调用：证据台账按 `callId` 串联 `tool/call` 与 `tool/result`，缺 `callId` 的调用状态未知，**不算证据**（真宿主先记调用再派发，一条还没执行或已失败的调用在日志里与成功的长得一样）。
    - 「读到的是哪一版」在 `lib/read-basis.ts`：观测基线与失效点同一条记录，且**只在拿到成功结果之后**才提交——一次失败或被拦的读不会把基线推向前而吞掉中间发生的外部改动；外部改动判出来之后一直有效，直到真的补上一次成功读取（或预检把正文当场递进结果里）。
- **预检自己把那份证据取到手**（两个面挂两条瀑布，分工按"证据在什么时刻才真的算被看见"定）：
  - A 面挂 `tools/post-execute`：只读检视（`read` / `view` / `str_replace_editor view`）的**引用面**随这次读取的结果一起交出去（`PostToolDecision.accept{additionalContexts}`），于是模型下一次编辑之前就看得见"谁引用它"。
  - B 面挂 `tools/pre-execute`：模型**没读就改**时，当场取到的目标正文与引用面写进这一次的拒绝理由（`PreToolDecision.deny{reason}`）；原样重试即凭投递水位放行。物理停止仍在 dispatch 之前，"改之前先看清它"这条一个字没让。
  - 为什么不是 `agent.inject()`：那个 API 把上下文排在**下一个 pre-step**，而决定是按 step 做的——证据会在编辑生效**之后**才读到。
  - 扫描有硬上限（文件数、目录数、单文件字节、命中条数；超限文件**跳过**），取消信号与墙钟合流。平台不会放弃一枚挂起的 pre-execute promise，所以无界工作不是一个选项。
  - **凭证判据**："遍历未被截断" **或** "找到了引用"。门禁认可模型自己那次作用域正确的检索当凭证，而那次检索**也不是穷尽的**——要求这趟扫描穷尽比门禁自己还严。但"**零命中 + 被截断**"仍然**不给**凭证：假阴性全住在那一种里，半份"我探过了"比不给更糟。
  - **层的零命中结论要求那棵子树真的读完**：扫描会记下因超限、凭据面规则或读取失败而**没读正文**的文件；只要目标层里还有这类文件（或遍历本身被截断），那层就不出"0 处命中"的结论——否则会在层内部被截断时宣称"这层没有引用"，而真正引用它的文件恰好排在预算之外。找到了命中则不受这条限制（实证不需要穷尽）。
- **每个拒绝都自带出路。** `BashVerdict` 带一枚结构化的 `Fix`：git 绕过点名越界的那几枚旗标，灾难 `rm` 点名真正成灾的目标（**排除安全目标**）。模型拿到的是"改哪几个词就能过"，不是一句判断。
- **`ask` 命中时跑一趟只读爆炸半径预演**（命令表写死、**不插值任何模型输入**），输出按每门语言分别接进审批请求的 `reason` 与 `displayReason`。空输出只说明探针没有可打印的内容，**不能证明原操作不会改动任何东西**；原命令带 `-C`/`--git-dir`/`--work-tree`、策略解析失败、会话 cwd 缺席或宿主截断输出时直接退回盲问。
- **重复命中不再重复上报**（`AskDeduper`）：同一会话 + 同一规则键 + 同一命令原文，第二次不再进教训总线、也不重算预演——但**判定与弹卡照旧**。这一层压掉的是"教训卡炸成碎片"，不是"用户被少问一次"；去重绝不能变成偷偷放行。

### 判定是怎么做出来的

- 只判 `bash` 与 `pwsh` 的命令串；`command` 非字符串则放行（不猜）。按 `;`、`&&`、`||`、`|`、换行、`&`、`(`、`)`、反引号分段，引号内不切段。
- 断段、切词、结构视图、引号是否闭合**四个出口共用一台 POSIX 状态机**（`lib/command-segments.ts`）。两台机器会让同一串在不同判据下结论相反。
- 包装词（`sudo`、`env`、`time`、`nice`、`stdbuf`、`timeout`、`taskset`、`watch`、`setsid`、`doas`、`pkexec`、`nohup`、`exec`、`command`、`xargs`、`parallel` 与前导 `VAR=x`）、bin 路径前缀（按 basename 比对，所以 `/usr/bin/sudo` 也不是逃逸口）、引号、反斜杠续行**都不是**逃逸口。引号包裹的旗标或命令头**是生效写法**：`git commit "--no-verify"` 确实跳过钩子，`"rm" -rf ~` 与不加引号同判。
- 因为按工具维护的 option 表按定义补不完，包装词领头的段还会把其后**每个词位**都当候选命令头各判一遍。
- **原则：认不准就放行**——唯一例外是**看不见的执行面**。取不出可靠文本的嵌套 `-c` / `eval` 体、超过下钻上限、段头是取代码串再执行的非 shell 解释器（`python3 -c`、`node -e`、`perl -e`、`php -r`…）、以及超出可判定长度的命令，一律判 `nestedShellUnconfirmed`：出路是交用户显式确认，或改写成单层、引号闭合的形态。
- **严重度择优**：同一串里既有 `ask` 段又有 `deny` 段时，**整串按 `deny` 收口**（逐段扫到拿到 `deny` 为止）。少了它，前面那段 `ask` 会让扫描提前收工、后面那段的灾难从未被判定。

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-danger-guard
```

卸载：`dsh plugin --profile web remove @jayyuen66/dsh-danger-guard`。包在公共 npm 上，安装不需要凭据，也不需要配作用域源。

- **要求 Node.js `>= 22.12`。** 本包是纯 ESM；正是这个下限让 ESM 入口的 `require()` 形式可用，所以声明了 `engines.node`。
- **要求宿主 `dsh` 在 `0.2.1-rc.3` 这条线上。** 宿主真正读的是 `engines.dsh`（`^0.2.1-rc.3`），而且它**单独决定**：`evaluatePluginCompatibility` 在 `engines.dsh` 那一支就返回了，根本走不到读 `peerDependencies` 的那段——所以 `@deepseek-ai/dsh*` 那几枚 peer 在这里不参与兼容判定。预发布版本参与范围比较。宿主是 `0.2.x` 任一小版本都满足；`0.3.0` 及以后不满足，要走显式担责的授权 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`。`peerDependencies` 里的精确钉版是一条**独立的编译期纪律**（由 `test/publish-manifest.test.ts` 钉住）：本插件的类型与名义品牌与宿主 ABI 耦合，"自动跟上去"正是宿主类型面被装出第二份的那条路。
- **`dependencies` 里不放任何 `@deepseek-ai/*`，这是契约**（`test/publish-manifest.test.ts` 钉着）。消费方的 profile 用 `nodeLinker: hoisted` 且 `autoInstallPeers: false` 安装，于是写在 `dependencies` 里的宿主包会被落成**真实目录**，与运行中的宿主已加载的那份并存。`@deepseek-ai/dsh-tools` 的工具运行期调度键是普通 `Symbol`（不是 `Symbol.for`），符号身份按模块实例算：宿主从 profile 副本上读那个键拿到 `undefined`，于是**每一次原生工具调用都抛**——而构建、类型检查、覆盖率门禁在此之前全部照绿。peer 与 devDependencies 都不会进 profile，所以都物化不出第二份。
- **按值导入的宿主包必须保持外部化。** `@deepseek-ai/dsh-brand` 与 `@deepseek-ai/schemastery` 是值导入（`brandNumber`、`import Schema from …`）。外部化名单读 `dependencies` ∪ `peerDependencies`；只写 `devDependencies` 会被打包器把官方函数体内联进产物，本包就各持一份官方构造器。必需 peer 同时满足两件事：说明符仍是外部的，而消费方 profile 不多装任何东西。`zod` 是普通依赖（由 `lib/tool-ledger.ts` 值导入）。
- **产物刻意不压缩。** `test/build-host.test.ts` 钉着 `host.js` 里那几枚裸说明符、以及 `settings.js` 里没有它们；压缩会把字符串一并去掉，那两条断言就会永远变绿。
- **随包发 TypeScript 声明**（`types/host.d.ts`、`types/settings-host.d.ts`，以及它们引用的 `lib/` 声明），各子路径带 `types` 条件，`node16` / `bundler` 下 `tsc` 能解析。`./client` 刻意没有（它是浏览器 UMD 外壳），`./cordis.patch.yml` 也没有（宿主 loader 当文件读）。
- 构建产物不入库，`prepack` 会重建，所以发出去的永远是当前源码产出的那一版。

### shared 的版本下限

如果你的 profile 用 pnpm `overrides` 把 `@jayyuen66/dsh-plugin-shared` 钉在某个版本，那个值必须不低于本包声明的那一版。钉得更低会装到一份缺少运行期所导入名字的产物，宿主起来时报 `N entries did not activate` 与 `does not provide an export named ...`——包装得上、永远不生效，而各仓单仓 CI 看不见这一类。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它真的在工作

1. **已装载**：设置页出现「danger-guard 危险拦截」这一行，且 `dsh --profile web --dump-config` 出现本包的层。
   - `--dump-config` 是唯一被接受的"进了层栈"信号，而它**不是只读命令**——它会重写该 profile 的根装配文件。所以判读要分别捕获 stdout 与 stderr；未匹配的 patch 目标只出现在 stderr，只看退出码什么都证明不了。
   - 层行可能是 `# == <层>`，也可能是 `# == <层>, patched by <路径>`；判据必须容得下后者，否则它会对着真实存在的层报"没装"。
2. **有拦截**：在一个会拦它的预设下（仅可查看或工作区内修改——完全权限档按设计放行这一条），让 agent 跑 `git commit --no-verify`。这次调用本身必须失败并给出 `Error: <理由>` 与一条出路。若"行为毫无变化"，读法是**闸门没装**，不是规则太松。
3. **设置**：打开卡片改一个值，`保存` 由 disabled 转 enabled，写入回 200。非本机 loopback 页面上控件禁用并显示只读状态。
4. **读数**：打开卡片（以及手动「刷新」）会走一次 `dangerGuardStats` 命名空间的 Remote 调用。按需拉取、不订阅——判定统计只在 agent 干活时变，而跨宿主重连缓存一份旧值正是这套设计要避开的失效。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

找之前先知道这几件事：

- **它不注册任何工具。** 没有 `guard_status` 这类模型侧工具——整个面就是 `ctx.tools.guard` 谓词加两条预检瀑布。
- **它没有自己的 HTTP 端点。** 它只注册一个 Remote 命名空间 `dangerGuardStats`，用途只有一个：经宿主 `/api` 网关给设置卡的读数块供数（无参、JSON 结果的方法）。除此之外没有别的路由，没有可从外部调用的 `/api/dangerGuard…` 面；本包内也没有 CSRF 与信任闸门——那整层归宿主网关。
- **它不加 CLI 子命令。** `dsh danger-guard …` 不存在。
- **它不落盘、不联网**（唯一的一次只读子进程见「数据与隐私」）。
- 它**可选**消费的东西：`lessonLoop` 总线（report/pass）、`sessionProjections`（工具台账）、`fs`（预检取证）、`workingDirectory`（当前目录基准）。这几样都是可选子注入——没有它们的 profile 照样拦，只是走回退路径。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- 组合包形态：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，由 `dsh plugin add/remove` 维护装配层。
- 补丁是**两行（bulkhead / 隔舱）**：`- id: danger-guard`（拦截半，**没有 `Config`**，name 指向包本体）与 `- id: danger-guard-settings`（设置半，严格 schema，name 指向 `./settings` 子路径）。
  - 卡片只由第一行带出：宿主只对**裸包名**条目扫 `dsh.client`，所以设置行写成子路径是有意的，不是漏改。
  - 卡片只在 web 平台装载，位置是设置页插件列表里的「danger-guard 危险拦截」。
- 部署默认值写在**设置那一行**的 `config:` 上；优先级是 设置卡运行时值 > 行 config > 内置底座（`lib/settings-schema.ts` 的 `BUILTIN_BASE`）。
  - 行里的显式 `undefined` 不覆盖底座；非法数值（如 `maxDenies: 0`）回落内置默认——`0` 等于把事实门整道关掉。
  - 写在拦截那一行的默认值是无效的：那个条目根本不收 `config` 参数。
- 装载失败的方向是保守的。严格 schema 只挂设置行，所以一行被改坏的用户配置只让**那个条目**失败；拦截条目回落内置底座并告警一次。`apply` 只在设置面本身缺件时抛错。缺 `tools` 服务不抛错（注册走可选链），但 `tools` 在 `inject` 里，于是 cordis 根本不激活该条目，启动诊断会点名它——"闸门没装，且宿主说了"。

## <img src="https://api.iconify.design/lucide/ban.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 规则拦什么

| 族 | 拦 | 放行与出路 |
|---|---|---|
| git 钩子绕过 | `commit` / `push` / `merge` / `cherry-pick` / `rebase` / `am` 上的 `--no-verify` 及其无歧义缩写；`commit` / `am` 的短形式 `-n`；`git -c core.hooksPath=` 与 `git config core.hooksPath <dir>`（含 `--global` 与 `=` 合写）。git 参数**按角色**走查：短簇逐字母展开、带值选项的取值不当旗标看、`--` 之后一律 pathspec、`-c` 的取值才是被查的那一段 | `git push -n`（dry-run）、`git cherry-pick -n`（不提交）、`git rebase -n`（--no-stat）、`git config --get` / `--unset` / `--list core.hooksPath`，以及提交信息里出现的该字样 |
| 灾难性 `rm` | 门槛**按命令词轨分别**。POSIX/cmd 轨要"递归 + 强制"，唯一例外是短旗标簇里的大写 `-R`，单独即灾难级。`Remove-Item` / `ri` 轨（以及 Windows 方言下的 `rm` / `del` / `rd` 别名）则**任何 Recurse 形态单独**命中灾难目标即灾难级、**不要求** `-Force`——那一形不给 `-Force` 也静默删整树。计入的目标：`/`、`~` 与 `~/…`、家目录字面路径、`$HOME` 与 `${HOME…}` 各形态、`.` / `..` / `../…`、系统与用户目录前缀下的整树、以及绝对 glob 与花括号展开；路径先做词法归一。命令词面另含 `pwsh` / `cmd` 的删除形态，大小写不敏感 | 项目内相对清理（`rm -rf node_modules`、`./dist`）、POSIX 轨上只有 `-f`（`rm -f ~`）或只有小写 `-r`（`rm -r ~`）——**这一档按写法而非语义**，不对称是刻意的；`Remove-Item -Recurse ./build`；`/var` 与 `/tmp`（有意不列：误拦代价高于漏拦）；`/usrx` 这类不同段 |
| 下载即执行 | `curl` / `wget` / `fetch` 之后接 shell 或脚本解释器，包括经 `sudo`、带路径前缀的解释器、`xargs`、`parallel`，以及反序的过程替换（`sh <(curl …)`、`python <(curl …)`、`source <(curl …)`、`. <(curl …)`）。执行端覆盖 `sh` / `bash` / `zsh` / `dash` / `ksh`、`pwsh` / `powershell` / `iex` / `Invoke-Expression`，以及 Python / Node / Perl / Ruby / PHP / Lua / osascript——它们都会把 stdin 当代码执行。**双引号内的 `$( )` 同样算执行面**，所以 `echo "$(curl x \| sh)"` 照拦。PowerShell 家族两端都认：`Invoke-WebRequest` / `Invoke-RestMethod` / `iwr` / `irm` 接 `pwsh` / `powershell` / `iex` / `Invoke-Expression`，与 `curl … \| sh` 同判 | `curl -O`、`curl … \| jq .name`、`cat x \| grep foo`、无下载来源的 `ls \| sh`、`source ./setup.sh`，以及引号内的字面 `\|` |
| 长驻 dev server | 裸 `vite` / `next` / `nuxt`、`webpack serve` / `--watch`、`cargo watch`、`npm` / `pnpm` / `yarn` / `bun run dev` / `watch` / `serve` / `start`、一切 `dev` 词根脚本名，以及经 `npx` / `bunx` / `exec` / `dlx` 起的长驻包（版本选择器不算新身份）。`vite build --watch` 仍拦。一次性豁免**只看子命令位** | `npm test`、`npm run build`、`vite build`、`next build`、`webpack --config prod.js`、`cargo run` / `check` / `test`、`vitest run`，以及确认一次性子命令（`vite optimize`、`next lint`、`nuxt prepare`） |
| 密钥路径编辑 | `.ssh` / `.gnupg` / `.aws` / `.kube` / `.docker` 目录内任何文件，**含相对形态**；`id_rsa` / `id_ed25519` / `id_ecdsa` 主名及其拷贝后缀；`.pem` / `.key` / `.p12` / `.pfx` / `.keystore` / `.jks` 结尾；`.env` 全族；`.envrc` / `.npmrc` / `.pypirc` / `.netrc` / `.pgpass` / `.git-credentials`；`credentials.json`、`service-account*.json`、`token.json`；`secret(s).yaml` / `yml` / `json`；`.git/config`。目标先做词法归一，宿主给了会话 cwd 时相对目标按 cwd 解析；反斜杠 Windows 路径同判 | `.env.example` / `.sample` / `.template` / `.defaults`、`api.key.ts`、`main.pem.tsx`、`.gitignore`、`mysecrets.yaml`、`secrets.yaml.bak`、`myid_rsa` |
| git 破坏族（全部 `ask`） | `reset --hard`（含 `--har` 这类无歧义缩写）、`checkout -- <path>` / `checkout .` / `checkout -f` / `checkout <rev> <path>`、`restore <path>`（`--staged` 单用**不判**——只动索引）、`clean -f*`（含 `-xf` / `-x -f`）、`stash drop` / `clear`、`branch -D` / `--delete --force`、`push -f` / `--force` / `--force-with-lease` / `+refspec`。短旗标取值**按子命令**解析（`push -u` 与 `clean -x` 是布尔，`commit -m` 与 `clean -e` 才取值）。与 no-verify 那条**共用一趟走查** | 每一条都有正当用法。硬拒"危险但有时正确"的操作会**逼模型找绕路写法**——`git reset --hard` 被拒后它可能直接 `rm` 掉那些文件，一个更糟且不被拦的写法。所以这一族是问，不是拒 |
| 基础设施破坏族（全部 `ask`） | `terraform destroy`、`terraform apply -auto-approve`、`docker … prune`、`kubectl delete`，以及迁移族（`manage.py migrate`、`prisma migrate`、`rails db:migrate`、`alembic upgrade`、`flyway migrate`、`typeorm migration:run`、`knex migrate:latest`…） | `plan -destroy`（plan 只打印）、裸 `apply`（terraform 自己会问）、`kubectl --dry-run=client` / `server`（只有这两个取值；`none` 会实际执行）、只读动作（`prisma migrate status`、`flyway info`）与按工具分表的干跑旗标（`manage.py --plan` / `--sql`、`alembic --sql`）。迁移族另接受 `uv run` / `poetry run` / `pnpm exec` / `python -m` 等启动器前缀，同时在文档里搜这串仍不会假命中 |

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

命名空间 `danger-guard-settings` 即设置条目 id；默认值是 `BUILTIN_BASE`。

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；`false` 时三类判定全部静默，连教训上报也不发 |
| `factGateEnabled` | boolean | `true` | 只关首次编辑事实门；危险命令与密钥面照拦 |
| `preflightEnabled` | boolean | `true` | 编辑前预检。关掉只是退回"拒绝后由模型自己补证"，判据一条不减 |
| `judgeStats` | boolean | `true` | 采样判定耗时与输入规模：本地滚动摘要，加上装了 lesson-loop 时每次判定一条 `judge-cost` pass（只带面名/毫秒/字符数）。卡片上的统计读数不受它管，它也不管拒绝上报里那几格 `judgeMs` |
| `maxDenies` | natural，1–5 | `2` | 同一目标连续"未收敛"拒绝的次数上限，超过即配额放行并告警 |
| `strictMode` | boolean | `false` | `true` 时忽略写面分档，每个代码文件首次编辑都走全探查 |
| `smallEditChars` | natural，≥1 | `200` | 写面 ≤ 此值且不含签名关键字 → 判小改，只要求 read |
| `bigEditChars` | natural，≥2 | `2000` | 写面 > 此值 → 判大段重写，升最高档全探查 |
| `extraTestDirs` | string[] | `[]` | 追加 test 层目录名，只追加 |
| `extraDevServerWords` | string[] | `[]` | 追加长驻命令头，只追加 |
| `extraDevRunArgs` | string[] | `[]` | 追加 run 脚本名，只追加 |
| `extraSecretPatterns` | string[] | `[]` | 追加密钥路径正则片段（卡片每行一条；非法片段跳过并告警），只追加、无白名单 |
| `refSearchTools` | string[] | `["grep","glob","zg_search"]` | 哪些检索工具算"引用探查"凭证；清空即任何检索都不计入。给模型的指令只点这台宿主上真注册着的名字 |
| `refSearchStrictTools` | string[] | `["zg_search"]` | 上表里改走"root + 相对路径"严格口径的子集 |

**本包没有任何白名单。** 三份 `extra*` 名单与 `refSearchTools` 都只能收紧。所以误拦只有三条路：临时关 `enabled`（或只关 `factGateEnabled`）、靠 `maxDenies` 配额放行、或按拒绝文案改写命令形态。

## <img src="https://api.iconify.design/lucide/layers.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 四个权限预设各拦什么

宿主的预设把沙箱模式与审批策略捆在一起，而官方沙箱只管**文件效应**：网络与进程面不在它的词汇表里，最紧的那一档也只是拒写、读一律放行。本插件补的正是那两面——而"写"类判据在沙箱管得住时让给它。

| 规则族 | 仅可查看 | 工作区内修改 | 完全权限 | 自动审查 |
|---|---|---|---|---|
| `noVerify`（git 钩子绕过） | deny | deny | allow | allow |
| `rmrf`（包住可写根 / 家目录 / 根） | allow¹ | deny | allow | **deny** |
| `rmrf`（沙箱完全覆盖这次目标） | allow | allow | allow | allow |
| `pipeShell`（下载即执行） | allow | **deny** | allow | **deny** |
| `devServer`（长驻服务） | allow² | allow² | allow² | allow² |
| `nestedShellUnconfirmed`（认不准） | ask | allow | allow | allow |
| git 破坏族 | ask | ask | allow | allow |
| 基础设施破坏族 | ask | ask | allow | allow |

¹ 只读档拒一切写，所以不存在"部分删除成功"——每个目标都被完全覆盖，整族让给宿主；宿主会给出官方拒绝标记与 `sandbox_permissions` 升级路径。
² 宿主自带的协作式超时与 `promoteOnTimeout` 已经管住长驻命令，这条规则不再提供安全属性，故整条让给宿主。

- **完全权限 = 零兵底，但仅限"问不了"的那一支。** 官方预设把这一档绑死 `approval: never`，用户选它就是"不要拦、不要问"：整档放行、命中只进设置卡的统计，模型侧一个字都不改。而 `danger-full-access + ask`（自定义组合，或没装预设服务时的默认）**还能问**，那一支沿用工作区档的处置——沙箱什么都不拦却把动作静默放行，方向正好相反。
- **自动审查只留两条确定性硬拦**（`rmrf` 与 `pipeShell`）。reviewer 是一个 LLM，它的 allow 不等于用户批准，而这一档沙箱什么都不拦；其余全部交给 reviewer，避免同一动作问两次。
- **一条硬规则：「能不能问」决定 `ask` 能不能落地。** `never` 在**任何应答者之前**就确定性返回 `rejected`（理由还会被宿主换成它自己的固定串），所以本该 `ask` 的规则在这一档由我们自己收口成 `deny`，并附一段"这档问不了、换哪一档才能问"，不让模型只拿到一句"不许"。
- **读不到沙箱模式时**（没有可约束的执行器，或服务形状不符）走一条保守列：写类判据照拦，"认不准"照问。它**刻意不复用**工作区档那一列——那一列依赖"沙箱会拦住一部分"这个前提，而这里没有这个前提。
- 类型让两条性质**结构性**成立：忘定档 = 编译错误；一枚键两属不可能。后者是要紧的：`tools.guard` 是同步谓词而审批是异步的，且宿主在审批放行之后**还会再跑一次 guard**——"两处都认领"的表现就是**用户点了允许之后还是被拒**。

### 与沙箱的让路，以及为什么只有 `rmrf` 有

- 让路只在三件事同时成立时发生：执行器自报在拦、解析出的模式不是完全权限、且目标**包不住任何可写根**。
- 最后一条是刻意收紧的。`workspace-write` 的语义是*允许*改工作区内的文件，于是 `rm -rf ~`（工作区在 `~` 下）会**先删光工作区内容**、再在边界外被拒——沙箱是路径白名单，**不提供原子性**。所以 `~`、`/`、`.`、`..` 一律不让路，只有 `rm -rf /etc/foo`、`rm -rf ~/Downloads` 这类才让。
- `secretPath` 完全不开让路：本地与沙箱两套文件系统后端是**互斥装配**，"装的是哪个"没有可读的口子，按本仓纪律**不猜**。代价也不对称——误拦只是让用户去终端改，漏拦是凭据外泄且难以发现。

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

按类登记，每类各钉一条现状用例；完整逐条理由写在那批测试旁边，不在这里。

- **`cmd` 当段头判不到。** `cmd.exe /c rd /s /q C:\Windows` 及其去 `.exe`、带路径前缀的写法仍逃逸：`cmd` 既不在删除命令词表、也不在下钻名单里，而它的引号规则（`%VAR%`、`^` 续行、`&` 不分段）离 POSIX 太远，拿 POSIX 词法器读它的 `/c` 体会新开一批误拦面。**PowerShell 家族已收**：`pwsh` / `powershell` 的 `-c` / `-Command` 体按 join 语义取出、逐段判，并在体内强制开 Windows 字形轨道。点了 `-File` / `-EncodedCommand` 而没有取体旗标 ⇒ 要跑的东西注定不在输入里，升格为需确认。
- **干跑修饰不进判据**（`Remove-Item -WhatIf -Recurse ~` 照拦）。`-WhatIf` / `-Confirm` 只是让 pwsh 打印将做什么；把干跑算成一类可豁免形态是一个还没人拍板的策略决定，所以现状按现状钉住。
- **裸 `~user`（词尾无分隔符）不收。** `rm -rf ~root` 展开成什么取决于本机账号表，而本闸既不碰文件系统也不查用户。**带分隔符的 `~user/…` 已收**。
- **PATH 上的解释器跑代码串一律需确认。** `python3 -c "print(1)"` 是良性的，也仍要确认——这是"看不见就不静默放行"的定价。
- **`bash` 重定向写入不在事实门覆盖面。** 门禁挂在 `edit` / `write` 两类工具上；`printf > f`、`tee`、`cat >`、`sed -i` 绕过"先取证"这条。纳入它要解析 shell 重定向与就地编辑器。
- **少数 `ask` 档形态是盲问。** 裸 `git checkout <path>` 与"切分支"在词法上不可分（显式的 `checkout <rev> <path>` 会判），`git push --force` 不解析目标分支。经 shell 重定向落笔的改动、以及目标在会话外被改动的残窗，同理。
- **MSYS/Cygwin 挂载形态不折算。** 真实 Windows 宿主上 `rm -rf /c/Windows/System32` 要一张挂载表，那是新依赖加新设计决定。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 口径 | 内容 |
|---|---|
| 不写盘、不联网 | 判定链没有任何文件系统写入与网络请求；输出面只有 `console.*` 告警与回给模型的文案。**唯一**的例外是下面那趟 `ask` 档预演 |
| 子进程调用（只有这一处） | `ask` 档命中时，按写死的 `BLAST_COMMANDS` 跑一条**只读命令**，在会话 cwd 里、经宿主的 `ctx.shell`，因此与 bash 工具走同一套沙箱与凭据擦洗环境。`git status` 用 `--no-optional-locks` 抑制可选锁与索引刷新，但仍按会话解析出的 `sandboxPolicy` 执行。输出收紧后按每门语言接进审批请求的 `reason` 与 `displayReason`。任何失败（执行器缺席、仓库目标不确定、策略解析失败、非零退出、超时、取消、宿主截断输出、形状不符）一律退回盲问，不重试、不换命令。命令表写死、**不插值任何模型输入**；原命令只用于目标/策略的跳过判据 |
| 读什么 | 会话事件历史里的工具台账（主路径：守卫里同步读的投影单元；回退是一次全量事件扫描，判定逐字相同）；目标与层目录的 `statSync`；预检写面对每枚声明目标的一次路径解析与一次正文读取；家目录取 `os.homedir()` |
| 记什么 | 全部在进程内存里——事实门分片、判定台账、以及卡片读的那几格计数——宿主退出即消失，dsh 数据目录下不留本包的文件 |
| 出域的只有两处且都可关 | 装了 lesson-loop 时，`report` 载荷含 cwd、session id、命中命令原文或目标路径与拒绝文案，另带 `judgeMs` 与（密钥面命中时的）目标解析形清单。此外每次判定还有一条 `judge-cost` pass，载荷只有面名、毫秒、字符数三枚数值，不含命令原文与路径。**只有 `judge-cost` 那条 pass 受 `judgeStats` 管**——拒绝上报里的 `judgeMs` / `judgeLength` / `resolvedPaths` 是无条件发送的 |

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 问题 | 怎么办 |
|---|---|
| 拦错了合法命令。 | 本包没有白名单，所以只有「设置项」那三条路：临时关、走配额放行、或按拒绝文案改写命令形态。 |
| 事实门一直不放行。 | 它只认成功的动作。照消息把检索起点指向项目根这类祖先目录；用了别的检索插件就把工具名加进 `refSearchTools`；实在取不到证就走配额放行或临时关 `factGateEnabled`。 |
| 它什么都没做。 | 先看设置页那一行，再用 `dsh --profile web --dump-config` 看本包的层**与 stderr**。宿主需在支持的版本线上。缺 `tools` 服务意味着条目从未激活——启动诊断会点名它。 |
| 怎么知道这个拒绝是本包给的？ | 拒绝文案点明规则族与一条出路，并作为那次工具调用的错误结果出现。规则从不改写或丢弃调用；它要么拒绝，要么交出一份审批请求。 |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check     # typecheck → lint → client 构建 → host 构建 → 类型 → 测试 → 格式
pnpm test          # vitest，带覆盖率
```

- `test/` 分三层，分开的理由是**桩测不到的那一类错**：把宿主的形状猜错，判定却照样自洽。
  - **单元**层用手写 `ctx` 桩：判据本身——词表、档位、缺项、状态机、文案。
  - **集成**层用官方 testkit 的**真 `ToolRuntime`**，夹具真读真写，直接经 `ctx.tools.execute` 派发：瀑布顺序与物化——pre-execute 先于 guard、deny 变成 `isError` 结果、`additionalContexts` 与别的插件并存。
  - **点对点**层用**真 agent loop 与真会话存储**，只有模型是脚本：A 面的引用面出现在**决定那次编辑的那一条请求**里，以及密钥正文在任何一次请求里都不出现。
  - 后两层的分工是测出来的事实，不是偏好：直接执行一次工具不写会话日志，所以"模型自己读过/搜过"这类凭证只能在点对点层成立。
- 覆盖率四项阈值都是 **100%**，所以新增分支必须有能走到它的用例。
- 断言用的判别标记必须跳过**共用前缀**——行动清单、当场递证据、随读取附上三条文案开头相同，所以"取首词当标记"会让两条互斥的断言同时为真。取法统一收在一处。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可

MIT。源码在 [github.com/JayYuen666/dsh-danger-guard](https://github.com/JayYuen666/dsh-danger-guard)。

事实门与命令规则是**机制层面**移植自 ECC（MIT，© Affaan Mustafa）——[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 记录了上游文件、本包做了哪些改动，以及逐项比对的结果（未搬运上游的代码、词表或文案）。

