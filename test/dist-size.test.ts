// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：`pnpm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人在切面里塞进大对象字面量或整段查表」这类回退——
// 它们不会让任何现有用例变红（体积不是行为），所以必须有一道单独的尺子。
//
// 预算怎么定的：取当前实测值上浮约 25%。留这 25% 是给正常演进的——加一条规则、改一句文案
// 不该立刻要人改预算；翻倍一定会顶穿。真需要突破时，改这些常量并写明理由。
//
// 明确不做的事：**不开 minify**。实测过——压缩后产物里
// `from "@jayyuen66/dsh-plugin-shared/lib/record"` 与 `from "@deepseek-ai/schemastery"`
// 两个说明符字符串双双消失，于是 test/build-host.test.ts 那两条「跨包依赖必须外部化」的断言
// 会从「依赖被内联了也不报」变成恒绿：它们防的正是 isRecord / brandNumber 这类单点被就地
// 复制多份。省下的体积不值得废掉两道真门禁，所以产物保持可读，体积改用预算盯着。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 拦截半产物体积预算（实测 191,721 B）。宿主按包名载入它，这几个字节是真实装载成本。 */
const HOST_BUDGET_BYTES = 240_000;
/** 设置半产物体积预算（实测 7,293 B）。与拦截半分属两个 bulkhead 条目，各自记账。 */
const SETTINGS_BUDGET_BYTES = 9100;
/** 客户端半产物体积预算（实测 30,503 B）。浏览器侧加载，按平台计账。 */
const CLIENT_BUDGET_BYTES = 38_000;
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
