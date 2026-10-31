// test/fixtures/local-fs-face.ts —— 官方 fs 面的**本地实现**，给单元层喂预检用的那份读法。
//
// 为什么需要它：预检的取证 I/O 已经全部走宿主 `ctx.fs`（`lib/preflight-scan.ts` 的
// `PreflightFs`），理由是"本地盘就是工具的那个执行世界"这层假定在 fs-sandbox / ssh / e2b
// 后端下不成立。单元层的 `ctx` 是手搓桩，装不了真后端，所以这里交回一份**同样按官方六位
// 实现**的本地读法——它只在测试里用，可以随便 `node:fs`。
//
// 语义对齐清单（照 installed @deepseek-ai/dsh-fs 与 dsh-fs-local 的实现写，不是自造口径）：
//  - `resolve` **跟**软链，并把路径折成稳定身份（真后端的 targetKey 就是 realpath 一族）；
//    目标缺席时 realpath 最深存在祖先再接剩余段（官方叫"为创建而观测缺席路径"）；
//  - `lstat` **不跟**最后一段，并能报出 `symlink`（官方明说这一位就是给"跟之前先拒掉"的用方）；
//  - `listDir` 逐子项解析 target，因此子项身份探不到时整层列不成（FsLocal 就是这么实现的）；
//  - `readByteRange` 是"窗口即上界"的那一位：读 `[offset, offset+length)`，文件更短就给短的；
//  - `processPath` 交出该执行世界里能打开的绝对路径（FsLocal 的实现就是 `String(target.targetKey)`，
//    lib/index.js:789-791——本地后端的 targetKey 正是 realpath，所以这一形与本机
//    `realpathSync` 同值；换到 sandbox/ssh 后端时它说的才是另一份盘）。
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import { brandString } from "@deepseek-ai/dsh-brand";
import type {
  FsDirEntry,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsTargetKey,
  FsVersion,
} from "@deepseek-ai/dsh-fs";

import type { PreflightFs } from "../../lib/preflight-scan.ts";

/** 可注入的失败位：一支对应一条用例（真世界里是权限 / 断链 / IO 故障 / 后端拒绝）。 */
export interface LocalFsFailures {
  readonly resolveThrows?: string;
  /** 只让指定路径的 `resolve` 抛错，其余路径照常解析（模拟某一层起点不可达）。 */
  readonly resolveThrowsAt?: { readonly path: string; readonly message: string };
  readonly lstatThrows?: string;
  readonly listDirThrows?: string;
  readonly readThrows?: string;
  readonly statThrows?: string;
  /** `processPath` 抛（远端/沙箱后端可以拒绝交出进程路径）：那一形就此缺席，判定退回另两形。 */
  readonly processPathThrows?: string;
  /** 这些名字在 `lstat` 上报"探不到"（模拟 readdir 与 lstat 之间条目消失）。 */
  readonly absentNames?: readonly string[];
  /** 每次 `lstat` 之后取消这枚控制器：用来钉"扫描中途被取消"那一支。 */
  readonly abortAfterLstat?: AbortController;
}

/** 命中注入位时抛（消息用注入值，方便用例点名"是哪一支"）。 */
function throwIf(message: string | undefined): void {
  if (message !== undefined) {
    throw new Error(message);
  }
}

/** 夹具用的本地路径就取官方那位 `displayPath`：官方注释说它是给模型/UI 输出的路径，
 *  在本地后端下就是绝对路径。真远程后端会换成 URI——那时这份夹具本来就不该被用。 */
function localPath(target: FsTarget): string {
  return target.displayPath;
}

/** 跟过软链之后的类型（FsLocal 的 FsInfo.type 就是这一位，官方只有三档）。 */
function followedKindOf(info: Stats): "file" | "directory" | "other" {
  if (info.isFile()) {
    return "file";
  }
  return info.isDirectory() ? "directory" : "other";
}

/** stat 的"探不到 = undefined"形状（本仓 lint 不容许 `.catch(() => undefined)` 那种
 *  显式 undefined 返回，而 try/catch 又要在四处重复——收成一枚助手）。 */
async function probeStat(targetPath: string): Promise<Stats | undefined> {
  let info: Stats | undefined;
  try {
    info = await stat(targetPath);
  } catch {
    info = undefined;
  }
  return info;
}

/** `lstat` 的同款包装（只有它能报出 symlink）。 */
async function probeLstat(targetPath: string): Promise<Stats | undefined> {
  let info: Stats | undefined;
  try {
    info = await lstat(targetPath);
  } catch {
    info = undefined;
  }
  return info;
}

