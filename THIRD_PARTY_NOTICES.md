# Third-party notices

本包自身编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件记录**机制来源**与
**运行期依赖**：本包的哪一部分来自第三方、在什么意义上「来自」，以及本包自身代码与第三方代码
的边界在哪里。

## 机制来源：ECC（Everything Claude Code）

- 上游项目：`ECC`（Everything Claude Code）
- 上游仓库：https://github.com/affaan-m/ECC
- 上游 npm 包：https://www.npmjs.com/package/ecc-universal
- 上游许可：MIT，版权归 Affaan Mustafa 所有
- 相关上游文件：`skills/gateguard/SKILL.md`、`scripts/hooks/gateguard-fact-force.js`、
  `scripts/hooks/block-no-verify.js`、`scripts/hooks/pre-bash-dev-server-block.js`

### 移植的是什么

**机制与设计思路**，具体为两处：

1. **首次编辑事实强制门**（`lib/fact-gate.ts`、`lib/gap-directives.ts`）——三段状态机
   `DENY → FORCE → ALLOW`：拒绝模型的第一次编辑，要求它先给出具体事实而非自我评估，
   补齐后放行。上游把这一点写在 `skills/gateguard/SKILL.md` 的 "Core Concept" 一节。
2. **危险命令拦截的四个类目**（`lib/danger-rules.ts`）——git 钩子绕过、灾难性删除、
   下载即执行、长驻 dev server。上游对应 `scripts/hooks/` 下的三个 hook。

本包在这两处都做了**扩展与改写**，与上游存在实质差异：

| 维度 | 上游 ECC | 本包 |
| --- | --- | --- |
| 事实门要求的四项 | 引用者 / 受影响公共接口 / **数据 schema 与日期格式** / 逐字引用用户指令 | 引用者（带工具白名单口径）/ 受影响公共接口 **与需同步的测试文档** / 逐字引用用户指令 |
| 拒绝文案 | 所有情形共用一段固定文本，拒绝满预算后改用单行简版 | **按成因定制**：没读过 / 调用失败过 / 被别的会话改过，三种缺项给出三种不同指令 |
| 防死锁 | 拒绝次数用尽后降级为单行文本 | `maxDenies` 配额，且**缺项变少即视为正在收敛并重置计数** |
| 结构 | 单个 hook 文件内自含状态与取证 | 纯状态机（`lib/fact-gate.ts`）/ 指令层（`lib/gap-directives.ts`）/ 检索口径层（`lib/ref-search-policy.ts`）三段分离，判定全部是纯函数 |
| 危险命令判定 | 按 hook 场景分支 | 逐段状态机拆词（`lib/command-segments.ts`），对引号闭合与分词共用一台机器 |

### 移植的**不是**什么

本包**不包含上游的代码、词表或文案**。这一点是逐项比对得出的，不是声明式的说法；比对
方式与结论一并记录在此，读者可自行复核：

- **代码行**：上游上述文件去注释后共 1394 条代码行，本包相关源码为 3194 条。逐字相同的
  共 25 条，**全部是 JavaScript 语言样板**（`return false;`、`} else {`、`let i = 0;`
  一类），无一条是上游的业务逻辑。
- **标识符级 6-gram 重叠**：276 / 33,996，约 0.81%，抽样全部为语言构造
  （`} else if ( /`、`. length ) { const ch` 一类）。
- **正则字面量**：上游三个文件去重后 49 个、本包相关源码 59 个，**完全相同 0 个**。
  双方都使用正则字面量书写（上游 89 处字面量，仅 2 处改用 `new RegExp`），差别在规则内容
  而不在书写风格。
- **词表**：4 处成员重合，且全部是由外部事实唯一确定的枚举——git 支持 `--no-verify` 的
  子命令表（`commit` / `push` / `merge` / `cherry-pick` / `rebase` / `am`）、POSIX shell
  名、包管理器名、`kill` 的 POSIX 标准选项。这些列表由 git 的 CLI、POSIX 标准和包管理器
  注册名决定，不是上游的创作。

因此本包以 MIT 发布、未按上游许可分发其代码，是**基于上述比对结论**的判断。若你认为该
结论有误，请以 issue 反馈，届时按上游许可条款补齐随包分发。

### A/B 数据的出处

本包多处注释与本文档引用「A/B 实测 +2.25 分」「平均 9.0 vs 6.75」。该数据来自上游
`skills/gateguard/SKILL.md` 的 "Evidence" 一节（分析模块 8.0/6.5、Webhook 校验器
10.0/7.0）。本包**未复跑该实验**，引用的是上游的测量结果。

## 运行期依赖

运行期依赖的许可由各自包随包分发，本包不重复其文本：`@deepseek-ai/dsh`（宿主本体：peer 里钉住
它能承载本包的版本面，源码不 import 它）、`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-llm`、
`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/schemastery`、
`@jayyuen66/dsh-plugin-shared`、`zod`。

其中 `@deepseek-ai/dsh-brand` 虽看似只服务于类型，**仍必须是运行期依赖**：宿主类型面用
品牌串做名义类型（nominal typing），构造品牌需要真实函数值而没有 type-only 的构造途径。
若把它降为 `devDependencies`，打包器会把构造函数体内联进产物，于是每个包各得一份官方
构造函数，单例语义随之失效。`build-host.mjs` 的外部化清单只读 `dependencies` ∪
`peerDependencies`，`test/build-host.test.ts` 对此有断言钉住。

`@deepseek-ai/dsh-llm` 由预检以值引入（`createUserMessage`，注入给模型的消息），同一条口径：
落 `peerDependencies`、产物里保持裸说明符 —— 内联等于每包各持一份官方的消息铸造与深冻结。

`@deepseek-ai/dsh-typert-protocol` 由判定统计读数面（`lib/stats-remote.ts`）以值引入：要
`extends TypertRemoteService` 并用 `@Remote` 标记端点，**两枚都是值，没有 type-only 的构造途径**
（与 `brandNumber` 同族）。同样落 `peerDependencies`，产物里保持裸说明符；`build-host.mjs` 的
外部化清单只读 `dependencies` ∪ `peerDependencies`，而 `test/build-host.test.ts` 另有一条
**结构性**断言钉住"依赖表里的包一个都没被内联"（看 chunk 的 `moduleIds`，不看函数名 —— 产物开了
minify，内联体里的标识符会被 mangle）。

`zod` 由 `lib/tool-ledger.ts` 以值引入（其 `stateSchema`），同样只能是运行期依赖。