// test/preflight-scan.test.ts —— 引用扫描器的**单元层**。
//
// 为什么补这一份：`lib/preflight-scan.ts` 是导出的（`scanReferences` / `renderRefsBlock` …），
// 但此前**只经 host 的预检接线被测**——而接线那一层看不到若干内部出口：分层遍历的"往上走"
// 终止条件、"某一层起点解析不出来"、"同层多个子项时逐项查取消"。那些出口在集成层要么
// 需要精心构造的目录形状，要么根本走不到（实测：一层只有一个文件时，逐项检查的第二次
// 永远不会发生，于是那处守卫成了死代码而覆盖率门只是把它算进去）。
//
// 这一份用**真临时目录 + 真本地 fs 面**（`test/fixtures/local-fs-face.ts`）直接调扫描器：
// 目录形状由用例自己摆，断言只看扫描结果，不经过任何别的插件代码。
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ancestorLevelsOf, scanReferences } from "../lib/preflight-scan.ts";
import type { PreflightFs, RefScan, ScanRequest } from "../lib/preflight-scan.ts";
import { localFsFace } from "./fixtures/local-fs-face.ts";

/** 一次扫描的**可判据视图**：把"整趟作废（`undefined`）"与"结果里的各位"收成一处，
 *  于是断言里全是普通取值，不必每行写一次可选链。 */
interface ScanView {
  readonly hits: readonly string[];
  readonly complete: boolean | undefined;
  readonly scanned: number | undefined;
  readonly dirs: readonly string[];
}

const viewOf = (scan: RefScan | undefined): ScanView => ({
  hits: (scan?.findings ?? []).map((finding) => finding.file),
  complete: scan?.complete,
  scanned: scan?.scanned,
  dirs: scan?.dirs ?? [],
});

