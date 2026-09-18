---
name: data-flow
description: Renders a single self-contained HTML diagram showing where data goes for a given file, feature, route, or description in this project — who sends it, over what transport, to which component, what comes back, and where it is stored — then opens it in the browser. Trigger on the /data-flow slash command, and also whenever the user asks where data goes, what the client sends to the server, how a request travels, what gets stored where, request/response shape, or asks to "trace this payload" — even if they never say "data flow".
disable-model-invocation: true
---

# Data Flow Diagram

Turn a file, a feature name, a route, or a plain-English description into one
HTML page that shows the real data flow in this project: sender → transport →
receiver → response → store. Every box name must come from the actual code.
Never invent a box, route, or table that isn't in the project — an invented
box is worse than no diagram, because it looks authoritative but lies.

## Resolve the argument

The argument (`$ARGUMENTS`) can be a path, a description, or a feature/route name.
Figure out which and resolve it to real code before doing anything else:

1. **Looks like a path** (contains `/` or a file extension, or matches a file
   in the project) → read that file directly.
2. **A description of behavior** ("the signup form submission") → grep the
   project for the words in it (form names, endpoint fragments, function
   names) and read the files that match. Try a few phrasings — the user's
   words may not match variable names exactly.
3. **A feature or route name** → first check for hand-written project docs
   that describe it: `spec.md`, `features.md`, `data_contract.md`, `ux.md`,
   `ui.md` (root or nearby directories). Read whichever exist and mention the
   feature, to learn the intended flow and the real names to grep for next.
   Then read the actual code for those names — docs describe intent, code is
   ground truth, and the diagram must reflect the code.
4. **Nothing matches** → stop. Do not guess or draw a plausible-looking
   generic flow. Tell the user exactly what you searched (grep terms tried,
   doc files checked, paths looked at) and that nothing matched.

This resolution step applies however the argument is phrased — a path still
gets read in full, not skimmed for the first match.

## Extract the flow

Once you have the real code, list every element of the flow explicitly. Do
this for the whole flow, not just the first hop — a signup form that also
triggers an email and a webhook has more than two edges, and every one of
them needs a box and a label:

- **Every sender**: UI elements, forms, buttons, client functions that
  originate a request. Record the file:line where each is defined.
- **Every transport**: the literal route/method (`POST /api/users`), queue
  name, event name, or function call boundary — read it from the code, don't
  paraphrase it.
- **Every receiver**: the handler, controller, or function that receives it,
  file:line.
- **Every payload shape**: what's actually sent and returned — field names
  from the real request/response type, schema, or object literal, not a
  guess.
- **Every store**: database tables, cache keys, files, external APIs that
  data lands in or is read from, with the real table/collection name.
- **Every tier**: if there's more than a client and a server — a queue, a
  third-party API, a cron job, a background worker — list it as its own tier
  in order. If there's genuinely only one tier (e.g. a CLI script with no
  network hop), note that too; the render step needs to know the tier count
  before laying out columns.

Write this list out before touching the template — it's the direct input to
the render step, and skipping straight to drawing is how boxes end up wrong.

## Render

1. Read `assets/template.html` in this skill's directory.
2. Fill it in following the Style contract below, using the box/edge list
   from the previous step. One `<g class="column">` per tier, one
   `<g class="box">` per real component, one `<path class="edge">` +
   `<text class="label">` per transfer. Every column, every box, and every
   edge from the extraction list must appear — not just the first one of
   each kind.
3. Set the heading to the resolved argument text and the source file
   path(s) actually read.
4. If there's only one tier, use a single column and say so in the heading
   text (e.g. "single-tier — no client/server split").
5. Save the filled page to `prototypes/diagrams/data-flow-<slug>.html` in
   the project root (slug = a short kebab-case name from the argument),
   creating the `prototypes/diagrams/` folder if it doesn't exist.
6. Open it with the command for the OS the shell reports: `open <path>` on macOS,
   `xdg-open <path>` on Linux, `start "" <path>` on Windows. Do not add any other
   browser-automation step — this one command is the entire job.

## Style contract

Verify the rendered page against every one of these before opening it:

- Background `#0d0f12`, near-black, for the whole page.
- Font: `"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace`.
- Boxes: rounded rect (`rx="6"`), fill `#15181d`, 1px border `#262a31`, text
  `#e6e6e6` at 16px.
- Column headings (`CLIENT`, `SERVER`, or the real tier name): grey
  `#6b7280`, 13px, wide letter-spacing, top-left of each column.
- Divider between columns: vertical dashed line, 1px, `#3a3f47`.
- Edges: 2px lines, `#e0b44a` (yellow), right-angle elbows only — no
  diagonals, no curves, no arrowheads.
- Edge labels: 13px, sitting just above the line; grey `#6b7280` for a
  request label, yellow `#e0b44a` for a response label (e.g. `json`).
- The request path runs left→right across the divider near the top; the
  response runs right→left, lower down; a server-to-store round trip is
  drawn as a loop on the server's side that returns to the same box.
- Generous whitespace, no shadows, no gradients, no icons.
- No external scripts or stylesheets — the page must open and render fully
  offline.

## Example

Input: `/data-flow the signup form submission`

Resolution: grep finds `<form onSubmit={handleSignup}>` in
`app/signup/page.tsx:42` and `handleSignup` posting to `/api/users`; the
handler is `app/api/users/route.ts:12`, which calls
`db.insert(users).values(...)` (Drizzle, table `users`) and returns
`{ id, email }` as JSON.

Box/edge list produced:
- CLIENT column: `<form>` (`app/signup/page.tsx:42`), `render(ui)`
  (`app/signup/page.tsx:58`, renders the response).
- SERVER column: `POST /api/users` (`app/api/users/route.ts:12`),
  `db.users` (Drizzle table, same file).
- Edges: `<form>` → `POST /api/users` labelled `request` (crosses the
  divider, top); `POST /api/users` → `db.users` → back, a loop labelled
  `insert` / `row`; `POST /api/users` → `render(ui)` labelled `json`
  (crosses the divider, lower, right→left).

Saved to `prototypes/diagrams/data-flow-signup-form-submission.html` and
opened with `open`.
