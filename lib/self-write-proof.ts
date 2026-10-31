// lib/self-write-proof.ts —— 内容自证：那次成功编辑写进去的文本此刻是否仍在文件里。
//
// 抽成模块是为了让"读全文"这件事可以被直接测到：调用点绑着真实的同步 fs，留在 host.ts
// 里只能靠集成用例间接观察。

import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * 内容自证允许读入的文件上限。
 *
 * 自证要把目标全文读进来做 `includes`，而它在 tools.guard 的同步主路径上执行；一份几百 MB
 * 的锁文件或数据导出会把宿主线程整段卡住并撑起等量内存。超过上限时不读全文，返回
 * `undefined`（不知）——`attributeExternalChange` 只把 `true` 当自证，于是多要求一次 read，
 * 方向保守。上限内的普通源码文件仍按原文逐字自证。
 */
export const MAX_SELF_PROOF_BYTES = 1024 * 1024;

/**
 * 在上限之内读取并自证。
 *
 * 读取本身受上限约束，而不是只靠调用前的 `statSync`：两次调用之间文件可能被追加或替换，
 * 那时 `readFileSync` 仍会把整份内容读进内存，上限就形同虚设。这里一次只读
 * `MAX_SELF_PROOF_BYTES + 1` 字节——读满这一格说明文件已超过上限，交回"不知"。
 *
 * @param targetPath - 归一后的目标绝对路径。
 * @param written - 上一次成功编辑写入的文本。
 * @returns 文本仍在为 true；文件超上限为 undefined（不知）。
 */
function passesProof(targetPath: string, written: string): boolean | undefined {
  // 同步 fd 是这条契约本身：自证跑在 tools.guard 的同步谓词里，异步 fs 在这里不可用。
  // oxlint-disable-next-line node/no-sync -- 同步谓词内唯一能限制读取量的方式
  const fd = openSync(targetPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_SELF_PROOF_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return bytes > MAX_SELF_PROOF_BYTES
      ? undefined
      : buffer.toString("utf8", 0, bytes).includes(written);
  } finally {
    // oxlint-disable-next-line node/no-sync -- 与上面的 openSync 配对，见该处说明
    closeSync(fd);
  }
}

/**
 * 内容自证。
 *
 * @param targetPath - 归一后的目标绝对路径。
 * @param written - 上一次成功编辑写入的文本。
 * @returns 文本仍在为 true；读不到或不在为 false；超过读取上限或空写入为 undefined（不知）。
 */
export function selfWritesStillPresent(targetPath: string, written: string): boolean | undefined {
  let result: boolean | undefined;
  // `includes("")` 恒为 true：空写入（如清空文件）证明不了任何事，按“不知”处理。
  if (written.length > 0) {
    try {
      const stats = statSync(targetPath);
      if (stats.isFile()) {
        try {
          // 读不到（不存在/无权限）⇒ 谈不上"写进去的文本还在"，交回 false。
          result = passesProof(targetPath, written);
        } catch {
          result = false;
        }
      } else {
        // 不是普通文件（目录 / FIFO / 字符设备）：`st_size` 不代表可读正文，而且同步
        // `readFileSync` 会在无写者的 FIFO 上**永久阻塞**——那是主路径挂死，不是保守判定。
        // 结论按"写进去的文本不在"收口（与目录同一档，调用方会多要一次 read）。
        result = false;
      }
    } catch {
      result = false;
    }
  }
  return result;
}
