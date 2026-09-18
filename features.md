# A1 Harness — features checklist

Built on AI Blueprint 1.9.0 (unchanged). Everything below is ours. Detail per item is in `plan.md`.

## Done
- [x] 1. `npx` installer (`create-software-factory`) — copies template, writes manifest, detects `claude` / `codex` / `agy` / `ollama`, prints the A1 Harness banner and next steps.
- [x] 2. `/control-flow <arg>` — execution-order HTML diagram.
- [x] 3. `/data-flow <arg>` — client/server data-movement HTML diagram.
- [x] 4. `/error-flow <arg>` — every failure point on the happy path, HTML diagram.
- [x] 5. `/io <arg>` — real inputs and outputs of a unit, HTML diagram.
- [x] 6. Five hand-written docs shipped as skeletons in `blueprint/`: `spec.md`, `data_contract.md`, `features.md`, `ux.md`, `ui.md` (+ `blueprint/mockups/`).
- [x] 7. `/plan` — reads the five docs, writes `build-plan.md` + `project-plan.md`, refuses to invent a missing doc.
- [x] 8. Public GitHub repo with attribution to AI Blueprint; installable via `npx github:Aariz27/software-factory`.

## Pending
- [x] 9. **Read-only localhost dashboard** — server + page reading `blueprint/.state/run.json`, the `blueprint/` markdown files, git, and our SQLite trace. Panels: now running, agent tree, sandbox & permissions, blocked models, token spend, git branches/worktrees, feature pipeline, gate results, files touched, hardware. Live-status strip: LIVE/STALE, repo path + last change, CLIs and child agents seen.
- [x] 10. **Installer opens the dashboard** right after copying files (`--no-dashboard` to skip; `npx create-software-factory dashboard` to restart). Onboarding re-open: pending with 11.
- [ ] 11. **Onboarding** (`/onboard` extension) — detect logged-in CLIs, read the 22 model cards, assign one model per `/` command, write to `blueprint/config.json`.
- [ ] 12. **`sf run` wrapper** — launches `claude -p` / `codex exec` / `agy -p` / Ollama with the assigned model, streams their JSON output, logs every tool call + tokens + flags to SQLite, assigns unique session IDs.
- [ ] 13. **Per-command model routing** — each `SKILL.md` reads `config.json` and delegates through the wrapper when the assigned model is not the host.
- [ ] 14. **Usage-window poller** — every 60 s: `claude -p "/usage"`, `agy -p "/usage" --output-format json`, `codex app-server` rate limits → one JSON file; blocks a model past the threshold, falls back to its backup, reports the switch.
- [ ] 15. **Hooks** (`.claude/settings.json`): `PreToolUse` usage hard block; `PreToolUse` scope block (deny `Edit`/`Write` outside the paths in `current-feature.md`); `UserPromptExpansion` / `PostToolUse` / `SubagentStart|Stop` / `Stop` → SQLite + `run.json` writes (replaces Blueprint's "LLM calls `run-state.mjs`"). Parent-process check so hooks skip headless children.
- [ ] 16. **Per-command write permissions + sandbox** — wrapper maps `config.json` permissions to `--permission-mode` / `--allowedTools` / `--disallowedTools` (Claude), `-s` / `-a` (Codex), `--mode` / `--sandbox` (agy); git-diff check script afterwards as backstop.
- [ ] 17. **Deterministic gate scripts** — artifacts exist & non-empty; claimed changed files exist; review verdict consistent; test command exits 0; commit refused on empty diff; real `git diff` captured for review.
- [ ] 18. **Bounded loops in `/implement`** — max 3 test→fix, max 2 review→revise, counter in `run.json`.
- [ ] 19. **Cross-model `/audit independent`** — routes to a different model than the builder.
- [ ] 20. **Per-model prompt tuning** — script rewrites each skill's prompt text from `~/.claude/skills/prompting/` for the assigned model.
- [ ] 21. **`/prototype <doc>`** — Blueprint's `/prototype` takes `spec` / `data_contract` / `features` / `ux` / `ui` and renders that doc's decisions as an HTML diagram.
- [ ] 22. **Race-condition guards** — one lock file per repo for write-capable commands; one git worktree per feature; single writer per store (atomic `run.json`, SQLite WAL); parallel subagents only when read-only.
- [ ] 23. **"Files in scope" section in the feature spec** — needed by the scope block (15) and the scope gate (17).
- [x] 24. **Verify command source of truth** — the `Verify:` line in `AGENTS.md` Commands is the only home; gate scripts read from it.
- [ ] 25. **npm publish** as `create-software-factory` (or rename to `create-a1-harness`).
