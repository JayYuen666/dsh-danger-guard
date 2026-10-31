// test/path-format.test.ts —— brand 的类型层契约与运行期零成本。
//
// 这个文件盯的是三件在**编译期**成立的事（下面用 `@ts-expect-error` 钉住）+ 一件在
// **运行期**成立的事（brand 不改变字符串本身）。
//
// 为什么值得单列：这轮的真实事故（`path.posix.resolve` 处理宿主路径、手拼 `${x}/` 做前缀
// 比较）在 POSIX 上一切正常、只在 Windows 上炸，靠读代码与测试都抓不住。brand 把
// "路径属于哪个世界"变成编译期约束。
// 生产面现在只接了 `OsPath`（sandbox-scope / disaster-target / effective-disposition）；
// `PosixPath` / `Win32Path` 尚无生产消费方，本文件钉的是它们作为**将来约束**的类型语义。
// 真要把词法层接上时，改这里是下一位读者该看的入口。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { asOsPath, asPosixPath, asWin32Path, plainPath } from "../lib/path-format.ts";
import type { OsPath, PosixPath, Win32Path } from "../lib/path-format.ts";

/** 一个只收宿主路径的判据（模拟 `sandboxDropsOf` / `disasterTargetPathOf` 那一类）。 */
const wantsOsPath = (value: OsPath): string => value;

/** 一个只收 shell 词面路径的判据（模拟 `lib/danger-rules.ts` 的词法层）。 */
const wantsPosixPath = (value: PosixPath): string => value;

/** 一个只收 Windows 字形路径的判据。 */
const wantsWin32Path = (value: Win32Path): string => value;

describe("brand：类型层禁止跨世界混用", () => {
  it("同世界的路径可以直传", () => {
    assert.equal(wantsOsPath(asOsPath(String.raw`C:\w\proj`)), String.raw`C:\w\proj`);
    assert.equal(wantsPosixPath(asPosixPath("/etc")), "/etc");
    assert.equal(wantsWin32Path(asWin32Path(String.raw`C:\Windows`)), String.raw`C:\Windows`);
  });

  it("把 shell 词面路径喂给宿主判据 ⇒ 编译期红（这轮事故的形态）", () => {
    const shellWord = asPosixPath("/etc");
    // @ts-expect-error PosixPath 不可当 OsPath：`/etc` 是命令文本里的词面，不是宿主路径
    const attempt = (): string => wantsOsPath(shellWord);
    assert.equal(typeof attempt, "function", "这一行只为让 ts-expect-error 有落点");
  });

  it("把宿主路径喂给 shell 词法层 ⇒ 编译期红（反方向的同一类错）", () => {
    const realPath = asOsPath(String.raw`D:\w\proj`);
    // @ts-expect-error OsPath 不可当 PosixPath：宿主分隔符在 Windows 上是 `\`
    const attempt = (): string => wantsPosixPath(realPath);
    assert.equal(typeof attempt, "function", "同上");
  });

  it("win32 字形与 POSIX 词面也不互通", () => {
    const windowsShape = asWin32Path(String.raw`C:\Windows`);
    // @ts-expect-error Win32Path 不可当 PosixPath：`C:\Windows` 的语义只在 Windows 读法里
    const attempt = (): string => wantsPosixPath(windowsShape);
    assert.equal(typeof attempt, "function", "同上");
  });

  it("跨世界矩阵的其余方向与裸 string 都被类型层挡住", () => {
    const posix = asPosixPath("/etc");
    const win = asWin32Path(String.raw`C:\Windows`);
    const os = asOsPath("/w/proj");
    // @ts-expect-error PosixPath 不可当 Win32Path
    const posixToWin = (): string => wantsWin32Path(posix);
    // @ts-expect-error Win32Path 不可当 OsPath
    const winToOs = (): string => wantsOsPath(win);
    // @ts-expect-error OsPath 不可当 Win32Path
    const osToWin = (): string => wantsWin32Path(os);
    const bare = "/tmp";
    // @ts-expect-error 裸 string 不能直接进 brand 形参
    const bareToOs = (): string => wantsOsPath(bare);
    assert.equal(
      [posixToWin, winToOs, osToWin, bareToOs].every((fn) => typeof fn === "function"),
      true,
      "四条负向断言只为让 ts-expect-error 有落点",
    );
  });
});

describe("brand：运行期零成本", () => {
  it("三枚构造器都原样返回同一串（brand 只在类型层）", () => {
    assert.equal(asOsPath("/a/b"), "/a/b");
    assert.equal(asPosixPath("/a/b"), "/a/b");
    assert.equal(asWin32Path(String.raw`C:\a`), String.raw`C:\a`);
  });

  it("`plainPath` 交回普通字符串视图，可参与字符串运算", () => {
    const real = asOsPath("/w/proj/src/a.ts");
    assert.equal(plainPath(real).length, real.length);
    assert.equal(plainPath(real).endsWith("a.ts"), true);
    assert.equal(plainPath(asPosixPath("~")), "~");
    assert.equal(plainPath(asWin32Path("C:")), "C:");
  });

  it("brand 不改变值：同一串标与不标逐字相等", () => {
    const raw = "/w/proj";
    assert.equal(asOsPath(raw), raw);
    assert.equal(asPosixPath(raw), raw);
  });
});
