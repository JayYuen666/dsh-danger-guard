// lib/target-paths.ts —— 目标路径的两种"不是模型字面量"的形：**归一形**与**官方真实路径形**。
//
// 为什么单列一枚模块：这两种形的写口与读口分属两个世界——写口在 async 的一侧（预检 B 面、
// `fs/observed` 监听器），读口在**同步**的 `tools.guard` 谓词里。官方那条真实路径通道
// （`ctx.fs.resolve` → `processPath`）是 async 的，"拦截那一刻"没法 await，所以只能由 async
// 的一侧先记下来、同步的一侧现读。键形必须逐字同源，而"逐字同源"这件事没法靠类型保证
// （少一次 `path.resolve` 不会编译报错，只会让官方那一形永远读不到），于是收进这一枚模块。
//
// ⚠ 本模块不 import `node:fs`：本机 `realpathSync` 那一形由 host.ts 注入（它是同步谓词当场
// 唯一付得起的解析），两形在本模块的 `resolvedFormsOf` 里合成清单交给判定——
// **并列，从不互相替换**，所以官方那一形缺席或陈旧只会少拦不会多放。
import path from "node:path";

import type { FsTarget } from "@deepseek-ai/dsh-fs";

import { lruPut } from "./lru.ts";
import type { PreflightFs } from "./preflight-scan.ts";

/** 路径归一化：相对路径按会话 cwd 解析（模型常报相对路径），绝对路径也折成规范形。
 *  cwd 缺席时的**相对**路径原样交回——那时 `process.cwd()` 是插件进程的目录，与工具的
 *  执行世界无关，拿它归一是猜。
 *
 *  绝对形为什么也要折：这份形同时是 `officialPaths` 的**键**。`/w/./.ssh/id_rsa`、
 *  `/w/x/../.ssh/id_rsa`、`/w/.ssh/id_rsa/` 与 `/w/.ssh/id_rsa` 是同一枚文件，不归一就
 *  各占一格——官方通道按其中一种写法记下真实路径，换一种写法来判时缓存 miss，于是这一
 *  形缺席、待判形态少一枚。归一之后四种写法落进同一格。 */
export const resolveTarget = (value: string, cwd: string | undefined): string => {
  if (value.length === 0) {
    return value;
  }
  if (path.isAbsolute(value)) {
    // 绝对路径的解析与 cwd 无关，这里借 `path.resolve` 只为折掉 `.`/`..` 与尾分隔符。
    return path.resolve(value);
  }
  // 空串与缺席同视：`path.resolve("", v)` 会落到插件进程自己的 cwd，那与工具的执行世界无关。
  return cwd === undefined || cwd.length === 0 ? value : path.resolve(cwd, value);
};

/** **官方通道**交出的目标真实路径（`归一后的目标 → 该执行世界里的绝对路径`）。
 *  两处写、一处读：
 *   - `fs/observed`（后端每观察一枚目标就报一次，`FsTarget` 是它自己的解析结果 ⇒ 零额外 I/O）；
 *   - 预检 B 面（async 的一站：`fs.resolve` + `fs.processPath`，写在密钥面让路判定之前，
 *     于是**同一次调用**随后同步跑的 guard 就吃得到）。
 *  读口是同步的（本模块的 `resolvedFormsOf`）——`tools.guard` 是同步谓词而官方 `resolve`
 *  是 async，miss 就只剩本机 `realpathSync` 那一形（照旧并列参与）。
 *  陈旧只是**多一形**（判定取并集）：软链被重新指向后旧值仍在，最坏是多拦一次；漏拦的方向
 *  只可能来自"少一形"，而这一枚不减少任何形。 */
const officialPaths = new Map<string, string>();

