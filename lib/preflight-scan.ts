// lib/preflight-scan.ts —— 预检的取证 I/O 与证据渲染。
//
// 这一族从 host.ts 拆出来的理由是**职责而不是行数**：host 那一侧管"这一次调用该不该拦、
// 缺哪几项、水位记在哪一格"（要读设置、读会话台账、读 fs 存在性）；这一侧只管"把证据取出来、
// 把它-render 成模型读得懂的文本"——纯 I/O + 纯文案，不碰会话键、不碰状态机。
// 拆开后两边各自可测：这一侧的预算/截断/二进制判据可以拿真实临时目录直接钉（不必再从
// 监听器绕进来），host 侧只需断言接线与水位。
//
// 三条口径与 host 侧的判定链**同源**，不在本文件重述：
//  - 扫描起点（root）由调用方用 `projectRootOf` 现算并送进来——拒绝理由里的检索起点与
//    预检扫的起点必须是同一枚，否则"门禁教模型去搜的位置，门禁自己又不认"。
//  - 匹配词（needles）由调用方用 `buildStems` / `MIN_STEM` 算好送来：与门禁记账认的
//    引用签名同一条口径（全名命中，或任一词干 ≥ MIN_STEM 命中），两处各写一份迟早会漂。
//  - 文档扩展名的跳过判据在 lib/fact-gate.ts 的 `SKIP_EXT_RE`，由调用方判。
//
// 有界是本族的第一要求，不是优化：平台的 `tools/pre-execute` 契约不会放弃一枚挂起的
// promise（installed dsh-tools/lib/types/index.d.ts:39-42），一次卡死的扫描会把整次工具
// 调用永久挂住。所以下面每一处循环都带预算，并保证循环体里至少有一次 `await` 作为
// 取消/墙钟的中断检查点；顺序读而不是 `Promise.all`（并发读会一次打开成百上千个 fd，
// 而 macOS 默认 ulimit 是 256）。

// `node:path` 留在这里只做**字符串**活（取 basename 报给模型）：它不碰 fs，因此不携带
// "本地盘就是执行世界"那层假定——远程后端给的 displayPath 是 URI 也一样能取出末段。
import path from "node:path";
import type { FactNeed } from "./fact-gate.ts";
import { fillTemplate } from "./messages.ts";
import type { DangerGuardMessages } from "./messages.ts";
// 官方文件系统面（type-only：dsh-fs 是 devDependency，产物里不出现对它的运行时引用）。
// 本文件**不再 import 任何 node:fs** —— 理由见下面 PreflightFs 那条注释。
import type { FileSystem, FsPathInfo, FsTarget } from "@deepseek-ai/dsh-fs";

/**
 * 预检用到的宿主 fs 面 = 官方 `FileSystem` 的本包调用点投影（只 `Pick` 真用的六位，
 * 签名一个字都不再重述：官方改一位这里就编译期红，而不是镜像照样通过、调用点静默拿错形状）。
 *
 * 为什么必须走 `ctx.fs` 而不是 `node:fs`：本包的宿主是**可插拔执行世界**的——同一个 profile
 * 可能挂在 fs-sandbox / ssh / e2b 后端上（`@deepseek-ai/dsh-fs` 的模块注释就写着
 * "Filesystem Service Definition for one execution world"）。`node:fs` 假定"本地盘就是工具
 * 用的那一份盘"，在这个前提不成立的部署上，预检会去读**模型根本没碰过的主机文件**，然后把
 * 它的内容当成"目标的当前正文 / 谁引用了它"抄进模型上下文——既给错证据，又是一条外泄路径。
 * 交回官方面之后，"哪一份盘、哪个目录、要不要越界"这几件事由后端判定，本包只表达意图。
 *
 * `processPath` 是同一件事的**路径形**读口（`resolve` 定身份，`processPath` 交出该执行世界里
 * 能打开的绝对路径）：密钥面判定要拿它当"目标的真实路径"，而不是拿本机 `realpathSync` 的
 * 结果去猜另一份盘。官方明令 `targetKey` 不许解析（"Consumers MUST NOT parse it"），所以
 * 真实路径只能经这一位取——它是同步的，代价是必须先有 `resolve` 出来的 target。
 */
