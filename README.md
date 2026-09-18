# A1 Harness

A1 Harness is a `/command`-driven development harness for AI coding agents (Claude Code, Codex, Antigravity), installed into an existing project with one command:

```bash
npx create-software-factory
```

## What this contains

This package is **[AI Blueprint](https://github.com/aiblueprinthq/ai-blueprint) 1.9.0 by Brad Traversy (MIT), unchanged, plus our additions on top.** Everything under `template/` that is not listed below is AI Blueprint's: its 24 skills (`/feature`, `/implement`, `/check`, `/audit`, `/complete`, `/rollback`, …), its `AGENTS.md` / `CLAUDE.md`, and its `blueprint/` memory files (project plan, build plan, config, context, findings, history). Read their docs at [ai-blueprint.dev](https://ai-blueprint.dev/) — they apply here as written.

### Added on top of AI Blueprint

| Addition | Status |
|---|---|
| `npx create-software-factory` installer with CLI detection | done |
| `/control-flow <arg>` — execution-order diagram (HTML) | done |
| `/data-flow <arg>` — client/server data-movement diagram (HTML) | done |
| `/error-flow <arg>` — every failure point on the happy path (HTML) | done |
| `/io <arg>` — real inputs and outputs of a unit (HTML) | done |
| Onboarding: assign a model to each `/command` from model cards | planned |
| Per-command model routing to `claude -p` / `codex exec` / `agy -p` | planned |
| Usage-window tracking (5-hour / weekly %) with hard block + fallback | planned |
| Per-model prompt tuning | planned |
| Deterministic gate scripts (artifacts, claimed files, verdict consistency, tests, empty-diff commit) | planned |
| Per-command write permissions and sandbox flags for child agents | planned |
| Bounded fix/revise loops in `/implement` | planned |
| Cross-model `/audit independent` | planned |
| Five hand-written docs (`blueprint/spec.md`, `data_contract.md`, `features.md`, `ux.md`, `ui.md`) + `/plan` → `build-plan.md` + `project-plan.md` | done |
| `/prototype <doc>` | planned |
| Read-only localhost dashboard | planned |

The four diagram commands take any free-text argument — a file, a function, a feature, a route, or a description like `/io LLM architecture in agents.py` — read the real code, and open a self-contained HTML diagram from `prototypes/diagrams/`.

## Install

Requires Node.js 22+. Run inside an app that is already scaffolded and is a git repository.

```bash
npx create-software-factory            # into the current directory
npx create-software-factory ./my-app   # into another directory
npx create-software-factory --dry-run  # show what would be written
npx create-software-factory --force    # overwrite files that already exist
```

Existing files are never overwritten without `--force`. A manifest with a sha256 per managed file is written to `blueprint/.state/manifest.json`.

## Licence

MIT. AI Blueprint's original MIT licence is reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
