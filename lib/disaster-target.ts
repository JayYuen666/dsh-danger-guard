// lib/disaster-target.ts —— 灾难目标词面 → 绝对路径（供沙箱包含性判断）。
//
// 只处理 `catastrophicRm` 会点名的形态；**归一不出来的一律 undefined**，调用方据此
// 保守地不让路。glob / brace / 变量 / Windows 字形都必须留在"判不出来"这一侧：
// 它们展开后落到哪棵树要过展开规则、盘符表或口令表，猜一个看似合理的路径会让
// `sandboxDropsOf` 把整棵受保护树当成工作区内目标。

import os from "node:os";
import path from "node:path";

import { asOsPath } from "./path-format.ts";
import type { OsPath } from "./path-format.ts";

/** 落点不可判的词面：glob、brace、反斜杠/Windows 字形、变量与 `~user`。 */
function isOpaqueDisasterTarget(word: string, homeItself: boolean, homeChild: boolean): boolean {
  return (
    word.includes("*") ||
    word.includes("?") ||
    word.includes("[") ||
    word.includes("]") ||
    word.includes("{") ||
    word.includes("}") ||
    word.includes("\\") ||
    (word.includes("$") && !homeItself && !homeChild) ||
    (!homeItself && !homeChild && /^[~$]/u.test(word))
  );
}

/**
 * @param word - `Fix.offending` 里的词面。
 * @param cwd - 会话工作目录（相对形按它归一）；缺席时相对形交回 `undefined`。
 * @returns 归一后的绝对路径；判不出来时 `undefined`。
 */
export function disasterTargetPathOf(word: string, cwd: OsPath | undefined): OsPath | undefined {
  const home = os.homedir();
  const homeItself = word === "~" || word === "$HOME";
  const homeChild = word.startsWith("~/") || word.startsWith("$HOME/");
  let result: string | undefined;
  if (!isOpaqueDisasterTarget(word, homeItself, homeChild)) {
    if (homeItself) {
      result = home;
    } else if (homeChild) {
      // 家目录是宿主真实路径，子段来自 shell 词面（总用 `/` 写）；拼接走平台实现。
      result = path.join(home, word.startsWith("~/") ? word.slice(2) : word.slice("$HOME/".length));
    } else if (path.posix.isAbsolute(word)) {
      // 词面是 shell 文本里的路径，归一在它自己的坐标系（POSIX）里做。
      result = path.posix.normalize(word);
    } else if (cwd !== undefined) {
      result = path.normalize(path.resolve(cwd, word));
    }
  }
  return result === undefined ? undefined : asOsPath(result);
}
