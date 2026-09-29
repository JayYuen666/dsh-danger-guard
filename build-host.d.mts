// build-host.mjs 的声明（供 test/build-host.test.ts 等 TS 侧类型化导入）。
// 本包有两个入口：host.ts 与 settings-host.ts（build-host.mjs:96/:106），故两份产物都要能读。
export function buildHost(): Promise<string>;
export function buildSettings(): Promise<string>;