describe("引用扫描器：分层遍历（近邻优先）", () => {
  let root: string;
  let target: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dg-scan-layer-"));
    // 远处兄弟层：300 个无命中文件，足以吃光 256 的文件预算。
    await mkdir(path.join(root, "bulk"), { recursive: true });
    await Promise.all(
      Array.from({ length: 300 }, (_unused, index) =>
        writeFile(path.join(root, "bulk", `f${index}.txt`), "no needle here\n"),
      ),
    );
    // 目标在两层深处，**引用者就在它同级**（正是要证明"预算先买到近邻"）。
    const dir = path.join(root, "deep", "mid");
    await mkdir(path.join(dir, "test"), { recursive: true });
    target = path.join(dir, "layermod.ts");
    await writeFile(target, "export const layered = 1;\n");
    await writeFile(path.join(dir, "test", "layermod.test.ts"), 'import "../layermod";\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("近邻的引用者被读到；遍历仍被远处那 300 个文件截断（截断发生在远处）", async () => {
    const scan = await scanReferences({
      targetN: target,
      root,
      needles: ["layermod"],
      signal: new AbortController().signal,
      fs: localFsFace(),
    });
    assert.equal(scan === undefined, false, "这一趟跑成了");
    const view = viewOf(scan);
    assert.deepEqual(view.hits, ["deep/mid/test/layermod.test.ts"]);
    assert.equal(view.complete, false, "远处那 300 个文件读不完 ⇒ 遍历确实被截断");
    assert.equal(view.scanned, 256, "预算按文件数上限用满（近邻先读，所以它没被饿死）");
  });

  it("目标**不在** root 之下 ⇒ 退回从 root 扫一遍（层级链为空那条出口）", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "dg-scan-outside-"));
    try {
      await writeFile(path.join(outside, "away.ts"), "export const away = 1;\n");
      await writeFile(path.join(root, "away.ts"), "import './elsewhere';\n");
      const scan = await scanReferences({
        targetN: path.join(outside, "away.ts"),
        root,
        needles: ["away"],
        signal: new AbortController().signal,
        fs: localFsFace(),
      });
      // root 之下没有指向它的引用者 ⇒ 零命中（这条只钉"链为空时也照样扫，且 root 被走过"）。
      const view = viewOf(scan);
      assert.deepEqual(view.hits, []);
      assert.ok(view.dirs.includes(""), "root 自身必须被走过（起点那一层）");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("引用扫描器：三条保守出口", () => {
  let root: string;
  let target: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dg-scan-outlet-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    target = path.join(root, "src", "outletmod.ts");
    await writeFile(target, "export const outlet = 1;\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 一条会调扫描器的请求（`fs` 由各用例给）。 */
  const requestOf = (fs: PreflightFs, signal: AbortSignal): ScanRequest => ({
    targetN: target,
    root,
    needles: ["outletmod"],
    signal,
    fs,
  });

  it("某一层起点解析不出来 ⇒ `capped` 置位（遍历不算完整），而不是静默当它不存在", async () => {
    // ⚠ 夹具的 `resolveThrows` 是枚**开关**（一设全抛），而 `resolve(root)` 抛错走的是
    // "整趟作废"那一支（`scanReferences` 刻意不接它，见函数注释）。这一条要钉的是**层起点**
    // 那一支，所以自己包一层：只对目标所在目录抛。
    const face = localFsFace();
    const levelUnreachable: PreflightFs = {
      ...face,
      resolve: (targetPath: string, opts?: { cwd?: string; signal?: AbortSignal }) =>
        targetPath === path.dirname(target)
          ? Promise.reject(new Error("level unreachable"))
          : face.resolve(targetPath, opts),
    };
    const { signal } = new AbortController();
    const scan = await scanReferences(requestOf(levelUnreachable, signal));
    const view = viewOf(scan);
    assert.equal(view.complete, false, "子树没走完就不能算完整");
    assert.equal(view.scanned, 0, "整层的子树都没进 ⇒ 一个文件都没读");
  });

  it("**同层多个子项**时逐项查取消：第一项之后取消 ⇒ 第二项不被 lstat（那处守卫的兑现）", async () => {
    // 一层只有一个文件时，逐项检查的第二次永远不会发生 —— 那处守卫会变成死代码。
    // 所以这里刻意摆**两个**文件，让取消落在"第一项读完之后、第二项开始之前"。
    await writeFile(path.join(root, "src", "second.ts"), "no needle\n");
    const controller = new AbortController();
    let lstats = 0;
    const face = localFsFace();
    const abortMidList: PreflightFs = {
      ...face,
      lstat: (childPath, opts, signal) => {
        lstats += 1;
        // 第一次 lstat 之后取消：下一项进循环时就会撞上守卫。
        if (lstats === 1) {
          controller.abort();
        }
        return face.lstat(childPath, opts, signal);
      },
    };
    const scan = await scanReferences(requestOf(abortMidList, controller.signal));
    assert.equal(lstats, 1, "取消之后同层其余子项一枚 lstat 都不该发");
    assert.equal(scan, undefined, "信号中断 ⇒ 整趟作废（不是半份结果）");
  });

  it("目录列出失败 ⇒ 降级成不完整（一条断链不能让整个项目的预检从此失效）", async () => {
    const broken = localFsFace({ listDirThrows: path.join(root, "src") });
    const { signal } = new AbortController();
    const scan = await scanReferences(requestOf(broken, signal));
    const view = viewOf(scan);
    assert.equal(view.complete, false, "列不出来只降级，不整趟抛掉");
    assert.deepEqual(view.hits, []);
  });
});

describe("引用扫描器：层覆盖位（`dirs`）如实记录走没走到", () => {
  it("走过的目录按**相对起点**交回，起点自身是空串", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dg-scan-dirs-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await mkdir(path.join(root, "src", "nested"), { recursive: true });
      const target = path.join(root, "src", "dirmod.ts");
      await writeFile(target, "export const dirmod = 1;\n");
      const scan = await scanReferences({
        targetN: target,
        root,
        needles: ["dirmod"],
        signal: new AbortController().signal,
        fs: localFsFace(),
      });
      assert.deepEqual(
        [...viewOf(scan).dirs].toSorted(),
        ["", "src", "src/nested"],
        "层探查结论要靠它判覆盖：少一个都可能把『没走到』说成『零命中』",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("引用扫描器：祖先层级链（纯字符串函数，导出只为可测）", () => {
  it("自下而上：目标所在目录打头，root 收尾", () => {
    assert.deepEqual(ancestorLevelsOf("/w/proj", "/w/proj/src/a/b/mod.ts"), [
      "/w/proj/src/a/b",
      "/w/proj/src/a",
      "/w/proj/src",
      "/w/proj",
    ]);
  });

  it("目标就在 root 下 ⇒ 只有一层（目标所在目录**就是** root）", () => {
    assert.deepEqual(ancestorLevelsOf("/w/proj", "/w/proj/mod.ts"), ["/w/proj"]);
  });

  it("root 是文件系统根 ⇒ 前缀不拼成 `//`（否则整条链空掉）", () => {
    // 只有"目标直接在 `/` 下"才走得到：`\`${root}/\`` 对 `root = "/"` 得到 `"//"`，
    // 而 `"/tmp".startsWith("//")` 恒假 —— 少了这条归一，链会空成 `[root]`。
    assert.deepEqual(ancestorLevelsOf("/", "/tmp/mod.ts"), ["/tmp", "/"]);
    // 上面那条里 `"/"` 是被**补**上去的（`/tmp` 往上一级是空串，循环在那里就退了）——
    // 少了那次补，`/` 自己的文件与其余兄弟目录永远不会被走。
  });

  it("目标**不在** root 之下 ⇒ 退回落成 `[root]`（那时『最近的祖先』无从谈起）", () => {
    assert.deepEqual(ancestorLevelsOf("/w/proj", "/elsewhere/mod.ts"), ["/w/proj"]);
  });
});
