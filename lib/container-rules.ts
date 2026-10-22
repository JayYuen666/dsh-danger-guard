// lib/container-rules.ts —— docker / kubectl 子命令判定（纯函数，无 I/O）。
//
// 子命令是**第一个位置词**，不是任意位置出现过的词：`docker inspect prune` 与
// `kubectl get pod delete` 都不是删除操作。全局旗标的独立取值（`--context prod`）
// 要在定位子命令前跳掉，否则值会被误认成子命令。

import type { BashDenialKey } from "./danger-rules.ts";

/** kubectl 的 dry-run 值：只有 `client`/`server` 是预演；`none`/缺失/未知都会执行。 */
const KUBECTL_DRY_RUN_FLAG = "--dry-run";
const KUBECTL_DRY_RUN_VALUES: ReadonlySet<string> = new Set(["client", "server"]);

function kubectlDryRun(words: readonly string[]): boolean {
  let dryRun = false;
  for (const word of words) {
    if (word === KUBECTL_DRY_RUN_FLAG) {
      dryRun = false;
    } else if (word.startsWith(`${KUBECTL_DRY_RUN_FLAG}=`)) {
      dryRun = KUBECTL_DRY_RUN_VALUES.has(
        word.slice(KUBECTL_DRY_RUN_FLAG.length + 1).toLowerCase(),
      );
    }
  }
  return dryRun;
}

/** kubectl / docker 的全局取值旗标：`--namespace prod` 与 `--namespace=prod` 都要跳。 */
const KUBECTL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-n",
  "--namespace",
  "--context",
  "--kubeconfig",
  "-s",
  "--server",
  "--token",
  "--user",
  "--cluster",
  "--as",
  "--as-group",
  "--request-timeout",
  "--cache-dir",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--tls-server-name",
]);
const DOCKER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-H",
  "--host",
  "--context",
  "-c",
  "--config",
  "-l",
  "--log-level",
]);

/** 跳过全局旗标及其独立取值后的位置词（附着值 `--flag=value` 只占一词）。 */
function commandWordsOf(words: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let skipValue = false;
  for (const word of words.slice(1)) {
    if (skipValue) {
      skipValue = false;
    } else if (word.startsWith("-")) {
      const equals = word.indexOf("=");
      const flag = equals === -1 ? word : word.slice(0, equals);
      skipValue = equals === -1 && valueFlags.has(flag);
    } else {
      out.push(word);
    }
  }
  return out;
}

/** `docker <group> prune` / `docker prune`；资源名恰好叫 `prune` 不算。 */
const DOCKER_PRUNE_GROUPS: ReadonlySet<string> = new Set([
  "system",
  "image",
  "container",
  "volume",
  "builder",
  "network",
]);

export function dockerDanger(words: readonly string[]): BashDenialKey | undefined {
  const [sub, next] = commandWordsOf(words, DOCKER_VALUE_FLAGS);
  return sub === "prune" || (sub !== undefined && DOCKER_PRUNE_GROUPS.has(sub) && next === "prune")
    ? "dockerPrune"
    : undefined;
}

export function kubectlDanger(words: readonly string[]): BashDenialKey | undefined {
  const [sub] = commandWordsOf(words, KUBECTL_VALUE_FLAGS);
  return sub === "delete" && !kubectlDryRun(words) ? "kubectlDelete" : undefined;
}
