import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 包内例外只有一枚：`execFileSync` —— 产物加载门禁（test/artifact-loads.test.ts）要在
  // **独立进程**里真的 import 一次产物（同进程 import 证明不了"Node 能不能加载它"，那正是
  // 本轮踩过的失效模式：装饰器原样落进产物 → 产物是非法 JS，而构建报成功）。
  // 为什么是同步：这条门禁没有并发需求（两次子进程各 ~50ms，顺序跑），而 async 三种写法
  // 恰好被本仓三条 promise 规则夹死 —— `new Promise`（promise/avoid-new）、回调形
  // （promise/prefer-await-to-callbacks）、`promisify(execFile)`（typescript/strict-void-return）。
  // 基线的只读组（existsSync/readFileSync/...）不含它，故按「逐项登记」的口径登记这一枚。
  syncWrites: ["execFileSync"],
});
