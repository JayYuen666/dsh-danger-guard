<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-danger-guard@main/icon.svg" width="96" height="96" alt="dsh-danger-guard logo" />
</p>

<h1 align="center">dsh-danger-guard</h1>

<p align="center"><em>Dangerous shell commands and credential edits, physically refused before dispatch.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-danger-guard"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-danger-guard?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-danger-guard"><img src="https://img.shields.io/npm/dm/@jayyuen66/dsh-danger-guard?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/JayYuen666/dsh-danger-guard/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-danger-guard/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-简体中文-658EFF?style=flat-square" alt="简体中文" /></a>
</p>

**A pre-execution guard for [dsh](https://github.com/deepseek-ai/deepseek-harness): dangerous shell commands and credential edits are physically refused before dispatch, and the model is handed the reason plus a working way out.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Verify it is live](#verify-it-is-live)
- [What it does not provide](#what-it-does-not-provide)
- [Enabling it in dsh](#enabling-it-in-dsh)
- [What the rules block](#what-the-rules-block)
- [Settings](#settings)
- [What each permission preset blocks](#what-each-permission-preset-blocks)
- [Known boundaries](#known-boundaries)
- [Data and privacy](#data-and-privacy)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **It blocks, it does not advise.** The decision lives in the synchronous predicate on `ctx.tools.guard`: returning a string rejects that call. The host turns the reason into the call's error result, so the model reads "why this was refused, and what to write instead" - not a silent failure.
- **Three defences:**
  - Dangerous `bash` / `pwsh` commands (`bashVerdictOf` in `lib/danger-rules.ts`): git hook bypass, catastrophic `rm`, download-and-run, long-running dev servers, the git destruction family, and the infrastructure destruction family.
  - Credential and secret paths on edit/write tools (`secretPathDeny`) - matched by **argument key shape**, never by tool name, because tool names drift with the provider.
    - The editor path face has a **second** refusal key, `opaqueTarget`: a target longer than the judgable length limit is neither confirmed nor cleared as a credential, so it is denied with a "paste the path to the user, do not retry verbatim" message. Same principle as `nestedShellUnconfirmed` on the bash side - **cannot judge is not the same as safe**. (An over-long *command* resolves to `nestedShellUnconfirmed` instead.)
  - The first-edit fact gate (`lib/fact-gate.ts`): an edit that has not read its target, or that touches a risky surface without layer evidence, gets refused with the missing evidence attached.
    - "Has read" counts **successful** calls only: the evidence ledger joins `tool/call` to `tool/result` by `callId`, and a call without one has unknown status and does **not** count (the host appends the call before dispatching, so a call that never ran or already failed looks exactly like a successful one in the log).
    - "Which revision was read" lives in `lib/read-basis.ts`: the observation baseline and the staleness point are one record, and it is committed **only after a successful result** - a failed or blocked read cannot advance the baseline and thereby swallow an external change. Once an external change is attributed it stays in force until a successful read actually lands (or the preflight hands the body over in a deny reason).
- **Preflight gathers that evidence itself** (two faces on two waterfalls, split by when evidence actually becomes visible):
  - Face A, on `tools/post-execute`: a read-only inspection (`read` / `view` / `str_replace_editor view`) returns its reference surface *with that read's result* (`PostToolDecision.accept{additionalContexts}`), so the model sees "who references this" before its next edit.
  - Face B, on `tools/pre-execute`: a write that never read its target gets the target content and reference surface written into that call's denial reason (`PreToolDecision.deny{reason}`); an identical retry then passes on the delivery watermark. The physical stop stays before dispatch, so "see it before you change it" is not negotiated away.
  - This is why not `agent.inject()`: that API queues context for the *next* pre-step, while decisions are made per step - evidence would arrive *after* the edit landed.
  - The scan is bounded by hard caps (files, directories, per-file bytes, findings) and merges cancellation with a wall clock; the platform never abandons a pending pre-execute promise, so unbounded work is not an option.
  - **The credential rule**: "the traversal was not truncated" **or** "references were found". A correctly scoped search by the model is itself not exhaustive, so demanding exhaustiveness here would be stricter than the gate. But "zero hits **and** truncated" grants nothing - every false negative lives there, and half an "I looked" is worse than none.
  - **A zero-hit layer conclusion requires that subtree to be fully read**: the scan records files it walked past **without reading their bodies** (over the size cap, quarantined credentials, unreadable). If the target layer still holds any of those - or the traversal itself was truncated - that layer gets no "0 hits" conclusion. Otherwise a truncation *inside* the layer would claim "no references touch this layer" while the file that references it sits past the budget. A found hit is exempt: evidence of existence needs no exhaustiveness.
- **Every refusal carries its way out.** `BashVerdict` holds a structured `Fix`: the git bypass names the offending flags, catastrophic `rm` names the offending targets (excluding the safe ones). The model gets "change these words and it passes", not a verdict.
- **On an `ask` hit, one read-only blast-radius rehearsal runs** (fixed command table, no model input interpolated) and its output is rendered per locale into the approval request's `reason` and `displayReason`. Empty output only means the probe printed nothing; **it does not prove the original action changes nothing**. A command carrying `-C`/`--git-dir`/`--work-tree`, a failed policy resolution, an unknown session cwd, or host-truncated output falls back to a blind ask.
- **Repeats are not re-reported** (`AskDeduper`): same session + same rule key + same command text no longer goes back to the lesson bus and its rehearsal is not recomputed - but the verdict and the prompt stay exactly as they were. What this suppresses is lesson-card fragmentation, not a user interruption; deduplication must never become a silent pass.

### How a verdict is decided

- Only `bash` and `pwsh` command strings are judged; a non-string `command` passes (no guessing). The string is split at `;`, `&&`, `||`, `|`, newline, `&`, `(`, `)`, backtick, with no splitting inside quotes.
- Segment splitting, word lexing, the structure view and the unclosed-quote check are **four projections of one POSIX state machine** (`lib/command-segments.ts`). Two different machines would give the same string opposite verdicts in different predicates.
- Wrapper words (`sudo`, `env`, `time`, `nice`, `stdbuf`, `timeout`, `taskset`, `watch`, `setsid`, `doas`, `pkexec`, `nohup`, `exec`, `command`, `xargs`, `parallel`, leading `VAR=x`), binary path prefixes (matched by basename, so `/usr/bin/sudo` is no escape), quoting, and backslash continuations are **not** escape hatches. A quoted flag or quoted command word is a working spelling: `git commit "--no-verify"` really skips the hook, and `"rm" -rf ~` judges like the unquoted form.
- Because a per-tool option table can never be complete, a wrapper-led segment also treats every following word position as a candidate command head.
- **Principle: when unsure, let it through** - with one exception, **an execution face you cannot see**. An unextractable nested `-c` / `eval` body, nesting past the drill-down limit, a segment head that is a non-shell interpreter running a code string (`python3 -c`, `node -e`, `perl -e`, `php -r`…), or a command past the judgable length limit all become `nestedShellUnconfirmed`: the way out is explicit user confirmation, or rewriting it as one plain, quote-balanced layer.
- **Severity ordering**: when one command holds both an `ask` segment and a `deny` segment, the whole string resolves as `deny` (the scan continues until it has one). Without this, the leading `ask` would end the scan early and the later catastrophe would never be judged.

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-danger-guard
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-danger-guard`. The package is on the public npm registry, so installation needs no credentials and no scoped-registry line.

- **Requires Node.js `>= 22.12`.** This is an ESM-only package; that Node floor is what makes `require()` of an ESM entry work at all, which is why `engines.node` is declared.
- **Requires host `dsh` at the `0.2.1-rc.3` line.** The requirement the host actually reads is `engines.dsh` (`^0.2.1-rc.3`), and it **decides alone**: `evaluatePluginCompatibility` returns on the `engines.dsh` branch before it ever looks at `peerDependencies`, so the `@deepseek-ai/dsh*` peers are not consulted for compatibility here. Prereleases participate in the comparison. A host on any `0.2.x` satisfies that range; one on `0.3.0` or later does not, and needs the explicit risk grant `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`. The exact pins in `peerDependencies` are a separate, compile-time discipline (enforced by `test/publish-manifest.test.ts`): this plugin's types and nominal brands are coupled to the host ABI, and silently following it upward is how a second copy of the host type surface ends up loaded.
- **No `@deepseek-ai/*` under `dependencies`, by contract** (`test/publish-manifest.test.ts` enforces it). Consumer profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package under `dependencies` is materialized as a **real directory** next to the copy the running host already loaded. `@deepseek-ai/dsh-tools` keys its tool-runtime scheduler with a plain `Symbol` (not `Symbol.for`), so symbol identity is per module instance: the host reads the scheduler off the profile copy, gets `undefined`, and **every native tool call throws** - while build, typecheck and coverage gates stay green right up to that moment. Peers and devDependencies never enter the profile, so they cannot produce a second copy.
- **Host packages imported for value stay externalized.** `@deepseek-ai/dsh-brand` and `@deepseek-ai/schemastery` are value imports (`brandNumber`, `import Schema from …`). The externalization list in `build-host.mjs` reads `dependencies` ∪ `peerDependencies`; a devDependencies-only entry would let the bundler inline the official function body, giving this package its own copy of the official constructor. A required peer satisfies both halves: the specifier stays external, and the profile installs nothing extra. `zod` is a plain dependency (imported for value by `lib/tool-ledger.ts`).
- **The artifact is not minified on purpose.** `test/build-host.test.ts` pins the bare specifiers in `host.js` and their absence from `settings.js`; minification would remove those strings and turn the assertions permanently green.
- **TypeScript declarations ship** (`types/host.d.ts`, `types/settings-host.d.ts`, plus the `lib/` declarations they reference), each subpath carrying a `types` condition so `tsc` resolves them under `node16` / `bundler`. `./client` deliberately has none (it is a browser UMD shell) and neither does `./cordis.patch.yml` (the host loader reads it as a file).
- Build artifacts are not committed; `prepack` rebuilds them, so what ships is always what the current source produces.

### Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names imported at runtime, and the host then reports `N entries did not activate` together with `does not provide an export named ...` at boot - the package installs fine and never loads, and no per-repository CI run can see it.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **Mounted**: the settings page lists a "danger-guard danger block" row, and `dsh --profile web --dump-config` shows this package's layer.
   - `--dump-config` is the only accepted "it is in the layer stack" signal, and it is **not read-only** - it rewrites that profile's root assembly file. Pass/fail therefore reads layer lines from stdout **and** checks stderr separately; an unmatched patch target appears only on stderr, so the exit code alone proves nothing.
   - A layer line may read `# == <layer>` or `# == <layer>, patched by <path>`; any check must accept the second form or it will report "not installed" about a layer that is really there.
2. **Blocking**: in a preset that blocks it (read-only, workspace write and full access all deny it; auto review allows it), ask the agent to run `git commit --no-verify`. The call itself must fail with `Error: <reason>` and name a way out. A "no change in behaviour" result there means the gate is not mounted, not that the rule is lenient.
3. **Settings**: open the card, toggle a value, `Save` becomes enabled, and the write returns 200. On a non-loopback page the controls are disabled with a read-only status.
4. **Stats readout**: opening the card (plus a manual Refresh) invokes one Remote method on the `dangerGuardStats` namespace. It is read on demand and never subscribed - verdict stats only move while the agent works, and a value cached across a host reconnect is exactly the staleness this design avoids.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

Worth knowing before you look for them:

- **It registers no tools.** There is no `guard_status` or similar model tool - the whole surface is the `ctx.tools.guard` predicate plus the two preflight waterfall subscriptions.
- **It exposes no HTTP endpoint of its own.** The single Remote namespace it registers, `dangerGuardStats`, exists only to feed the settings card's readout through the host's `/api` gateway (a no-argument, JSON-result method). There are no other routes, no `/api/dangerGuard…` surface to call from outside, and no CSRF or trust gate in this package - the host's gateway owns all of that.
- **It adds no CLI subcommand.** `dsh danger-guard …` does not exist.
- **It keeps no file on disk** and makes no network call (see Data and privacy for the single read-only subprocess).
- What it *does* consume optionally: the `lessonLoop` bus (report/pass), `sessionProjections` for the tool ledger, `fs` for preflight evidence, and `workingDirectory` for the current directory base. Every one of those is an optional child injection - a profile without them keeps blocking, it just falls back.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- Bundle form: `dsh.bundle.patch` in `package.json` points at `cordis.patch.yml`, and `dsh plugin add/remove` maintains the assembly layer.
- The patch carries **two lines (bulkhead)**: `- id: danger-guard` (the guard half, **no `Config`**, name points at the package root) and `- id: danger-guard-settings` (the settings half, strict schema, name points at the `./settings` subpath).
  - Only the first line brings up the card: the host scans `dsh.client` on **bare package-name** entries only, so the settings line's subpath name is deliberate rather than an oversight.
  - The card loads on the web platform only, as "danger-guard danger block" in the settings plugin list.
- Deployment defaults sit on the **settings row's** `config:`; precedence is settings-card runtime value > row config > the built-in base (`BUILTIN_BASE` in `lib/settings-schema.ts`).
  - An explicit `undefined` in the row does not override the base, and illegal numbers (e.g. `maxDenies: 0`) fall back to the built-in default - `0` would switch the fact gate off entirely.
  - Defaults on the guard row are inert by design: that entry takes no `config` argument at all.
- Failures go the conservative way. Only the settings row carries the strict schema, so one broken user-layer config line fails **that entry alone**; the guard entry falls back to the built-in base and warns once. `apply` throws only when the settings surface itself is missing. A missing `tools` service does not throw (the registration is optional-chained), but `tools` is in `inject`, so cordis never activates the entry and the startup diagnostic names it - "no gate mounted, and the host says so".

## <img src="https://api.iconify.design/lucide/ban.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What the rules block

| Family | Blocks | Passes / way out |
|---|---|---|
| Git hook bypass | `--no-verify` and its unambiguous abbreviations on `commit` / `push` / `merge` / `cherry-pick` / `rebase` / `am`; the short `-n` on `commit` / `am`; `git -c core.hooksPath=` and `git config core.hooksPath <dir>` (including `--global` and the `=` form). Git arguments are walked **by role**: short clusters expand letter by letter, a value-taking option's argument is never read as a flag, everything after `--` is a pathspec, and `-c`'s value is what gets checked | `git push -n` (dry run), `git cherry-pick -n` (no commit), `git rebase -n` (no stat), `git config --get` / `--unset` / `--list core.hooksPath`, and that text appearing inside a commit message |
| Catastrophic `rm` | The threshold is **per command-word track**. On the POSIX/cmd track, recursion **and** force are required, the one exception being an upper-case `-R` anywhere in a short cluster, which is disaster-level on its own. On the `Remove-Item` / `ri` track (and, under the Windows dialect, its `rm` / `del` / `rd` aliases), **any Recurse form alone** against a disaster target is enough - no `-Force` required, because that form silently deletes a whole tree. Targets that count: `/`, `~` and `~/…`, the literal home path, `$HOME` and every `${HOME…}` form, `.` / `..` / `../…`, whole trees under system and user directory prefixes, and absolute globs / brace expansions, with the path lexically normalized first. The command-word side covers `pwsh` / `cmd` delete forms as well, matched case-insensitively | Relative cleanup inside the project (`rm -rf node_modules`, `./dist`), force-only (`rm -f ~`) or lower-case recursion-only (`rm -r ~`) on the POSIX track - this slot is keyed by **spelling**, and the asymmetry is deliberate; `Remove-Item -Recurse ./build`; `/var` and `/tmp` (deliberately excluded: a false block there costs more than a miss); a different segment such as `/usrx` |
| Download-and-run | A shell or script interpreter after `curl` / `wget` / `fetch`, including through `sudo`, a path-prefixed interpreter, `xargs`, or `parallel`, and the reversed process substitutions (`sh <(curl …)`, `python <(curl …)`, `source <(curl …)`, `. <(curl …)`). The executor set covers `sh` / `bash` / `zsh` / `dash` / `ksh`, `pwsh` / `powershell` / `iex` / `Invoke-Expression`, and Python / Node / Perl / Ruby / PHP / Lua / osascript because they all execute stdin as code. **`$( )` inside double quotes** is an execution face too, so `echo "$(curl x \| sh)"` is denied. The PowerShell family counts on both ends: `Invoke-WebRequest` / `Invoke-RestMethod` / `iwr` / `irm` feeding `pwsh` / `powershell` / `iex` / `Invoke-Expression` judges like `curl … \| sh` | `curl -O`, `curl … \| jq .name`, `cat x \| grep foo`, `ls \| sh` with nothing downloaded, `source ./setup.sh`, and a literal `\|` inside quotes |
| Long-running dev server | Bare `vite` / `next` / `nuxt`, `webpack serve` / `--watch`, `cargo watch`, `npm` / `pnpm` / `yarn` / `bun run dev` / `watch` / `serve` / `start`, any script name rooted in `dev`, and a long-running package via `npx` / `bunx` / `exec` / `dlx` (a version selector does not create a new identity). `vite build --watch` still blocks. The one-shot exemption is read **only in subcommand position** | `npm test`, `npm run build`, `vite build`, `next build`, `webpack --config prod.js`, `cargo run` / `check` / `test`, `vitest run`, and confirmed one-shot subcommands (`vite optimize`, `next lint`, `nuxt prepare`) |
| Secret path edits | Any file inside `.ssh` / `.gnupg` / `.aws` / `.kube` / `.docker`, **also in relative form**; the `id_rsa` / `id_ed25519` / `id_ecdsa` stems with their copy suffixes; names ending `.pem` / `.key` / `.p12` / `.pfx` / `.keystore` / `.jks`; the whole `.env` family; `.envrc` / `.npmrc` / `.pypirc` / `.netrc` / `.pgpass` / `.git-credentials`; `credentials.json`, `service-account*.json`, `token.json`; `secret(s).yaml` / `yml` / `json`; `.git/config`. Targets are normalized first and resolved against the session cwd when the host supplies one; backslashed Windows paths judge the same | `.env.example` / `.sample` / `.template` / `.defaults`, `api.key.ts`, `main.pem.tsx`, `.gitignore`, `mysecrets.yaml`, `secrets.yaml.bak`, `myid_rsa` |
| Git destruction family (all `ask`) | `reset --hard` (including unambiguous abbreviations such as `--har`), `checkout -- <path>` / `checkout .` / `checkout -f` / `checkout <rev> <path>`, `restore <path>` (`--staged` alone is **not** judged - it only moves the index), `clean -f*` (including `-xf` / `-x -f`), `stash drop` / `clear`, `branch -D` / `--delete --force`, `push -f` / `--force` / `--force-with-lease` / `+refspec`. Short-option values are parsed **per subcommand** (`push -u` and `clean -x` are boolean, `commit -m` and `clean -e` take values). These share **one walk** with the no-verify rule | Every one of them has a legitimate use. Hard-refusing a "dangerous but sometimes correct" operation pushes the model into workarounds - after `git reset --hard` is refused it may just `rm` those files, a worse spelling that nothing blocks. So these ask instead |
| Infrastructure destruction family (all `ask`) | `terraform destroy`, `terraform apply -auto-approve`, `docker … prune`, `kubectl delete`, and the migration family (`manage.py migrate`, `prisma migrate`, `rails db:migrate`, `alembic upgrade`, `flyway migrate`, `typeorm migration:run`, `knex migrate:latest`…) | `plan -destroy` (a plan only prints), a bare `apply` (terraform asks by itself), `kubectl --dry-run=client` / `server` (only those values; `none` executes), read-only verbs (`prisma migrate status`, `flyway info`) and tool-specific dry-run flags (`manage.py --plan` / `--sql`, `alembic --sql`). The migration family additionally accepts launcher prefixes such as `uv run` / `poetry run` / `pnpm exec` / `python -m`, while still rejecting a command-shaped string in documentation |

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

Namespace `danger-guard-settings` equals the settings entry id; defaults are `BUILTIN_BASE`.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch; `false` silences all three verdicts, lesson reports included |
| `factGateEnabled` | boolean | `true` | Turns off only the first-edit fact gate; dangerous commands and secret paths still block |
| `preflightEnabled` | boolean | `true` | Pre-edit preflight. Off only restores "refuse, then the model gathers evidence" - no criterion is dropped |
| `judgeStats` | boolean | `true` | Samples verdict duration and input size: a rolling summary line locally, plus one `judge-cost` pass per verdict when lesson-loop is installed (face / ms / character count only). The card's stats readout is independent of it, and it does not gate the `judgeMs` fields that a denial report always carries |
| `maxDenies` | natural, 1-5 | `2` | Consecutive non-converging denials per target before the quota releases it with a warning |
| `strictMode` | boolean | `false` | `true` ignores the risk tiers and runs the full probe on the first edit of every code file |
| `smallEditChars` | natural, >=1 | `200` | A write of at most this many characters without signature keywords is small: only read is required |
| `bigEditChars` | natural, >=2 | `2000` | A write above this size is a rewrite and escalates to the full probe |
| `extraTestDirs` | string[] | `[]` | Appends test-layer directory names; append-only |
| `extraDevServerWords` | string[] | `[]` | Appends long-running command heads; append-only |
| `extraDevRunArgs` | string[] | `[]` | Appends run script names; append-only |
| `extraSecretPatterns` | string[] | `[]` | Appends secret path regex fragments (one per line on the card; invalid ones are skipped with a warning); append-only, no allowlist |
| `refSearchTools` | string[] | `["grep","glob","zg_search"]` | Which search tools count as reference evidence; clearing it means none count. The instructions shown to the model only name tools actually registered on this host |
| `refSearchStrictTools` | string[] | `["zg_search"]` | The subset judged by the strict "root + relative path" criterion |

**There is no allowlist anywhere in this package.** Every `extra*` list and `refSearchTools` can only tighten. A false positive therefore has exactly three routes: turn `enabled` (or only `factGateEnabled`) off temporarily, take the `maxDenies` quota release, or rewrite the command as the denial text suggests.

## <img src="https://api.iconify.design/lucide/layers.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What each permission preset blocks

The host presets bundle a sandbox mode with an approval policy, and the official sandbox governs **file effects only**: network and process visibility are outside its vocabulary, and even the tightest mode merely refuses writes and allows every read. This package covers those two faces - and yields the write-side rules whenever the sandbox genuinely governs them.

| Rule family | Read-only | Workspace write | Full access | Auto review |
|---|---|---|---|---|
| `noVerify` (git hook bypass) | deny | deny | **deny** | allow |
| `rmrf` (encloses a writable root / home / root) | allow¹ | deny | allow | **deny** |
| `rmrf` (the sandbox fully covers this target) | allow | allow | allow | allow |
| `pipeShell` (download-and-execute) | allow | **deny** | allow | **deny** |
| `devServer` (long-running server) | allow² | allow² | allow² | allow² |
| `nestedShellUnconfirmed` (cannot tell) | ask | allow | allow | allow |
| Git destruction family | ask | ask | allow | allow |
| Infrastructure destruction family | ask | ask | allow | allow |

¹ Read-only refuses every write, so nothing can be partially deleted - every target is fully covered and the whole family goes to the host, which returns its official denial marker plus the `sandbox_permissions` escalation path.
² The host's cooperative timeout and `promoteOnTimeout` already govern long-running commands, so this rule is no longer a safety property and goes to the host entirely.

- **Full access means zero guardrails - but only in the "cannot ask" arm, and with one exception.** The shipped preset pins this mode to `approval: never`, so choosing it means "do not block, do not ask": hits only increment the card's stats and the model sees no change, except `noVerify`, which stays denied because bypassing a git hook is unrelated to the sandbox and would otherwise be the only way around the guard. `danger-full-access + ask` (a custom combination, or the default when the preset service is absent) **can still ask**, and that arm reuses the workspace-write column - silently allowing while the sandbox restricts nothing is the exact opposite direction.
- **Auto review keeps exactly two deterministic hard stops** (`rmrf` and `pipeShell`). The reviewer is an LLM, its allow is not the user's approval, and this preset's sandbox restricts nothing; everything else goes to the reviewer so the same action is never asked about twice.
- **One hard rule: whether asking is possible decides whether `ask` can land.** `never` returns `rejected` deterministically *before any answerer runs* (with the host swapping in its own wording), so a rule that should ask is collapsed to `deny` here - carrying a dedicated paragraph on "this preset cannot ask, switch to one that can" so the model is not left with a bare "no".
- **When no sandbox mode is readable** (no confining executor, or an unexpected service shape) the guard takes a conservative column of its own: write-side rules block, "cannot tell" still asks. It deliberately does not reuse the workspace-write column, which relies on the sandbox stopping part of the damage.
- The type makes two properties **structural**: a missing tier is a compile error, and one key belonging to both tiers is impossible. The latter matters because `tools.guard` is synchronous while approval is async, and the host **runs the guard again after approval passes** - a key claimed by both tiers would show up as *the user pressing Allow and still being refused*.

### The sandbox deferral, and why only `rmrf` gets one

- Deferral happens only when the executor reports it confines, **its own reported default mode is itself blocking**, the resolved mode is not full access, **and** containment fails in both directions: the target must neither enclose a writable root nor lie inside one.
- That last clause is deliberately strict. `workspace-write` means files *inside* the workspace are writable, so `rm -rf ~` (workspace under `~`) **wipes the workspace first** and only then hits the boundary - a sandbox is a path allow-list and offers **no atomicity**. So `~`, `/`, `.` and `..` are never deferred; only things like `rm -rf /etc/foo` or `rm -rf ~/Downloads` are.
- `secretPath` gets no deferral at all: the local and sandboxed filesystem backends are mutually exclusive mounts and there is no readable face for "which one is composed", so the discipline is **not to guess**. The costs are asymmetric anyway - a false block sends the user to their terminal, a miss leaks credentials and is hard to notice.

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

Registered honestly, one entry per class, each pinned by a test at its current verdict. Full case-by-case reasoning lives next to those tests rather than here.

- **`cmd` as a segment head is not judged.** `cmd.exe /c rd /s /q C:\Windows` and its path-prefixed or extension-less spellings still escape: `cmd` is in neither the delete command-word table nor the drill-down list, and its quoting rules (`%VAR%`, `^` continuations, `&` that does not split segments) are far enough from POSIX that reading its `/c` body with the POSIX lexer would open a batch of false blocks. The **PowerShell family is closed instead**: the `-c` / `-Command` body of `pwsh` / `powershell` is extracted with join semantics, judged segment by segment, and forced onto the Windows glyph track inside that body. `-File` / `-EncodedCommand` without a code flag means the thing to run is by design not in the input, so it becomes a confirmation request.
- **Dry-run modifiers are not read** (`Remove-Item -WhatIf -Recurse ~` still denies). `-WhatIf` / `-Confirm` only make PowerShell print what it would do; treating dry-run as an exempt class is a policy decision nobody has made yet, so the current verdict is pinned as-is.
- **Bare `~user` without a separator is not judged.** Whether `rm -rf ~root` expands depends on the machine's account table, and this guard neither touches the filesystem nor looks up users. The delimited form `~user/…` *is* covered.
- **A PATH-level interpreter running a code string always asks.** `python3 -c "print(1)"` is benign but still needs confirmation - that is the price of "invisible means not silently allowed".
- **`bash` redirection writes are outside the fact gate.** The gate hangs on the `edit` / `write` tools; `printf > f`, `tee`, `cat >`, `sed -i` bypass the "gather evidence first" requirement. Covering them means parsing shell redirection and in-place editors.
- **Some `ask`-tier forms are blind.** A bare `git checkout <path>` is lexically indistinguishable from switching branches (the explicit `checkout <rev> <path>` form is judged), and `git push --force` does not resolve its target branch. Writes made through shell redirection and edits to a target that changed outside the session keep a small residual window.
- **Msys/Cygwin mount forms are not translated.** On a real Windows host `rm -rf /c/Windows/System32` needs a mount table, which is a new dependency plus a new design decision.

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Aspect | Content |
|---|---|
| Nothing is written, nothing is fetched | The verdict chain does no filesystem writes and no network calls; the only output surfaces are `console.*` warnings and the text sent back to the model. The **one** exception is the `ask`-tier blast-radius rehearsal below |
| The subprocess call (the only one) | On an `ask` hit, one **fixed read-only command** from `BLAST_COMMANDS` runs in the session cwd through the host's `ctx.shell`, so it shares the bash tool's sandbox and credential-scrubbed environment. `git status` uses `--no-optional-locks` to suppress optional locks and index refreshes, and still runs under the session's resolved `sandboxPolicy`. Output is capped and rendered per locale into the approval request's `reason` and `displayReason`. Any failure (executor absent, uncertain repository target, failed policy resolution, non-zero exit, timeout, cancel, host-truncated output, unexpected shape) falls back to a blind ask - no retry, no substitute command. The command table is fixed and **interpolates no model input**; the original command is used only for the target/policy skip checks |
| What it reads | The tool ledger from the session event history (primary path: a projection unit read synchronously inside the guard; the fallback is a full event scan with byte-identical verdicts); `statSync` of the target and of layer directories; path resolution plus one content read per declared target on the preflight write face; the home directory from `os.homedir()` |
| What it keeps | Entirely in process memory - fact-gate shards, verdict ledgers, and the counters the card reads - gone when the host exits, with no file left under the dsh data directory |
| The only two things that leave, both switchable | With lesson-loop installed, the `report` payload carries cwd, session id, the matched command text or target path, and the denial text, plus `judgeMs` and (on a secret-path hit) the list of resolved target forms. Each verdict additionally emits one `judge-cost` pass carrying three numbers only - face, milliseconds, character count, never a command text or a path. **Only the `judge-cost` pass is what `judgeStats` governs** - the `judgeMs` / `judgeLength` / `resolvedPaths` fields inside a denial report are always sent |

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question | Answer |
|---|---|
| It blocked a legitimate command. | There is no allowlist, so the routes are the three listed under Settings: disable temporarily, take the quota release, or rewrite the command as the denial text suggests. |
| The fact gate keeps refusing. | It credits only actions that succeeded. Point the search origin at an ancestor such as the project root as the message says; if another search plugin is in play, add its tool name to `refSearchTools`; when evidence is unreachable, take the quota release or turn `factGateEnabled` off temporarily. |
| It did nothing at all. | Check the settings row, then `dsh --profile web --dump-config` for this package's layer **and** stderr. The host must be on the supported line. A missing `tools` service means the entry never activated - the startup diagnostic names it. |
| How do I know a refusal is from this package? | The denial text names the rule family and a way out, and appears as that tool call's error result. Rules never modify or drop the call; they either reject it or hand over an approval request. |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check     # typecheck → lint → client build → host build → types → tests → format
pnpm test          # vitest, with coverage
```

- `test/` splits into three layers, and the split is about **the class of defect a stub cannot see**: guessing the host's shape while the verdict stays self-consistent.
  - **Unit** tests drive hand-written `ctx` stubs: the predicates themselves - word lists, tiers, gaps, state machines, wording.
  - **Integration** tests drive the **real `ToolRuntime`** from the official testkit, with fixtures that really read and write, dispatched through `ctx.tools.execute`: waterfall order and materialization - pre-execute before guard, a deny becoming an `isError` result, `additionalContexts` coexisting with another plugin's.
  - **Point-to-point** tests drive the **real agent loop and session store**, with only the model scripted: that the reference surface attached to a read is visible in the very request where the model decides its next edit, and that a secret file's body appears in no request at all.
  - The division between the last two is a measured fact, not a preference: executing a tool directly does not append to the session log, so "the model read or searched it" can only be credited in the point-to-point layer.
- Coverage thresholds are **100%** across four metrics, so a new branch needs cases that reach it.
- Assertions use discriminative markers that skip a **shared prefix** - the action-checklist, on-the-spot-handover and attached-evidence texts all begin with the same tag, so "take the first word as the marker" would make two mutually exclusive assertions true at once. The marker helpers live in one place.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-danger-guard](https://github.com/JayYuen666/dsh-danger-guard).

The fact gate and the command rules are **ported in mechanism** from ECC (MIT, © Affaan Mustafa) - [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records the upstream files, what differs in this package, and the item-by-item comparison showing that no upstream code, word list or message text was copied.

