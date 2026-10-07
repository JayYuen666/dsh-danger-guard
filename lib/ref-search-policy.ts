// lib/ref-search-policy.ts —— 引用取证的**口径面**：哪些检索工具算取证、各自按哪些参数判。
//
// 为什么从 lib/fact-gate.ts 拆出来：这一族回答的是"怎样算探过引用面"，与状态机决定"还缺哪几项"
// 无关，而本包吃它的生产侧有好几个——host 的取证记账（`refPolicyOf` 每次判定现读设置）、
// 设置底座 `BUILTIN_BASE` 的默认名单、客户端卡的回退显示，以及 lib/gap-directives.ts 给模型的
// 指令文案（内置默认兜底）。此前它们都从 fact-gate.ts 取用，只因那里是第一处落点。
//
// 指令里点名的**检索工具名不许写死**：口径由 host 随缺项传进来的这份策略现算（设置项
// refSearchTools/refSearchStrictTools 派生）。写死就等于门禁认一套、模型看到另一套，
// 拒绝理由失去可执行路径——那正是本包发布给第三方前必须拆掉的东西。

/**
 * 检索取证的**判据口径**（按工具名配置，见 host 的 refSearchTools/refSearchStrictTools）。
 * 修复前这两套口径是 host 里 `call.name === "zg_search"` 与其余分支的硬编码，等于把门禁
 * 凭证只发给"本机另一插件注册的那个工具名"——第三方检索工具（rg_search/semgrep_scan…）
 * 无论怎么搜都不被计入，拒绝理由与模型能走的路彻底脱节。口径本身一字未改，改的是"谁来选"：
 *  - `"pattern"`：签名取 `pattern`/`include`，作用域取 `path`/`file_path`（原生 grep/glob 形态）。
 *  - `"strict-relative"`：签名取 `query`/`queries`/`fts`/`vector`，作用域取 `root`，且签名
 *    可凭**目标相对路径**命中（语义检索类命中面宽，只比 basename 会让 index.ts 到处顶包——
 *    修复前 zg_search 那条严格判据）。
 */
export type RefSearchCriterion = "pattern" | "strict-relative";

/** 生效的检索取证判据：工具名 → 口径的映射。**记账与给模型的指令共用同一份**（单源）。 */
export interface RefSearchPolicy {
  /** 计入取证的工具名 → 口径；名单之外的工具不给凭证。 */
  readonly criteria: ReadonlyMap<string, RefSearchCriterion>;
  /** 走 pattern/include 口径的名字（按配置序，渲染指令用）。 */
  readonly patternTools: readonly string[];
  /** 走严格相对路径口径的名字。 */
  readonly strictTools: readonly string[];
}

/** 默认可计入引用取证的检索工具名 = 修复前 host 硬编码的三个（默认判定逐条不变）。 */
export const DEFAULT_REF_SEARCH_TOOLS: readonly string[] = ["grep", "glob", "zg_search"];
/** 默认走严格口径的子集 = 修复前那个 `zg_search` 单分支。 */
export const DEFAULT_REF_SEARCH_STRICT_TOOLS: readonly string[] = ["zg_search"];

/**
 * 由两份名单构造判据映射。**只有 refSearchTools 里的名字计入取证**，严格名单只切换口径：
 * 把陌生名字只写进严格名单不会给它开任何凭证——否则"顺手配上一个还没装的插件名"就会
 * 静默扩大凭证面（本包是安全拦截插件，配置面只能收紧不能放宽）。
 */
export const refSearchPolicyOf = (
  tools: readonly string[],
  strict: readonly string[],
): RefSearchPolicy => {
  const strictNames = new Set(strict);
  const criteria = new Map<string, RefSearchCriterion>();
  const patternTools: string[] = [];
  const strictTools: string[] = [];
  for (const tool of tools) {
    if (strictNames.has(tool)) {
      criteria.set(tool, "strict-relative");
      strictTools.push(tool);
    } else {
      criteria.set(tool, "pattern");
      patternTools.push(tool);
    }
  }
  return { criteria, patternTools, strictTools };
};

/** 内置默认判据：上下文未带策略时的兜底（文案宁可退回默认，也不能退成"谁都不认"）。 */
export const DEFAULT_REF_SEARCH_POLICY: RefSearchPolicy = refSearchPolicyOf(
  DEFAULT_REF_SEARCH_TOOLS,
  DEFAULT_REF_SEARCH_STRICT_TOOLS,
);
