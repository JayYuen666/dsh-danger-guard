// decorator-transform.mjs 的声明（供 vitest.config.ts 等 TS 侧类型化导入）。
// 声明形状跟着 decorator-transform.mjs 的返回面走：`object` 会让调用方每次取 sources/mappings
// 都得各自 cast 一次，cast 写错也不会红。这里给出实际结构。
export interface DecoratorSourceMap {
  sources?: string[];
  mappings?: string;
}

// 与 build-host.d.mts / build-client.d.mts / build-types.d.mts 同一条：构建工具链里的 .mjs
// 给不出类型，而消费它的 .ts 在 strict 下会 TS7016 —— 手写一枚声明是这里既定的做法。
// ⚠ 这一份是**同步**的（`execFileSync` + `readFileSync`）：转换钩子拿到的就是结果本身。

/** 这个文件需要预转换吗（后缀与装饰器形状两道筛）。 */
export function needsDecoratorLowering(id: string, code: string): boolean;

/** 把一个带装饰器的 TS 文件编译成 JS（跑 `tsc`，理由见该模块文件头）。 */
export function lowerStandardDecorators(
  code: string,
  file: string,
  coverageHints?: boolean,
): { code: string; map: DecoratorSourceMap | null };

/** rolldown 插件（构建流水线）。 */
export function rolldownDecorators(): {
  name: string;
  transform: (code: string, id: string) => { code: string; map: DecoratorSourceMap | null } | null;
};

/** Vite 插件（测试流水线）。 */
export function viteDecorators(): {
  name: string;
  enforce: "pre";
  transform: (
    code: string,
    id: string,
  ) => { code: string; map: DecoratorSourceMap | null } | undefined;
};
