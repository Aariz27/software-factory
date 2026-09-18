---
name: models
description: Choose or change which AI model runs each /command in this project (the A1 Harness routing table in blueprint/harness.json). Use for /models, "which model runs /implement", "route /plan to Opus", "set the backup model", or right after /onboard on a new project. Never picks a model for the user.
---

# models - assign a model to each /command

**Context reuse:** Reuse any required file already loaded in project instructions or the current session. Read it again only if absent, changed, or exact current bytes or line references are needed.

The routing table lives in `blueprint/harness.json` (user-owned, committed).
Only the user decides which model runs which command; this skill shows the
options and records the answers. It never writes `blueprint/config.json`.

## Steps

1. Run `node .harness/onboard.mjs --list` and show the result as a short
   table: each CLI, whether it is installed and logged in, and the models it
   exposes. Also run `node .harness/onboard.mjs --show` and show the current
   routing if a `harness.json` already exists.
2. Ask the user, in one message: the default `cli:model` for every command,
   the backup `cli:model` used when the default is blocked by usage limits,
   the block threshold (default 95%), and any per-command overrides
   (`/plan`, `/implement`, `/audit`, … — the list of commands is in the
   `--list` output). Do not suggest a choice; the user knows their
   subscriptions and their budget.
3. Write the answers with flags, for example:

   ```text
   node .harness/onboard.mjs --default agy:gemini-3.8-flash-high --backup claude:claude-sonnet-5 --threshold 95 --set plan=claude:claude-opus-5 --set implement=agy:gemini-3.8-flash-high
   ```

   The script refuses a CLI that is not installed or not logged in, and a
   model the CLI does not list, unless `--force` is given — say so and ask
   before using `--force`.
4. Show `node .harness/onboard.mjs --show` and stop.

## Rules

- Never guess a model or fill in an answer the user did not give.
- Never edit `blueprint/harness.json` by hand; the script validates and writes it atomically.
- Never run the script with no flags from an AI session (it expects a terminal); use `--list` / `--show` / `--set`.
