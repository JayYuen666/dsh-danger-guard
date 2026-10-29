# Danger guard

Stops destructive commands before they run, and requires evidence before a file is edited for the first time in a session.

## What the card changes

- **Interception** — `enabled` (on) turns the whole guard off, so every command passes; `factGateEnabled` (on) requires reading the file and running a reference search before its first edit, and the strictness follows the risk tier.
- **Verdicts** — `judgeStats` (on) only samples how long each verdict takes; it changes no rule. `maxDenies` (1–5, default 2) lets a write through once it has been denied that many times without any evidence. `strictMode` (off) ignores the tiers and runs the full probe on every file.
- **Tiers** — `smallEditChars` (200) and `bigEditChars` (2000) set the boundaries between the low, middle and top tier. `refSearchTools` (`grep`, `glob`, `zg_search`) lists which tools count as reference-search evidence; `refSearchStrictTools` (`zg_search`) applies the strict root-and-path-signature rule to the ones named.
- **Your own patterns** — `extraTestDirs`, `extraDevServerWords`, `extraDevRunArgs` extend the test-layer, dev-server and dev-command recognisers; `extraSecretPatterns` adds secret patterns, compiled when the plugin loads, and a pattern that fails to compile is named in the log rather than dropped.

Everything on the card is read per decision, so a change takes effect on the next call without restarting the host.

## Restart-only and card-missing values

Nothing here needs a restart: every value written through the card is read again at the next decision.

One value has no knob on the card: `preflightEnabled` is volatile, but the settings entry registers its form with `auto: false`. It is reachable through the settings row `config:`, not through the card.

## What it needs from outside

Nothing it cannot supply itself — no external CLI, interpreter or credential. `zg_search` counts as evidence only when the Zvec indexed search plugin is installed.

## Further detail

The rule vocabulary, the permission-preset behaviour, the sandbox deferral and the known boundaries are in the package README (`README.md` / `README.zh-CN.md`).
