// test/preflight-fs-face.test.ts —— 引用扫描对 **fs 后端各种失败形状**的反应。
//
// 为什么单独一层：预检的取证 I/O 已经全部走官方 `ctx.fs`（见 lib/preflight-scan.ts 的
// PreflightFs），而真后端会抛的形态比 node:fs 多得多——权限、越界被拒、断链、远程 IO 故障，
// 每种都在"这一份我到底看没看过"这件事上要求一个诚实答案。集成层用真 FsLocal 跑通了主路径
// （test/host-integration.test.ts），这里用可注入失败的夹具把每一支**确定地**跑一遍：
// 真后端下要造"读的时候正好故障"没有稳定办法，而这几支的语义（哪些算没扫完）恰恰是
// "零命中"那句结论能不能说出口的唯一依据。
//
// 共同口径（三档，全都有用例）：
//  - **整趟作废**：取消 ⇒ 回 undefined ⇒ 不注入、不记凭证（半份"已探过引用面"最糟）；
//  - **降级但不作废**：目录列不出 / 子项探不到 / 文件读不动 ⇒ `complete: false`
//    ⇒ 文案换成"已扫范围内"，refs 凭证不给（保守），但已取到的正文照给；
//  - **本来就不算数**：软链、点开头目录、依赖/产物目录、超大文件、二进制 ⇒ 跳过而**不**降级
//    （它们不是"该看没看到"，而是"按口径就不看"）。
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PREFLIGHT_MAX_BYTES, scanReferences } from "../lib/preflight-scan.ts";
import type { RefScan } from "../lib/preflight-scan.ts";
import { localFsFace } from "./fixtures/local-fs-face.ts";
import type { LocalFsFailures } from "./fixtures/local-fs-face.ts";

/** 一次临时"项目"的根与目标（beforeAll 里建，afterAll 里删；不给初值，避免 describe
 *  体内那层 setup 语义 —— vitest(require-hook) 管的就是这个）。 */
let root: string;
let target: string;

/** 命中清单里的文件路径（相对起点），按名排序便于比对。不捕外层变量，所以放模块层。 */
function hitFiles(scan: RefScan): string[] {
  return scan.findings.map((finding) => finding.file).toSorted();
}

/** 走一遍扫描并**要求它跑成**（跑不成即抛，用例里就不用每处再判一次 undefined）。 */
async function scanned(fail: LocalFsFailures = {}): Promise<RefScan> {
  const result = await scanReferences({
    targetN: target,
    root,
    needles: ["widget"],
    signal: new AbortController().signal,
    fs: localFsFace(fail),
  });
  if (result === undefined) {
    // 回 undefined 只该出现在取消时；出现在别处就是判据变了，让用例直接红在这里
    throw new Error("这一趟本该跑成（扫描回 undefined = 被取消）");
  }
  return result;
}

describe("引用扫描的降级与跳过", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dg-fs-face-"));
    target = path.join(root, "src", "target.ts");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "export const widget = 1;\n");
    await writeFile(path.join(root, "caller.ts"), 'import { widget } from "./src/target";\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("主路径：命中报的是相对起点的路径，整趟算扫完", async () => {
    const scan = await scanned();
    assert.equal(scan.complete, true);
    assert.deepEqual(
      scan.findings.map((finding) => finding.file),
      ["caller.ts"],
    );
    assert.equal(scan.quarantined, 0);
  });

  it("子项 lstat 抛 ⇒ 降级为未扫完（不是静默跳过）", async () => {
    const scan = await scanned({ lstatThrows: "lstat boom" });
    assert.equal(scan.complete, false, "一份都没探过，就不能说没有任何引用者");
    assert.deepEqual(scan.findings, []);
    assert.equal(scan.scanned, 0);
  });

  it("子项 lstat 报「探不到」⇒ 同样降级（条目刚消失也不等于看过了）", async () => {
    const scan = await scanned({ absentNames: ["caller.ts"] });
    assert.equal(scan.complete, false);
    assert.deepEqual(hitFiles(scan), []);
  });

  it("目录列不出来 ⇒ 降级但**不**整趟作废（一条断链不该废掉整个项目的预检）", async () => {
    const scan = await scanned({ listDirThrows: "cannot list: dangling entry" });
    assert.equal(scan.complete, false);
    assert.equal(scan.scanned, 0, "这层没展开，就是没读过任何文件");
  });

  it("文件读不动 ⇒ 降级", async () => {
    const scan = await scanned({ readThrows: "read boom" });
    assert.equal(scan.complete, false);
    assert.equal(scan.scanned, 1, "确实算作「读过一次」，只是没读到");
  });

  it("中途取消 ⇒ 整趟作废（回 undefined，既不注入也不记凭证）", async () => {
    const controller = new AbortController();
    const aborted = await scanReferences({
      targetN: target,
      root,
      needles: ["widget"],
      signal: controller.signal,
      fs: localFsFace({ abortAfterLstat: controller }),
    });
    assert.equal(aborted, undefined, "半份「已探过引用面」比不注入更糟");
  });

  it("根解析不了 ⇒ 抛给调用方（连起点都不在，「零命中」更是无根之言）", async () => {
    await assert.rejects(
      () => scanned({ resolveThrows: "resolve boom" }),
      /resolve boom/u,
      "根解析失败不静默降级，交给监听器留一条告警",
    );
  });

  it("超大文件与二进制按口径跳过，且不算未扫完", async () => {
    const bigFile = path.join(root, "huge.ts");
    const binFile = path.join(root, "blob.ts");
    const bigBody = `${"widget".padEnd(PREFLIGHT_MAX_BYTES + 400, "z")}\n`;
    const binBody = Buffer.concat([Buffer.from("widget\n"), Buffer.alloc(64, 0)]);
    await Promise.all([writeFile(bigFile, bigBody), writeFile(binFile, binBody)]);
    const scan = await scanned();
    assert.equal(scan.complete, true, "跳过 ≠ 没扫完：这两类按口径本来就不读");
    assert.deepEqual(hitFiles(scan), ["caller.ts"], "超大与二进制都不进命中");
    await Promise.all([rm(bigFile), rm(binFile)]);
  });

  it("软链子项不进队列（指向树外的链会把扫描面弹到整机）", async () => {
    const outside = path.join(tmpdir(), `dg-outside-${String(process.pid)}.ts`);
    const link = path.join(root, "via-link.ts");
    await writeFile(outside, 'import { widget } from "./src/target";\n');
    await symlink(outside, link);
    const scan = await scanned();
    assert.equal(
      hitFiles(scan).includes("via-link.ts"),
      false,
      "跟随软链等于让「项目级引用探查」去读目录树之外",
    );
    assert.equal(scan.complete, true, "按口径不看，就不算没扫完");
    await Promise.all([rm(link), rm(outside)]);
  });

  it("点开头目录与依赖目录都不展开", async () => {
    const hidden = path.join(root, ".hidden");
    const modules = path.join(root, "node_modules");
    const dependency = path.join(modules, "pkg");
    await Promise.all([mkdir(hidden, { recursive: true }), mkdir(dependency, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(hidden, "a.ts"), "widget here\n"),
      writeFile(path.join(dependency, "b.ts"), "widget here\n"),
    ]);
    const scan = await scanned();
    assert.deepEqual(
      hitFiles(scan),
      ["caller.ts"],
      "两类目录一个字都不进结果（node_modules 里同名命中只会误导）",
    );
    await Promise.all([
      rm(hidden, { recursive: true, force: true }),
      rm(modules, { recursive: true, force: true }),
    ]);
  });
});
