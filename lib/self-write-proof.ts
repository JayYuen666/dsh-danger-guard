// lib/self-write-proof.ts —— 内容自证：那次成功编辑写进去的文本此刻是否仍在文件里。
//
// 抽成模块是为了让"读全文"这件事可以被直接测到：调用点绑着真实的同步 fs，留在 host.ts
// 里只能靠集成用例间接观察。

import { readFileSync, statSync } from "node:fs";

/**
 * 内容自证允许读入的文件上限。
 *
 * 自证要把目标全文读进来做 `includes`，而它在 tools.guard 的同步主路径上执行；一份几百 MB
 * 的锁文件或数据导出会把宿主线程整段卡住并撑起等量内存。超过上限时不读全文，返回
 * `undefined`（不知）——`attributeExternalChange` 只把 `true` 当自证，于是多要求一次 read，
 * 方向保守。上限内的普通源码文件仍按原文逐字自证。
 */
const MAX_SELF_PROOF_BYTES = 1024 * 1024;

/**
 * 内容自证。
 *
 * @param targetPath - 归一后的目标绝对路径。
 * @param written - 上一次成功编辑写入的文本。
 * @returns 文本仍在为 true；读不到或不在为 false；超过读取上限为 undefined（不知）。
 */
export function selfWritesStillPresent(targetPath: string, written: string): boolean | undefined {
  let result: boolean | undefined;
  try {
    const { size } = statSync(targetPath);
    if (size <= MAX_SELF_PROOF_BYTES) {
      try {
        // 读不到（不存在/无权限）⇒ 谈不上"写进去的文本还在"，交回 false。
        result = readFileSync(targetPath, "utf8").includes(written);
      } catch {
        result = false;
      }
    }
  } catch {
    result = false;
  }
  return result;
}
