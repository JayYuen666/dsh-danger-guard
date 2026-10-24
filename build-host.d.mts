// build-host.mjs 的声明（供 test/build-host.test.ts 等 TS 侧类型化导入）。
// 本包有两个入口：host.ts 与 settings-host.ts（build-host.mjs:96/:106），故两份产物都要能读。
export function buildHost(): Promise<string>;
export function buildSettings(): Promise<string>;
/** 产物 + **打进 chunk 的模块 id 清单**：跨包外部化的门禁走它（文本判据在 minify 下会瞎，
 *  内联体被改名 —— 详见 build-host.mjs 里 `minify: true` 那一段）。 */
export function buildHostReport(): Promise<{ code: string; inlinedModules: string[] }>;
export function buildSettingsReport(): Promise<{ code: string; inlinedModules: string[] }>;
/** 单文件产物只接受唯一的 entry chunk；多余 chunk / asset 直接构建失败。 */
export function singleEntryChunk(
  output: readonly {
    type: string;
    fileName: string;
    code?: string;
    isEntry?: boolean;
    moduleIds?: string[];
  }[],
  source: string,
): { type: "chunk"; code: string; moduleIds?: string[] };
