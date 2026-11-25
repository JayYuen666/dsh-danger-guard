// lib/gh-rules.ts —— `gh` 的远端破坏判定（从 danger-rules 拆出）。
//
// 这些动作不写本地文件，宿主的文件沙箱不管网络，所以必须由插件补一次用户拍板。
// 独立成模块既让规则表靠近文件行数上限时还能加规则，也让 gh 的匹配只依赖命令词，
// 不必把整份 shell 判定链拖进来。

import type { BashVerdict } from "./danger-rules.ts";
import type { ShellToken } from "./command-segments.ts";

/** `gh` 的远端破坏子命令对（`repo delete`、`release delete`…）。 */
const GH_DESTRUCTIVE_PAIRS = new Set([
  "repo delete",
  "repo archive",
  "repo rename",
  "repo transfer",
  "release delete",
  "release delete-asset",
  "project delete",
  "codespace delete",
  "run delete",
  "cache delete",
  "secret delete",
  "variable delete",
  "label delete",
  "issue delete",
  "gist delete",
]);

/** `gh api` 的 DELETE 写法：`-X DELETE` 的紧凑形都在这里。 */
const GH_API_DELETE_RE = /^(?:-X|--method)=?DELETE$/iu;
/** GraphQL 的 mutation 关键字（区分 `query` 与 `mutation`；`mutation` 也可能出现在变量名里，
 *  但真 GraphQL 文档里它作为操作类型出现时总是独立词，宁可多问一次也不静默放行写操作）。 */
const GRAPHQL_MUTATION_RE = /\bmutation\b/u;
/** 路径前缀剥掉，只留 basename；gh 的路径前缀不构成逃逸。 */
const PATH_PREFIX_RE = /^.*[\\/]/u;

/** 跳过 `gh` 的全局旗标与取值，返回子命令词的起始下标（`gh -R owner/repo repo delete`
 *  里 `-R` 的取值不能被当成 `repo` 子命令）。 */
function commandStart(tokens: readonly ShellToken[]): number {
  const valueFlags = new Set(["-R", "--repo", "--hostname", "-H", "--config"]);
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    /* v8 ignore next 2 —— 循环条件已保证下标在界内 */
    if (token === undefined) {
      break;
    }
    const word = token.value;
    if (word === "--") {
      return index + 1;
    }
    if (!word.startsWith("-")) {
      break;
    }
    index += valueFlags.has(word) ? 2 : 1;
  }
  return index;
}

/** 只看命令头 basename 是否 `gh`；路径前缀不构成逃逸。 */
function isGhHead(head: ShellToken): boolean {
  return head.value.replace(PATH_PREFIX_RE, "").toLowerCase() === "gh";
}

/** `gh` 的远端破坏：删仓库/发布/运行记录、绕过分支保护合并、`api -X DELETE`。 */
export function ghDestroyDanger(
  head: ShellToken,
  tokens: readonly ShellToken[],
): BashVerdict | undefined {
  let result: BashVerdict | undefined;
  if (isGhHead(head)) {
    const words = tokens.slice(commandStart(tokens)).map((token) => token.value);
    const pair = words.length >= 2 ? `${words[0]} ${words[1]}` : "";
    const apiDelete =
      words.some(
        (word, index) =>
          (word === "-X" || word === "--method") && words[index + 1]?.toUpperCase() === "DELETE",
      ) || words.some((word) => GH_API_DELETE_RE.test(word));
    if (
      GH_DESTRUCTIVE_PAIRS.has(pair) ||
      (pair === "pr merge" &&
        words.some((word) => word === "--admin" || word === "--admin=true")) ||
      (words[0] === "api" && apiDelete) ||
      (pair === "api graphql" && words.some((word) => GRAPHQL_MUTATION_RE.test(word)))
    ) {
      result = { key: "ghDestroy" };
    }
  }
  return result;
}