export type PreflightFs = Pick<
  FileSystem,
  "resolve" | "stat" | "lstat" | "listDir" | "readByteRange" | "processPath"
>;

/** 引用扫描最多**读**多少个文件（超出即停）；真实扫过的数量会随证据报给模型，不装成"扫完了"。 */
export const PREFLIGHT_MAX_FILES = 256;
/** 目录展开预算：列一层目录本身就是一次 await 加一堆返回项，文件预算管不到它。没有这一枚，
 *  "最多读 256 个文件"会退化成"最多列几万层目录然后照样超时"——大仓里正是这个形状。 */
export const PREFLIGHT_MAX_DIRS = 256;
/** 单文件字节上限：扫描**跳过**更大的文件，目标内容读取只**定长读**这一段（两种取舍各见其函数注释）。 */
export const PREFLIGHT_MAX_BYTES = 64_000;
/** 引用命中最多列多少处（列表是给模型的证据，不是全文导出）。 */
export const PREFLIGHT_MAX_FINDINGS = 40;
/** 每处命中的单行截断长度。 */
export const PREFLIGHT_LINE_CHARS = 200;
/** 引用扫描跳过的目录名（依赖树与产物目录：既慢又会给出误导性命中——`node_modules` 里
 *  同名文件一大把）。点开头的目录另有判定，不逐个列进来。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  "venv",
]);

/** 没给隔离判据时的缺省：一个都不隔离。写成模块常量而不是在调用点现造 `() => false`，
 *  是为了每次扫描复用同一枚引用（也让"缺省 = 不隔离"这件事只有一处说法）。 */
const NEVER_QUARANTINED = (): boolean => false;

/** 一处引用命中：相对扫描起点的路径、1 起的行号、截断后的一行原文。 */
export interface RefFinding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * 一次引用扫描的结果；`scanned` 是**真实读过**的文件数（不含被跳过的目标自身）。
 * 三枚完成度位必须留在结果里，因为它们的去向不同：
 *  - `complete === false`（遍历被文件/目录预算截断）→ 文案不能给全称结论，而且调用方
 *    **不给 refs 凭证**（"扫过一部分"不顶替"探过引用面"）；
 *  - `hitsCapped`（命中列表达上限，遍历本身扫完了）→ 只补一行说明，凭证照给：
 *    "有引用"这件事已经被证实了，列全列不全不影响它；
 *  - `quarantined > 0`（凭据面文件按规则未读）→ 凭证照给（遍历确实扫完了），但全称结论
 *    不成立：被隔离的那几份完全可能写着引用，只是它们的正文不允许抄进模型上下文。
 */
export interface RefScan {
  readonly root: string;
  readonly scanned: number;
  readonly findings: readonly RefFinding[];
  readonly complete: boolean;
  readonly hitsCapped: boolean;
  readonly quarantined: number;
  /** **真展开过**的目录（相对扫描起点；起点自身是 ""）。层探查结论要靠它判覆盖：
   *  预算截断时"这层没命中"与"这层根本没走到"是两件不同的事，说错就是骗模型。 */
  readonly dirs: readonly string[];
}

/** 一枚层的结论：目录（相对起点）、该目录内的命中数，以及这次扫描是否覆盖它。 */
export interface LayerFinding {
  readonly layer: FactNeed;
  readonly dir: string;
  readonly hits: number;
}

