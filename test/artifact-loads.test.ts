// test/artifact-loads.test.ts —— 产物**真的能被 Node 加载**。
//
// 为什么补这条门禁：本仓此前对产物的检查只有"与最新构建逐字节一致"（`test/host-freshness.ts`）
// 与体积预算（`test/dist-size.test.ts`）—— **两条都不执行产物**，所以"产物是语法上无效的 JS"
// 这一类错它们一条都抓不住。本轮实测踩过：rolldown 不认识标准装饰器，会把 `@Remote("stats")`
// **原样吐进 `host.js`**，而 `npm run build` 报**成功** —— 那一段一旦发出去，插件在宿主里
// 直接加载失败，且没有任何本地信号。修法（`decorator-transform.mjs`）本身也需要这条门禁兜底：
// 它跑 `tsc` 且**不看退出码**（`--noResolve` 下必有 TS2307），所以"产物到底成不成"只能靠真加载。
//
// 只加载两个 host 产物：`client.js` 是浏览器 UMD 外壳，在 Node 里 import 会撞 `window is not
// defined`（那是**设计如此**，见 README 的导出面那一节），拿它当"加载失败"会是一条假门禁。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 在**独立进程**里 import 一个产物（同进程 import 会污染我们的模块表，也测不到解析期的
 *  语法错）。同步子进程：这条门禁没有并发需求，而 async 三种写法都被本仓的 promise 规则夹住
 *  —— 见 oxlint.config.ts 里 `syncWrites` 那一段。stdio 一律收进返回值，绝不漏进测试日志。 */
function loadArtifact(file: string): { code: number; stderr: string } {
  const url = pathToFileURL(path.join(pkgDir, file)).href;
  try {
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`],
      {
        cwd: pkgDir,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    return { code: 0, stderr: "" };
  } catch (error: unknown) {
    const stderr =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    return { code: 1, stderr };
  }
}

describe("产物可加载：两个 host 产物能被 Node 真的 import 进来", () => {
  it("host.js 解析并加载成功（语法错/裸说明符解析失败都会在这里现形）", () => {
    assert.ok(existsSync(path.join(pkgDir, "host.js")), "host.js 不存在：先跑 npm run build");
    const { code, stderr } = loadArtifact("host.js");
    assert.equal(code, 0, `host.js 加载失败：\n${stderr.slice(-1200)}`);
    // 语法错是这一类里最该被点名的一种（装饰器原样落进产物就是它）。
    assert.doesNotMatch(stderr, /SyntaxError/u, `host.js 有语法错误：\n${stderr.slice(-600)}`);
  });

  it("settings.js 解析并加载成功（同上）", () => {
    assert.ok(
      existsSync(path.join(pkgDir, "settings.js")),
      "settings.js 不存在：先跑 npm run build",
    );
    const { code, stderr } = loadArtifact("settings.js");
    assert.equal(code, 0, `settings.js 加载失败：\n${stderr.slice(-1200)}`);
    assert.doesNotMatch(stderr, /SyntaxError/u, `settings.js 有语法错误：\n${stderr.slice(-600)}`);
  });

  it("装饰器**没有**原样落进产物（本轮踩过的那一类：rolldown 不降级标准装饰器）", () => {
    const host = readFileSync(path.join(pkgDir, "host.js"), "utf8");
    // 源码里那个装饰器用法还在（注释里提到过），但**不能**出现在可执行位置：
    // `@Remote("stats")` 这种行首装饰器形状一旦出现，就是预转换没生效 —— 而那是**非法 JS**，
    // 真跑起来会由上面那条加载用例当场抛出（语法错在 import 期就炸）。
    assert.doesNotMatch(host, /^\s*@Remote\(/mu, "装饰器没被预转换：产物是非法 JS");
    // ⚠ 这里**不**再断言 `__esDecorate`：产物开了 minify，那枚标识符会被 mangle（实测 0 次），
    // 断言它会变成恒红/恒绿之间的摇摆。降级到底成没成，唯一可信的证据是真加载（上面两条）
    // 加上源侧的契约用例（test/stats-remote.test.ts 拿 remoteMethods() 对标记）。
    // 剩下这条正向断言只钉一件事：服务类没被 DCE 掉（它的服务键是字符串字面量，mangle 不动）。
    assert.match(host, /dangerGuardStats/u, "服务键不见了：装饰器那一段被摇树摇没了？");
  });
});
