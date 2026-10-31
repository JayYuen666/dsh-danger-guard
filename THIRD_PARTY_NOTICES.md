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
   下载即执行、长驻 dev server。上游对应两处 hook 加一处同文件判据：git 钩子绕过见
   `scripts/hooks/block-no-verify.js`，长驻 dev server 见
   `scripts/hooks/pre-bash-dev-server-block.js`，灾难性删除是
   `scripts/hooks/gateguard-fact-force.js` 中由 `skills/gateguard/SKILL.md` 的
   “Destructive Bash Gate” 一节描述的判据。下载即执行没有对应的上游文件，是本包
   按同一判定框架扩展出的类目。

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
方式与结论一并记录在此，读者可自行复核。

比对固定在上游 commit `b38be6a7f6350964d59328b52f0624e1d1d552d1` 的 `scripts/hooks/`
三份文件（`gateguard-fact-force.js`、`block-no-verify.js`、`pre-bash-dev-server-block.js`）；
本包侧取参与这两处机制的 11 个模块：`lib/danger-rules.ts`、`lib/fact-gate.ts`、
`lib/gap-directives.ts`、`lib/command-segments.ts`、`lib/danger-regexes.ts`、
`lib/container-rules.ts`、`lib/disaster-target.ts`、`lib/edit-targets.ts`、
`lib/prefix-tables.ts`、`lib/secret-patterns.ts`、`lib/ref-search-policy.ts`。复核方式：
按该 commit 取文件，去掉注释后比较去掉首尾空白的非空行；标识符 6-gram 取标识符序列；
正则字面量按源码逐字比较。以下读数是写下这段时的快照（本包 0.1.11 工作区）；本包源码
此后增长不改变结论，复核时按同一方法重算即可。

- **代码行**：上游 3185 行、本包 3695 行（去注释后的非空行）。逐字相同的 625 行里，长度
  超过 20 字符的只有 `for (const segment of segments) {` 一条，其余全部是标点、
  `return false;`、`let i = 0;` 一类语言样板；没有上游的业务谓词或规则内容。
- **标识符级 6-gram 重叠**：13 / 11,128，约 0.12%。全部落在由外部事实唯一确定的枚举上：
  git 支持 `--no-verify` 的子命令表（`commit` / `push` / `merge` / `cherry-pick` /
  `rebase` / `am`）、POSIX shell 名、包管理器名、`kill` 的 POSIX 标准选项。这些列表由
  git 的 CLI、POSIX 标准和包管理器注册名决定，不是上游的创作。
- **正则字面量**：上游去重后 75 个、本包 71 个，逐字比较没有一条内容相同。双方都使用
  正则字面量书写（上游 75 处里只有 2 处改用 `new RegExp`），差别在规则内容而不在书写风格。

因此本包以 MIT 发布、未按上游许可分发其代码，是**基于上述比对结论**的判断。若你认为该
结论有误，请以 issue 反馈，届时按上游许可条款补齐随包分发。

### 上游 MIT 原文（防御性随附）

不论上述比对结论是否成立，上游的版权与许可声明原文都随本包分发：附上它只是一段文本，
而「比对结论被推翻时发布物里没有上游许可文本」是实质性合规缺口。以下为上游仓库 LICENSE
的逐字原文：

```
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

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
构造函数，单例语义随之失效。外部化清单由 `@jayyuen66/dsh-plugin-shared/lib/build-host`
从 `dependencies` ∪ `peerDependencies` 折出（`build-host.mjs` 只声明产物表）；
`test/build-host.test.ts` 独立读 `package.json` 取同一份包名表，断言其中没有任何一个
出现在产物的 `inlinedModules` 里。

`@deepseek-ai/dsh-llm` 由预检以值引入（`createUserMessage`，注入给模型的消息），同一条口径：
落 `peerDependencies`、产物里保持裸说明符 —— 内联等于每包各持一份官方的消息铸造与深冻结。

`@deepseek-ai/dsh-typert-protocol` 由判定统计读数面（`lib/stats-remote.ts`）以值引入：要
`extends TypertRemoteService` 并用 `@Remote` 标记端点，**两枚都是值，没有 type-only 的构造途径**
（与 `brandNumber` 同族）。同样落 `peerDependencies`，产物里保持裸说明符；外部化清单
由 shared 的 `buildHostEntries` 从 `dependencies` ∪ `peerDependencies` 折出，而
`test/build-host.test.ts` 另有一条**结构性**断言钉住"依赖表里的包一个都没被内联"
（看 chunk 的 `moduleIds`，不看函数名 —— 产物开了 minify，内联体里的标识符会被 mangle）。

`zod` 由 `lib/tool-ledger.ts`（其 `stateSchema`）与设置卡的 `src/stats-reader.ts`（快照形状守卫）
以值引入，同样只能是运行期依赖；client 产物按宿主的 `PLATFORM_MODULES` 保持 `require("zod")`
外部化，不内联。