/** 目标内容（read 证据）：`bytes` 是实际带上的字节数，`truncated` 表示原文更长。 */
export interface TargetContent {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** 一次带证据拦截可能出现的两块证据：按需出现，两块都没有时调用方根本不拦。 */
export interface PreflightEvidence {
  readonly scan: RefScan | undefined;
  readonly content: TargetContent | undefined;
  /** 从同一次扫描派生的层结论（high 档的 test/e2e/docs）。空数组 = 这一趟没有层缺项。 */
  readonly layers: readonly LayerFinding[];
}

/** 扫描队列的一项：目录要展开、文件要读一遍。
 *  `target` 是后端给回的已解析身份（读与列都吃它，不再自己拼路径去 resolve）；
 *  `path` 只用于 `lstat` 与凭据面词表（两者都是路径形，官方就是这么设计的）；
 *  `rel` 是报给模型的路径（相对扫描起点），由父项一路带下来——后端给的
 *  `displayPath` 在远程世界可能是 URI，拿它做 `path.relative` 会算出无意义的串。 */
interface ScanItem {
  readonly path: string;
  readonly rel: string;
  readonly target: FsTarget;
  readonly isDir: boolean;
  /** `lstat` 顺带给的字节数（后端报不出时 undefined → 读到超长再说）。 */
  readonly size: number | undefined;
}

/** 扫描的累加器（跨 await 传递；`scanned` / `dirs` 只数**真做过**的，`capped` 记遍历是否
 *  被预算截断，`quarantined` 记按凭据面规则**没读**的份数——三者决定这份结果能不能当凭证、
 *  以及结论能说到多大，见 RefScan 的注释）。 */
interface ScanState {
  scanned: number;
  dirs: number;
  capped: boolean;
  quarantined: number;
  /** 真展开过的目录（相对起点），随结果交回用于层覆盖判定。 */
  readonly walked: string[];
  readonly findings: RefFinding[];
}

/** 一次扫描的运行面（目标、扫描起点、匹配词、取消信号、隔离判据与累加器）。 */
interface ScanCtx {
  readonly fs: PreflightFs;
  readonly root: string;
  readonly targetN: string;
  readonly needles: readonly string[];
  readonly signal: AbortSignal;
  /** 这份路径的**正文**能不能抄进模型上下文（凭据面文件不能，见 scanReferences）。 */
  readonly quarantined: (file: string) => boolean;
  readonly state: ScanState;
}

/** 一次引用扫描的入参（收成一个对象而不是四五个位置参数：加"隔离判据"这一步
 *  本来会顶到 max-params 的上限，而调用点两个（A/B 面）传的其实是同一份东西）。 */
export interface ScanRequest {
  /** 归一化后的目标绝对路径（自身不进结果）。 */
  readonly targetN: string;
  /** 扫描起点，与拒绝理由里给模型的检索起点同一枚（由 host 的 projectRootOf 现算）。 */
  readonly root: string;
  /** 匹配词：目标全名 + 够长的词干（口径与门禁记账同源，由调用方算好送来）。 */
  readonly needles: readonly string[];
  /** 取消 + 墙钟的合流信号（见 host 的 preflightSignalOf）。 */
  readonly signal: AbortSignal;
  /** 凭据面判据：命中的文件**整个跳过**（不读、不抄正文）。缺省 = 一个都不隔离。 */
  readonly isQuarantined?: (file: string) => boolean;
  /** 宿主 fs 面（执行世界由它判定，见 `PreflightFs`）。 */
  readonly fs: PreflightFs;
}

/** 子项的实际类型（按 `lstat`，不跟软链）。报 `symlink` / `other` 的一律不进队列。
 *  **探不到就当这层没扫完**（抛错与"条目刚消失"都算）：静默跳过的话，一份没看过的文件
 *  会被算进"已扫范围内零命中"，而那句正在被当成"目标没有任何引用者"的证据用。
 *  标成未完成只是不给 refs 凭证并换一句话说结论——方向保守，与整趟抛掉不同（后者会让
 *  一条断链把整个项目的预检从此废掉）。 */
async function entryKindOf(ctx: ScanCtx, childPath: string): Promise<string> {
  let info: FsPathInfo | undefined;
  try {
    info = await ctx.fs.lstat(childPath, {}, ctx.signal);
  } catch {
    ctx.state.capped = true;
    return "";
  }
  if (info === undefined) {
    ctx.state.capped = true;
    return "";
  }
  return info.type;
}

/** 相对路径拼接：本包自己拼（`/` 分隔，报给模型的永远是相对扫描起点的 POSIX 形），
 *  不去 import `node:path`——那正是本文件这次要撤掉的"假定本地盘"的一部分。 */
function joinRel(rel: string, name: string): string {
  return rel.length === 0 ? name : `${rel}/${name}`;
}

/** 后端交回的字节 → 文本。非 UTF-8 按替换字符处理（与迁移前 `Buffer.toString("utf8")` 同形）。 */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 这一层只数"目录"，文件名前缀的点不判（`.env` 靠凭据面词表隔离，见 scanReferences）。 */
function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

/** 展开一层目录。列不出来（例如目录里有一枚**断链软链**——官方的 `listDir` 会把每个子项
 *  先解析成 target，断链就抛）时**不算这层没扫过**：把遍历标成未完成并继续走其余分支，
 *  于是结论自动降级成"已扫范围内"，refs 凭证也不给。整趟抛掉是更糟的选项：一条断链会让
 *  整个项目的预检从此失效，而那恰恰是预检最该工作的大仓形状。 */
async function listChildren(ctx: ScanCtx, item: ScanItem): Promise<ScanItem[]> {
  const out: ScanItem[] = [];
  let entries;
  try {
    entries = await ctx.fs.listDir(item.target, ctx.signal);
  } catch {
    ctx.state.capped = true;
    return out;
  }
  for (const entry of entries) {
    if (ctx.signal.aborted) {
      return out;
    }
    // 依赖/产物目录与点开头目录根本不展开（连 lstat 都不必花一次）
    if (entry.type === "directory" && isSkippedDir(entry.name)) {
      // 跳过这一项、继续走同层其余项：换成"条件成立才入队"要把三层判断嵌进一个表达式，
      // 读起来比 continue 更难。
      // oxlint-disable-next-line eslint/no-continue -- 理由见上
      continue;
    }
    // 软链一律不进（与迁移前的 `withFileTypes` 同一条口径，但这次是**官方给的判据**：
    // `resolve` 会跟链，`lstat` 不跟，官方注释明说 lstat 就是给"要在跟之前先拒掉"的用方的。
    // 跟随软链会把扫描面弹到目录树之外——一枚指向 `/` 的链就能让"项目级引用探查"去读整机。
    const childPath = `${item.path}/${entry.name}`;
    // 逐子项探类型是这条扫描的中断检查点；并发探会一次打开成百上千个句柄（见文件头"有界"）。
    // oxlint-disable-next-line eslint/no-await-in-loop -- 理由见上
    const kind = await entryKindOf(ctx, childPath);
    const common = {
      path: childPath,
      rel: joinRel(item.rel, entry.name),
      target: entry.target,
    };
    if (kind === "file") {
      out.push({ ...common, isDir: false, size: entry.size });
    } else if (kind === "directory") {
      out.push({ ...common, isDir: true, size: undefined });
    }
  }
  return out;
}

/** 把一个文件里的命中收进结果（命中数达上限即停，否则逐行扫到文末）。
 *  @param rel 报给模型的路径（相对扫描起点，由队列一路带下来） */
function collectFindings(rel: string, text: string, ctx: ScanCtx): void {
  for (const [index, line] of text.split("\n").entries()) {
    if (ctx.state.findings.length >= PREFLIGHT_MAX_FINDINGS) {
      return;
    }
    if (ctx.needles.some((needle) => line.includes(needle))) {
      ctx.state.findings.push({
        file: rel,
        line: index + 1,
        text: line.trim().slice(0, PREFLIGHT_LINE_CHARS),
      });
    }
  }
}

/** 读一枚文件参与扫描：含 NUL（二进制）算"不构成引用面"，跳过但不影响完成度；
 *  **读不动**（权限 / 断链 / 后端拒绝）则把整趟标成未完成——那一份没看过，就不能再说
 *  "已扫范围内没有任何引用者"。 */
async function scannableText(ctx: ScanCtx, item: ScanItem): Promise<string | undefined> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await ctx.fs.readByteRange(
      item.target,
      { offset: 0, length: PREFLIGHT_MAX_BYTES },
      ctx.signal,
    );
  } catch {
    ctx.state.capped = true;
  }
  return bytes === undefined || bytes.includes(0) ? undefined : decodeText(bytes);
}

