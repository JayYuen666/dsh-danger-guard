# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.2

### Added

- **预检（Phase 2）：门禁要的证据现在**编辑之前**就到模型手里，取代"先拒绝、再由模型自己去查"**。两个面各挂一条官方瀑布，分工按「证据在什么时刻才真的算被看见」定，而不是按方便定：
  - **A 面（只读检视 `read` / `view` / `str_replace_editor view`）挂 `tools/post-execute`**：引用面随**这次读取的结果**一起出去（官方 `PostToolDecision.accept{additionalContexts}`），agent-loop 在 commit 那条结果时收下、排到下一个 step 边界（`packages/core/agent-loop/src/tool-calls.ts:57,157`「accepts committed result context for the next step boundary」）。于是模型下一次动手编辑前就看得见"谁引用它"——这才是前置。按 mid 档问缺项（要 refs 的**最低**必要档：此刻还没有写参数，按 high 问会顺带要层证据、按 low 问根本没有 refs 这项要求）。
  - **B 面（写类调用）挂 `tools/pre-execute`**：模型**没读就改**时，当场取到的正文与引用面写进这一次的拒绝理由（官方 `PreToolDecision.deny{reason}`，宿主 materialize 成本次调用的错误结果），并记下投递水位；原样重试即放行。物理停止仍在 dispatch 之前，所以"改之前先看清它"这条不变式一个字没让。
  - **为什么把上一轮的 `exec.agent.inject()` 撤掉**（官方契约逐字核对过，`packages/core/agent/src/runtime-types.ts:233-241`）：`inject()` 把消息排在 **next pre-step**、不唤醒 driver，而模型的上下文按 step 推进——它在第 N 步决定这次编辑，只能看见第 N-1 步为止的内容。所以那条通道"取证时点"在前、"可见时点"却在编辑**生效之后**，那叫事后补证；官方还明说排队可能被取消/丢弃（"Cancellation or disposal may discard pending context"、"It may miss a request whose pre-step already claimed its batch"），水位却会把它记成"补过了"。两个面因此都改走**必然落地**的通道：结果本体、或拒绝理由。
  - **不抢别人的决定**：两条瀑布都先 `await next()`，下游已经 deny/cancel/ask/block 就原样交回。B 面另外让路三道：会被密钥面拦下的目标（见 Fixed 的「预检不再把密钥正文送进模型上下文」）、已配额放行的目标（新增 `FactGate.releasedFor()` 只读查询，不改状态机任何一格——防死锁承诺不能被插件自己新加的拒绝换掉）、什么都没挣到的那一趟（正文读不出、扫描没跑成或被预算截断、或层缺项里有一层没被这次扫描覆盖）。
  - **有界是硬要求，不是优化**：平台**不会放弃**一枚挂起的 pre-execute promise（installed dsh-tools `lib/types/index.d.ts:39-42` "never abandons their promise"），一次卡死的扫描会把整次工具调用永久挂住。引用扫描四道预算（文件 256 / 目录 256 / 单文件 64KB 超限跳过 / 命中 40，另有单行 200 字符），跳过依赖·产物与点开头目录，顺序 `await` 而不是 `Promise.all`（并发读会一次打开成百上千个 fd，macOS 默认 ulimit 256；那一次 `await` 同时也是取消/墙钟的中断检查点）；取消信号与 3 秒墙钟合流（`AbortSignal.any([exec.signal, AbortSignal.timeout(3000)])`，工程上界而不是产品策略，故不落设置面）。扫描没跑成（取消/墙钟）整趟作罢——半份"已探过引用面"比不注入更糟。
  - 设置项 `preflightEnabled`（boolean，默认 `true`，`.volatile()`）：关掉即退回"先拒绝、再由模型自己补证"的老路径，**判据一条不减**，变的只是这次取证谁去跑。`enabled` / `factGateEnabled` 关闭、目标为文档扩展名（与门禁共用同一枚 `SKIP_EXT_RE`，导出给预检用）、工具不在上述名单、`exec.agent`/会话形状不符时整趟跳过。仍**不给卡片控件**（沿用上一轮那条豁免与理由，见 `test/build-client.test.ts`）。
  - **刻意的口径变化两处**（记在此处，免得日后被当成漏判）：① B 面的 deny 走的是 pre-execute，同步 guard 因此**不会**跑到——事实门那次的 `reportDeny`（lesson-loop）与拒绝计数不再发生，换来的是模型没有被"拒一次再去查"；取证通过时的 `reportPass` 照旧在重试那一趟上报。② 判定缺项走的是与 guard **同一条** `evidenceFor`，它会顺带刷新 read 的 mtime 基线；A 面判在读取**之后**，于是基线比 guard 那次更准，但"读取与本次附加之间的外部改动"会被并成一次观测（与 `recordReadObservation` 那条残余窗口同源，方向保守，代价最多一次重读）。
  - **层证据也在这一版并进来了**：high 档（新建、触及导出签名、高风险路径、大段重写、`strictMode`）原本还要求 test/e2e/docs 各一次可归因检索，而那一度正是"预检整趟让路"的理由；本版把层结论并进同一次引用扫描、并记进投递水位（`DeliveryWatermark.layerSeqs`），来龙去脉见 Fixed 的「high 档不再因为层证据给不出而多拒一轮」。
  - 值导入面：A 面用官方的 `createUserMessage`（`@deepseek-ai/dsh-llm`）造那条上下文，`source` 走官方 `MessageSourceMap` 的**合并式扩展**声明本包自己的 kind（`dangerguard-preflight`），`form: "notice"` 由官方 `ContextFormed` 判别并要求带一行 ≤120 字的 `summary`（`packages/llm/llm/src/message.ts:95-99,122-133`）——这一整套的形状与官方 `repeat-tool-reminder` 逐字同形（其 `src/index.ts:14-18,210-225`）。它必须**外部化**：落 `peerDependencies`（`dependencies` 仍是禁区，`test/publish-manifest.test.ts` 钉着），`build-host.test.ts` 那条"说明符在、官方函数体不在"的断言继续兜内联。
  - 三个入口共用**同一条认定链**：`evaluateFactGate`（同步判定）、A 面、B 面都经 `factEvidenceOf`（读法面 `EvidenceReadings` + 查询面 `FactEvidenceQuery`），于是"门禁会看到哪些缺项"与"预检补了哪些缺项"不可能不一致——两处各算一遍迟早会漂。会话键的完整形状也单源成一枚 `sessionTargetKeyOf`（五处读法共用；此前只共用前缀，剩下的拼接各写一遍，少一个分隔符不会编译报错、只会让水位静默读不到）。
  - I/O 与渲染本体提到 **`lib/preflight-scan.ts`**：那一侧只做"取证据 + 渲染成模型读得懂的文本"，不碰会话键、不碰状态机；扫描起点（`projectRootOf`）与匹配词（`buildStems` / `MIN_STEM`）刻意**留在 host 侧算好送进去**——这两处一旦跟着搬走，"预检扫的"与"门禁认的"就成了两套。顺带让 host.ts 回到 `eslint/max-lines` 的代码行预算内。
