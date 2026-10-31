import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // `execFileSync` 的豁免收在该文件内，不做包级登记：包级放行等于把"宿主热路径禁止同步子进程"
  // 这条契约在整个包内关掉（host.ts 的同步契约只覆盖 stat/read 两类 fs 读，见 syncStat 的注释），
  // 而实际需要它的只有下面这一处 —— decorator-transform.mjs 走 SCRIPTS_OVERRIDES 那一条，
  // 不归这里管。
  // 为什么是同步：这条门禁没有并发需求（两次子进程各 ~50ms，顺序跑），而 async 三种写法
  // 恰好被本仓三条 promise 规则夹死 —— `new Promise`（promise/avoid-new）、回调形
  // （promise/prefer-await-to-callbacks）、`promisify(execFile)`（typescript/strict-void-return）。
  // 为什么必须真的 spawn：产物加载门禁要在**独立进程**里 import 一次产物（同进程 import
  // 证明不了"Node 能不能加载它"，那正是踩过的失效模式：装饰器原样落进产物 → 产物是非法
  // JS，而构建报成功）。
  // 基线的只读名单由共享配置在这条 override 里一起带上：override 对同一条规则是整条设置替换，
  // 本仓不需要再 import 那张表。
  syncIoScopes: [{ files: ["test/artifact-loads.test.ts"], apis: ["execFileSync"] }],
});
