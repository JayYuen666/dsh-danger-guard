# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.2-rc

宿主生态与工具链升到当前发布线，并把判据的目录基准换到宿主 0.2.1-alpha.2 的那枚服务上。**判定规则、拦截面与默认配置未改**，改的是"跟谁对齐"。

### Changed

- `@deepseek-ai/dsh-*` 家族与 peer 的 `@deepseek-ai/dsh` 从 `0.2.1-alpha.1` 升到 `0.2.1-alpha.2`（devDependencies、peerDependencies、`pnpm-workspace.yaml` 的 `overrides`、`engines.dsh` 四处同值——`test/publish-manifest.test.ts` 要求它们与 peer 逐项相等）。`@deepseek-ai/cordis` `4.0.5-alpha.1` 与 `@deepseek-ai/schemastery` `3.18.5-alpha.1` **不动**：那是 alpha.2 自己钉的那两枚（`~4.0.5-alpha.1` / `~3.18.5-alpha.1`），registry 上没有更新的 alpha。
- `@jayyuen66/dsh-plugin-shared` `^0.1.2` → `^0.1.4`。这一枚是本轮升级里唯一改变**发布物形状**的：0.1.2 把 `@deepseek-ai/dsh-tools` / `dsh-session` 等宿主包列在自己的 `dependencies` 里，消费方 profile（`nodeLinker: hoisted` + `autoInstallPeers: false`）于是会物化出第二份宿主类型面——正是 `test/publish-manifest.test.ts` 那条"不进 dependencies"门禁的理由，只是它此前管不到依赖树的下一层。0.1.3 把它们挪进 `peerDependencies`，`dsh-danger-guard@0.1.1` 在真实宿主上装出的 `cosmokit`/`dsh-brand`/`schemastery` 三枚真实目录到此不再出现；0.1.4 再把那几枚 peer 从 `0.2.1-alpha.1` 钉到 `0.2.1-alpha.2`，与本包同版本，依赖树里最后一处 `alpha.1` 需求随之清零（profile 内 `pnpm peers check` 实测：剩下的只有"宿主运行期才提供、本包刻意不安装"的 missing peer 提示，版本一律对得上）。
  ⇒ 因此 0.1.1 那份"传递引入约 30 枚包，本包改不动"的记录已经过期：改得动，且改的方式就是升级这枚依赖。
- 工具链（`pnpm-workspace.yaml` 的 `catalog`）跟到发布线：`@types/node` 26.6.3→26.6.5、`@vitest/coverage-v8` 与 `vitest` 5.0.2→5.0.3、`happy-dom` 20.14.5→20.14.6、`jsdom` 30.1.1→30.1.2、`oxfmt` 0.71.0→0.72.0、`oxlint` 1.86.0→1.87.0、`oxlint-tsgolint` 7.0.2003→7.0.2004、`rolldown` 1.2.11→1.2.13、`vite` 8.3.1→8.3.4。`typescript` 7.0.2、`react`/`@types/react*` 19.3.0、`zod` 4.6.5 已是发布线，未动。

### Fixed

- **相对目标的目录基准跟着宿主走**。`SessionHeader.cwd` 从 alpha.2 起只是创建期快照（官方定性：dsh-session `src/index.ts:533` "detached, deep-frozen creation metadata"），活目录搬到 `ctx.workingDirectory`，宿主 bash 也改读它（tool-bash `src/index.ts:487`）。本包原先五处直接读 `header.cwd`（事实门取证、读时基线、密钥面 realpath、deny/pass 上报），升级后与宿主各用一枚：会话 `cd` 之后 `<当前目录>/.ssh/config` 这类密钥路径会按 `<创建期目录>/.ssh/config` 判——该拦的拦不住。现在五处统一到 `effectiveCwdOf()`：服务在场且交出非空串即用，否则退回 `header.cwd`（没装 `dsh-working-directory` 的 profile 行为不变，闸门不下线）；`GuardRuntime.cwd` 每趟调用算一次，读时基线与评估侧因此共享同一枚值。
- 两份 README 里"宿主版本只是记录、尚无门禁"的说法与实测不符：`evaluatePluginCompatibility` 从 0.1.7-rc 就在装插件时比对**每一枚** `@deepseek-ai/dsh*` peer，不符即 `dsh: installation rejected`，出路是 `dsh plugin allow-version … --accept-risk`。已按实测改写，并补上"精确钉 = 高于本下限的宿主同样需要授权"这条推论。