- `test/host-preflight.test.ts` 四十四条用例钉住接线与边界，全部经 `tools/pre-execute` / `tools/post-execute` 监听器与 `ctx.tools.guard` 三个**真实入口**断言。替身载荷一律按官方 `Events` 的两条投影 checked（`Parameters<Events["tools/pre-execute"]>` 等），不再手抄形状——`kind` 拼错、结果少一枚必填位、decision 换臂都会变成编译错误而不是"绿着的假用例"；`callId`/`rootCallId`/`token` 这三枚幻影品牌集中在 `execOf` 里补一次（同 `test/fixtures/events.ts` 补信封的理由），下游那条已有上下文用 `createUserMessage` 造（自己拼 `{role:"user"…}` 等于绕开官方 id 铸造）。覆盖面：三种只读检视各附一块引用块且不重复给、同会话不二次附加、写类不经 A 面、读取失败不附、block/value/content/已有上下文四种合并、截断扫描不附也不记凭证、零命中全称那句只在扫完时出现、B 面四种让路（密钥面 / 层缺项 / 配额放行 / 什么都没挣到）、正文截断、目录与不存在目标不拦、坏 agent 三形、认定链抛错兜底、目录预算与文件预算各自的文案、缓存复用与作废重扫、水位随会话销毁回收、旧水位不顶外部改动。夹具是真实临时目录：`projectRootOf` 认盘上的工程标记、二进制靠 NUL 字节、非普通文件靠 `isFile()`，替身路径会让"扫到了什么"整段退化成空断言。
- **密钥面判定的真实路径改读官方通道，三形并列取并集**（第 4 项）。此前目标的真实路径只有一处来源：host 侧的 `realpathSync`（`realpathOf`）。本地后端下它没问题，而宿主的 fs 是**可插拔执行世界**的（fs-sandbox / ssh / e2b）——在那种部署下"本机 realpath"说的是另一份盘：看不见软链面还是小事，真正的漏是**执行世界里那枚凭据文件在本机恰是无害路径**时密钥闸判不到它（反方向也成立，只是那一侧的代价是多拦）。
  硬约束先说清：官方那条真实路径通道是 async 的（`ctx.fs.resolve` → `processPath`；`processPath` 同步，但只吃已 resolve 的 target），而 `tools.guard` 是**同步**谓词——"拦截那一刻"没法 await。所以做法是三形并列、判定取并集：
  - **声明形**：模型字面量（宿主不替我们解析，官方明确排除输入改写）；
  - **本机形**：`realpathOf`（同步，guard 当场唯一付得起的解析）；
  - **官方形**（新增 `lib/target-paths.ts`）：`fs/observed` 顺手记下后端自己报的那一枚（零额外 I/O），预检 B 面在密钥面让路判定**之前** async 问一次 `resolve` + `processPath` 写进同一枚 LRU 缓存——官方保证 pre-execute 整趟跑完才轮到 guard，所以**同一次调用**的拦截判定就吃得到。
  三形**从不互相替换**（`resolvedFormsOf` 交的是清单，`lib/danger-rules.ts` 的 `resolvedPaths` 随之从单值改成 `readonly string[]`），于是官方那一形缺席或陈旧只会少一形、不会多放；缓存陈旧的方向同样是多拦而不是漏拦。`fs/observed` 是 emit 模式（官方明说监听器抛错会让**别人的**那次工具调用失败），故取路径那一步整个包在 try 里；只记**绝对**的 `displayPath`（相对形与远端 URI 没有 cwd 就归一不了，猜一种归一等于造一枚永远读不到的键）；`targetKey` 一个字节都不解析（官方明令 opaque）。
  身份问询复用（review 那一轮按"现在就穿递"补齐）：Layer 2 的 `resolve` 结果交回调用方并透传给正文读取与版本探针（`lib/preflight-scan.ts` 的 `targetOrResolveOf`），于是**同一枚目标在一次盲改里只问一次身份**——远端后端下改造前后的身份往返数相同（目标一枚 + 扫描起点一枚），不是从两次抬成四次。官方形那枚缓存另给上限 1000：它的写入频率由**外部事件**决定（`fs/observed` 对会话碰到的每枚文件都发一次），共用 200 会把它冲成一件摆设，而一条只是两枚短路径串，放大五倍仍是定长。
  用例：`test/danger-rules.test.ts` 两条（并集里任一形命中即拦、空清单与缺席同解），`test/host-preflight.test.ts` 七条（官方形落在凭据面 ⇒ B 面整趟让路且密钥闸照旧拦、`fs/observed` 报绝对形后同步 guard 的结论当场翻转、报相对形不记、后端拒绝 `processPath` 或 `resolve` 抛 ⇒ 那一形缺席而拦截面一条不减、没有 fs 后端 ⇒ 报了也记不下、无声明目标的调用一枚 resolve 都不发），`test/host-contract.test.ts` 两条改断上报清单。容量口径与 LRU 写入单源进 `lib/lru.ts`（见 Changed 的结构那条）。
