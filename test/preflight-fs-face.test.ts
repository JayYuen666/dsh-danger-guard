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
//  - **不展开**：软链、点开头目录、依赖/产物目录 ⇒ 跳过而**不**降级（按口径就不看）；
//  - **走到了但没读**：超大文件、二进制 ⇒ 进 `unread` / `unreadNotQuarantined`，
//    零命中结论要降级成「已扫范围内」（它们不是"按口径不看"，是"这份正文没看"）。
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MESSAGES } from "../lib/messages.ts";
import {
  PREFLIGHT_MAX_BYTES,
  PREFLIGHT_MAX_FILES,
  renderRefsBlock,
  scanReferences,
} from "../lib/preflight-scan.ts";
import type { RefScan } from "../lib/preflight-scan.ts";
import { localFsFace } from "./fixtures/local-fs-face.ts";
import type { LocalFsFailures } from "./fixtures/local-fs-face.ts";

/** 一次临时"项目"的根与目标（每个用例各建一份，afterEach 删；用例断言失败时残留
 *  不会进入下一个用例）。 */
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
  beforeEach(async () => {
    root = "";
    target = "";
    root = await mkdtemp(path.join(tmpdir(), "dg-fs-face-"));
    target = path.join(root, "src", "target.ts");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "export const widget = 1;\n");
    await writeFile(path.join(root, "caller.ts"), 'import { widget } from "./src/target";\n');
  });

  afterEach(async () => {
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
      root = "";
      target = "";
    }
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

  it("文件读不动 ⇒ 降级，且不计入「读过」", async () => {
    const scan = await scanned({ readThrows: "read boom" });
    assert.equal(scan.complete, false);
    // `scanned` 的契约是「真实读到正文的文件数」：读不动只证明走到了这一枚，
    // 不能据此声称探过它的内容；它由 `unreadNotQuarantined` 记账。
    assert.equal(scan.scanned, 0, "没读到正文就不能算进读过");
    assert.equal(scan.unreadNotQuarantined.length, 1);
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
    // 但它们是「走到了没读」：必须进 unreadNotQuarantined，零命中结论才会降级。
    assert.ok(
      scan.unreadNotQuarantined.some((entryPath) => entryPath.endsWith("huge.ts")),
      "超大文件必须记进 unreadNotQuarantined",
    );
    assert.ok(
      scan.unreadNotQuarantined.some((entryPath) => entryPath.endsWith("blob.ts")),
      "二进制文件同样必须记进 unreadNotQuarantined",
    );
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
    assert.deepEqual(hitFiles(scan), ["caller.ts"], "同层普通文件照常命中：排除的只是软链");
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

  it("隔离文件也吃文件预算：不走预算检查的那一支能无限长大", async () => {
    // 隔离与超大/读不动一样都不消耗 `scanned`。预算若挂在 `scanned` 上，这一支就在
    // 预算检查**之前** return，命中隔离词表的文件可以任意多，`unread` 跟着无界增长——
    // 而 `unread` 每次 push 都带一条相对路径字符串，实测 400 个就长了 400 条。
    const secrets = path.join(root, "secrets");
    await mkdir(secrets, { recursive: true });
    // 逐个写：预算量级（约 300）的无界并发在 macOS 默认 ulimit 下可能撞 EMFILE。
    for (let index = 0; index < PREFLIGHT_MAX_FILES + 40; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- 顺序写是刻意的：控制同时打开的文件数
      await writeFile(path.join(secrets, `k${String(index)}.env`), "widget\n");
    }
    const scan = await scanReferences({
      targetN: target,
      root,
      needles: ["widget"],
      signal: new AbortController().signal,
      fs: localFsFace(),
      isQuarantined: (candidate: string) => candidate.startsWith(secrets),
    });
    assert.ok(scan !== undefined, "这一趟该跑成");
    assert.equal(scan.complete, false, "预算用尽就是没扫完，不能报「扫完了」");
    assert.ok(scan.quarantined > 0, "隔离分支确实生效（否则预算耗尽也能伪装成这条结论）");
    assert.deepEqual(hitFiles(scan), ["caller.ts"], "隔离文件不进命中");
    assert.ok(
      scan.unread.length <= PREFLIGHT_MAX_FILES,
      `unread 不得超过文件预算（实测 ${String(scan.unread.length)} 条，上限 ${String(PREFLIGHT_MAX_FILES)}）`,
    );
    await rm(secrets, { recursive: true, force: true });
  });

  it("走到了但没读到的那几份也让零命中降级（隔离与超限是两件事）", async () => {
    // `complete` 只说明遍历没被预算截断，说明不了「这一层的正文都看过了」。
    // 超大文件按口径跳过、不进 `quarantined`，但它完全可能写着引用——那一句
    // 「即目标没有任何引用者」在这一态下是假话，模型会据此删掉仍有引用者的文件。
    const huge = path.join(root, "huge-only.ts");
    await writeFile(huge, "x".repeat(PREFLIGHT_MAX_BYTES + 10));
    const cleanTarget = path.join(root, "src", "lonely.ts");
    await writeFile(cleanTarget, "export const lonely = 1;\n");
    // 用一枚整棵树里都不存在的词：这一支要的是**零命中**，而夹具根里已有
    // `caller.ts` 引用着 `widget`——拿它当搜索词会走进"有命中"那一支，测不到这里。
    const scan = await scanReferences({
      targetN: cleanTarget,
      root,
      needles: ["zzznotpresent"],
      signal: new AbortController().signal,
      fs: localFsFace(),
    });
    assert.ok(scan !== undefined, "这一趟该跑成");
    assert.equal(scan.complete, true, "跳过超大文件不算「没扫完」");
    assert.equal(scan.quarantined, 0, "它不是凭据面文件，别记到隔离那一档去");
    assert.deepEqual(scan.unreadNotQuarantined, ["huge-only.ts"], "但它确实没被读到");
    const rendered = renderRefsBlock(MESSAGES.zh, scan);
    assert.equal(
      rendered.includes("即目标没有任何引用者"),
      false,
      "有没读到的文件时不能说全称结论",
    );
    assert.ok(rendered.includes("没能读正文"), `文案要点名「没读到」这一类：${rendered}`);
    await rm(huge);
  });
});
