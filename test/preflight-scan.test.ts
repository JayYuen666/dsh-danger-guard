// test/preflight-scan.test.ts —— 引用扫描器的**单元层**。
//
// 为什么补这一份：`lib/preflight-scan.ts` 是导出的（`scanReferences` / `renderRefsBlock` …），
// 但经 host 的预检接线测不到若干内部出口：接线那一层看不到分层遍历的"往上走"
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

import { PREFLIGHT_MAX_FILES, ancestorLevelsOf, scanReferences } from "../lib/preflight-scan.ts";
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
    // 远处兄弟层：比文件预算多出 44 个无命中文件（预算数值从实现导入，不在这里抄一份）。
    await mkdir(path.join(root, "bulk"), { recursive: true });
    await Promise.all(
      Array.from({ length: PREFLIGHT_MAX_FILES + 44 }, (_unused, index) =>
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
    assert.equal(
      view.scanned,
      PREFLIGHT_MAX_FILES,
      "预算按文件数上限用满（近邻先读，所以它没被饿死）",
    );
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
    const lstats: string[] = [];
    const face = localFsFace();
    const abortMidList: PreflightFs = {
      ...face,
      lstat: (childPath, opts, signal) => {
        const name = path.basename(childPath);
        lstats.push(name);
        // 第二枚子项才取消：钉的是「同层逐项查取消」，不是「第一枚就停」。
        if (name === "second.ts") {
          controller.abort();
        }
        return face.lstat(childPath, opts, signal);
      },
    };
    const scan = await scanReferences(requestOf(abortMidList, controller.signal));
    assert.ok(lstats.length >= 2, `取消前应已逐项 lstat（实际 ${String(lstats.length)} 次）`);
    assert.equal(lstats.at(-1), "second.ts", "取消落在第二枚子项上（首项之后、后续不再发）");
    assert.equal(scan, undefined, "信号中断 ⇒ 整趟作废（不是半份结果）");
  });

  it("列目录期间取消 ⇒ 该层不再逐项枚举", async () => {
    const controller = new AbortController();
    const base = localFsFace();
    const abortWhileListing: PreflightFs = {
      ...base,
      listDir: async (dirTarget) => {
        const entries = await base.listDir(dirTarget);
        controller.abort();
        return entries;
      },
    };
    const scan = await scanReferences(requestOf(abortWhileListing, controller.signal));
    assert.equal(scan, undefined, "信号中断 ⇒ 整趟作废");
  });

  it("目录列出失败 ⇒ 降级成不完整（一条断链不能让整个项目的预检从此失效）", async () => {
    // 夹具的 `listDirThrows` 是整层必抛的消息位，不能按路径注入；这里自带一层包装，
    // 只让 `src` 这一层失败，其余层照常列——否则「只断一条链」根本没有被验证。
    const base = localFsFace();
    const broken: PreflightFs = {
      ...base,
      listDir: async (dirTarget) => {
        if (path.basename(String(dirTarget.targetKey)) === "src") {
          throw new Error("src list boom");
        }
        return base.listDir(dirTarget);
      },
    };
    const { signal } = new AbortController();
    const scan = await scanReferences(requestOf(broken, signal));
    const view = viewOf(scan);
    assert.equal(view.complete, false, "列不出来只降级，不整趟抛掉");
    assert.deepEqual(view.hits, []);
    assert.ok(
      view.dirs.some((dir) => !dir.startsWith("src")),
      `其余层照常走（实际走过：${view.dirs.join(", ")}）`,
    );
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
    const root = path.resolve(path.parse(process.cwd()).root, "w", "proj");
    assert.deepEqual(ancestorLevelsOf(root, path.join(root, "src", "a", "b", "mod.ts")), [
      path.join(root, "src", "a", "b"),
      path.join(root, "src", "a"),
      path.join(root, "src"),
      root,
    ]);
  });

  it("目标就在 root 下 ⇒ 只有一层（目标所在目录**就是** root）", () => {
    const root = path.resolve(path.parse(process.cwd()).root, "w", "proj");
    assert.deepEqual(ancestorLevelsOf(root, path.join(root, "mod.ts")), [root]);
  });

  it("root 是文件系统根 ⇒ 前缀不拼成两个分隔符（否则整条链空掉）", () => {
    // 判据要平台无关：Windows 的文件系统根是 `C:\`、POSIX 是 `/`。写死 `/` 时这一条在
    // Windows 上测的就不是"根"，而是一个没有盘符的相对串。
    const { root } = path.parse(process.cwd());
    const under = path.join(root, "tmp", "mod.ts");
    assert.deepEqual(ancestorLevelsOf(root, under), [path.join(root, "tmp"), root]);
    // 上面那条里根是被**补**上去的（`<root>tmp` 往上一级收敛到根，循环在那里就退了）——
    // 少了那次补，根自身的文件与其余兄弟目录永远不会被走。
  });

  it("windows 形态的层级链：反斜杠路径逐级上溯，且盘符根收敛到自身", () => {
    // 这两条在 macOS 上也跑得起来：切分已改成**平台无关**的 `dirnameOf`（认两种分隔符、
    // 保留原形态），所以 Windows 串能在本地验证。修前用 `path.dirname` 时，这里对
    // `C:\...` 恒给出 `.`，层级链塌成 `[root]`。
    const bs = String.fromCodePoint(92);
    const root = `C:${bs}w${bs}proj`;
    assert.deepEqual(ancestorLevelsOf(root, `${root}${bs}deep${bs}mid${bs}m.ts`, path.win32), [
      `${root}${bs}deep${bs}mid`,
      `${root}${bs}deep`,
      root,
    ]);
    // 盘符根自身：上溯必须收敛到根，不能退化成空串（否则链空掉 ⇒ 扫描退化成平坦一趟）。
    // ⚠ 目标本身不入链（它是文件，链上是它所在的目录）——所以这里期望的就是 `[driveRoot]`。
    const driveRoot = `C:${bs}`;
    assert.deepEqual(ancestorLevelsOf(driveRoot, `${driveRoot}tmp`, path.win32), [driveRoot]);
  });

  it("目标就是 root 的直接子项时，上溯一步到 root 即停（不越过它）", () => {
    // 这一条钉的是"上行终止"：`dirnameOf(root)` 等于 root 自身，于是循环在 root 处 break。
    // 少了它，`levels` 会继续往上爬，把 root 之外的兄弟目录也纳入扫描预算。
    const projectRoot = path.resolve(path.parse(process.cwd()).root, "w", "proj");
    assert.deepEqual(ancestorLevelsOf(projectRoot, path.join(projectRoot, "a.ts")), [projectRoot]);
  });

  it("没有分隔符的目标与根级起点：上溯收敛，不退化成空链", () => {
    // ① 目标就是一个裸名（无分隔符）⇒ 它所在目录无从谈起，链只剩 root。
    // ② root 是文件系统根时，任何绝对目标都落在它之下 ⇒ 链必须非空（空链等于"没有一层要扫"）。
    const bs = String.fromCodePoint(92);
    // ⚠ 这里的入参是**纯字符串判据的输入**（`ancestorLevelsOf` 不碰文件系统），所以可以
    // 直接给任意形态；但为了不给"夹具写死 POSIX 路径"开先例，仍按平台根构造。
    const projectRoot = path.join(path.parse(process.cwd()).root, "w", "proj");
    assert.deepEqual(ancestorLevelsOf(projectRoot, "mod.ts"), [projectRoot]);
    assert.deepEqual(ancestorLevelsOf(`C:${bs}`, `C:${bs}a${bs}b.ts`, path.win32), [
      `C:${bs}a`,
      `C:${bs}`,
    ]);
  });

  it("目标**不在** root 之下 ⇒ 退回落成 `[root]`（那时『最近的祖先』无从谈起）", () => {
    const root = path.resolve(path.parse(process.cwd()).root, "w", "proj");
    const elsewhere = path.resolve(path.parse(process.cwd()).root, "elsewhere", "mod.ts");
    assert.deepEqual(ancestorLevelsOf(root, elsewhere), [root]);
  });
});