- **预检的取证 I/O 从 `node:fs` 迁到宿主 `ctx.fs`**（第 2 项）。旧写法假定"本地盘就是工具用的那份盘"，而宿主的 fs 是可插拔执行世界的（fs-sandbox / ssh / e2b 后端）——在那种部署下预检会去读**主机上**同名的文件，把它当成"目标的当前正文"或"谁引用了它"抄进模型上下文：既给错证据，又是一条外泄路径。现在 `lib/preflight-scan.ts` 只吃官方的 `FileSystem` 投影（`PreflightFs = Pick<FileSystem, …>`，type-only，产物里没有对 `@deepseek-ai/dsh-fs` 的运行时引用），各位各司其职：
  - `resolve` 定身份（**跟**软链）、`listDir` 列一层、`readByteRange` 只读窗口——正文的上界因此由后端的窗口语义保证，而不是"读完整份再切"；
  - `lstat` 不跟最后一段，**软链一律不进队列**（官方注释明说这一位就是给"在跟之前先拒掉"的用方；真后端的 `listDir` 给的 type 是跟过链的，靠它挡不住指向 `/` 的链）；
  - 缓存失效位从宿主侧 mtime 换成后端给的 opaque `FsVersion`——远程后端下 mtime 要么探不到、要么探到的是另一份同名文件的时间。
  三条失败口径全部落成用例（新增 `test/preflight-fs-face.test.ts` 十条，用 `test/fixtures/local-fs-face.ts` 那份按官方六位实现的本地夹具注入失败）：**整趟作废**只留给取消（回 `undefined` ⇒ 不注入也不记凭证）；**降级不作废**给"目录列不出 / 子项探不到 / 文件读不动"（`complete: false` ⇒ 文案换成"已扫范围内"、refs 凭证不给，但已取到的正文照给）；**本来就不算数**给软链、点开头目录、依赖/产物目录、超大文件与二进制（跳过而不降级，因为按口径本来就不读）。迁移中由编译器与真后端各自抓到两处：缓存判据写成 `cached?.version === version` 时"两边都 undefined"会去读一枚不存在的条目（TS 直接报错），以及 `ctx.fs` **不能按属性读**——cordis 对未声明 inject 的服务名是抛错而不是回 undefined（真 spine 实测 "cannot get property \"fs\" without inject"），所以它走可选注入装箱，与投影台账同一手法；`inject: ["fs"]` 是刻意**不**用的：那会让没装 fs 后端的 profile 整个闸门不再激活。"没装 fs 后端 ⇒ 预检整趟不参与、拦截面不受影响"另有一条用例（`test/host-preflight.test.ts`）。

