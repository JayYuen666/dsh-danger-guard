// test/client-freshness.ts —— 产物新鲜度指纹门禁（8 包共用，TDD）。
//
// 背景：src/client-entry.ts 改后忘跑 node build-client.mjs，浏览器一直加载旧
// client.js——本会话已两次踩坑（rescue 403 修复没进产物；ctx-observe 字段补齐
// 曾靠人工时间戳核对）。mtime 断言在 git clone / touch 下不稳定，故用
// **内容指纹**：内存构建（buildClient()，纯函数、确定性输出）vs 磁盘
// client.js 逐字节比对。src 任何变更未重建 → 字节必差 → 红。
//
// 用法（各包 test/build-client.test.ts 顶部引入后调用）：
//   declareClientFreshness(import.meta.url)   // 自动定位 ../client.js 与 ../build-client.mjs
//
// 注意：buildClient() 必须是确定性构建（同输入同输出）。当前 8 包的
// build-client.mjs 均不含时间戳/随机数（rollup 无 banner hash 变量），
// 逐字节相等成立；若未来构建引入非确定性，改为规范哈希比较并在
// build-client.mjs 里输出 canonical 形态。

import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 指纹门禁：磁盘 client.js 必须与最新构建逐字节一致。 */
export async function declareClientFreshness(testFileUrl: string): Promise<void> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgJson = await readFile(path.resolve(pkgDir, "package.json"), "utf8");
  const nameMatch = /"name":\s*"(?<name>[^"]+)"/u.exec(pkgJson);
  const pkgName = nameMatch?.groups?.["name"] ?? "unknown";

  test(`${pkgName}: client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）`, async () => {
    const buildMod = (await import(path.resolve(pkgDir, "build-client.mjs"))) as {
      buildClient: () => Promise<string>;
    };
    const expected = await buildMod.buildClient();
    const onDisk = await readFile(path.resolve(pkgDir, "client.js"), "utf8");
    assert.equal(
      onDisk,
      expected,
      onDisk === expected
        ? "fresh"
        : `[${pkgName}] client.js 已过期：src/client-entry.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-client.mjs`,
    );
  });
}