/** 扫一枚候选文件。回 `false` = 文件预算用尽，调用方应当就此收队（`capped` 已置位）。
 *  拆出来而不是inline在走循环里：那三条分支（隔离 / 预算 / 读取）各有一个"停"的去向，
 *  叠在同一个循环体里既顶爆认知复杂度，也把"这一份到底为什么没读"揉成一团。 */
async function scanOneFile(ctx: ScanCtx, item: ScanItem): Promise<boolean> {
  // 凭据面文件整个跳过：一条引用命中会把那行**原文**抄进模型上下文，而"凭据正文不外泄"
  // 正是本包存在的理由之一。跳过而不是脱敏：脱敏等于在证据里留一份"这里有内容"的形状。
  if (ctx.quarantined(item.path)) {
    ctx.state.quarantined += 1;
    return true;
  }
  if (ctx.state.scanned >= PREFLIGHT_MAX_FILES) {
    ctx.state.capped = true;
    return false;
  }
  ctx.state.scanned += 1;
  // 超大文件跳过而不是读前半（与迁移前同一条取舍）：半份内容给出的命中面更不完整，
  // 而"读到一半"会多出第二种语义（这份扫描结果到底覆盖了什么）。
  if (item.size !== undefined && item.size > PREFLIGHT_MAX_BYTES) {
    return true;
  }
  const text = await scannableText(ctx, item);
  if (text !== undefined) {
    collectFindings(item.rel, text, ctx);
  }
  return true;
}

