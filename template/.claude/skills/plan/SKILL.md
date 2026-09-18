---
name: plan
description: Turn the five hand-written planning docs (blueprint/spec.md, data_contract.md, features.md, ux.md, ui.md) into blueprint/build-plan.md and blueprint/project-plan.md. Use for /plan, "make the build plan", "turn my spec into a plan", or whenever the five docs are filled in and build-plan.md is still the stub. Never edit product code.
disable-model-invocation: true
---

# plan - build the plan from the five hand-written docs

**Context reuse:** Reuse any required file already loaded in project instructions or the current session. Read it again only if absent, changed, or exact current bytes or line references are needed.

This skill reads what the user wrote by hand and produces the two files the rest
of the Blueprint loop runs on. It writes nothing until the user approves the
draft, and it never touches product code.

```
spec.md + data_contract.md + features.md + ux.md + ui.md  ->  [this skill]  ->  build-plan.md + project-plan.md  ->  /overview  ->  /feature
```

## Start

**First action:** Before project inspection, preflight, or any other tool call,
publish the `plan` activity as `running` when `blueprint/.state/` exists.

Read all five docs in `blueprint/`:

- `spec.md` — the technical decisions (runtime, routes, integrations, deploy, agents, database, auth, jobs, observability, release, storage, prompting).
- `data_contract.md` — every piece of data: where it lives, when it moves, its shape, what happens on arrival, ordering, and whether it was verified.
- `features.md` — what the user can do; must-have vs later vs not building.
- `ux.md` — the routes a user takes through the app, in the user's own words.
- `ui.md` — look and feel, reference images in `blueprint/mockups/`.

A doc still equal to its installed skeleton (headings with empty answers) is
**missing**. Stop and name each missing doc with its path. Do not guess its
contents and do not interview the user in its place — the docs are the user's
decisions, written by hand on purpose. `features.md` and `spec.md` are required;
the other three may be thin, and you say so in the draft rather than inventing
what they would have said.

## Derive the build plan

Every item in `build-plan.md` must trace back to a line in `features.md`. Do not
add features the user did not write. Do:

- Order items by dependency and earliest useful vertical slice: the data a
  feature needs (from `data_contract.md`) and the routes it sits on (from
  `spec.md`) must exist before the feature that uses them.
- Keep each item one feature-sized outcome on one line, in the user's wording
  from `features.md`, with a short description drawn from `ux.md` where it
  helps. Implementation detail belongs in later `/feature` specs, not here.
- Put `later` items under a `## Later` heading, unchecked, after the must-haves.
- Leave `Explicitly not building` items out entirely.
- Flag, in one line each, any feature whose data has a `?` in
  `data_contract.md` or whose spec field is `N/A` — the user decides whether
  that blocks the item, you do not.

Use Blueprint's format: numbered checkboxes, optional milestone headings, and
the `/overview` note kept at the top so the rest of the loop still works. If a
substantive `build-plan.md` already exists, preserve completed numbering and
mark proposed additions and removals clearly.

## Derive the project plan

`/overview` still reads `blueprint/project-plan.md`, so fill its nine sections
from the five docs rather than leaving it a stub:

1. Problem — from the top of `features.md` / `spec.md` context.
2. Users — from `ux.md`.
3. Features — the must-have list from `features.md`.
4. Data — the piece names from `data_contract.md`.
5. Tech — from `spec.md` §1, §5, §4.
6. Monetize — only if the user wrote it; otherwise "not stated".
7. UI/UX — from `ui.md` and the route names in `ux.md`.
8. Deployment — from `spec.md` §3.
9. Usage model and constraints — from `spec.md` §6, §8; leave blank when not established.

Quote the user's own words; do not expand a one-line decision into paragraphs.

## Show the draft, then write

Present both files in full and end with one question: write them, or change
what. Write only after an explicit yes. On changes, revise and show the affected
sections again.

After writing:

- report which files changed
- list the flagged `?` / `N/A` items
- stop before generating `blueprint/context/project-overview.md`
- point to `/overview` as the next command

## Rules

- Never scaffold the app, edit product code, generate the overview, create a
  feature spec, commit, merge, push, or deploy.
- Never overwrite a substantive `build-plan.md` or `project-plan.md` without
  showing the replacement and receiving explicit approval.
- Never fill a missing doc from your own judgement; the user writes those.

## Formatting

Follow `blueprint/context/ai-interaction.md`: concise headings and lists so the
user can inspect what came from which doc.