- **测试补到三层：同一份源码，三种"谁来跑这次调用"**。此前只有单元层——`ctx.tools` 是一只手搓桩（`test/bulkhead-isolation.test.ts` 里那句 `ctx.provide("tools", { guard })`），于是"官方到底怎么把调用交给我们、我们的决定又被官方怎么处理"从来没被跑过；补上的两层都用官方发布件（`@deepseek-ai/dsh-agent-loop-testkit` 等，全部钉 `0.2.1-alpha.2` 同线，只进 `devDependencies`）：
  - **集成层** `test/host-integration.test.ts`（25 条）：真 `ToolRuntime` + `defineContentToolFixture` 造的真读真写工具，直接 `ctx.tools.execute` 派发。钉住瀑布顺序（pre-execute 整趟跑完才轮到单调 guard，于是被别的插件截住的那几趟**不推进**事实门轮次）、deny 的物化（`Error: <理由>` + `isError`）、`additionalContexts` 与别的插件并存且不改写正文、下游 `block` 不被翻成 `accept`。
  - **点对点层** `test/agent-loop-e2e.test.ts`（9 条）：真 `AgentLoop` + 真 SessionStore，模型换成按官方 `LlmAdapter` 面实现的脚本（`test/host-spine.ts` 的 `ScriptedModel`）。断言取在"第 i 次请求里模型能看见什么"（`model.requests[i]`）与"磁盘上文件真的变了"两处。这一层测的是上一轮 A/B 改造的**全部论点**——证据在模型下一次动手之前可见：读取附上的引用面确实出现在**决定那次编辑的那一条请求**里，而不是编辑之后。
  - 顺带测出来的四条宿主事实都写进了用例注释（其中两条改变了用例该放在哪一层）：**直接 `ctx.tools.execute` 不写会话日志**（只有 loop 会 `appendToolCall`），所以"模型自己读过/搜过"只能在点对点层成立，集成层里能顶的只有预检投递水位——这条边界被显式写成一条断言（`agent.session.snapshotEvents().length === 0`），免得日后有人拿集成层的红去改判据；**同一步里的多枚调用按调度序执行**，先读后改 ⇒ 编辑凭那次读取放行，反过来先改后读 ⇒ 拦（两条都钉，因为只钉一边就等于没测到"闸门被自己的并发绕过去"那种形状）；官方 `Agent` 的类型面只有 `id`（`dsh-agent/lib/types/runtime-types.d.ts:143` 的 `session` 在实现侧），本包按运行时判的形状没变；真 `SettingsForms` 注入 `configEditor` + `profileContext`（属 Loader 启动层，实测缺它们时 `ctx.plugin(SettingsForms)` 直接抛），所以 spine 里唯一保留的桩就是 `settings`，而它按 `Pick<SettingsForms, "configure" | "describe">` 钉住成员签名、描述符按官方 `SettingsDescriptor` 必填位给齐。
  - 装上官方件之后 tsc 立刻抓到一处早已失效的宽松：`test/host-preflight.test.ts` 里 `agent` 那位过去靠"`@deepseek-ai/dsh-agent` 不在依赖 ⇒ `ToolExecution.agent` 塌成 `any`"塞替身，注释还写着这条理由。现在 `fakeAgent` 给得出合法 `SessionId`（官方 `Agent` 面就一位），坏形状那一档改由单点 `as never` 交代并写明为什么（本包要测的正是"宿主送来不像 Agent 的东西"）。

### Changed

- **上报键：`resolvedPath` 换成 `resolvedPaths`**。密钥面命中时的那一格由单值改成**清单**——判定吃的就是并集，只报一枚等于把"哪一形命中的"这件事藏起来，而非本地部署下恰恰只有官方那一形说得准。**这一格只改本包就够**：核过同级 lesson-loop 仓，它把 `evidence` 当不透明袋存（`row.evidence = evidence`）、从不按字段名读——本包已有的 `judgeMs` / `judgeLength` 在那一仓里同样 0 命中，HTTP/UI 投影甚至直接 `Omit<RuleCard, "evidence">`。
- **安装：显式拒绝 koffi 的构建脚本**（`pnpm-workspace.yaml` 的 `allowBuilds`）。`@deepseek-ai/dsh-fs-local`（真 spine 那两层测试要真 FsLocal 才装的 devDependency）直接依赖 `koffi@3.1.1`，而它只被 dsh-fs-local 的 win32 那一支**懒加载**（`GetFileSecurityW` / `ReplaceFileW`；官方模块注释原话 "non-Windows processes never open Win32 libraries"），发布流水线又只有 `ubuntu-latest` 一枚 runner。pnpm 12 对"没做过决定"的依赖直接报 `ERR_PNPM_IGNORED_BUILDS` 并让 `pnpm install` 失败——发布流程就卡在这一步。这里给的是**显式拒绝**而不是默默忽略，也不是顺手放行一枚用不上的第三方原生构建；将来若在 Windows 上跑真 FsLocal 的后端面，改成 `true` 即可，别无其它改动。
- **结构：三处单源，代价是产物变大**。host.ts 顶到 `eslint/max-lines` 的 2000 行预算，于是把两件事搬出去各自的模块——台账容量与 LRU 写入进 `lib/lru.ts`（`lruPut` 现多收一枚可选 `cap`：默认仍是 200，官方真实路径那枚缓存单独 1000，理由见 `lib/target-paths.ts`），目标路径的归一形与官方形进 `lib/target-paths.ts`（写口在 async 侧、读口在同步谓词里，键形必须逐字同源，收在一处才不至于漂）。取证 I/O 与渲染本体早在上一节就在 `lib/preflight-scan.ts`，本版只是把这两枚新邻居并进去。**值导入面一字未增**：产物里仍只有 `dsh-brand` / `dsh-llm` / `schemastery` / `zod` 四枚外部说明符加 shared 的三枚深路径，`@deepseek-ai/dsh-fs` 保持 type-only（`test/build-host.test.ts` 与 `test/publish-manifest.test.ts` 各自钉着）。产物预算随之从 250,000 抬到 264,000（实测 253,498 B，理由写在 `test/dist-size.test.ts` 的注释里）。

