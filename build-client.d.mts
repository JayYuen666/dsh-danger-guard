/** build-client.mjs 的声明（供 test/build-client.test.ts 等 TS 侧类型化导入）。 */
export function buildClient(): Promise<string>;
/**
 * rolldown 外部化判据：登记过的精确说明符外置，react 家族里没登记的说明符抛错。
 *
 * @param id rolldown 交来的说明符
 * @returns 是否外置
 */
export function isExternalModule(id: string): boolean;
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