/** realpath，缺席则逐层上溯到最近的存在祖先再拼回去（"为创建而观测"那一条）。
 *  逐层 await 是有意的：每一层的结果决定要不要继续往上，并发探父目录没有意义。 */
async function realpathOf(absolute: string): Promise<string> {
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- 逐层上溯：每层结果决定是否继续
      const resolved = await realpath(current);
      return path.join(resolved, ...missing.toReversed());
    } catch {
      if (current === path.dirname(current)) {
        return absolute;
      }
      missing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
}

/** 列目录时给子项的类型（官方 FsDirEntry.type 三档，跟过链的读法）。 */
function listKindOf(info: Stats): "file" | "directory" | "other" {
  return info.isDirectory() ? "directory" : followedKindOf(info);
}

/** 与真后端同形：绝对化 → realpath（缺席走上面那条回退）。 */
async function localTargetOf(targetPath: string, cwd: string | undefined): Promise<FsTarget> {
  const absolute = path.resolve(cwd ?? process.cwd(), targetPath);
  return {
    targetKey: brandString<FsTargetKey>(await realpathOf(absolute)),
    displayPath: absolute,
  };
}

function fsVersion(info: Stats): FsVersion {
  return brandString<FsVersion>(`${String(info.mtimeMs)}:${String(info.size)}`);
}

/** 目标级探针（跟软链）：官方 FsInfo 只有三档，没有 symlink。 */
function fsInfoOf(info: Stats): FsInfo {
  return { version: fsVersion(info), type: followedKindOf(info), size: info.size };
}

/** 路径级探针：只有这里能报出 `symlink`（官方就靠它把"跟之前先拒掉"这件事交给用方）。 */
function fsPathInfoOf(info: Stats): FsPathInfo {
  const kind = info.isSymbolicLink() ? "symlink" : followedKindOf(info);
  return { version: fsVersion(info), type: kind, size: info.size };
}

/** 窗口读：只分配 length 那么多字节（"窗口即上界"就是这份夹具要维持的语义）。 */
async function readWindowOf(
  targetPath: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(length);
  const handle = await open(targetPath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 列一层：子项 target 走 `resolve`（**跟**软链），因此身份探不到就是这一层列不成。 */
async function listChildrenOf(dir: string): Promise<FsDirEntry[]> {
  const found = await readdir(dir);
  const names = found.toSorted();
  const out: FsDirEntry[] = [];
  for (const name of names) {
    const childPath = path.join(dir, name);
    // 逐项探子项身份是**官方 listDirectory 自己的形状**（它逐子项 resolve+probe），
    // 并发会让这份桩与真实语义脱节；两处 await 也都是取消/预算的检查点。
    // oxlint-disable-next-line eslint/no-await-in-loop -- 理由见上
    const info = await probeStat(childPath);
    if (info === undefined) {
      throw new Error(`cannot list "${childPath}": not found`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- 解析子项身份本来就是逐项的活
    const childTarget = await localTargetOf(childPath, undefined);
    out.push({
      name,
      type: listKindOf(info),
      target: childTarget,
      size: info.size,
    });
  }
  return out;
}

/** 造一枚 fs 面（本地盘 + 可选的注入式失败）。 */
export function localFsFace(fail: LocalFsFailures = {}): PreflightFs {
  return {
    async resolve(targetPath, opts): Promise<FsTarget> {
      const targeted = fail.resolveThrowsAt;
      if (targeted?.path === targetPath) {
        throw new Error(targeted.message);
      }
      throwIf(fail.resolveThrows);
      return localTargetOf(targetPath, opts?.cwd);
    },
    async stat(target): Promise<FsInfo | undefined> {
      throwIf(fail.statThrows);
      const info = await probeStat(localPath(target));
      return info === undefined ? undefined : fsInfoOf(info);
    },
    async lstat(targetPath): Promise<FsPathInfo | undefined> {
      throwIf(fail.lstatThrows);
      fail.abortAfterLstat?.abort();
      const injected = fail.absentNames?.includes(path.basename(targetPath)) ?? false;
      const info = await probeLstat(targetPath);
      return injected || info === undefined ? undefined : fsPathInfoOf(info);
    },
    async listDir(target): Promise<FsDirEntry[]> {
      throwIf(fail.listDirThrows);
      return listChildrenOf(localPath(target));
    },
    async readByteRange(target, range): Promise<Uint8Array> {
      throwIf(fail.readThrows);
      return readWindowOf(localPath(target), range.offset, range.length);
    },
    processPath(target): string {
      throwIf(fail.processPathThrows);
      // 与 FsLocal 逐字同形（lib/index.js:789-791）：本地后端的 targetKey 就是 realpath。
      return String(target.targetKey);
    },
  };
}