### Fixed

- **引用扫描不再把凭据文件的正文抄进证据**。预检的引用扫描会读根目录下**每一枚**普通文件，并把命中那一行**原文**抄给模型（`· {file}:{line}: {text}`）——而密钥闸只管"编辑这类路径"，管不到"扫描顺手把 `.env` 的一行抄进引用命中"。目标文件名撞进凭据文件是常态而非边角（改 `token.ts`，`.env` 里正写着 `token = "…"`），于是本包存在的理由之一——凭据正文不外泄——被自己的取证通道开了个洞。这条洞是**集成层跑出来的**：单元层的手搓 fs 夹具里没有凭据文件参与扫描。
  现在扫描侧走的是**同一把词表**：新增 `lib/danger-rules.ts` 的 `isSecretPath`（`editDanger` 的内部一步，同一份内置分支 + 同一份 `extraSecretPatterns`），host 用它造 `scanQuarantineOf(cfg)` 传给扫描；命中的路径**整个不读**（不是脱敏——脱敏等于在证据里留一份"这里有内容"的形状）。份数随结果交回，于是零命中那一支不再宣称"没有任何引用者"，改说"已读范围内零命中，另有 N 个凭据面文件按本包规则未读"（中英各两条新文案）。refs 凭证**照给**：遍历确实扫完了，被隔离的原因不是"没扫到"而是"不许读"，把它算成 incomplete 会逼模型去做一件它也做不到的检索。
  用例：`test/host-integration.test.ts` 两条（真磁盘 + 真 FsLocal：内置 `.env` 那一支、用户 `extraSecretPatterns` 那一支，各自带**对照组**——摘掉判据后同一枚扫描确实会抄出那行，免得修复被"文件本来就没命中"冒充）、`test/host-preflight.test.ts` 一条（值面 `extraSecretPatterns` 不是数组时按内置词表继续：不抛，也不放宽）。
- **拒绝理由只点这台宿主上注册着的检索工具**（可照做性）。`refSearchTools` 的默认名单是两路来源拼起来的：`grep`(pattern*, path, include) 与 `glob`(pattern*, path) 出自宿主 stock 目录（`docs/tool-catalog.md`、`packages/fs/tool-fs-search/src/{grep,glob}.ts`），而 `zg_search` 连同它的 `root`/`query`/`fts`/`vector` 参数面出自**另一枚插件**——本仓同级包 `@jayyuen66/dsh-zvec-grep`。这个名字**装不装逐台不同**，而文案是无条件点的：没装那枚插件的宿主上，模型照着「zg_search 的 root 指向 …」去做只会撞一次「工具不存在」，缺项原样还在，只能连拒到 `maxDenies` 换一次配额放行——与上一轮那条「检索起点不可达」同族：闸门判得对，给出的路走不通。
  现在指令侧点名的名单先过一道在位探测：新增 `toolPresentOf(svc.tools)`，用官方成员 `ToolRuntime.get(name)`（installed dsh-tools `index.d.ts:164`）逐个问「这台宿主注册着吗」，只把答有的写进文案——装了 `dsh-zvec-grep` 的宿主上 `zg_search` 照点，严格口径一字不损。**默认名单不改**（它记的是「哪些检索算凭证」，与该工具此刻在不在无关）。三条口径写在函数注释里，也都落成用例：探测**缺席或抛错一律算「在」**（多点名一个名字只是让模型白烧一次调用，少点名一个真存在的工具则是把模型要走的门关上）；`GuardService` 的 `get` 挂 `Partial`，因为它是探测面而不是判定面；**记账侧一字未动**（没注册的工具本来就被调用不到，筛与不筛同解），所以这次改动不会给任何形态的检索开新凭证。名单被筛空时走那句「当前设置里没有任何计入取证的检索工具」——那是配置的实情，不是一条看起来能走的路。
  用例：`test/host-integration.test.ts` 三条（这台 spine 没装 `zg_search` ⇒ 它与 `root 指向` 都不进文案、配置里添的未注册名字被滤掉、全名单缺席时给出「无法记账」那句），`test/host-contract.test.ts` 三条（get 认得出的才点、get 抛错退化为不筛、tools 面没有 get 同样不筛）。
  ⚠ 本条第一版的措辞已被修正：当时写成「宿主里不存在这条工具」，并把 `root`/`fts`/`vector` 说成「没有任何工具受理」——都不对。`zg_search` 与它的参数面都是真的，只是逐台装配；要修的缺陷是无条件点名。
