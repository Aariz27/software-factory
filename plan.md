# My Software Factory — Plan

Status: planning. Created 2026-09-18, revised 2026-09-18. Supersedes `software-factory/My Version/PLAN.md`.

## What I am building
ai-blueprint, plus our own additions on top. The host CLI the user is typing into (Claude Code, Codex or Antigravity) stays in control of the loop — there is no custom Python engine. SSSF is inspiration only: we import none of its code.

## Requirements (as stated by me)
1. **Install:** one command — `npm i -g`, `npx <name>`, or a shell one-liner. Our own installer.
2. **Onboarding:** uses the subscriptions already logged in on this Mac (Claude Code, Codex, Antigravity, local Ollama). No API keys. No re-sign-in.
3. **Build loop:** ai-blueprint's `/feature → /implement → /check → /audit → /complete` loop, run by typing `/` commands in the host CLI.
4. **Memory:** everything from ai-blueprint — `blueprint/project-plan.md`, `build-plan.md`, `config.json`, `context/` (overview, coding-standards, ai-interaction, current-feature, findings, review), `history/{features,fixes,rollbacks}/`, `.state/run.json`.
5. **Token tracking:** subscription usage windows (5-hour and weekly %), polled by script, plus per-command token counts in SQLite.

## Features added on top of ai-blueprint
1. **Our own installer** — one `npx` / shell command that drops ai-blueprint's skills + memory files + our additions into a project, then immediately starts the localhost dashboard (feature 6) and opens it in the browser, before any `/` command has run.
2. **Onboarding** — detects which CLIs are logged in (`claude`, `codex`, `agy`, `ollama`), lists the models each exposes, and asks the user which model (and backup) runs each `/` command, writes the choice into `blueprint/config.json`, then starts the localhost dashboard (feature 6) and opens it in the browser so the user sees the factory from the first minute. Done once per project.
3. **Per-command model routing** — each `SKILL.md` starts by reading `config.json`; if the assigned model is not the host, the host delegates the step to that CLI headless (`agy -p`, `codex exec`, `claude -p`) via Bash and reads back the result. Example: `/plan` → Opus; `/implement` → Gemini via `agy -p`.
4. **Usage-window tracking** — a script polls `claude -p "/usage"`, `agy -p "/usage" --output-format json`, and `codex app-server` JSON-RPC `account/rateLimits/read` every 60 seconds with no stored state; a skill reads the result before delegating; a model past the threshold (e.g. 95%) is blocked, the command falls back to its backup model, and the switch is reported. Tokens per command are recorded in SQLite. No dollar-cost column.
5. **Per-model prompt tuning** — after onboarding assigns a model to a command, a script rewrites that skill's prompt text using the matching guide in `~/.claude/skills/prompting/` (Fable 5, Opus, Sonnet 5, Qwen 2.5 exist; GPT and Gemini guides do not yet). A script decides which guide applies, not an LLM.
6. **Localhost visualizer** — reads `blueprint/.state/run.json` and our SQLite trace (model used, tokens, gate results per command). `run.json` stays as the quick "what just finished" record. The page carries a live-status strip at the top that states, from real checks and not from a static label: (a) LIVE / STALE — the server is running and the page received data in the last N seconds; (b) which repo path it is reading and the last time `blueprint/` or `run.json` changed on disk; (c) which agents/CLIs it can see (`claude`, `codex`, `agy`, `ollama` found on this machine; any child agent currently running with its pid). It opens right after install (feature 1) and again from onboarding (feature 2).
7. **Deterministic gates as scripts** (same pattern as blueprint's `run-state.mjs`), called by the skills:
   - declared artifact files exist and are not empty;
   - every file the builder claims it changed exists on disk;
   - a review with approved=true has no blocking items and no unmet requirements; approved=false names at least one problem;
   - the test command exits 0 (last N chars of output kept on failure);
   - commit refused when `git status --porcelain` is empty;
   - the real `git diff` is captured for the reviewer instead of the builder's description.
8. **Per-command write permissions** — delegation passes `--permission-mode` / `--allowedTools` / `--disallowedTools` to the child CLI (Codex and agy equivalents to be verified); a git-diff check script runs afterwards as backstop.
9. **Bounded loops written into `/implement`** — max 3 test→fix rounds, max 2 review→revise rounds; counter kept in `run.json`.
10. **Cross-model review** — `/audit independent` routes to a different model than the one that built.
11. **Five hand-written docs + `/plan`** — done. The five skeletons live in `blueprint/` (`spec.md`, `data_contract.md`, `features.md`, `ux.md`, `ui.md`, plus `blueprint/mockups/`). `/plan` reads them and writes BOTH `blueprint/build-plan.md` and `blueprint/project-plan.md` (project-plan filled from the five docs so Blueprint's `/overview` keeps working unchanged). It shows the draft once and writes on approval, like Blueprint's `/discovery`.
12. **`/prototype <doc>`** — ai-blueprint's `/prototype` takes one argument naming any of the five hand-written documents (`/prototype ui`, `/prototype data_contract`) and opens an HTML page showing the result of that document's decisions as a diagram (flow chart, tree, data model — whatever fits).
13. **`/control-flow`, `/data-flow`, `/error-flow`, `/io`** — written, in `.claude/skills/`. Each takes any free-text argument (`/io main.py`, `/io LLM architecture in agents.py`), reads the real code, and renders one self-contained HTML diagram (dark background, monospace, yellow happy path, red failures), saved to `prototypes/diagrams/` and opened in the browser.
14. **Hooks skip headless children** — parent-process check as in `~/.claude/hooks/snapshot-checkpoint.sh` (skips when the parent is `claude -p` / `--print`), applied to every hook that must not fire inside a child.

## Hand-written project documents
Every project has five documents the user writes by hand before `/plan` runs:
1. `spec.md` — the technical decisions the user makes. Skeleton already exists: `~/.claude/skills/project-spec/project-spec-SKILL.md` (`/project-spec`).
2. `data_contract.md` — the data model the project needs. Currently a skill (`~/.claude/skills/data-contract/SKILL.md`, `/data-contract`); to be turned into a skeleton file for the factory.
3. `features.md` — every feature the app needs.
4. `ux.md` — UX decisions, written however the user wants; my own style is the user's point of view as they move through the app, split into the different routes they can take.
5. `ui.md` — UI direction: images, words, or both.

(The `features.md` in this folder's root is the factory's own feature list, not a project's.)

## Source material
- ai-blueprint v1.9.0 stock install: `~/Documents/software-factory/blueprint-test/` (24 commands as `SKILL.md`, memory files in `blueprint/`, `run-state.mjs`).
- SSSF v1 stock install (inspiration only, no code reused): `~/Documents/software-factory/sssf-test/`.
- Research reports (scratchpad): `research-blueprint.md`, `research-sssf-and-plan.md`, `research-web.md`.

## Conflicts still open
None. The Verify command lives only on the `Verify:` line of `AGENTS.md` Commands (decided 2026-09-18; `template/AGENTS.md` says so); gate scripts read it from there.

## Dashboard design
Chosen 2026-09-18 from a six-way design tournament: **rail + graph** — fixed 260px left rail (LIVE dot, repo, CLIs, subscription bars, blocked models, hardware), main area with a "now running" hero (40px command, segmented step bar) and the agent tree as an SVG node graph (host → headless children; child-less processes packed 4 per row), then a 2-column card grid. Dark `#0d0f12`, monospace, amber `#e0b44a` for active, red for fail/blocked/hot, green for pass/live.
