// src/bundle-pkg.ts —— 本包 bundle 的 npm 包名（**单源**）。
//
// 两个产物侧的键都逐字等于它：`plugins.bundle.config` 槽位的 key（client-entry.ts）与
// 统计读数 `$mount` 贡献对象里的 `package` 字段（stats-reader.ts；descriptor 侧只把它
// 用作 `id` 前缀）。宿主按包名**逐字相等**匹配槽位
// （dsh-client-ui-renderer/lib/client.js:1154），写错的不是回落而是整张卡不渲染；`$mount`
// 的 `package` 分叉则表现为读数"读不到"。两处各写一遍时，改名漏一处没有任何编译期信号。
// 派发证据（installed dsh 0.1.7）：
//   · dsh-client-ui-plugin-manager/lib/client.js:1821 `renderSlot("plugins.bundle.config",
//     { view: "page" }, { entryKey: pkg.name })`——pkg.name 由 :306/:320 的
//     `packageView()` 取 `bundle.name`（= bundle 包名）；:2698
//     `configured: ledger.bundles.has(openPkg.name)` 决定页面**要不要**开这个槽位；
//   · 同包 lib/types/client/slot-contract.d.ts:96-100「A bundle's own configuration,
//     **keyed by the bundle's package name**」，kind `keyed` → `key` 必填；
//   · 官方占位者 dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661 亦用包名。
// 行槽（本包未用）写成 `<pkg>#<rowId>`（plugin-manager/lib/client.js:27-28 `rowConfigKey`）。
// 值必须与 package.json 的 name 一致并出现在 `~/.dsh/profiles/web/package.json` 的
// `dsh.profile.bundles` 里——test/client-card.test.ts 从该文件解析校验，不抄硬编码。
export const BUNDLE_PKG = "@jayyuen66/dsh-danger-guard";