- **文件头与 README 里那条 realpath 假前提被纠正**（`host.ts` 头部、README 两条边界 ⑦）。原文写的是「宿主另把 realpath 解析形一起送进判定」——按源码核对不成立：`ToolExecution.arguments` 在策略链之前就被快照并深冻结（`packages/core/tools/src/index.ts:1447-1451`），官方又明确排除输入改写（`PreToolDecision` 的注释原话 "Input rewriting is excluded because arguments are already logged and presented"），而路径解析发生在**工具体内**（`packages/fs/tool-fs/src/read-target.ts:25`），晚于整条判定链；全仓 grep `resolvedPaths` 零命中。真实情况是本包自己用 `realpathOf`/`resolvedFormsOf` 把真实路径折进判定——结论（软链面可见、TOCTOU 只收窄）一字未变，变的是这条能力**记在谁账上**。留着的代价很具体：下一个人会认为"宿主会做，这里删掉即可"，然后"凭据文件是软链"那一面静默失效。现在它由 `test/host-integration.test.ts` 的两条行为断言钉住（相对路径按会话 cwd 归一后仍交出真正文、`ln -s .env` 的链接形仍按密钥面拦且正文一个字都不出现），不再只靠注释。
- **high 档不再因为「层证据给不出」而多拒一轮**（第 3 项：层结论从同一次扫描派生）。事实门对 high 档额外要求 test/e2e/docs 层各一次可归因检索，而预检此前的口径是「层缺项 ⇒ 整趟让路」：模型即使原样重试也拿不到那几层的证据，只能自己去搜——预检省下的那一轮在 high 档上一分都省不到，而 high 档恰恰是改导出面/签名那类最需要前置事实的改动。
  现在层结论与引用面**共用同一趟走树**：扫描本就逐目录记下走到过哪里（`RefScan.dirs`），于是「门禁要的那层目录内有几处命中」只是这次扫描的派生量，不为此多花一次 I/O；结论随拒绝理由一起给出（`preflightLayerLine`，中英各一条），并与 read/refs 一起记进投递水位（`DeliveryWatermark.layerSeqs`，只抬不清），原样重试即放行。
  两条口径钉死。**没覆盖就不成结论**：遍历被预算截断、那层在扫描起点之外、或那层是软链（门禁的层探查走 `statSync` 跟链，扫描按官方 `lstat` 口径不跟）时 `layerConclusionsOf` 回 undefined，整趟让路给行动清单，绝不投半份「这层我探过了、零命中」。**词表单源**：门禁算缺项与预检派生结论吃同一枚 `extraTestDirsOf(cfg)`——两边各写一遍 `strArray(...) ?? []` 时，任何一侧改了读法都会把「门禁要一层、预检查不到那层」变成永远让路的死结。
  用例：`test/host-preflight.test.ts` 三条（真实 `test/` 层 ⇒ 同一次扫描派生结论、guard 那几项全记 done、原样重试放行；遍历被预算截断 ⇒ 让路；层目录是软链 ⇒ 扫描跑得完也让路），`test/host-integration.test.ts` 一条（新建文件那趟的理由里随行 `[层探查]`）。
- **两条用例曾在错误的分支上全绿：判别标记取的是共用前缀**（测试面）。`headFirst`（行动清单）、`preflightHandoff`（当场递证据）、`preflightAttach`（随读取附上）三条文案都以 `[fact-gate] ` 开头，而两层真 spine 用例的标记取的是「模板首词」⇒ 三个标记同值，于是「走清单」与「递证据」两条**互斥**的断言同时为真。第 3 项改完 high 档的层证据后才暴露：点对点层「照清单做过即放行」与集成层「pre-execute 截住 ⇒ 轮次不推进」实际走的是递证据那条路，断言却照样绿。
  现在取法收在一处（`test/host-spine.ts`）：`gateMarkOf` 跳过共用前缀、取到第一个标点；`markOf` 只留给 `[引用探查]` / `[目标内容]` / `[层探查]` 那类**独占标签**（单元层那份同口径，注释写明为什么不能用于 `[fact-gate]`）。转红的两条按各自本意补齐前提：要点名「清单」就必须让 B 面答不出证据，所以先 `capTree` 吃光遍历预算（这枚助手随之收进 spine，两层共用）。补齐之后点对点层那条证的正是集成层证不到的那一半——凭证来自**会话日志里模型自己的**读与搜；集成层另加一条对照（模型自己 dispatch 的 grep 换不到任何凭证：那一趟引用面仍由本包当场扫出来）。
