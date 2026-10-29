// test/self-write-proof.test.ts —— 内容自证的读取上限。
//
// 自证要把目标全文读进来做 includes；超过上限还读，等于让一份几十万行的锁文件/数据导出
// 在同步守卫的主路径上整段卡住。这里钉住三件事：超限返回"不知"、上限内照常自证、
// 读不到正文照旧返回 false。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { selfWritesStillPresent } from "../lib/self-write-proof.ts";

/** 远大于实现上限的文件：若实现仍读全文，写入文本会被自证为 true。 */
const OVERSIZE_BYTES = 2 * 1024 * 1024;

const dirs: string[] = [];

/** 建一个临时目录，测试结束统一删除。 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-self-proof-"));
  dirs.push(dir);
  return dir;
}

describe("selfWritesStillPresent：内容自证的读取上限", () => {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("文件超过上限时返回 undefined（不知），即使写入文本确实还在", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "big.txt");
    await writeFile(file, `needle\n${"x".repeat(OVERSIZE_BYTES)}`);
    expect(selfWritesStillPresent(file, "needle")).toBeUndefined();
  });

  it("上限内的文件仍按内容自证", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "small.txt");
    await writeFile(file, "before needle after\n");
    expect(selfWritesStillPresent(file, "needle")).toBe(true);
    expect(selfWritesStillPresent(file, "missing")).toBe(false);
  });

  it("读不到正文（目录或缺失路径）⇒ false，不把读失败当成自证", async () => {
    const dir = await tempDir();
    expect(selfWritesStillPresent(dir, "needle")).toBe(false);
    expect(selfWritesStillPresent(path.join(dir, "absent.txt"), "needle")).toBe(false);
  });
});
