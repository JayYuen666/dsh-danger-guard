// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：`pnpm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人在切面里塞进大对象字面量或整段查表」这类回退——
// 它们不会让任何现有用例变红（体积不是行为），所以必须有一道单独的尺子。
//
// 预算怎么定的：取当前实测值上浮约 25%。留这 25% 是给正常演进的——加一条规则、改一句文案
// 不该立刻要人改预算；翻倍一定会顶穿。真需要突破时，改这些常量并写明理由。
//
// 三枚运行期产物开 `minify: true`（裁决见下），types/ 的声明**不**压缩：那是发布面给编辑器
// 读的 API 文档，JSDoc 就是它的正文。
//
// ⚠ 更正一条曾写在**这里**的错误结论（它的影响是让本包白白多背了几百 KB）：此前记的是
// "压缩后 `from "@jayyuen66/dsh-plugin-shared/lib/record"` 与 `from "@deepseek-ai/schemastery"`
// 两个说明符双双消失，于是两道外部化门禁会变成恒绿"。**实测否证**：那时看到的是
// `from"x"`（minify 去掉了空格）与 `from "x"` 的差异 —— 说明符一直在，依赖照样外部化。
// 真正会被 minify 打瞎的是**带标识符的文本判据**（内联体的函数名会被 mangle，实测故意不外部化
// dsh-brand 时产物里 `brandNumber` 一次都查不到），所以那两道门禁已改成**结构性判据**：
// 看 chunk 的 `moduleIds` 里有没有依赖表的包（test/build-host.test.ts）。产物可读性不再是
// 一条门禁（谁也不会去读装载器吃的文件），体积与"依赖没被内联"各由一道真门禁盯着。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 拦截半产物体积预算（实测 309,394 B）。宿主按包名载入它，这几个字节是真实装载成本。
 *  从 191,721 一路涨上来的增量都是**改动本身**：预检 A/B 两面、检索工具在位探测、引用扫描的
 *  凭据面隔离，再加层结论派生（第 3 项）与官方真实路径通道（第 4 项，含 lib/lru.ts
 *  与 lib/target-paths.ts 两枚新模块）。
 *  预算按同一条规矩取实测上浮 ~4%：留够正常演进的余量，同时任何一次"塞进大表"仍会当场顶穿。
 *
 *  本轮 +17,575 B，分两笔：
 *   1. **出路渲染**（`Fix` 的两枚新拒绝文案中英各一份 + `renderFix` 的角色表 + `gitFacts`
 *      记越界词与 `catastrophicRm` 过滤命中目标的逻辑）；
 *   2. **ask 通道 + 沙箱对齐**（`RULE_TIER` 单表、严重度择优、`AskRequest` 构造、
 *      沙箱管辖面的读与包含性判断、以及 `devServer` 那条点名 `run_in_background` 的新文案 ——
 *      它比旧文案长一倍，而它正处在"模型知道该怎么改"这条路径上）。
 *   3. **git 破坏族 + 基础设施族**（7 + 5 枚规则键、两族的判据表与走查面、中英各 12 条
 *      写明出路的文案）。判据表这一轮真加了——A1/A2 就是这个目的。
 *   4. **判定统计读数块**（D）与 **`minify: true`**：前者是行为增量，后者把 309,394 B
 *      一次压到 86,727 B（−72%）——注释与空白此前占了产物的一半以上。
 *   5. **权限档位分叉**（`lib/mode-policy.ts` 新模块 + 四档说明文案中英各一份 + 去重表
 *      `AskDeduper` + 档位探针与两处接线）：这一轮加的是**判据本体**——静态档位表换成了
 *      以权限档位为第一维的处置表，四档 × 全部规则键的矩阵现在是可复跑的测试
 *      （`test/mode-policy.test.ts`）。实测 97,587 B。
 *   6. **词法层补洞**（注释与 heredoc 的独立扫描、双引号续行、region 内引号/反引号配对、
 *      续行空词、兄弟 region 展开）：新增的是词法状态机本身，不是查表；实测 104,037 B。
 *   7. **执行端与参数语义加固**（非 shell stdin 解释器、Git 子命令取值表、kubectl dry-run
 *      取值、secret 逐条匹配与解析形预算、路径 handoff 保护）：新增的是判据本体；实测
 *      108,354 B。
 *   8. **事实门状态边界**（严格配额水位、归一化状态键、缺失 input 退化、构造参数校验、
 *      会话键类型前缀、访问型 LRU、need 标签）：新增的是判据与中英文案；实测 109,858 B。
 *   9. **沙箱管辖面的三处加固**（可写根规范化失败时退回 `path.resolve` 形而不丢那一枚、
 *      执行器自报的 mode 必须本身在拦、rm 的重定向操作数不进目标面）：实测 110,625 B。
 *      第一笔是判据本体（丢根会让反方向的误放行），第二笔给让路加了一道前提，
 *      第三笔把 `rm -rf ./build > /dev/null` 从误拦改回放行。
 *  10. **扩展密钥模式的口进**（`looksLikeRegexLiteral`：拒收写成 `/…/i` 形状的输入 ——
 *      那种写法编得过却永远匹配不到，用户以为开了保护而密钥面静默失效）：判据本体 + 一处
 *      拒收分支，实测 111,551 B。
 *   第 11 次（「读到的是哪一版」账本的四个方向：取不到写入文本不再被当自证、全局基线
 *      不在 observeVersion 里抢着刷新而挪到 settleVersion、同一目标的多笔读按先后排队、
 *      换代时全局基线一并清空）：新增的是判据与一条队列，不是查表；实测 113,048 B。
 *   第 13 次（结构视图的两个递归入口 `structureRun` / `structureText` 断开前向引用：
 *      区体文本的递归入口改为经参数传入，两者不再互相按名字引用）：增量是两处调用点的
 *      实参传递，不是查表；实测 113,889 B。
 *   第 14 次（审计收口：收口走 `verdictOf`、写面阈值的交叉校验与告警、判定成本样本带
 *      `judged` 位、事实门放行判据单源化）：增量全是判据本体与一处告警文案，不是查表；
 *      实测 115,711 B。
 *  预算按同一条规矩取实测上浮 ~0.7%。 */
