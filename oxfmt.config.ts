// 手工维护（此前注释声称的生成脚本在本仓不存在，值来源也不在版本控制内——那句声明已删）。
// 这两条忽略的是 Markdown 与 jsonc：正文按原样发布，被格式化改写就会与发布物分叉。
// 运行期产物（host.js / settings.js / client.js / types/）不必列在这里：oxfmt 未显式给
// --ignore-path 时按 .gitignore 与 .prettierignore 跳过（其 --help 自述），本仓的产物全在
// .gitignore 里。
export default {
  // 根级与子目录分开写：`**/` 能否匹配零级目录取决于 glob 实现的 gitignore 语义，
  // 显式补 `*.md`/`*.jsonc` 让根目录 README、CHANGELOG 的忽略不依赖那一条假设。
  ignorePatterns: ["**/*.md", "**/*.jsonc", "*.md", "*.jsonc"],
};
