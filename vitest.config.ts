import { viteDecorators } from "./decorator-transform.mjs";
import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
// ⚠ `test` 块是**浅合并**（base 里 `{ ...baseTest, ...test }` 整块展开）：本包的 setupFiles
// 会整体替换公共层同名键。约束随之而来——公共层若将来新增 setupFiles（全局 mock、env 注入），
// 必须同步把那份名单并进这里，不能指望自动追加。
const base = definePackageConfig({
  coverageInclude: ["host.ts", "settings-host.ts", "lib/**/*.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
  },
});

// ⚠ 装饰器预转换必须**合并**进去而不是当成 `definePackageConfig` 的一个入参：那个工厂只读
// `coverageInclude` 与 `test` 两个键，多传的顶层键会被**静默丢掉**（实测：传进去之后测试
// 依旧报 `SyntaxError: Invalid or unexpected token`）。
//
// 为什么非有它不可：官方 Typert Remote 只能用标准装饰器声明，而管线的解析器（oxc）不降级它 ——
// 少了这一步，测试**连文件都加载不了**。为什么是 spawn `tsc` 而不是进程内转换（本仓 TS 7 的
// JS 面上没有转换 API）：理由全在 decorator-transform.mjs 的文件头。
export default {
  ...base,
  plugins: [...(base.plugins ?? []), viteDecorators()],
};