const HOST_BUDGET_BYTES = 116_500;
/** 设置半产物体积预算（实测 3,380 B；开 minify 前 7,293 B）。与拦截半分属两个 bulkhead
 *  条目，各自记账。增量：apply 阶段的值面形状守卫（plain 值当场点名，不拖到第一次读）
 *  与服务面守卫的报错收窄；预算按 ~3% 上浮。 */
const SETTINGS_BUDGET_BYTES = 3500;
/** 客户端半产物体积预算（实测 25,549 B；开 minify 前 38,782 B）。浏览器侧加载，按平台计账。
 *  本轮增量：名单行的回退显示、批量保存的逐字段结算（部分失败只留失败项）、
 *  bundle 包名抽成单源模块；预算按 ~1% 上浮。
 *
 *  ⚠ 更早的一笔补记（24,500 → 25,000）：超出来自 `src/ui-messages.ts` 里两处
 *  `secretPlaceholder` 的文案加长（写清"别写成 /…/i 形状"），HEAD 那一版就已顶穿旧预算，
 *  构建脚本的改动一个字节都没影响体积（A/B 过三份 `build-client.mjs`）。 */
const CLIENT_BUDGET_BYTES = 25_800;
/** 声明入口层体积预算。types/ 整目录进 files，体积会计入 tarball。 */
const DECLARATION_ENTRY_BUDGET_BYTES = 120_000;

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  ["host.js", HOST_BUDGET_BYTES],
  ["settings.js", SETTINGS_BUDGET_BYTES],
  ["client.js", CLIENT_BUDGET_BYTES],
];

/**
 * 某目录下 `.d.ts` 的字节合计（**不递归**）。
 *
 * 不递归是刻意的：types/ 一层就是两个声明入口（host.d.ts / settings-host.d.ts），lib/ 下是
 * 它们各自的依赖，量级不同。只对一层求和，就不必去减一个可能为空的子目录——那种写法在
 * 子目录为空时得到 0、断言恒真，而一条永远绿的闸门比没有闸门更坏：它让人以为有护栏。
 *
 * @param dir - 目录绝对路径
 * @returns 字节合计
 */
function entryDeclarationBytes(dir: string): number {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".d.ts"))
    .reduce((sum, name) => sum + readFileSync(path.join(dir, name)).byteLength, 0);
}

describe("产物体积", () => {
  // 用 it.each 而不是手写循环：三条预算断言形状完全相同，手写循环会多一层缩进，且新增一条
  // 预算时容易忘了把它塞进某个数组的某个分支里。
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    const bytes = readFileSync(path.join(pkgDir, file)).byteLength;
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表或字面量。` +
        `确属正常演进就改 test/dist-size.test.ts 里对应的预算常量，并写明理由。`,
    );
  });

  it("types/ 入口声明不超出预算", () => {
    const bytes = entryDeclarationBytes(path.join(pkgDir, "types"));
    assert.ok(
      bytes <= DECLARATION_ENTRY_BUDGET_BYTES,
      `types/ 入口声明实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${DECLARATION_ENTRY_BUDGET_BYTES.toLocaleString("en-US")} B。` +
        `确认是正常演进就改这条预算常量，并写明理由。`,
    );
  });
});