### Added

- `test/host-contract.test.ts` 六条工作目录契约用例：密钥面吃当前目录（并用"服务缺席即放行"作反向对照）、服务缺席退回 `header.cwd`、四类坏形状（空串 / 非字符串 / 没有 `get` / `get` 不是函数）一律退回且不抛错、会话不可得时不读服务、事实门在当前目录下与绝对路径取证同键、上报载荷的 `cwd` 跟到当前目录。覆盖率仍为四项 100%。
- 真机回归口径写进两份 README：对 `dsh 0.2.1-alpha.2` 实测 `dsh plugin --profile web add <tarball>` → 3 枚包、profile 下无 `@deepseek-ai/` 目录、`--dump-config` 出现 `danger-guard` 与 `danger-guard-settings` 两条、web profile 启动无 fiber 报错；另以一枚故意把 peer 写成 `@deepseek-ai/dsh: 0.1.0` 的探针包验证门禁真的拒绝安装并回滚。

### Not changed, deliberately

- **不给 `working_directory` / `worktree_create` 新增拦截规则**。前者只改目录、不写文件，而判据现在跟着目录走；后者属 experimental bundle，不在 `dsh-base`。它们的参数键 `cd` 也不在 `TARGET_PATH_KEYS` 里，密钥面不会把它误当写目标判。
- **`inject` 不加 `workingDirectory`**。与 `sessionProjections` 同一条理由：可选读面一旦写进插件级 `inject`，没装那个 bundle 的 profile 会整条闸门下线。
- **`ctx.sessionProjections.register()` 的返回物仍不接**。alpha.2 起它交回一枚 Cordis disposer，可以 yield 进 `ctx.effect()`；本包的注册落在注入子 fiber 上、随其回收，行为未变，不在本轮顺手改形。
- **台账不做逐条目录定标**。相对取证仍按评估时那枚目录重新归一（新增边界 ⑪），要收掉它得把 `working-directory/change` 折进 `lib/tool-ledger.ts`、给每条记录盖上当时所在目录——那是台账形状的改变，不属于一次依赖升级。

## 0.1.1

发布形态整改：入口面补齐类型声明、归属声明随包发出、发布流水线加固。**判定逻辑、拦截面与默认配置均未改动**——所有变更都在「装出去之后」那一侧。

### Added

- **TypeScript 声明随包发布。** 新增 `tsconfig.types.json` 与 `build-types.mjs`，产出 `types/host.d.ts`、`types/settings-host.d.ts` 及 `lib/` 下 8 份声明；`package.json` 增加 `types` 字段，包根与 `./settings` 两条导出各带 `types` 条件。此前 `exports` 把这两个入口暴露成运行时可import，却没有任何类型，消费方在 `strict` 下会拿到 TS7016。`build:types` 已接进 `check` 与 `prepack`，漏跑时声明会停在旧源码上。
- `build-types.mjs` 在出声明前清空 `types/`：`tsc` 自己不清 `outDir`，删掉源文件后旧 `.d.ts` 会留在原地，而 `files` 里的 `types` 是整目录，于是陈旧声明照样发出去。
- `THIRD_PARTY_NOTICES.md` 随包发出（已列入 `files`——npm 不自动附带 NOTICE 类文件，实测只无条件附带 `package.json`、`README*` 与 `LICENSE`）。`LICENSE` 尾部增加一段指引。内容是**机制来源与致谢**，不是法定声明：本包移植 ECC 的事实门与四类命令拦截的**机制**，未搬运其代码、词表或文案，文件内附逐项比对依据。
- `test/dist-size.test.ts`：产物体积预算门禁，拦截半 / 设置半 / 客户端半 / 声明入口各一条，预算取实测值上浮约 25%。
- 发布流水线加固：`concurrency` 防两个 runner 并行发同一版本；三个 action 由 tag 改为钉 commit SHA；`--provenance`（此前 `id-token: write` 是空转的）；`--publish-wait-timeout` 让「发出去了但装不上」在 workflow 里就红；预检补读本包自身（此前只查依赖库，于是「版本号没进 main 就触发 workflow」这个最常见的失败模式预检发现不了）；`NPM_TOKEN` 在预检与发布两步用同一份清洗口径（此前 workflow 自己打印「已剔除后使用」，发布那步却传的是裸 secret）。
- 发布面门禁新增五条：归属声明必须在 `files`、声明入口存在且 `types/` 真的产出、声明不比它派生的源码旧、声明不含本机绝对路径或 `.pnpm` 内部路径、声明里的相对说明符都指向产物后缀。

