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

/** 行首是 `~` 的词面：落到哪棵树要展开后才知道（`$` 由下面的 `includes("$")` 单独判）。 */
const LEADING_TILDE = "~";

/** Windows 盘符（`C:`）与前导 UNC（`//server/share`）：词法形不是 POSIX 绝对路径。 */
const WINDOWS_SHAPE = /^(?:[A-Za-z]:|\/\/)/u;

/** 落点不可判的词面：glob、brace、反斜杠/Windows 字形、盘符与 UNC、反引号、引号、换行、变量与 `~user`。 */
function isOpaqueDisasterTarget(word: string): boolean {
  return (
    word.includes("*") ||
    word.includes("?") ||
    word.includes("[") ||
    word.includes("]") ||
    word.includes("{") ||
    word.includes("}") ||
    word.includes("\\") ||
    word.includes("`") ||
    word.includes('"') ||
    word.includes("'") ||
    word.includes("\n") ||
    word.includes("\r") ||
    word.includes("$") ||
    // 盘符与 UNC 的落点不在 POSIX 路径世界：`path.posix.isAbsolute("//server/share")`
    // 是 true，把它按 POSIX 形交给沙箱面的可写根比，会得出「沙箱盖得住」的误判。
    WINDOWS_SHAPE.test(word) ||
    word.startsWith(LEADING_TILDE)
  );
}

/** 家目录子段（`~/x` 与 `$HOME/x` 的 `x`）；两种写法都不可用时 `undefined`。 */
function homeChildOf(
  word: string,
  homeUsable: boolean,
  dollarHomeUsable: boolean,
): string | undefined {
  let child: string | undefined;
  if (homeUsable) {
    if (word.startsWith("~/")) {
      child = word.slice(2);
    } else if (dollarHomeUsable && word.startsWith("$HOME/")) {
      child = word.slice("$HOME/".length);
    }
  }
  return child;
}

/** 归一的主体：返回绝对路径形；空词面与判不出来的形态都交回 undefined。
 *  三个分支的坐标系是刻意的：家目录子段用原生 `path.join`（家目录是宿主真实路径），
 *  POSIX 绝对路径在它自己的坐标系里归一（宿主在 Windows 上时这种词面不落到某个盘，
 *  与可写根比较自然不成立，方向是保守的不让路），相对路径用原生 `path.resolve`。 */
function normalizedTargetOf(word: string, cwd: OsPath | undefined): string | undefined {
  let result: string | undefined;
  // 空词面不是路径：`path.resolve(cwd, "")` 会把它变成 cwd 本身，等于替一个读不懂的
  // 词面编出一个确定目标，方向是放行。
  if (word.length > 0) {
    const home = os.homedir();
    // shell 的 `$HOME` 是环境变量：HOME 未设置时 bash 把它展开成空串，而 `os.homedir()`
    // 会回退到 passwd 家目录——两者不是同一个落点。只有 HOME 确实设置过才把 `$HOME`
    // 当家目录；否则交给不透明分支（含 `$` 即判不出来）。`~` 仍按 bash 的规则走
    // os.homedir()：HOME 未设置时 bash 也用 passwd 家目录。
    // 家目录本身必须是绝对路径：HOME 被写成相对形时，`~` 展开后的落点不在宿主路径世界。
    const homeUsable = path.isAbsolute(home);
    const dollarHomeUsable =
      typeof process.env["HOME"] === "string" && process.env["HOME"].length > 0;
    const homeItself = homeUsable && (word === "~" || (dollarHomeUsable && word === "$HOME"));
    const homeChild = homeChildOf(word, homeUsable, dollarHomeUsable);
    // 家目录形的尾部要**单独**过不透明判断：`~/$W` 的前缀是合法写法，但子段里的 `$W`
    // 展开后落到哪里要过口令表才知道。整串一起判会连前缀的 `~`/`$HOME` 也算成可疑，
    // 于是 `~/Documents` 这种最常见、完全可判的写法会退成"判不出来"（那是误伤，不是保守：
    // 判不出来就让路，而 `~/Documents` 恰恰不该让路）。
    // 三条分支各有各的判据：家目录本身无需再看；家目录子段只看子段；其余看整串。
    // 子段为空（`~/`）时按「没有子段」处理：`~/` 就是家目录本身。
    const homeChildOpaque =
      homeChild !== undefined && homeChild !== "" && isOpaqueDisasterTarget(homeChild);
    const junkOpaque = homeChild === undefined && !homeItself && isOpaqueDisasterTarget(word);
    if (!homeChildOpaque && !junkOpaque) {
      if (homeItself) {
        result = home;
      } else if (homeChild !== undefined) {
        // 家目录是宿主真实路径，子段来自 shell 词面（总用 `/` 写）；拼接走平台实现。
        result = path.join(home, homeChild);
      } else if (path.posix.isAbsolute(word)) {
        // 词面是 shell 文本里的路径，归一在它自己的坐标系（POSIX）里做。
        result = path.posix.normalize(word);
      } else if (cwd !== undefined) {
        result = path.normalize(path.resolve(cwd, word));
      }
    }
  }
  return result;
}

/**
 * @param word - `Fix.offending` 里的词面。
 * @param cwd - 会话工作目录（相对形按它归一）；缺席时相对形交回 `undefined`。
 * @returns 归一后的绝对路径；判不出来时 `undefined`。
 */
export function disasterTargetPathOf(word: string, cwd: OsPath | undefined): OsPath | undefined {
  const result = normalizedTargetOf(word, cwd);
  return result === undefined ? undefined : asOsPath(result);
}