/** 广度优先走一遍项目：目录展开、文件按引用词扫一遍；每一项之前查取消与**各自的预算**。
 *  循环体里的 `await` 是这条扫描的**中断检查点**（见文件头的"有界"）。
 *  预算用完而停下 = `capped`（结论只覆盖已扫范围，仍然可用）；信号中断 = 整趟作废
 *  （由 scanReferences 收尾，不在这里判——两种"停"的去向不同，混在一处就会把截断当完整）。 */
async function walkForRefs(ctx: ScanCtx, rootTarget: FsTarget): Promise<void> {
  const queue: ScanItem[] = [
    { path: ctx.root, rel: "", target: rootTarget, isDir: true, size: undefined },
  ];
  for (const item of queue) {
    if (ctx.signal.aborted) {
      return;
    }
    if (item.isDir) {
      if (ctx.state.dirs >= PREFLIGHT_MAX_DIRS) {
        ctx.state.capped = true;
        return;
      }
      ctx.state.dirs += 1;
      ctx.state.walked.push(item.rel);
      // oxlint-disable-next-line eslint/no-await-in-loop -- 顺序展开一层：见文件头（并发列目录同样会爆 fd；这处 await 也是取消与墙钟的中断点）
      queue.push(...(await listChildren(ctx, item)));
    } else if (item.path !== ctx.targetN) {
      // 顺序读单个文件（并发读会一次打开成百上千个 fd，macOS 默认 ulimit 256，见文件头），
      // 而这处 await 同时是取消/墙钟的中断点。
      // oxlint-disable-next-line eslint/no-await-in-loop -- 理由见上两行
      const keepGoing = await scanOneFile(ctx, item);
      if (!keepGoing) {
        return;
      }
    }
  }
}

