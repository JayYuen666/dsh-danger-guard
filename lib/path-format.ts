// lib/path-format.ts —— **路径格式的类型标注**（typesafe-path 思路的原生实现，零依赖）。
//
// 要解决的是一类已经真实发生过的缺陷：同一段代码里混用两种路径世界 ——
//   · **宿主真实路径**（`node:path` 的产物，由平台决定分隔符）
//   · **shell 命令文本里的路径**（永远是 POSIX 语义，因为 shell 源码就是那样写的）
// 这轮就因此出过事：`disasterTargetPathOf` 用 `path.posix.resolve` 处理宿主路径，
// 在 Windows 上把 `D:\w\proj` 拼成 `/a/.../D:\w\proj/build`；而 `sandbox-scope` 里
// 手拼 `${candidate}/` 做前缀比较，在 Windows 上恒假 —— 方向恰是**放行一次灾难删除**。
// 两种混用的共同点是：在 POSIX 上一切正常，只有到了 Windows 才炸。靠读代码抓不住。
//
// 做法照 `typesafe-path` 的 branded type（`string & { __brand }`）：
// 给每枚路径打上它属于哪个世界的标记，于是把一枚 POSIX 路径传给要宿主路径的函数
// 会**在 `tsc` 阶段**报错，不必等 CI 的 Windows runner。
//
// 它与运行期零成本：brand 只存在于类型层，`tsc` 一擦就没，产物里没有这一层。

// brand 构造器必然是类型断言（本模块存在的全部理由就是"给字符串打归属"），换任何写法
// 都只是把同一条断言挪个位置。断言的安全性由**调用点**承担（谁标 brand 谁为"这确实是
// 宿主路径"负责），不是这个模块能校验的。豁免按行挂在三枚构造器上，不整文件放开——
// 文件级的 disable 会连带屏蔽将来新增的、与 brand 无关的不安全断言。
declare const osPathBrand: unique symbol;
declare const posixPathBrand: unique symbol;
declare const win32PathBrand: unique symbol;

/** **宿主真实路径**：`node:path` 的产物，分隔符由平台决定（POSIX `/`、Windows `\`）。
 *  凡是"要去碰真实文件系统"或"要跟宿主给的路径做比较"的位置，都该收这一枚。 */
export type OsPath = string & { readonly [osPathBrand]: true };

/** **shell 文本里的 POSIX 路径**：`/etc`、`~/x` 这类，语义永远按 POSIX 读。
 *  命令判据（`lib/danger-rules.ts` 的词法层）收这一枚：那里的入参是**命令字符串**，
 *  不是宿主路径，两者混起来正是上面那两起事故的根源。 */
export type PosixPath = string & { readonly [posixPathBrand]: true };

/** **Windows 字形路径**：`C:\x`、`\\server\share` 这类，只在 Windows 轨道上产生。 */
export type Win32Path = string & { readonly [win32PathBrand]: true };

/**
 * 把一枚普通字符串标成**宿主路径**。
 *
 * 只在"这一枚确实是宿主路径"的地方调用：`path.resolve` / `path.join(平台)` /
 * `realpathSync` / 宿主服务交出的 `workspaceRoot` 等。它不是校验，是**声明**——
 * 调用者要为这个断言负责。
 *
 * @param value 宿主真实路径。
 * @returns 带 brand 的同一枚字符串（运行期完全不变）。
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- brand 构造器必然是断言，见文件头
export const asOsPath = (value: string): OsPath => value as OsPath;

/**
 * 把一枚普通字符串标成 **shell 文本里的 POSIX 路径**。
 *
 * @param value 命令文本里的 POSIX 路径词面。
 * @returns 带 brand 的同一枚字符串（运行期完全不变）。
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- brand 构造器必然是断言，见文件头
export const asPosixPath = (value: string): PosixPath => value as PosixPath;

/**
 * 把一枚普通字符串标成 **Windows 字形路径**。
 *
 * @param value Windows 写法（反斜杠或盘符形）。
 * @returns 带 brand 的同一枚字符串（运行期完全不变）。
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- brand 构造器必然是断言，见文件头
export const asWin32Path = (value: string): Win32Path => value as Win32Path;

/**
 * 去掉 brand，交回普通字符串（写进文案、上报、序列化时用）。
 *
 * brand 是**名义**类型，`OsPath` 本来就能当 `string` 用；这个函数存在的理由是让
 * "我确实要把它当普通串交出去"这件事在调用点是**显式**的，而不是隐式靠结构化子类型。
 *
 * @param value 任意带 brand 的路径。
 * @returns 同一枚字符串的普通类型视图。
 */
export const plainPath = (value: OsPath | PosixPath | Win32Path): string => value;

/**
 * 路径实现的形状：`node:path` 本身，或它的 `win32` / `posix` 分支。
 *
 * 为什么要有这一枚：路径规则由**平台**决定，而判据的正确性要按**两种规则各验一次**。
 * 把实现作为入参传进来，判据就不必假设"宿主是哪一种"——测试可以显式交 `path.win32`
 * 验证 Windows 语义，而不必去伪装整个运行环境（那既不可靠，也会让"`\` 是不是分隔符"
 * 这类前提混进被测逻辑里）。
 */
export type PathApi = Pick<
  typeof import("node:path"),
  "sep" | "join" | "dirname" | "basename" | "isAbsolute" | "normalize" | "relative" | "resolve"
>;
