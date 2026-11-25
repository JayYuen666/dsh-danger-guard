// lib/container-rules.ts —— docker / kubectl 子命令判定（纯函数，无 I/O）。
//
// 子命令是**第一个位置词**，不是任意位置出现过的词：`docker inspect prune` 与
// `kubectl get pod delete` 都不是删除操作。全局旗标的独立取值（`--context prod`）
// 要在定位子命令前跳掉，否则值会被误认成子命令。

import type { BashDenialKey } from "./danger-rules.ts";

/** 选项终止符：之后的词一律按位置参数读，不再当旗标。 */
const OPTION_TERMINATOR = "--";

/** kubectl 的 dry-run 值：只有 `client`/`server` 是预演；`none`/缺失/未知都会执行。 */
const KUBECTL_DRY_RUN_FLAG = "--dry-run";
const KUBECTL_DRY_RUN_VALUES: ReadonlySet<string> = new Set(["client", "server"]);

/** kubectl / docker 的全局取值旗标：`--namespace prod` 与 `--namespace=prod` 都要跳。
 *  kubectl 的日志旗标与 `--kuberc` 同样取独立值：漏登记时取值会落进位置词，
 *  真删除会被读成「子命令 = 取值」而整条漏判。 */
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
  "--as-uid",
  "-v",
  "--v",
  "--vmodule",
  "--username",
  "--password",
  "--profile",
  "--profile-output",
  "--log-flush-frequency",
  "--log-file",
  "--log-dir",
  "--stderrthreshold",
  "--log-backtrace-at",
  "--request-timeout",
  "--cache-dir",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--tls-server-name",
  "--kuberc",
]);
const DOCKER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-H",
  "--host",
  "--context",
  "-c",
  "--config",
  "-l",
  "--log-level",
  // TLS 三件套也取独立值：漏了它们 `docker --tlscacert ca.pem system prune` 的
  // 子命令会读成 ca.pem，prune 整条漏判。
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);

function kubectlDryRun(words: readonly string[]): boolean {
  let dryRun = false;
  let skipValue = false;
  for (const [index, word] of words.entries()) {
    // `--` 之后全是传给子命令的位置参数：`kubectl delete pod foo -- --dry-run=client`
    // 里那个 `--dry-run=client` 是给 foo 的参数，不是 kubectl 自己的旗标，把它读成
    // 预演会让一次真实删除被判成 dry-run。
    if (word === OPTION_TERMINATOR) {
      break;
    }
    if (skipValue) {
      // 上一枚旗标取独立值：它的取值不是 kubectl 自己的旗标。少了这一步，
      // `kubectl delete pod x --as-group --dry-run=client` 里那枚 `--dry-run=client`
      // 会被读成预演（实际它是 `--as-group` 的值），一次真实删除就此漏判。
      skipValue = false;
    } else if (word === KUBECTL_DRY_RUN_FLAG) {
      // 不带 `=` 的写法后面可以跟独立取值（`--dry-run client`）：取值为 client/server 才是预演，
      // 缺失或未知值都会执行。该取值不是旗标，跳过它。
      const value = words[index + 1];
      dryRun = value !== undefined && KUBECTL_DRY_RUN_VALUES.has(value.toLowerCase());
      skipValue = true;
    } else if (word.startsWith(`${KUBECTL_DRY_RUN_FLAG}=`)) {
      dryRun = KUBECTL_DRY_RUN_VALUES.has(
        word.slice(KUBECTL_DRY_RUN_FLAG.length + 1).toLowerCase(),
      );
    } else if (word.startsWith("-")) {
      const equals = word.indexOf("=");
      skipValue = equals === -1 && KUBECTL_VALUE_FLAGS.has(word);
    }
  }
  return dryRun;
}

/**
 * 跳过全局旗标及其独立取值后的位置词（附着值 `--flag=value` 只占一词）。
 *
 * 约定：`words[0]` 是 docker/kubectl 命令词本身；包装词（`sudo`/`env`）与路径前缀
 * 由调用方先剥离，否则子命令会读成包装词，整族判定静默失效。
 */
