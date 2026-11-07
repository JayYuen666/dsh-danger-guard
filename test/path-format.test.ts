// test/path-format.test.ts —— brand 的类型层契约与运行期零成本。
//
// 这个文件盯的是三件在**编译期**成立的事（下面用 `@ts-expect-error` 钉住）+ 一件在
// **运行期**成立的事（brand 不改变字符串本身）。
//
// 为什么值得单列：这轮的真实事故（`path.posix.resolve` 处理宿主路径、手拼 `${x}/` 做前缀
// 比较）在 POSIX 上一切正常、只在 Windows 上炸，靠读代码与测试都抓不住。brand 把
// "路径属于哪个世界"变成编译期约束。
// 生产代码现在只接了 `OsPath`（sandbox-scope / disaster-target / effective-disposition）；
// `PosixPath` / `Win32Path` 尚无生产消费方，本文件钉的是它们作为**将来约束**的类型语义。
// 真要把词法层接上时，改这里是下一位读者该看的入口。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { asOsPath, asPosixPath, asWin32Path, plainPath } from "../lib/path-format.ts";
import type { OsPath, PosixPath, Win32Path } from "../lib/path-format.ts";

/** 一个只收宿主路径的判据（模拟 `sandboxDropsOf` / `disasterTargetPathOf` 那一类）。 */
const wantsOsPath = (value: OsPath): string => value;

/** 一个只收 shell 用词路径的判据（模拟 `lib/danger-rules.ts` 的词法层）。 */
const wantsPosixPath = (value: PosixPath): string => value;

/** 一个只收 Windows 字形路径的判据。 */
const wantsWin32Path = (value: Win32Path): string => value;

describe("brand：类型层禁止跨世界混用", () => {
  it("同世界的路径可以直传", () => {
    assert.equal(wantsOsPath(asOsPath(String.raw`C:\w\proj`)), String.raw`C:\w\proj`);
    assert.equal(wantsPosixPath(asPosixPath("/etc")), "/etc");
    assert.equal(wantsWin32Path(asWin32Path(String.raw`C:\Windows`)), String.raw`C:\Windows`);
  });

  it("把 shell 用词路径喂给宿主判据⇒ 编译期红（这轮事故的形态）", () => {
    const shellWord = asPosixPath("/etc");
    // @ts-expect-error PosixPath 不可当 OsPath：`/etc` 是命令文本里的用词，不是宿主路径
    const attempt = (): string => wantsOsPath(shellWord);
    // 断言的是**调用结果**，不是「箭头函数是不是个函数」：后者永远成立，什么也钉不住。
    // 这一行同时钉住 brand 的运行期零成本——红只可能来自上面那行类型判据。
    assert.equal(attempt(), "/etc");
  });

  it("把宿主路径喂给 shell 词法层 ⇒ 编译期红（反方向的同一类错）", () => {
    const realPath = asOsPath(String.raw`D:\w\proj`);
    // @ts-expect-error OsPath 不可当 PosixPath：宿主分隔符在 Windows 上是 `\`
    const attempt = (): string => wantsPosixPath(realPath);
    assert.equal(attempt(), String.raw`D:\w\proj`);
  });

  it("win32 字形与 POSIX 用词也不互通", () => {
    const windowsShape = asWin32Path(String.raw`C:\Windows`);
    // @ts-expect-error Win32Path 不可当 PosixPath：`C:\Windows` 的语义只在 Windows 读法里
    const attempt = (): string => wantsPosixPath(windowsShape);
    assert.equal(attempt(), String.raw`C:\Windows`);
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
    // 断言落在**调用结果**上：brand 在运行期是零成本，四条负向判据的红只该来自上面那四行。
    // （原写法断言 `typeof fn === "function"`，箭头函数永远成立是函数，这一句钉不住任何东西。）
    assert.deepEqual(
      [posixToWin(), winToOs(), osToWin(), bareToOs()],
      ["/etc", String.raw`C:\Windows`, "/w/proj", "/tmp"],
    );
  });
});

describe("brand：运行期零成本", () => {
  it("三枚构造器都原样返回同一串（brand 只在类型层）", () => {
    assert.equal(asOsPath("/a/b"), "/a/b");
    assert.equal(asPosixPath("/a/b"), "/a/b");
    assert.equal(asWin32Path(String.raw`C:\a`), String.raw`C:\a`);
  });

  it("`plainPath` 交回的就是那一枚普通字符串视图", () => {
    // 三个 world 一律逐字比。原先 OsPath 这一支只比 `length` 与 `endsWith`：一次等长而内容不同
    // 的变换（大小写或分隔符归一）照样过关，而 Posix / Win32 两支比的是整串——同一件事不该两套判据。
    const real = asOsPath("/w/proj/src/a.ts");
    assert.equal(plainPath(real), "/w/proj/src/a.ts");
    assert.equal(plainPath(asPosixPath("~")), "~");
    assert.equal(plainPath(asWin32Path("C:")), "C:");
  });

  it("brand 不改变值：同一串标与不标逐字相等", () => {
    const raw = "/w/proj";
    assert.equal(asOsPath(raw), raw);
    assert.equal(asPosixPath(raw), raw);
  });
});
