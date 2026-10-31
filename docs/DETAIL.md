# Danger guard

Stops destructive commands before they run, and requires evidence before a file is edited for the first time in a session.

## What the card changes

- **Interception** — `enabled` (on by default) keeps the whole guard active; turning it off skips both the command blocking and the first-edit gate, so every command and edit passes. `factGateEnabled` (on by default) requires reading the file and running a reference search before its first edit, and the strictness follows the risk tier.
- **Verdicts** — `judgeStats` (on by default) folds each verdict's duration and input size into a rolling summary line in the host log, and with lesson-loop installed sends one `judge-cost` pass per verdict (face, milliseconds, character count — never the command text or a path); off hides those samples and changes no verdict. `maxDenies` (1–5, default 2) is how many consecutive non-converging denials one target may collect: once they exceed that count the write is released with a warning, and while a `read` gap is still open the quota is withheld — reading the file is the one piece of evidence no quota waives. A verdict that cannot be determined asks the user instead and consumes nothing. `strictMode` (off) ignores the risk tiers so every code file's first edit runs the full probe; document-extension targets and non-edit tools stay outside the gate either way.
- **Tiers** — `smallEditChars` (200) is the inclusive ceiling of the low tier and `bigEditChars` (2000) the exclusive floor of the top one: a 200-character write is low, a 2000-character one is mid. Size never decides alone — creating a file, touching an exported signature, a manifest/lockfile/assembly path, or a write whose size cannot be measured all promote to the top tier. The low tier only asks for `read`; reference search is asked from the middle tier up, and the layer probes only at the top. `refSearchTools` (`grep`, `glob`, `zg_search`) lists which tools count as reference-search evidence — a name that appears only in `refSearchStrictTools` (`zg_search`) earns nothing, that list switches on the strict root-and-path-signature criterion. If `smallEditChars` is not below `bigEditChars`, the middle tier is unreachable and both values fall back to the built-in pair with a one-time warning.
- **Your own patterns** — `extraTestDirs`, `extraDevServerWords`, `extraDevRunArgs` extend the test-layer, dev-server and dev-command recognisers; `extraSecretPatterns` adds secret patterns, validated and compiled one by one when the settings entry is assembled — a fragment that fails validation never takes effect and is named in the log, and the same string is named only once even when it is written after that assembly.

Everything on the card is read per decision, so a change takes effect on the next call without restarting the host.

## Values without a knob on the card

Nothing here needs a restart: every value written through the card is read again at the next decision.

One value has no knob on the card: `preflightEnabled` is volatile, but the settings entry registers its form with `auto: false`. It is reachable through the settings row `config:`, not through the card.

## What it needs from outside

Nothing it cannot supply itself — no external CLI, interpreter or credential. `zg_search` counts as evidence only when the Zvec indexed search plugin is installed.

## Further detail

The rule vocabulary, the permission-preset behaviour, the sandbox deferral and the known boundaries are in the package README (`README.md` / `README.zh-CN.md`).
