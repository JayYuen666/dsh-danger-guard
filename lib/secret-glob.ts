// lib/secret-glob.ts —— 密钥面 glob 的词干与 dotfile-only 判据。
//
// 单列原因：`lib/danger-rules.ts` 贴着 `max-lines` 的 2000 行预算；这两个判据是
// 纯字符串检查，不依赖密钥词表，也不读 fs。具体的 glob 探针仍留在判定层，
// 因为它们要复用已有的 `globRegExp`。

/** 含这些字面片段、且带 glob 元字符的目标有命中凭据面的可能。
 *  只做「词干命中」筛选，具体能否展开到凭据路径仍由判定层的 glob 探针确认；
 *  `.gitignore*` 这类 `\.git` 后接普通字母的写法不会命中，避免把普通 dotfile 通配误拦。 */
export const SECRET_GLOB_STEM_RE =
  /(?:\.env|\.git|\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|id_rsa|id_ed25519|id_ecdsa|credentials|service-account|token\.json|secrets?)(?=$|[^A-Z0-9])/iu;

/** `.*` / `.??*` 这类只由点与 glob 元字符组成的模式：它没有词干，但会匹配 `.env`/`.git`。 */
export function isDotfileOnlyGlob(form: string): boolean {
  if (!form.startsWith(".")) {
    return false;
  }
  const rest = form.slice(1);
  if (rest.length === 0) {
    return false;
  }
  for (const ch of rest) {
    if (!"*?[]".includes(ch)) {
      return false;
    }
  }
  return true;
}

/** glob 能否落到凭据面：用一组代表路径反查，而不是枚举目录内容（纯函数、无 fs 访问）。
 *  `~` 与家目录形态都试，覆盖 `~/.ssh/*` 与家目录下的绝对 `.env*`。 */
export const SECRET_GLOB_PROBES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.production",
  ".git",
  ".git/config",
  ".ssh",
  ".ssh/id_rsa",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "credentials.json",
  "service-account.json",
  "token.json",
  "secrets.yaml",
  "secrets.yml",
  "secrets.json",
  "server.pem",
  "server.key",
  "server.p12",
  "server.pfx",
  "server.keystore",
  "server.jks",
];