/**
 * 引用扫描：从 `root`（调用方用 `projectRootOf` 现算，与拒绝理由里的起点同源）出发扫一遍，
 * 给出"谁引用它"的实证。
 * 返回 undefined = 这一趟没跑成（取消 / 墙钟到点）→ 调用方整趟放弃预检：半份"已探过引用面"
 * 比不注入更糟（模型与门禁都会把它当成探过了）。
 * 预算用完**不**算没跑成：那种结果 `complete` 为 false 交出去，文案换成"已扫范围内"的说法，
 * 并且不记 refs 凭证。
 * `isQuarantined` 命中的文件（默认判据来自本包自己的密钥面词表）**整个不读**：一条引用命中
 * 会连带把那行原文抄进模型上下文，而凭据文件的正文正是本包禁止外泄的东西。份数随结果交回，
 * 于是零命中那一支不再宣称"没有任何引用者"。
 * @param request 一次扫描的入参（见 `ScanRequest`）。
 */
export async function scanReferences(request: ScanRequest): Promise<RefScan | undefined> {
  const { targetN, root, needles, signal, isQuarantined, fs } = request;
  // 根解析失败就抛出这一趟（由监听器兜底告警）：连起点都不在，"零命中"更是无根之言。
  const rootTarget = await fs.resolve(root, { signal });
  const ctx: ScanCtx = {
    fs,
    root,
    targetN,
    needles,
    signal,
    quarantined: isQuarantined ?? NEVER_QUARANTINED,
    state: { scanned: 0, dirs: 0, findings: [], capped: false, quarantined: 0, walked: [] },
  };
  await walkForRefs(ctx, rootTarget);
  return signal.aborted
    ? undefined
    : {
        root,
        scanned: ctx.state.scanned,
        findings: ctx.state.findings,
        complete: !ctx.state.capped,
        hitsCapped: ctx.state.findings.length >= PREFLIGHT_MAX_FINDINGS,
        quarantined: ctx.state.quarantined,
        dirs: ctx.state.walked,
      };
}

/** 目标身份二选一：调用方（预检 B 面）已经 resolve 过就用那一枚，没 resolve 成才现解一次。
 *  本地后端下省的是一个 syscall，远端/沙箱后端下省的是**一次往返**——同一枚目标在一次盲改里
 *  会被正文读取与版本探针各要一次，不复用就是三次。
 * ⚠ 写成两条 `return` 而不是 `resolved ?? await fs.resolve(...)`（也不是三元）：把 await 放进
 *  逻辑/条件表达式的那一条臂里，v8 → istanbul 的区间归并会把**紧随其后的语句**算进这条没走到
 *  的臂，于是"正文确实读到了"的用例跑过之后那一行仍报 0 次（实测如此）。本包的覆盖率门是
 *  100%，测量骗人比多写两行贵得多；lint 的 `prefer-nullish-coalescing` 想改回 `??` 时别听它的。 */
export async function targetOrResolveOf(
  fs: PreflightFs,
  targetN: string,
  signal: AbortSignal,
  resolved: FsTarget | undefined,
): Promise<FsTarget> {
  if (resolved !== undefined) {
    return resolved;
  }
  return fs.resolve(targetN, { signal });
}

/** 定长读出目标开头（`resolve` → 一次 `readByteRange`）。
 *  为什么不能用"整读再截"：那条路先把**整个文件**读进内存再切，于是 64KB 只管得到
 *  "投出去多少"，管不到"读进来多少"——门禁判的是模型要改的那枚路径，而它可以是任意大的
 *  生成物（锁文件、数据集、日志导出）。官方把上界放在这个接缝上（`readBytes` 超限直接抛
 *  `FS_TOO_LARGE`，`readByteRange` 才是"窗口即上界"的那一位），所以这里读
 *  PREFLIGHT_MAX_BYTES **+ 1**：多出的那一枚字节就是"原文更长"的实证，不必另开一次 stat。
 *  非普通文件（目录 / FIFO / 设备节点）在后端就抛，落进同一个 catch —— 那没有
 *  "这份文件现在的正文"这回事。
 *  **任何**失败都只表示"这一趟拿不到正文"（不存在 / 无权限 / 越界被拒 / 后端 IO 故障），
 *  一律塌成 undefined：调用方据此**不记凭证**，于是门禁照旧要求模型自己去读——方向保守，
 *  而不必为"这条错误码我们没见过"再养一条测不到的分支（本包的覆盖率阈值是 100%，
 *  按码白名单的写法必然留下一条永远走不到的"非预期码"支路）。
 *  也不出声：edit 打在缺席目标上（新建文件）时这条路径每次都会走，告警只会把真问题淹在
 *  常态噪声里，而模型此刻看得见的结果是"仍需取证"，不是静默放行。 */