- **项目根缓存的键漏了会话目录 ⇒ 两个会话互相吃对方的根**（精确性；本轮 review 揪出，不是本轮引入）。`projectRootOf` 在祖先链上找不到工程标记时，回落值取决于"cwd 是不是目标的祖先"（是 ⇒ 取 cwd，范围更大；不是 ⇒ 取目标父目录，那是唯一必然仍是祖先的取值），而缓存键只有 `targetN`。于是同一枚目标（典型是 `/tmp` 下整条祖先链都没有标记的草稿脚本）先被 A 会话按"cwd 是祖先"评估过之后，B 会话再来就吃到 A 的根：拒绝理由里递给模型的检索起点、引用扫描的起点、层相对形（`toPosixRelative`）的基准三处一起错位。方向是保守的（层结论对不上就整趟让路，不会误放行），代价是白给的摩擦——模型照着一个不属于自己会话的起点去搜，搜了也不算数。现在键形是 `会话目录|目标`，与判定真正依赖的输入一致。
  用例：`test/project-root-scope.test.ts` 一条（同一枚目标先用"cwd 是祖先"的会话评估、再用无关目录的会话评估 ⇒ 起点必须回落成目标父目录，而不是吃到上一趟的根）。
- **review 收口的两条**（一条性能、一条是覆盖率测量在骗人）。
  - **pre-execute 的热路径白烧定时器**：第 4 项刚接上时，`runPreflight` 对**每一次**工具调用都算一遍 `preflightSignalOf`（`AbortSignal.any` + `AbortSignal.timeout(3000)`），包括 bash / grep 这些根本没有声明目标的调用——那正是"每次工具调用都要过"的路，白烧的是一枚定时器加一次信号合流。现在先取 `declaredTargets`，为空就一枚 resolve 都不发、也不造信号。用例：`test/host-preflight.test.ts` 一条（bash 调用过一趟 B 面，探针数到 `resolve` 调用次数为 0）。
  - **`x ?? await f()` 会把下一行的覆盖率算进没走到的那条臂**：穿递 target 时先写成 `const target = resolved ?? (await fs.resolve(...))`，随后 `head = await fs.readByteRange(...)` 那行在四项 100% 的门禁里恒报 0 次——而正文确实读到了（同一条用例的 `READ_MARK` 与真内容断言都过）。用探针确认那行**每次**都执行，才定位到是 v8 → istanbul 的区间归并把紧随其后的语句并进了逻辑表达式的右臂。写法因此改成两条 `return` 的独立函数 `targetOrResolveOf`（lint 的 `prefer-nullish-coalescing` 想改回 `??`，注释里写明为什么不能听它），并把"一次盲改对同一枚目标只问一次身份"用探针钉成断言（`asked === [target, root]`），否则这类失真只会在下一次改动时重新出现。
- **事实门不再索要"结构上取不到"的凭证**。`projectRootOf` 向上找不到工程标记（`package.json` / `.git` / `tsconfig.json` / `Cargo.toml` / `pyproject.toml` / `pnpm-workspace.yaml`）时，项目根原先回落成**会话 cwd**；会话 cwd 与目标分处两棵树时（最典型的是 `/tmp` 下的草稿脚本）它**不是目标的祖先目录**。而拒绝文案会把项目根当检索起点原样递给模型，引用取证的判据（`isProjectScopeOf`）又只认「检索起点是目标的祖先」——两头一夹，模型**照着拒绝理由做也拿不到凭证**，只能连拒到 `maxDenies` 换一次配额放行，外加一条 `[danger-guard] fact-gate: <目标> 连续无证据拒绝达上限，配额放行（maxDenies）` 警告。闸门判定没错，给出的路却走不通。
  现在回落值必须满足与判据**同源**的不变式：新增 `isAncestorDirOf()`，项目根回落与引用取证判据共用同一枚（此前是两处各自 `startsWith`，天然可漂）。cwd 只在**确实是目标的祖先**时才采用（会话就在目标所在树里时，它范围更大、层探查更准）；否则退到目标自己的父目录——那是唯一必然仍是祖先的取值。
  已知代价（记在此处，避免日后被当成回归）：项目外目标不再越过自身目录去探 test/e2e/docs 层。对着 `/tmp` 问"有没有 tests/"本来就没有意义。
