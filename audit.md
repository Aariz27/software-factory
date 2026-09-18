# A1 Harness audit — read-only

Repo `~/Documents/sf` @ a8e8e8c · 2026-09-18 · 5 Sonnet auditors (installer, dashboard, gates, our skills, structure). Every "verified" claim below was re-run by the synthesizer. Repo untouched (`git status` clean).

**Numbers:** 1.1 MB tracked (128 files) · our own code ≈ bin 188 · server 223 · index 384 · gates 184 · 4 diagram skills 489 · plan 102 · doc skeletons 177 lines · **0** callers of `gates.mjs` · **0** writers of `trace.db` / `usage.json` / `hardware.json` · **3** copies of the feature-status list (plan.md, features.md, README) that already disagree.

## 1 · Ship-blockers (verified)

| sev | where | what | evidence |
|---|---|---|---|
| HIGH | `template/.sessions-state.json` | A stray Claude Code session file sits inside `template/`. It is gitignored but **npm ships it** (the `files` whitelist beats .gitignore) and the installer copies every file under template/, so it lands in every user's project and gets hashed into their manifest. | `npm pack --dry-run` → `48B template/.sessions-state.json`, total 125 files |
| HIGH | `README.md:26,31` | README says gate scripts and `/prototype <doc>` are "planned"; features.md marks 17 and 21 `[x]` and the files exist. README also still describes the prompt-tuning-by-script design that features.md item 20 says was replaced. | grep |
| HIGH | `template/.harness/gates.mjs` | No skill, hook or AGENTS.md line calls any of the 7 gates. Finished script with no caller until features 12/15 exist. | `grep -rln gates.mjs template README.md` → only itself |
| HIGH | `template/AGENTS.md:141-184` | Our five skills (`plan`, `control-flow`, `data-flow`, `error-flow`, `io`) are not in the command roster; Codex/OpenCode/Copilot users can't discover them. `plan` writes run.json activity but is missing from the "commands that write activity" list at line 213. | skills auditor grep |
| HIGH | `gates.mjs:150-174` (`diff`, `scope`) | Both gates use cwd-relative paths from `git ls-files --others` but compare/run against repo-root paths. Run from a subdirectory: `diff` silently omits untracked files; `scope` false-FAILs on a file that is listed. | reproduced live in a scratch repo |

## 2 · Real bugs (medium)

| sev | where | what |
|---|---|---|
| MED | `gates.mjs:160-174` scope | Pattern `**` in "Files in scope" passes everything; pattern `dir/` (no star) matches nothing → false FAIL. No "pattern matched 0 files" warning. |
| MED | `gates.mjs:92-96` claimed | Accepts a directory as a "changed file" (only `existsSync`; `artifacts` at :86 correctly checks `isFile()`). Also accepts `../../etc/hosts`. |
| MED | `gates.mjs:101` review | Ledger regex is case-sensitive: `### F-1 [P0] Open` is invisible, verdict "passed" goes through with an open P0. |
| MED | `schema.sql:38` vs `gates.mjs` | Schema documents gate names `artifacts_exist / claimed_files_exist / verdict_consistent / tests_pass / nonempty_diff`; gates.mjs uses `artifacts / claimed / review / test / commit-ready / diff`. Contract and only producer disagree before a writer exists. |
| MED | `server.mjs:96-97` | Dashboard counts P0/P1 with a loose free-text regex over findings.md; gates.mjs parses the `### F-n [P0] open` heading structurally. Same file, two parsers, can disagree. |
| MED | `bin/create-software-factory.js:47,96-99` | `--port` with no value → `NaN`, no error. `dashboard --dry-run` starts a real server (dry-run ignored in that branch). |
| MED | `package.json:4` | npm description claims "model routing, usage-window tracking" — both unbuilt. |
| MED | all 5 skills' "open it" step | Hard-coded `open` (macOS only). Package is meant for npm publish. |
| MED | `feature-spec-template.md:48-50` | Tells the model "an edit to a path not listed here is blocked" — no hook exists yet (feature 15 unchecked). False today. |
| MED | `features.md:15-30` | Six `[x]` items sit under the `## Pending` heading. |
| MED | `plan.md:20` item 5 | Still describes the script-rewrites-prompts design; features.md item 20 says it was replaced. |
| MED | `CLAUDE.md:8` | Lists .harness contents without `gates.mjs`. |

## 3 · "Do we need this?" — candidates to cut (decision is yours)

