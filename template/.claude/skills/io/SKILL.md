---
name: io
description: Draws an HTML diagram of what a piece of code takes in and gives back, then opens it. Trigger on `/io <argument>` (file, section, function, feature, endpoint, or CLI command), or when the user asks what a function/endpoint/LLM call takes and returns, "what does this expect", or a signature with real example values — even without saying "io".
disable-model-invocation: true
---

# io

`/io <anything>` reads the real code behind the argument and renders one HTML page: a left
box (input, with a realistic example value), a yellow arrow, a middle box (the unit under
inspection, named exactly as in the code), a yellow arrow, a right box (output, with a
realistic example value). It never shows a diagram for code it has not actually read — a
guessed IO is worse than no diagram, because it teaches the user the wrong contract.

## Resolve the argument

The argument can be a path, a fragment of a description, a function/endpoint name, a
feature, or a CLI command. Resolve it before drawing anything:

- **Looks like a file path** (`main.py`, `agents.py`, `src/api/users.ts`) → read that file
  directly.
- **Names part of a file** (`LLM architecture in agents.py`) → read the file, then locate the
  specific function(s)/class(es)/call(s) that match the description inside it.
- **Names a function, endpoint, or CLI command without a path** (`getUser`, `POST /users`,
  `mycli sync`) → grep/search the project for the definition (function name, route
  decorator/registration, argparse/click command) and read the matching code.
- **Names a feature with no obvious single function** (`checkout flow`, `onboarding`) → first
  check the project root and nearby folders for hand-written docs — `spec.md`,
  `features.md`, `data_contract.md`, `ux.md`, `ui.md` — read whichever exist for the
  relevant section, then read the code they point to, to confirm the docs still match reality.
- **Nothing matches** → stop. Tell the user exactly what you searched (files opened, grep
  patterns tried, docs checked) and that no matching code was found. Do not draw invented
  IO — every box in the output must trace back to a line of real code or a real doc-plus-code
  match.

Apply this resolution step to the whole argument, not just its first word — a compound
argument like "the retry logic in the scraper's fetch function" needs both halves resolved
(the file/function AND the specific sub-behavior) before moving on.

## Extract the IO

For every unit you are about to draw (there may be more than one — see Render below), pull
out, from the code you just read:

- The unit's exact name, as it appears in the code (`getUser(id)`, not "get user function").
- Each input: its parameter/field name, its type (from a type hint, a schema, a function
  signature, or inferred from usage if untyped), and one realistic example literal value for
  it. Prefer a literal already present in the codebase — a test fixture, a default value, a
  docstring example, a sample request in the docs — over inventing one; if you must invent
  one, make it look like real data of that type (a plausible ID, a plausible email, a
  plausible short string), never a placeholder like `"string"` or `"foo"`.
- Each output: same rules — real field name, real type, realistic example literal. Never
  include a field the code does not actually return; if the return type is a class/dict/
  schema, enumerate its actual fields.
- The file:line the unit and its types/examples came from.
- One line noting where each example value came from (a fixture, a test, a docstring, or "no
  example found in code — inferred a realistic literal of the declared type").

Apply this to every unit in the diagram, not only the first one — a file with five public
functions needs five complete extractions, each with its own file:line and example
provenance.

If the unit has several inputs (e.g. an LLM call with a system prompt, a user prompt, and a
tool list) or several outputs (e.g. text, tool calls, and token usage), list every one of
them individually here — each becomes its own box in the render step, not a single combined
box.

## Render

1. Copy `assets/template.html` (in this skill's folder) as the starting point.
2. Replace the heading text with the resolved argument, and the source line with the real
   file path(s) and line number(s) from the Extract step.
3. Inside the `<!-- ROWS -->` region, build one `<g class="row">` per unit, each containing
   one `<g class="input">` per input, one `<g class="unit">`, and one `<g class="output">` per
   output — following the layout math and comments already in the template. When a unit has
   more than one input or output, stack those boxes vertically within the row, all pointing
   through the single middle box. When the argument covers a whole file or an "architecture",
   emit one row per public function or agent call, top to bottom, in the order they are
   called in the code.
4. Every row and every box in it follows the same rules — do not simplify or skip the style
   contract for rows after the first.
5. Save the finished file to `prototypes/diagrams/io-<slug>.html` in the project root — the
   nearest ancestor directory containing `.git` or `package.json` (otherwise the current
   working directory; `<slug>` = a short kebab-case version of the argument), creating the
   `prototypes/diagrams` folder if it does not exist.
6. Open it with the command for the OS the shell reports: `open <path>` on macOS,
   `xdg-open <path>` on Linux, `start "" <path>` on Windows. Do nothing else with the
   browser — no further automation beyond this one call.

## Style contract

Verify the rendered page against this before finishing:

- Background `#0d0f12`, near-black, full page.
- Font: monospace throughout — `"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace`.
- Every box: rounded rectangle, fill `#15181d`, 1px border `#262a31`.
- Input literal text and the unit's name: `#e6e6e6`, 18px.
- Output JSON block: braces and keys `#e6e6e6`; string values `#e0b44a` (yellow); numbers
  `#e6e6e6`; 15px; left-aligned; one key per line.
- Arrows: 2px line, `#e0b44a`, with a small open arrowhead — every arrow, not just the first.
- Captions `input` / `output`: grey `#6b7280`, 13px, wide letter-spacing, centred under the
  left and right boxes of every row.
- Layout: three boxes per row, horizontal, ~80px gaps between box edges. Multiple
  inputs/outputs stack vertically on their own side. Generous whitespace. No shadows, no
  gradients, no icons.
- Single file, inline CSS and inline SVG only — no external scripts or stylesheets, so the
  page opens offline.
- Fits phone width with no horizontal scroll (`viewBox` + `width="100%"`).

## Example

Input: `/io getUser`

Resolution: grep the project for `getUser`, find it defined in `api/users.py:14` as
`getUser(id: str) -> User`, read the `User` model and an existing test fixture for a sample
row.

Extraction: unit `getUser(id)` at `api/users.py:14`; input `id: str`, example `"usr_8f2k"`
(from `tests/fixtures/users.py`); output `User` with fields `name: str` → `"John Doe"` and
`email: str` → `"john@acme.dev"` (from the same fixture).

Render: one row — input box `"usr_8f2k"` → arrow → unit box `getUser(id)` → arrow → output
box `{ name: "John Doe", email: "john@acme.dev" }` — saved to
`prototypes/diagrams/io-getuser.html` and opened with `open`.
