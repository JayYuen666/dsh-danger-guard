// test/log-templates.ts —— 本包算子可见日志的模板片段（与源码逐条手工对齐）。
// 账本用它判「这条日志是不是源码里现存的模板」；新增 console.* 若没有对应片段，
// 跑测时那条日志就会被判未认领（见 test/setup-logs.ts）。这里不读盘：规则面
// （node/no-sync 等）不该为了测试脚手架开口子，所以清单的增删与源码同步是显式改动。
export const LOG_TEMPLATES: readonly string[] = [
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
  "个非字符串项，已忽略",
  "连续无证据拒绝达上限，配额放行（maxDenies）",
];