### Fixed

- `.d.ts` 被门禁误判成源码。`test/publish-manifest.test.ts` 的入口断言原为 `/\.tsx?$/u`，`types/host.d.ts` 同样以 `.ts` 结尾，于是补上 `types` 入口后**这道门自己先红了**。改为 `/(?<!\.d)\.tsx?$/u`，`host.ts` / `lib/x.ts` 指进来照样红。
- 发布产物里带着构建机用户名。`lib/danger-rules.ts` 里一句解释波浪号展开的举例，用的是作者本机账号名与家目录绝对路径，会被打包器原样搬进随包发布的 `host.js`，于是本机用户名出现在公共 tarball 里。已改用本仓既有的 `<user>` 占位约定；门禁的 `FORBIDDEN_IN_COMMENTS` 同时补上本机绝对路径一条，这类泄漏不再靠人眼发现。
- `ALWAYS_SHIPPED` 把 `CHANGELOG.md` 与 `README.zh.md` 当成发布器无条件附带的文件。实测 npm 只无条件附带 `package.json`、`README*` 与 `LICENSE`；把没被附带的文件列进清单，会让「入口都在 files 覆盖内」这道断言的集合**虚高**，门禁比真实语义更宽松、于是自己先失效。
- 安装时可见的脚本警告。`prepare` 与 `prepack` 内容相同，在 registry 安装时 `prepare` 没有任何用处（产物已随包发布），却让 npm 11+ 的每个消费方都看到一条 install-scripts 警告。已删除 `prepare`，保留 `prepack`。
- README 两份里「发布产物只有 `host.js` / `settings.js` / `client.js` / `cordis.patch.yml`」的说法在加入 `types/` 与归属声明后已不成立，两份同步更正。
- 源码与文档注释里若干时点绑定的表述（「上一轮」「早期版本」「0.1.0 已经发出去了」「现在是异步落库」等）：读的人无法从中重建上下文，且会随时间变成错的。

### Not changed, deliberately

- **产物不压缩。** 实测 minify 之后 `from "@jayyuen66/dsh-plugin-shared/lib/record"` 与 `from "@deepseek-ai/schemastery"` 两个说明符字符串双双消失，于是 `test/build-host.test.ts` 那两条「跨包依赖必须 external、官方函数体不得内联」的断言会从「依赖被内联了也不报」变成**恒绿**——它们防的正是 `isRecord` / `brandNumber` 这类单点被就地复制多份。省下的体积不值得废掉两道真门禁，体积改由 `test/dist-size.test.ts` 盯着。这条理由也写进了该文件的头注释与两份 README，免得日后有人「顺手优化」。
- **判定节的篇幅不动。** 那 44KB 里 96% 是规则本身（按赛道分档的阈值、旗标拼写形态、例外情形），只有 4% 是机制考据；规则删一条，使用者就少知道一种自己会不会被拦的形态。真正的篇幅浪费在别处：两份 README 各有约一半字符是 markdown 表格的对齐填充空格，已去除且内容逐字符未变。
- `./client` 与 `./cordis.patch.yml` 仍在 `exports` 里但不提供声明。前者是浏览器 UMD 外壳（Node 侧 import 会撞 `window is not defined`），后者由宿主 loader 当文件读。
- 运行时依赖仍是四枚。经 `@jayyuen66/dsh-plugin-shared` 传递引入的约 30 个包来自上游的依赖分类，本包改不动。