async function readHeadBytes(
  fs: PreflightFs,
  targetN: string,
  signal: AbortSignal,
  resolved: FsTarget | undefined,
): Promise<Uint8Array | undefined> {
  let head: Uint8Array | undefined;
  try {
    // 调用方（预检 B 面）已经把这枚目标 resolve 过一次时就用那一枚；undefined = 那次没解成
    //（新建路径、越界被拒、后端故障），这里才自己解一次——失败仍然只落进下面那个 catch。
    const target = await targetOrResolveOf(fs, targetN, signal, resolved);
    head = await fs.readByteRange(target, { offset: 0, length: PREFLIGHT_MAX_BYTES + 1 }, signal);
  } catch {
    // 空 catch 是有意的（见函数注释）：任何失败都只表示"这一趟拿不到正文"，而 `head` 的
    // 初值就是全部要做的事。真问题不会被静默：模型随后仍会被门禁要求自己去读。
  }
  return head;
}

/** 读到的头部 → 证据（正文 + 实际字节数 + 是否还有更多）。 */
const targetContentOf = (head: Uint8Array): TargetContent => ({
  text: decodeText(head),
  bytes: head.length,
  truncated: head.length > PREFLIGHT_MAX_BYTES,
});

/** 目标内容（read 证据）。回 undefined = 这一项拿不到（已取消 / 不存在 / 无权限 /
 *  非普通文件 / 二进制）。
 *  二进制（NUL 字节）不进上下文：与扫描侧同一条口径，理由也相同——一屏乱码既不是证据，
 *  也白吃模型的一段上下文预算。
 *  与扫描侧相反的选择（那里是**跳过**大文件）：门禁要的是"改之前先看清这份内容"，
 *  给一半并加一句说明仍然成立；给零则这条证据就是空话。
 *  @param targetN 归一后的目标路径（`resolved` 缺席时用它现解一次身份）。
 *  @param signal 取消信号（调用方信号 ⊕ 墙钟的合流）。
 *  @param fs 宿主 fs 面。
 *  @param resolved 调用方已经 resolve 过的同一枚 target；给了就不再问一次身份。 */
export async function readTargetContent(
  targetN: string,
  signal: AbortSignal,
  fs: PreflightFs,
  resolved?: FsTarget,
): Promise<TargetContent | undefined> {
  const head = signal.aborted ? undefined : await readHeadBytes(fs, targetN, signal, resolved);
  return head === undefined || head.includes(0) ? undefined : targetContentOf(head);
}

/** 渲染引用块。零命中那一支按实际完成度说三句不同的话，不含糊：
 *  - 扫完且没隔离任何东西 → 全称结论"没有任何引用者"（空列表本身不是结论，这句话才是）；
 *  - 未扫完 → "已扫范围内零命中"并点名上限，全称结论在这一支是**假**的：
 *    模型据此删掉一个仍有引用者的文件，比不给证据更糟；
 *  - 扫完但有凭据面文件被隔离 → 全称结论同样不成立，只是原因不同（不是没扫到，
 *    是那几份**不许读**）——所以单独一句，并把份数报出来；
 *  - 有命中 → 逐行列出，尾部按截断种类补行（遍历截断 / 命中达上限 / 有隔离面）。 */
