# create-software-factory

npm package that installs the Software Factory workflow into a project. `template/` is what gets copied; `bin/create-software-factory.js` is the installer. `plan.md` is the design; `features.md` is the running feature list.

## Layout
- `template/` — AI Blueprint 1.9.0 files (unchanged) + our skills. `.claude/skills/` and `.agents/skills/` must stay byte-identical except Blueprint's `disable-model-invocation` frontmatter line.
- `bin/` — installer. Plain Node ESM, no dependencies. Keep it that way.
- `template/.harness/` — our runtime pieces installed into projects: `dashboard/` (server.mjs + index.html, read-only, no deps, polls every 2 s), `schema.sql` (trace.db contract), `usage.schema.json` (usage.json contract), `trace.mjs` (the only writer of trace.db), `sf.mjs` (`sf run` wrapper: routing, usage swap, permission flags, lock, worktree; `sf usage` poller), `usage-poller.mjs`, `hooks.mjs` (every hook in `template/.claude/settings.json`), `gates.mjs` (deterministic checks), `onboard.mjs` (writes `blueprint/harness.json`).
- `plan.md`, `features.md` — design docs, root only.

## Rules
- Never edit Blueprint's own files in `template/` to change behaviour; add new skills/scripts beside them so an upstream update can be re-applied.
- A new skill goes into BOTH `template/.claude/skills/<name>/` and `template/.agents/skills/<name>/`.
- Test the installer with `node bin/create-software-factory.js <scratch-dir> --dry-run` before committing. Run `npm test` (node:test, `test/`). Test the dashboard with `node template/.harness/dashboard/server.mjs <scratch-dir> --port 4799` then `curl localhost:4799/api/state`.
- No AI attribution lines in commits.

## Lab notes
- Routing config lives in `blueprint/harness.json`, never in `blueprint/config.json`: Blueprint's `/doctor` rejects unknown keys there and blocks mutating commands.
- `codex login status` prints to stderr; `agy models` takes ~1.5 s (cache it); test interactive scripts with `expect`, not `printf | script` (EOF races the prompts).
- Trace/usage data can be seeded for dashboard testing: `run-state.mjs start …` for run.json, the `example` in usage.schema.json for usage.json, and `schema.sql` + a few INSERTs via node:sqlite for trace.db.
- `git branch --format` does not expand `%x1f` (only `git log` does); use a literal separator.
- Blueprint's stock `manifest.json` is not shipped; the installer regenerates it with our own schema.
- The npm name `create-sf` is taken; this package is `create-software-factory`.
