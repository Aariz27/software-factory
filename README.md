# A1 Harness

A1 Harness is a `/command`-driven development harness for AI coding agents (Claude Code, Codex, Antigravity), installed into an existing project with one command:

```bash
npx create-software-factory
```

## What this contains

This package is **[AI Blueprint](https://github.com/aiblueprinthq/ai-blueprint) 1.9.0 by Brad Traversy (MIT), unchanged, plus our additions on top.** Everything under `template/` that is not listed below is AI Blueprint's: its 24 skills (`/feature`, `/implement`, `/check`, `/audit`, `/complete`, `/rollback`, …), its `AGENTS.md` / `CLAUDE.md`, and its `blueprint/` memory files (project plan, build plan, config, context, findings, history). Read their docs at [ai-blueprint.dev](https://ai-blueprint.dev/) — they apply here as written.

### Added on top of AI Blueprint

Status per item (done / in progress / pending) lives in `features.md` — the
single source of truth; this list is not duplicated with per-item status here.

- `npx create-software-factory` installer with CLI detection; starts the dashboard and opens it in the browser
- `/control-flow <arg>` — execution-order diagram (HTML)
- `/data-flow <arg>` — client/server data-movement diagram (HTML)
- `/error-flow <arg>` — every failure point on the happy path (HTML)
- `/io <arg>` — real inputs and outputs of a unit (HTML)
- `/prototype <doc>` — renders a hand-written doc's decisions as an HTML diagram
- Onboarding: assign a model (and backup) to each `/command`
- Per-command model routing to `claude -p` / `codex exec` / `agy -p`
- Usage-window tracking (5-hour / weekly %) with hard block + fallback
- Deterministic gate scripts (artifacts, claimed files, review verdict consistency, tests, commit-ready, diff, scope)
- Per-command write permissions and sandbox flags for child agents
- Bounded fix/revise loops in `/implement`
- Cross-model `/audit independent`
- Five hand-written docs (`blueprint/spec.md`, `data_contract.md`, `features.md`, `ux.md`, `ui.md`) + `/plan` → `build-plan.md` + `project-plan.md`
- Read-only localhost dashboard (`.harness/dashboard/`) — opens right after install; LIVE/STALE strip; now-running, agent tree, sandbox & permissions, blocked models, token spend, subscription windows, feature pipeline, git, gates, files touched, hardware, trace events

The four diagram commands take any free-text argument — a file, a function, a feature, a route, or a description like `/io LLM architecture in agents.py` — read the real code, and open a self-contained HTML diagram from `prototypes/diagrams/`.

## Install

Requires Node.js 22.13+. Run inside an app that is already scaffolded and is a git repository.

```bash
npx create-software-factory            # into the current directory
npx create-software-factory ./my-app   # into another directory
npx create-software-factory --dry-run  # show what would be written
npx create-software-factory --force    # overwrite files that already exist
npx create-software-factory --no-dashboard   # install without starting the dashboard
npx create-software-factory dashboard  # (re)start the dashboard for an installed project, http://localhost:4747
npx create-software-factory --port 4800  # any command: dashboard port (default 4747)
npx create-software-factory onboard    # choose which model runs each /command (writes blueprint/harness.json), then opens the dashboard
```

The dashboard is read-only and model-free: every number comes from files on disk (`blueprint/`, `blueprint/.state/run.json`, `usage.json`, `trace.db`), `git`, and the process table, re-read on every 2-second poll. If the server stops, the header turns STALE. The trace schema is `.harness/schema.sql`; the usage file shape is `.harness/usage.schema.json`. Needs Node 22.13+ for `node:sqlite` (trace panels say so when it is missing).

Existing files are never overwritten without `--force`. A manifest with a sha256 per managed file is written to `blueprint/.state/manifest.json`.

## Licence

MIT. AI Blueprint's original MIT licence is reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