/** 这张表的容量，单独给而不共用 `LEDGER_CAP`：它的写入由**外部事件**决定——`fs/observed`
 *  对会话碰到的每一枚文件都发一次，200 条在大会话里会被冲成一件摆设（而写类调用那一侧
 *  本来有 Layer 2 兜着，这张表的价值恰恰在"上一次调用碰过的路径这次被改"）。
 *  放大到 1000 的代价是定长的：一条 = 两枚路径串，最坏几百 KB，且仍由 LRU 硬界住。 */
const OFFICIAL_PATH_CAP = 1000;

/** 官方那一形的键（写读两侧共用 `resolveTarget` 的绝对形）。收成一枚构造不是因为短：
 *  写侧与读侧各写一遍归一时，少一个 `path.resolve` 都不会编译报错，只会让这一形永远读不到
 *  ——与本包其余几枚键形同一条教训。 */
export const officialPathKeyOf = (target: string, cwd: string | undefined): string =>
  resolveTarget(target, cwd);

/** 同步读口：这一枚目标有没有官方那一形（`undefined` = 没到手，判定退回另两形）。 */
export const officialPathOf = (target: string, cwd: string | undefined): string | undefined =>
  officialPaths.get(officialPathKeyOf(target, cwd));

/** 记下官方通道交出的一形。`undefined` = 这一形没到手（解析失败 / 后端拒绝），不记空值：
 *  键在而值空会让读侧以为"官方说这枚目标没有真实路径"，那是一句它从没说过的话。 */
export function rememberOfficialPath(
  target: string,
  cwd: string | undefined,
  real: string | undefined,
): void {
  // 空串同样是"没到手"：记下去会让读侧以为官方给出了一枚空路径，并把它塞进待判并集。
  if (real !== undefined && real.length > 0) {
    lruPut(officialPaths, officialPathKeyOf(target, cwd), real, OFFICIAL_PATH_CAP);
  }
}

/** `fs.processPath` 的"给不出就没有这一形"包装：官方那一面是同步的，但后端可以拒绝
 *  （远端/沙箱面本就未必能交出进程路径），拒绝只表示少一形，不是放行。 */
function processPathOf(fs: PreflightFs, target: FsTarget): string | undefined {
  let real: string | undefined;
  try {
    real = fs.processPath(target);
  } catch {
    real = undefined;
  }
  return real;
}

/** 后端自己报的一次观察（`fs/observed`）⇒ 顺手记下它的官方真实路径，零额外 I/O。
 *  ⚠ 这是 **emit** 模式的事件，官方明说监听器必须同步、**抛错会让那次工具调用失败**
 *  （dsh-fs 的 `fs/observed` 注释："throws fail the tool call"）——本包绝不能成为别人
 *  写盘失败的原因，所以整趟包在 try 里：载荷不像官方 `FsTarget` 时什么都不记就是了，
 *  少一形从来不是放行。（`processPathOf` 自己那道 try 服务的是 async 那一侧：那里抛出去
 *  会让整趟预检退化成"没有证据"，而不只是"少一形"。）
 *  只记**绝对**的 `displayPath`：相对形与远端 URI 没有 cwd 就归一不了，而键形必须与读侧
 *  逐字同源（见 officialPaths 的注释），猜一种归一等于造一枚永远读不到的键。 */
export function rememberObservedPath(fs: PreflightFs | undefined, target: FsTarget): void {
  try {
    if (fs !== undefined && path.isAbsolute(target.displayPath)) {
      rememberOfficialPath(target.displayPath, undefined, processPathOf(fs, target));
    }
  } catch {
    // 见上：这里抛出去，代价是别人那次工具调用失败。
  }
}

/** 问一次官方通道：`resolve` 定身份（按后端口径归一、跟软链）。任何失败（目标不存在 /
 *  越界被拒 / 后端 IO / 取消）都塌成 undefined——与本机那一形同一个口径：缺席一形只是少看到
 *  一面，声明形与本机形照判。
 *  ⚠ 交回的是**已 resolve 的 target**而不是一个字符串：同一次调用随后还要读正文、探版本，
 *  本地后端下那是几个 syscall，而远端/沙箱后端下是**几次往返**——一枚目标只问一次是这个
 *  函数存在的理由（`PreflightFs` 那边因此都收可选的 pre-resolved target）。 */
