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

/** 行首是 `~` 或 `$` 的词面：落到哪棵树要展开后才知道。 */
const LEADING_TILDE_OR_DOLLAR = /^[~$]/u;

/** 落点不可判的词面：glob、brace、反斜杠/Windows 字形、反引号、引号、换行、变量与 `~user`。 */
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
    LEADING_TILDE_OR_DOLLAR.test(word)
  );
}

/** 家目录子段（`~/x` 与 `$HOME/x` 的 `x`）；不是这两种写法时 `undefined`。 */
function homeChildOf(word: string): string | undefined {
  if (word.startsWith("~/")) {
    return word.slice(2);
  }
  return word.startsWith("$HOME/") ? word.slice("$HOME/".length) : undefined;
}

/**
 * @param word - `Fix.offending` 里的词面。
 * @param cwd - 会话工作目录（相对形按它归一）；缺席时相对形交回 `undefined`。
 * @returns 归一后的绝对路径；判不出来时 `undefined`。
 */
export function disasterTargetPathOf(word: string, cwd: OsPath | undefined): OsPath | undefined {
  const home = os.homedir();
  const homeItself = word === "~" || word === "$HOME";
  // 家目录形的尾部要**单独**过不透明判断：`~/$W` 的前缀是合法写法，但子段里的 `$W`
  // 展开后落到哪里要过口令表才知道。整串一起判会连前缀的 `~`/`$HOME` 也算成可疑，
  // 于是 `~/Documents` 这种最常见、完全可判的写法会退成"判不出来"（那是误伤，不是保守：
  // 判不出来就让路，而 `~/Documents` 恰恰不该让路）。
  // 三条分支各有各的判据：家目录本身无需再看；家目录子段只看子段；其余看整串。
  const homeChild = homeChildOf(word);
  // 子段为空（`~/`）时按「没有子段」处理：`~/` 就是家目录本身。
  const homeChildOpaque =
    homeChild !== undefined && homeChild !== "" && isOpaqueDisasterTarget(homeChild);
  const junkOpaque = homeChild === undefined && !homeItself && isOpaqueDisasterTarget(word);
  let result: string | undefined;
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
  return result === undefined ? undefined : asOsPath(result);
}