| thing | who uses it today | if removed |
|---|---|---|
| `server.mjs` fields: `config`, `server.*`, `run.ageSeconds`, `usage.ageSeconds`, `trace.recentSessions` (a full SQL query every 2 s), `openSessions.{parent_session_id,pid,started_at}`, `files.{ts,session_id}`, `commits[].refs`, `branches[].date`, `clis[].label`, `agents[].startedAt` | nobody — index.html never reads any of them (grep: 0 hits each) | nothing changes on screen; ~15 lines and one SQL query per poll gone |
| `hardware.json` / "ollama gate" (`server.mjs:175-182`, `index.html:247-250`) | nobody writes it; **not in plan.md or features.md at all** | a UI state for a feature never planned disappears |
| `spec.md:92-95` "External documentation needed" | nothing — `/plan` and `/prototype spec` both skip it | user stops filling a section nobody reads |
| spec.md §2, §7, §9, §10, §11 | `/plan` only checks them for N/A; never carries content into build-plan/project-plan | wire into /plan or accept write-only |
| `/plan` vs Blueprint's `/discovery` | both produce the same two files with near-identical approval gate and near-verbatim "never scaffold/commit/push" rule; only input differs (5 docs vs interview) | keep both = two paths to one output; or /plan becomes "/discovery fed from the five docs" |
| 4 diagram skills (489 lines) | same 5-section skeleton, same 5-doc fallback, same colour tokens rephrased 4 ways; repo already uses one-skill-with-argument in `/prototype` | one `diagram` skill or two shared reference files (argument-resolution + visual-base); est. 489 → ~400-440 lines, one place to fix colours/root/open |
| README status table (`README.md:15-32`) | third copy of features.md, already stale on 2 rows | drop the Status column, point at features.md |
| Installer CLI-detection table (`bin:147-150`) | display only; nothing gates on it | informational nicety lost; no behaviour change |
| schema.sql (4 tables) + usage.schema.json | zero writers; readers exist in server.mjs; features 12/14/15 will write them | **keep** — planned contract, fix the gate-name mismatch |
| `.agents/skills` tree | Codex reads it (AGENTS.md:116); byte-identical except one line, verified (27 diffs × 1 line) | **keep** — or generate at install time (~10 installer lines); rule at CLAUDE.md:6 is not enforced by any script |
| THIRD_PARTY_NOTICES.md vs LICENSE | licence compliance for redistributed Blueprint code | **keep** |

## 4 · Inconsistencies inside our four diagram skills

- **Project root**: control-flow gives an algorithm (.git/package.json ancestor); data-flow and io give none; error-flow says "directory containing the code you read" — three different answers to where `prototypes/diagrams/` goes.
- **Grey text**: `#6b7280` in three skills, `#9ca3af` in error-flow.
- **Arrowheads**: data-flow bans them, io requires them, the other two are silent.
- **Phone width**: only io demands it.
- **Descriptions**: ours are 549-617 chars; Blueprint's longest is 370.

## 5 · Low-severity, listed for completeness

- bin: banner prints before `--help`; `-h` undocumented; `--port` not in README; manifest `installedAt` overwritten on every re-run; git-repo check warns but does not stop; `which` has no Windows `where` fallback; a typo'd flag without dashes becomes a target dir.
- package.json: no `repository`/`author`; `engines` says `>=22` while README says 22.13+ for node:sqlite.
- server.mjs: `readFileSync(index.html)` at module load has no try/catch; ps regex hard-codes a 24-char `lstart` column; corrupt hardware.json renders as "blocked" not "malformed"; process-tree builder has no cycle guard.
- gates.mjs: Verify line containing a backtick fails to parse; header never says file args are root-relative; `changedFiles()` and `diff` both re-implement the untracked-files listing; "same pattern as run-state.mjs" (plan.md:22) is not true — nothing is shared.
- .gitignore: no `*.db`, `run.json`, `usage.json`, `.state/` entries — latent. `--force` against the repo root would overwrite our own CLAUDE.md with Blueprint's 239-byte one.
- feature-spec-template.md:74 cites a "Testing gate" heading that is actually "## Testing".
- installer manifest hardcodes `adapters: ["claude","codex"]`; plan names four CLIs.

**Verified clean:** no path traversal in the HTTP server (3 hardcoded routes); no unhandled promise rejections; `artifacts` gate rejects whitespace-only files; skill frontmatter names match folders; `.claude`/`.agents` parity holds; every field index.html reads is produced by server.mjs; every usage.schema.json field is consumed; all `[x]` items in features.md have a file on disk; CLAUDE.md's manifest claim and test commands are accurate.

**Auditor conduct:** the installer auditor created and deleted a throwaway `template/.harness/dummy-ignored-test.log` to prove the npm-pack leak. It is gone; `git status` is clean.
