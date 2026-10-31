// lib/secret-pattern-report.ts —— 非法密钥模式的**点名上报**（去重 + 有界）。
//
// 为什么单列：这个上报有两个调用点，而且必须共享同一张去重表——设置条目在 apply 时报一次
// （用户刚写完就能在日志里看见是哪条无效），拦截半在密钥面判定前再报一次（覆盖 apply 之后
// 才写进来的值，例如直接改 profile 行的 `config:`）。各写一份就会变成"同一件事的两个读数"：
// 一侧去重、另一侧刷屏，或一侧点名、另一侧静默。
//
// 判定链每次工具调用都会跑到这里，所以去重表**必须有界**：模式串来自用户配置，长驻进程里
// 反复改设置会持续往里加，而它只用于「这条已经报过别再刷」，丢一条旧记录最坏的后果是
// 多打一行日志，不是漏掉一条保护。
import { partitionSecretPatterns } from "./secret-patterns.ts";
import { lruPut } from "./lru.ts";

/** 已点过名的模式字面。 */
const logged = new Map<string, true>();

/** 去重表容量：一次设置里的无效模式数远小于它；超出的旧记录被淘汰只意味着日志可能重复一次。 */
const CAP = 64;

/** 逐条点名非法/超长的扩展密钥模式（同一条只报一次）。 */
export function reportRejectedSecretPatterns(patterns: readonly string[]): void {
  for (const pattern of partitionSecretPatterns(patterns).rejected) {
    if (!logged.has(pattern)) {
      lruPut(logged, pattern, true, CAP);
      console.warn(`[danger-guard] extraSecretPatterns 无效，本条未生效: ${pattern}`);
    }
  }
}