- `test/project-root-scope.test.ts` 三条用例钉住这条不变式：拒绝理由里给出的检索起点必须是目标的**祖先目录**，且**沿该起点检索一次即放行**（"提示可照做"才是判据的意义）；对照支覆盖「真实项目内仍取最近的标记目录」与「cwd 是祖先时仍取 cwd」。检索起点从文案的反引号路径里取，与语言、措辞无关——文案改版会让用例红，而不是静默失效。该用例在修复前实测为红（起点落在无关的会话 cwd 上），修复后转绿。
- **上报给 lesson-loop 的 bash 教训现在带得上"是哪条命令"**。`dangerous-bash` 分类原先给"`-c` 体未被检查"那一类传常量签名（`NESTED_UNCONFIRMED_SIGNATURE`，当时的理由是命令原文会把同一条教训按套娃形态碎成无数张卡）。但那条理由现在由 **lesson-loop 的类别级归并**承担（`CATEGORY_SIGNATURES` 把 `dangerous-bash` 折成一个稳定键，命令原文改落 `evidence.signature`），于是常量签名只剩坏处：那张卡里每一条证据都是**逐字相同**的模板拒绝文案，人审时看不出该审哪条命令。现在签名一律用**命令原文**——"一张卡"不变，命令原文如实落进证据；"是否需用户确认"仍由 `evidence.needsUserConfirmation` 承载，两种结论照样可分辨。常量随之删除（留着就是一条测不到的死绑定）。`test/host-contract.test.ts` 的断言同步从常量改成命令原文。

- **预检不再把密钥正文送进模型上下文**。上一轮的写类触发点会按缺项去读目标文件并把正文注入会话，而它挂在 `tools/pre-execute`——官方契约里这道瀑布**跑在同步 guard 之前**（installed dsh-tools `prepareExecution`：只有瀑布给出 `allow` 才走 `guardReason`）。于是编辑 `~/.ssh/id_rsa`、`.env`、`.aws/credentials` 这类目标时，插件在一次它自己马上就要拦下的调用上，先把凭据正文读出来交了出去（注入排在 next pre-step，不随这次拒绝撤回）。现在 B 面先用**与密钥闸同一份入参组装**（新提取的 `secretOptsOf`：扩展词表 + 会话 cwd + realpath 解析形）问一次"这一趟会不会被密钥面拦下"，命中就整趟让路——既不漏正文，也不发生"预检抢在密钥闸前面把拒绝理由换成'请重试'"那种替别人做决定。引用面照旧给：扫描从不读目标自身，而 A 面只读别的文件的命中行。
- **目标正文改成定长读**。上一轮 `readTargetContent` 是 `readFile` 整文件进内存再 `subarray(0, 64_000)`，注释写的"吃 64KB 上限"只管得到"投出去多少"、管不到"读进来多少"——而这一枚路径正是模型要改的那份文件，锁文件、导出数据、日志导出都能把它顶到几百 MB，一次预检换一次宿主进程内存尖峰。现在换成 `open` → `handle.stat()` → 一次 `handle.read(缓冲区长 64KB+1)` → `close`：缓冲区长度就是这次读的上界，多读那一枚字节顺便给出"原文更长"的实证（不必再开一次 stat 判）。非普通文件（目录/FIFO/设备）与含 NUL 的二进制都不再递正文。
- **未扫完的引用扫描不再冒充"探过引用面"**。上一轮只按文件数（256）界住读取，目录展开完全没有预算：大仓里"最多读 256 个文件"实际退化成"列几万层目录直到撞墙钟"，而零命中的文案是「即目标没有任何引用者」——**扫描被预算截断时这句是假的**，模型据此删掉一个仍有引用者的文件比不给证据更糟。现在 `RefScan` 带 `complete` / `hitsCapped` 两枚完成度位（并新增目录预算 `PREFLIGHT_MAX_DIRS = 256`），文案分三档：扫完且零命中才给全称结论；未扫完的零命中改说「已扫范围内零命中，这不等于没有任何引用者」；有命中时按截断种类补一行说明。凭证（投递水位）只在 `complete` 时记——半份扫描可以给模型看，但不顶替探过引用面。
- **台账读不到时，预检挣到的凭证终于算数**。`evidenceFor` 在会话日志不可得时回 `undeterminable`，而那份保守输入的缺项清单是**写死的两项**，从不看投递水位——于是"预检当场递过正文、guard 仍按缺 read 拒"在 A/B 面都收不了口（上一轮的注入版本同样收不了，只是它连"递出去"这一件事都没做对）。现在这一支也按水位剔除：插件自己的记录不依赖会话日志，剔除后缺项为空即放行；两项只补上一项时照旧走"不可判定 → 请用户拍板"那条逃生口。
- **每次 read 不再同步付满墙钟**。上一轮的读触发点是"只为紧接着可能发生的编辑预热缓存、一个字符都不注入"，代价是**每一次**读新目标都在 `tools/pre-execute` 里同步跑一趟项目级扫描：在宿主仓那种体量里它必然吃掉 3 秒后返回 `undefined`（不写缓存），于是预热没省到任何东西，读付 3 秒、随后的编辑再付 3 秒。现在读那一趟做的是**有用的事**（A 面把引用面随读取结果交出去，正是这一步该产出的证据），而扫描的成本由四道预算先收住——大仓里的常态是"截断即返"（毫秒级、`complete:false`、结果照样进缓存复用），墙钟只兜"单枚 syscall 卡住"那种罕见形状，因此也不再需要"负缓存"那格状态（它唯一能测到的分支恰是它自己）。

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