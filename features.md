# Features established so far

1. One-command install (`npm i -g` / `npx` / shell one-liner), built by us.
2. Onboarding uses the subscriptions already logged in on this Mac (Claude Code, Codex, Antigravity, local Ollama). No API keys, no re-sign-in.
3. ai-blueprint's full set of `/` commands and its development loop (`/feature → /implement → /check → /audit → /complete`, plus the rest of the 24).
4. ai-blueprint's memory system: `blueprint/project-plan.md`, `build-plan.md`, `config.json`, `context/`, `history/`, `.state/run.json`.
5. Plan and spec files are written by hand; a coder agent writes the diff; tests run as a script; a reviewer agent checks the diff against the spec; commit only after a gate.
6. A Python engine owns the loop (sequencing, retries, gates, acceptance).
7. Agent roles (planner, builder, scout, reviewer, documenter); each `/` command maps to a role.
8. One adapter per CLI: `claude -p`, `codex exec`, `agy -p`, Ollama. `pi` is no longer required.
9. Role → model assignment decided once per project at onboarding, using the 22 model cards, written into the project config. Example: `/plan` → Opus, `/implement` → Gemini via `agy -p`.
10. Usage-window token tracking: script polls each subscription's 5-hour / weekly usage every 60 s, blocks a model past the threshold, switches the role to its backup, and reports the switch. Per-run token counts stored in SQLite.
11. Per-model prompt rewriting: after onboarding, a script rewrites each role's prompt files using the matching guide in `~/.claude/skills/prompting/`.
12. Localhost visualizer, rebuilt on our own trace store.
13. SSSF's deterministic checks carried over (artifact gates, envelope parsing, verdict consistency, tests-pass gate, bounded fix/revise loops, fail-by-default phases, empty-diff commit refusal, real-diff capture, SQLite tracing).
14. Role file-permissions enforced before the write via each CLI's permission flags (Claude Code permission-mode style); SSSF's after-the-fact git-diff rollback kept as a backstop.
15. Global hooks skip headless child agents (parent-process check, as `snapshot-checkpoint.sh` already does).