export function renderRefsBlock(messages: DangerGuardMessages, scan: RefScan): string {
  if (scan.findings.length === 0) {
    const slots = {
      root: scan.root,
      scanned: String(scan.scanned),
      limit: String(PREFLIGHT_MAX_FILES),
      count: String(scan.quarantined),
    };
    // 三句零命中说的是三件事：扫完了没引用 / 没扫完 / 扫完了但有几份不许读
    let line = messages.preflightRefsNonePartial;
    if (scan.complete) {
      line =
        scan.quarantined === 0 ? messages.preflightRefsNone : messages.preflightRefsNoneQuarantined;
    }
    return fillTemplate(line, slots);
  }
  const lines = [
    fillTemplate(messages.preflightRefsHead, {
      root: scan.root,
      scanned: String(scan.scanned),
      hits: String(scan.findings.length),
    }),
  ];
  for (const finding of scan.findings) {
    lines.push(
      fillTemplate(messages.preflightRefsLine, {
        file: finding.file,
        line: String(finding.line),
        text: finding.text,
      }),
    );
  }
  // 三种"没说全"的成因各说一件事：范围没覆盖到 / 命中太多 / 有凭据面文件不许读。
  if (scan.complete) {
    if (scan.hitsCapped) {
      lines.push(
        fillTemplate(messages.preflightRefsCapped, { limit: String(PREFLIGHT_MAX_FINDINGS) }),
      );
    }
  } else {
    lines.push(
      fillTemplate(messages.preflightRefsPartial, {
        limit: String(PREFLIGHT_MAX_FILES),
        root: scan.root,
      }),
    );
  }
  if (scan.quarantined > 0) {
    lines.push(
      fillTemplate(messages.preflightRefsQuarantined, { count: String(scan.quarantined) }),
    );
  }
  return lines.join("\n");
}

/** 渲染目标内容块（截断时补一行说明，不静默截断）。 */
export function renderContentBlock(
  messages: DangerGuardMessages,
  targetN: string,
  content: TargetContent,
): string {
  const head = fillTemplate(messages.preflightReadHead, {
    name: path.posix.basename(targetN),
    bytes: String(content.bytes),
  });
  const tail = content.truncated
    ? `\n${fillTemplate(messages.preflightReadTruncated, { bytes: String(PREFLIGHT_MAX_BYTES) })}`
    : "";
  return `${head}\n${content.text}${tail}`;
}

/** A 面的注入正文：一句头 + 引用块。
 *  目标正文**不在**这里给——模型这一次就在读它，结果里已经有了；再抄一遍只是白刷上下文，
 *  而"每次 read 都塞一整份文件内容"正是本节旧形态被否掉的原因之一。 */
export const renderAttach = (messages: DangerGuardMessages, scan: RefScan): string =>
  `${messages.preflightAttach}\n\n${renderRefsBlock(messages, scan)}`;

/** B 面的拒绝理由：头部（含"原样重试即放行"）+ 当场取到的证据块。
 *  这一串走的是官方 `PreToolDecision.deny{reason}`，宿主把它 materialize 成本次调用的
 *  错误结果（installed dsh-tools `prepareExecution`：`content:[{type:'text',
 *  text:'Error: '+reason}]`）——所以模型是在**这次**调用的结果里读到正文的，不是下一步。 */
export function renderHandoff(
  messages: DangerGuardMessages,
  targetN: string,
  evidence: PreflightEvidence,
): string {
  const blocks = [messages.preflightHandoff];
  if (evidence.content !== undefined) {
    blocks.push(renderContentBlock(messages, targetN, evidence.content));
  }
  if (evidence.scan !== undefined) {
    blocks.push(renderRefsBlock(messages, evidence.scan));
  }
  for (const layer of evidence.layers) {
    blocks.push(
      fillTemplate(messages.preflightLayerLine, {
        layer: layer.layer,
        dir: layer.dir,
        hits: String(layer.hits),
      }),
    );
  }
  return blocks.join("\n\n");
}
