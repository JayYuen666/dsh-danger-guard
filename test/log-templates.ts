// test/log-templates.ts —— 本包算子可见日志的模板片段（与源码逐条手工对齐）。
// 账本用它判「这条日志是不是源码里现存的模板」；新增 console.* 若没有对应片段，
// 跑测时那条日志就会被判未认领（见 test/setup-logs.ts）。这里不读盘：规则面
// （node/no-sync 等）不该为了测试脚手架开口子，所以清单的增删与源码同步是显式改动。
//
// 一条消息只登记一枚片段，且登记它**带 `[danger-guard]` 前缀的那半**：认领判据是
// `LOG_TEMPLATES.some(片段被文本包含)`，同一条消息的两半都能认领它，留两半只会让清单
// 读起来像两条独立承诺。片段一律单行——setup-logs 拼文本时把空白压成单空格，含换行的
// 片段永远不会命中，那是一条静默失效的判据（该校验也写在那里）。
//
// `Object.freeze` 是运行期的：`readonly string[]` 只挡编译期，而这份账本的可信度取决于
// 它不被就地改动（push/splice 会让未认领的日志悄悄变成"已认领"）。
export const LOG_TEMPLATES: readonly string[] = Object.freeze([
  "[danger-guard] fact-gate:",
  "[danger-guard] judge stats (",
  "[danger-guard] slow judge (",
  "[danger-guard] lessonLoop pass failed:",
  "[danger-guard] lessonLoop report failed:",
  "[danger-guard] save failed:",
  "[danger-guard] settings 数组字段",
  "[danger-guard] 设置面（条目 danger-guard-settings）不可用，本轮回落内置默认底座；",
  "[danger-guard] smallEditChars（",
  "[danger-guard] extraSecretPatterns 无效，本条未生效:",
  "[danger-guard] 预检失败，本轮不递证据、交回下游决定:",
  "[danger-guard] sessionProjections register failed, falling back to log scan:",
  "[danger-guard] sessionProjections.register returned neither a disposer nor a handle,",
  "[danger-guard] sessionProjections stateOf threw, falling back to log scan:",
  "[danger-guard] sessionProjections dispose failed:",
  "[danger-guard] sessionProjections effect registration failed, reader withdrawn:",
  "[danger-guard] 判定统计读面没能注册（",
]);
