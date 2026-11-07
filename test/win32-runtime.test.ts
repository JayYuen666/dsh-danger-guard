// test/win32-runtime.test.ts —— 把整个运行时换成 win32，跑**真实产品判据**。
//
// 为什么需要这一层：`test/cross-platform.test.ts` 验的是"判据在两种 path 语义下同构"，
// 但它跑的是测试里复述的逻辑。产品代码到底有没有踩平台假设，只有让产品代码自己在 win32
// 语义下跑一遍才知道。这一份就是那个"跑一遍"：`vi.mock` 把 `node:path` 换成本机自带的
// `path.win32`、`node:os` 换成 Windows 形 homedir/platform —— 两条都是 Node 内置能力，
// 零第三方依赖。
//
// 重构方向照官方 `deepseek-harness/packages/deliverables/workspace-changes/src/paths.ts`：
// 真实路径的包含性判定一律走 `path.relative`（`isInside`），**不拼分隔符前缀**；
// 展示形态在输出前用 `toPosix` 折一次。这一份就是那条纪律的回归钉。
//
// 与本仓另一条纪律的边界要说清：lib/path-format.ts 与 test/sandbox-scope.test.ts 刻意**不**伪装运行环境，
// 而是把 pathApi 作为参数注入——那是对的（判据的平台差异该由入参决定）。本文件是那条纪律的**例外**而不是
// 重复：它要看的正是「产品代码自己去读 node:path / node:os 时会不会踩平台假设」，注入式桩够不到那一次读取。
// 覆盖面因此是有限的四条（家目录展开、祖先层、沙箱降级、灾难目标的 Windows 字形），与 sandbox-scope /
// preflight-scan 的注入式 win32 用例互补而不是重叠：那两处验判据同构，这一处验读取本身。
//
// ⚠ 本层**测不到**的三类（只有真 Windows runner 覆盖）：8.3 短名
// （`RUNNER~1` vs `runneradmin`）、盘符大小写不敏感、PE 加载器的 PATHEXT 解析。
// 所以这里证明的是"路径语义判据跨平台"，不是"宿主环境跨平台"。
import { describe, it, vi } from "vitest";
import { asOsPath } from "../lib/path-format.ts";
import assert from "node:assert/strict";

const BS = String.fromCodePoint(92);
const win = (...segments: readonly string[]): string => segments.join(BS);

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  const { win32: windowsPath, posix } = actual;
  return { ...windowsPath, default: windowsPath, win32: windowsPath, posix };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  // 工厂被提升到文件顶部，不能引用模块级变量 ⇒ 替身值就地写。
  // 两条 `oxlint-disable` 是**该规则与 `vi.mock` 工厂的结构性冲突**：钩子要求函数提到外层，
  // 而提升机制禁止它引用外层——两个要求无法同时满足。同源先例见 `test/danger-rules.test.ts`
  // 的 `node:os` 桩（那里也是就地定义 homedir/platform）。
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const homedir = (): string => String.raw`C:\Users\tester`;
  // ⚠ 本文件现有四条用例只读到 `homedir()`：`os.platform()` 的唯一入口是 lib/danger-rules.ts 的
  // `isWindowsHost()`，而那走在 bash 判据路径上，本层没有触达。留这一枚替身是为了模块替换的完整性
  // （漏掉它，将来任何一条用例读到平台就会拿到宿主的真实值而让结论随机器变），不是它此刻被断言过。
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const platform = (): string => "win32";
  // 运行期命名空间上有 `default`（指向同一模块），类型上没有：经 unknown 取它，
  // 让 `os.default.homedir()` 也落在桩上，而不是回到宿主真实家目录。
  const actualDefault =
    (actual as unknown as { readonly default?: typeof actual }).default ?? actual;
  return { ...actual, homedir, platform, default: { ...actualDefault, homedir, platform } };
});

describe("win32 全运行时下的路径判据", () => {
  it("disasterTargetPathOf：相对形按 cwd 归一，不坍到宿主 cwd", async () => {
    const { disasterTargetPathOf } = await import("../lib/danger-rules.ts");
    const cwd = win("C:", "w", "proj");
    assert.equal(disasterTargetPathOf(".", asOsPath(cwd)), cwd);
    assert.equal(disasterTargetPathOf("..", asOsPath(cwd)), win("C:", "w"));
    assert.equal(disasterTargetPathOf("build", asOsPath(cwd)), win("C:", "w", "proj", "build"));
  });

  it("ancestorLevelsOf：反斜杠路径逐级上溯", async () => {
    const { ancestorLevelsOf } = await import("../lib/preflight-scan.ts");
    const root = win("C:", "w", "proj");
    assert.deepEqual(ancestorLevelsOf(root, win("C:", "w", "proj", "src", "a", "m.ts")), [
      win("C:", "w", "proj", "src", "a"),
      win("C:", "w", "proj", "src"),
      root,
    ]);
  });

  it("sandboxDropsOf：认得出「包住可写根」就不让路", async () => {
    const { sandboxDropsOf } = await import("../lib/sandbox-scope.ts");
    const scope = { mode: "workspace-write" as const, roots: [asOsPath(win("C:", "w", "proj"))] };
    const driveRoot = asOsPath(`C:${BS}`);
    const parentDir = asOsPath(win("C:", "w"));
    const elsewhere = asOsPath(win("C:", "elsewhere"));
    assert.equal(sandboxDropsOf(scope, [driveRoot]), false, "盘根包住可写根");
    assert.equal(sandboxDropsOf(scope, [parentDir]), false, "父目录包住可写根");
    const insideRoot = asOsPath(win("C:", "w", "proj", "build"));
    assert.equal(
      sandboxDropsOf(scope, [insideRoot]),
      false,
      "目标落在可写根之内 ⇒ 沙箱允许写，不能让路",
    );
    assert.equal(sandboxDropsOf(scope, [elsewhere]), true, "够不着 ⇒ 让路");
  });

  it("家目录子路径用平台分隔符拼接", async () => {
    const { disasterTargetPathOf } = await import("../lib/danger-rules.ts");
    assert.equal(
      disasterTargetPathOf("~/Documents", undefined),
      win("C:", "Users", "tester", "Documents"),
    );
  });
});