function commandWordsOf(words: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let skipValue = false;
  let afterTerminator = false;
  for (const word of words.slice(1)) {
    if (afterTerminator) {
      // 终止符之后的词都是位置参数：继续按旗标读会把「值是子命令」的形态读反
      // （`kubectl -- delete` 与 `kubectl delete` 在子命令位置上等价）。
      out.push(word);
    } else if (skipValue) {
      skipValue = false;
    } else if (word === OPTION_TERMINATOR) {
      afterTerminator = true;
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

/** `docker <group> prune` / `docker prune`；资源名恰好叫 `prune` 不算。
 *  `buildx prune` 是真实的构建缓存清理（与 `builder prune` 同族）。 */
const DOCKER_PRUNE_GROUPS: ReadonlySet<string> = new Set([
  "system",
  "image",
  "container",
  "volume",
  "builder",
  "buildx",
  "network",
]);

/** `docker compose` 自己那层带取值的全局旗标：`-f compose.yml`、`--profile prod`。
 *  它们出现在 `compose` 与子命令之间，不跳取值会把 compose 文件名读成子命令。 */
const COMPOSE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--project-directory",
  "--env-file",
  "--profile",
  "--ansi",
  "--progress",
  "--parallel",
]);

/** 取一枚词的旗标主名（`--volumes=true` 的 `=` 之前那一段）。 */
const flagNameOf = (word: string): string => {
  const equals = word.indexOf("=");
  return equals === -1 ? word : word.slice(0, equals);
};

/** `docker compose down -v/--volumes`：删掉 Compose 文件里声明的**命名卷**，数据不可撤销。
 *
 *  只认 `down` 子命令之后的 volume 旗标：`docker compose up -v` 不是删数据，
 *  `docker compose config --volumes` 也只是打印清单。`--volumes=false` 不删。
 *  `-v` 在 compose 的其它子命令里含义不同，所以位置必须钉在 `down` 之后——
 *  这是"按真实 CLI 语义判"而不是"见到 -v 就当删卷"。
 */
function composeVolumeFlagAfterDown(args: readonly string[]): boolean {
  let sawDown = false;
  let skipValue = false;
  let afterTerminator = false;
  for (const word of args) {
    const flag = flagNameOf(word);
    const equals = word.indexOf("=");
    if (skipValue) {
      skipValue = false;
    } else if (!afterTerminator && word === OPTION_TERMINATOR) {
      afterTerminator = true;
    } else if (!afterTerminator && word.startsWith("-")) {
      const volumeOn =
        sawDown &&
        (flag === "-v" || flag === "--volumes") &&
        (equals === -1 || word.slice(equals + 1).toLowerCase() !== "false");
      if (volumeOn) {
        return true;
      }
      skipValue = equals === -1 && COMPOSE_VALUE_FLAGS.has(flag);
    } else if (!sawDown && word === "down") {
      sawDown = true;
    }
  }
  return false;
}

function composeDownVolumes(words: readonly string[]): boolean {
  // 先剥 docker 自己的全局旗标，再确认第一个位置词是 compose。
  const [sub] = commandWordsOf(words, DOCKER_VALUE_FLAGS);
  if (sub !== "compose") {
    return false;
  }
  const composeAt = words.indexOf("compose");
  return composeVolumeFlagAfterDown(words.slice(composeAt + 1));
}

export function dockerDanger(words: readonly string[]): BashDenialKey | undefined {
  const [sub, next] = commandWordsOf(words, DOCKER_VALUE_FLAGS);
  if (composeDownVolumes(words)) {
    return "composeDownVolumes";
  }
  return sub === "prune" || (sub !== undefined && DOCKER_PRUNE_GROUPS.has(sub) && next === "prune")
    ? "dockerPrune"
    : undefined;
}

export function kubectlDanger(words: readonly string[]): BashDenialKey | undefined {
  const [sub] = commandWordsOf(words, KUBECTL_VALUE_FLAGS);
  return sub === "delete" && !kubectlDryRun(words) ? "kubectlDelete" : undefined;
}
