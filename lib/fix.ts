// lib/fix.ts —— 一条拒绝附带的「出路」的**形状**（零依赖叶子模块）。
//
// 为什么单列一枚：产它的 `lib/danger-rules.ts` 导入 `node:os`/`node:path`，而渲染它的
// `lib/messages.ts` 会进**客户端**的类型程序（设置卡那条链）。若把这份形状放在
// danger-rules 里，`messages.ts` 为拿类型就得 `import type` 它，于是浏览器侧那一次
// 类型检查把两个 node 内建模块也拖进 program（实测 TS2591：`Cannot find name 'node:os'`）。
// 收在中间这枚零导入模块里，两边各自单向依赖它，谁也不拖谁。
//
// 本模块只有类型，没有运行期成分——所以它对产物字节数的贡献是零。

/**
 * 出路的**类别**：决定 `lib/messages.ts` 用哪句模板渲染它。
 *
 * - `bypassFlag`：命令里那几枚**词**本身就是判据（git 的 `--no-verify` / 短簇里的 `n`）。
 * - `disasterTarget`：那几枚**目标**触发判据（`~`、`/`、`/etc`…）。
 */
export type FixRole = "bypassFlag" | "disasterTarget";

/** 一条拒绝的出路。`offending` 非空是**产出方契约**：两处产出点各自在组装前判过长度，
 *  类型本身允许空数组，新增产出点时由它负责。 */
export interface Fix {
  role: FixRole;
  /** 点名的词面，按首次出现序、去重。 */
  offending: readonly string[];
}
