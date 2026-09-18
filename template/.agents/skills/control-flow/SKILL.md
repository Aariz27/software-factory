---
name: control-flow
description: Renders the real control flow of a file, function, feature, or route as a dark-themed HTML diagram and opens it. Trigger on `/control-flow`, or when the user asks about order of execution, branching logic, "what runs first/next", or wants a flowchart — even without saying "control flow". Argument: a file path, code fragment, feature name, or route.
---

# control-flow

This skill turns real code into a picture of its control flow: what runs first, what runs
next, what only happens under a condition, and what happens when something fails. The
diagram must be built from code that was actually read — never from a guess at what the
code probably does.

## Resolve the argument

The argument to `/control-flow` is free text. Work out what kind of reference it is before
reading anything:

- **A file path** (`main.py`, `src/agents.py`) — read that file directly.
- **A part of a file** (`the retry loop in agents.py`, `the validate function in api.py`) —
  open the named file and locate the named function, class, loop, or block inside it. Read
  enough surrounding code to see its callers and what it calls.
- **A feature name or route** (`the checkout flow`, `POST /orders`) — first check the project
  root for hand-written docs: `spec.md`, `features.md`, `data_contract.md`, `ux.md`, `ui.md`.
  If any exist, read them to find which files and functions implement the feature. Then open
  those files and read the real code — the docs point you to the code, they are never the
  source of the diagram themselves.
- **Nothing matches** — if the path doesn't exist, the grep for the description turns up
  nothing, and no doc file mentions it either, stop. Do not draw a flow from assumption.
  Report exactly what you searched (files checked, grep terms tried, docs consulted) and ask
  for a more specific pointer.

Use `grep`/`rg` across the project to locate descriptions that aren't literal file paths.
Prefer the project's own function and variable names over any rephrasing.

## Extract the flow

Once the relevant code is open, list out, in execution order:

1. Every step in the main path, as it actually appears in the code, in the order it runs.
2. Every condition (`if`, `else`, ternary, early return, guard clause) — the exact expression
   or a short paraphrase of it as the node label (e.g. `ok?`, `user.exists?`).
3. Every failure point (`try`/`except`, `.catch`, error return, thrown exception) and the
   handler it goes to.
4. For every single node above — not just the first one — record the real function or
   statement name from the code and its `file:line`. A node with an invented name, or a node
   with no traceable `file:line`, is not allowed anywhere in the diagram, not only at the
   entry point.

Keep this as a plain ordered list before touching the template — it is the input to Render,
and it is what you re-check against the code before writing any SVG.

## Render

1. Read `assets/template.html` from this skill.
2. Replace the `<!-- NODES -->` placeholder region with the real flow: one `<g class="node">`
   per step (and one diamond shape per condition), edges drawn as `<path>` with
   `class="edge main"` for the taken path, `class="edge false"` for the untaken branch, and
   `class="edge throws"` for a failure branch. This rule applies to every node and every edge
   in the diagram, not just the ones in the worked example — replace all of them.
3. Set the top-left heading to the literal argument text the user passed, and list the
   `file:line` sources underneath it.
4. Determine the project root: the nearest ancestor directory containing `.git` or
   `package.json` (otherwise the current working directory). Create `prototypes/diagrams/`
   under it if it doesn't exist, and save
   the filled page as `prototypes/diagrams/control-flow-<slug>.html`, where `<slug>` is the
   argument text lowercased, spaces and punctuation turned into hyphens.
5. Open the saved file in the default browser with the command for the OS the shell
   reports: `open <path>` on macOS, `xdg-open <path>` on Linux, `start "" <path>` on
   Windows. Do not add any other browser-automation step — this one command is the
   entire delivery mechanism.

## Style contract

These are the exact visual rules the rendered page must satisfy, so they can be checked by
eye against the output:

- Background: `#0d0f12` (dark, near-black), full page.
- Font: monospace — `"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace`.
- Node (a step): rounded rectangle, `rx="6"`, fill `#15181d`, 1px border `#262a31`, text
  `#e6e6e6` at 16px.
- Condition: diamond (`<polygon>`) with the same fill/border as a node, label like `ok?`.
- Main-path edge: 2px line, color `#e0b44a` (yellow).
- Edge labels (`true`, `false`, `throws`): 13px. `true` in yellow `#e0b44a`, `false` in dim
  grey `#6b7280`, `throws` in red `#e5484d`.
- Failure edge and its handler node: red `#e5484d` border; handler node fill `#1c1416`.
- Untaken branch (the `false` side when it's not the main path): node and edge in dim grey —
  border/edge `#4b5059`, text `#6b7280`.
- Every edge (main-path, false-branch, throws) ends in a small open arrowhead at the node it
  points to — not just the main path.
- Left margin: a column of 15px grey captions, one per row, in plain words only — "what
  happens first", "what happens next", "what only happens if something is true", "what
  happens when something fails". No jargon substitutes for these captions.
- Layout: vertical chain, nodes centered on one axis, ~120px row spacing, generous
  whitespace, no shadows, no gradients, no icons.
- True branch continues straight down the main axis; false branch and throws branch go
  sideways off the main axis to their own node.
- Fits phone width with no horizontal scroll (`viewBox` + `width="100%"`).

## Example

Input: `/control-flow the login handler in auth.py`

Resolve: `auth.py` exists at the project root → open it → find `def login_handler(...)`.

Extract, in order:
1. `fetchUser(email)` — `auth.py:12` — main path start.
2. `validate(input)` — `auth.py:18` — main path.
3. Condition `ok?` (`if not user.is_valid`) — `auth.py:21` — false branch (dim, sideways) →
   `reject()` at `auth.py:23`; true branch continues down.
4. `save(user)` — `auth.py:27` — main path, wrapped in `try`.
5. Failure branch (red, sideways) from `save(user)` → `handleError(err)` at `auth.py:31`,
   labeled `throws`.

Render: fill the template with these five nodes and their edges exactly as extracted, save
to `prototypes/diagrams/control-flow-the-login-handler-in-auth-py.html`, then `open` it.
