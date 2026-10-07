// test/log-templates.ts —— 本包算子可见日志的模板片段（由源码扫出，勿手改）。
// 账本用它判「这条日志是不是源码里现存的模板」；新增 console.* 若没有对应片段，
// 跑测时那条日志就会被判未认领（见 test/setup-logs.ts）。这里不读盘：规则面
// （node/no-sync 等）不该为了测试脚手架开口子，且模板漂移应当是一次显式的改动。
export const LOG_TEMPLATES: readonly string[] = [
  "[danger-guard] fact-gate:",
  "[danger-guard] lessonLoop pass failed:",
  "[danger-guard] lessonLoop report failed:",
  "[danger-guard] save failed:",
  "[danger-guard] settings 数组含",
  "[danger-guard] 设置面（条目 danger-guard-settings）不可用，本轮回落内置默认底座；",
  "[danger-guard] 跳过非法的 extraSecretPatterns 正则:",
  "个非字符串项，已忽略",
  "连续无证据拒绝达上限，配额放行（maxDenies）",
];