export async function officialTargetOf(
  fs: PreflightFs,
  target: string,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<FsTarget | undefined> {
  let resolved: FsTarget | undefined;
  try {
    // 条件展开而不是 `{ cwd, signal }`：官方那一位是 `cwd?: string`，而本包的读法面允许
    // "会话目录不可得"（undefined）——`exactOptionalPropertyTypes` 下送 undefined 是类型错，
    // 语义上也不该送：缺席时让后端按它自己的默认基准归一，比替它猜一个目录诚实。
    resolved = await fs.resolve(target, { ...(cwd === undefined ? {} : { cwd }), signal });
  } catch {
    resolved = undefined;
  }
  return resolved;
}

/** 一次调用最多向官方通道问多少枚目标。声明目标来自模型可写的参数，条数没有上界；
 *  逐枚并发时整批会同时打到后端（远端/沙箱面每枚是一次往返）。超出上限的部分按"官方
 *  那一形缺席"处理——它仍会走本机形与声明形，只是不额外挣这一形。 */
const MAX_OFFICIAL_RESOLVE_TARGETS = 64;

/** 把这一次调用声明的每枚目标问一遍官方通道：真实路径记进缓存，同时把**已 resolve 的
 *  target** 按声明形交回调用方复用（预检随后读正文、探版本都吃这一枚，不再各付一次往返）。
 *  逐枚**并发**而不是串行 await：常规调用的声明目标是个位数，而每枚 resolve 在远端后端上
 *  可能是一次往返——串行会把那 3 秒墙钟吃光，反而让唯一挣得到手的一形也赔进去。
 *  解析不成的那枚**不进**表（调用方据此回落到自己 resolve 的旧路径，行为与改造前逐字一致）。 */
export async function rememberOfficialTargetsOf(
  fs: PreflightFs,
  targets: readonly string[],
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, FsTarget>> {
  const resolvedByTarget = new Map<string, FsTarget>();
  await Promise.all(
    targets.slice(0, MAX_OFFICIAL_RESOLVE_TARGETS).map(async (target) => {
      const resolved = await officialTargetOf(fs, target, cwd, signal);
      if (resolved !== undefined) {
        rememberOfficialPath(target, cwd, processPathOf(fs, resolved));
        resolvedByTarget.set(target, resolved);
      }
    }),
  );
  return resolvedByTarget;
}

/** 卸载兜底：插件换代时作废全部官方形——换代之间软链可能被重新指向、后端可能整个换掉，
 *  留着旧形等于拿上一代的盘判这一代（这一枚喂的是**密钥面判定**，不与纯路径映射同列）。 */
export function clearOfficialPaths(): void {
  officialPaths.clear();
}

/** 宿主注入的**本机形**解析：`realpathSync` 那一形。
 *  形状即 host.ts 的 `realpathOf`（解析不出来交 `undefined`）。注入而不是 import：
 *  本模块不 import `node:fs`（见文件头），而它正是"宿主这一层付得起的同步解析"。 */
export type LocalRealpath = (target: string, cwd: string | undefined) => string | undefined;

/**
 * 声明目标的解析形表（`声明原文 → 真实路径**清单**`）：宿主注入的本机形与官方后端形并列，
 * **判定取并集**——两形从不互相替换，所以"官方那一形陈旧/缺席"只会少拦不会多放。
 *
 * 为什么单列到本模块：它归属的关注点正是本模块的名字（"不是模型字面量的那两种形"），
 * 而此前它长在 host.ts 里只为了一枚 `realpathOf`。搬过来之后 host 只负责"把本机那枚
 * 解析注入进来"，判定侧（读并集）与这里同处一份文件，键形不同源的空间就没了。
 *
 * 一形都没到手的目标**不占键**：读侧据此分得清"没有解析形"与"有一枚空清单"，
 * 而占着键交空数组会把这两件事说成同一件。
 *
 * @param targets - 一次调用声明的目标（声明形，未归一）。
 * @param cwd - 会话工作目录（相对目标按它归一）。
 * @param localRealpath - 宿主注入的本机形解析。
 * @returns 目标 → 解析形清单；无解析形的目标不出现在表里。
 */
export function resolvedFormsOf(
  targets: readonly string[],
  cwd: string | undefined,
  localRealpath: LocalRealpath,
): Record<string, string[]> {
  // 键是**模型给的目标路径**，所以这张表不能是普通对象字面量：`forms["__proto__"] = [...]`
  // 命中的是 Object.prototype 的设值器，改的是这张表的原型而不是加一个键（实测：写完之后
  // `Object.keys` 里没有 `__proto__`，而 `getPrototypeOf` 变成数组）。`Object.fromEntries`
  // 走的是 CreateDataProperty，`__proto__` 会老老实实成为一个自有属性。
  const entries: [string, string[]][] = [];
  for (const target of targets) {
    const union = new Set<string>();
    const local = localRealpath(target, cwd);
    if (local !== undefined) {
      union.add(local);
    }
    const official = officialPathOf(target, cwd);
    if (official !== undefined) {
      union.add(official);
    }
    if (union.size > 0) {
      entries.push([target, [...union]]);
    }
  }
  return Object.fromEntries(entries);
}

/** `path` 是否就是 `root` 或落在它之下（照官方 `workspace-changes/src/paths.ts` 的 `isInside`）。
 *
 * 为什么不拼前缀再 `startsWith`：那要自己判"末尾有没有分隔符"，而分隔符在 Windows 上是
 * `\\\\`、混形还合法——每漏一种写法就多一条恒假的判据。`path.relative` 由平台实现同时解决
 * 分隔符与 `..` 归一：结果是空串（同一路径）或以 `..` 开头（在外面）都不是"在内部"。
 *
 * ⚠ 判"是否上跳出根"必须比**路径组件边界**，不能只看 `rel.startsWith("..")`：
 * `relative()` 对根内名为 `..cache` 的目录返回 `..cache`，那个前缀判断会把它误判成
 * "跑到根外面" —— 方向是**放行**（"沙箱盖不住"为真 ⇒ 灾难删除让路给同样管不了它的沙箱）。 */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** `candidate` 是否为 `target` 的**祖先目录**（目标自身不算）。
 *  这是「引用取证的作用域判据」与「项目根的回落取值」共用的**同一条不变式**，故单列一处：
 *  判定侧（`isProjectScopeOf`）只认"检索起点是目标的祖先"，而拒绝文案会把项目根当检索
 *  起点原样递给模型（`assembleGaps` 的 `ctx.searchPath`）。两处一旦不同源，就会出现
 *  「门禁教模型去搜的位置，门禁自己又不认」——模型怎么照做都攒不满凭证。 */
export const isAncestorDirOf = (candidate: string, target: string): boolean =>
  candidate !== target && isInside(candidate, target);

/** 起点内的层目录 → 相对起点的 POSIX 形（结果里的 `file` 用的就是这一形，比对才不用两边各 normalize）。
 *  收在路径模块里：它产出的就是 `underLayer` 的输入契约（统一 `/` 形）。 */
export function toPosixRelative(root: string, dir: string): string {
  return path.relative(root, dir).split(path.sep).join("/");
}

/** 这一项是不是那层（或层更深）里的命中。层就是起点自身时（rel = ""）整棵都在层内。
 *  两侧都是 `toPosixRelative` 的产物，所以这里的 `/` 是那个函数的输出契约，不是平台分隔符假设
 *  （换成 `path.sep` 反而会错：拿 `/` 形的串去比 `\` 形的前缀）。 */
export function underLayer(rel: string, file: string): boolean {
  return rel.length === 0 || file === rel || file.startsWith(`${rel}/`);
}
