---
name: error-flow
description: Renders an HTML diagram of every place the happy path in a piece of code can fail, then opens it. Trigger on `/error-flow <file, function, feature, route, or description>`, or when the user asks what can go wrong, which errors are handled, what edge cases exist, or wants a failure-mode review — even without saying "error flow".
---

# error-flow

Turn a piece of real code into one picture: a straight yellow line for the
happy path, and a red crack breaking off it at every point the code can
fail. The point of the diagram is honesty — it must show exactly what the
code's own error handling covers, and exactly what it does not, so the
reader can see the gaps at a glance instead of trusting that "errors are
handled" somewhere.

## Resolve the argument

The argument can be a file path, a fragment of a file, a feature name, a
route, or a function name. Figure out which, then get to real code before
doing anything else:

- **Looks like a path** (`services/user.py`, `orders.ts`) → read that file
  directly.
- **Names a part of a file** ("the checkout handler in orders.ts") → read
  the file, then locate the named function/handler inside it.
- **Names a feature, route, or function with no file given** → grep/search
  the project for the identifier (function name, route string, class name)
  and read the matching source. If the project has hand-written docs —
  `spec.md`, `features.md`, `data_contract.md`, `ux.md`, `ui.md` — read
  whichever of those exist first, so you know what the feature is supposed
  to do and which files implement it, then go read the code itself. The
  docs tell you where to look; the code is still the source of truth for
  what actually happens.
- **Nothing matches** → stop. Do not guess and do not draw an invented
  flow. Tell the user exactly what you searched (which terms, which
  files/dirs) and that nothing matched.

## Extract the failures

Walk the happy path in the order the code actually executes it — request
in, validation, lookups, external calls, transform, response out (whatever
subset applies). This rule applies to **every step you walk, not just the
first one or two** — do not stop early because the pattern is obvious.

For each step, check whether that step can fail, and if so record:

1. **Step name** — the plain-words action ("save the user", "call the
   payment API").
2. **Failure value** — the concrete thing the code produces on failure:
   the exact exception class caught or raised, the exact status code
   returned, the exact field that can be `undefined`/`null`/missing, the
   exact validation rule that rejects input. Never invent a value the code
   cannot actually produce — copy it from the source.
3. **Caption** — the same failure in plain words a non-engineer would say
   ("a request fails", "a value is missing", "a user enters bad data",
   "the query throws", "a format you didn't expect").
4. **Handled or not** — whether the code catches/checks it, and where
   (`file:line`). If a whole category of failure has no handling anywhere
   in the path (e.g. the external API call has no try/catch, or a field
   from the request body is used without a null check), add exactly ONE
   branch for that gap, captioned `unhandled`, and mark it dimmer red in
   the render. Do not add more than one unhandled branch per gap — one
   branch per distinct failure category, not one per line of code.

Keep this as a working list (step, value, caption, handled?, file:line)
before touching the template — it is what fills `<!-- BRANCHES -->`.

## Render

1. Read `assets/template.html` from this skill's folder.
2. Replace the example content: the heading gets the user's argument text
   and the resolved source file path(s); the `<!-- BRANCHES -->` region
   gets one `<g class="branch up|down">` (or `"branch up unhandled"` /
   `"branch down unhandled"`) per failure found, spaced evenly along the
   happy-path line, alternating above/below in the order the steps occur.
   Follow the placeholder comment in the template for the exact markup
   shape and coordinate math — do not redesign the SVG structure.
3. Save the filled HTML to `prototypes/diagrams/error-flow-<slug>.html` in
   the project root — the nearest ancestor directory containing `.git` or
   `package.json` (otherwise the current working directory), creating
   `prototypes/diagrams/` if it doesn't exist. `<slug>` is the argument,
   lowercased, non-alphanumerics turned into `-`.
4. Open it with the command for the OS the shell reports: `open <path>` on macOS,
   `xdg-open <path>` on Linux, `start "" <path>` on Windows. Do nothing else with the
   browser — no automation, no screenshot loop, just the one call.

## Style contract

Verify the rendered page against this before considering the diagram done:

- Background `#0d0f12`, monospace font stack (`"JetBrains Mono", "IBM Plex
  Mono", ui-monospace, Menlo, monospace`) everywhere.
- Happy path = one horizontal 2px line, `#e0b44a`, full width. Caption
  "the happy path" in grey `#6b7280` 14px just above its left end.
- Each failure = a 2px `#e5484d` zigzag `<polyline>` of 3 segments leaving
  the line at a slight angle, ~80–110px long, ending in a small open
  arrowhead at its outer end. Branches alternate above/below the line
  along its length so labels never collide.
- Failure value: `#e5484d`, 20px monospace, at the branch's outer end.
- Caption: grey `#6b7280`, 13px, directly below the value.
- Unhandled branches use `#8b3a3e` instead of `#e5484d` for both the
  zigzag line, its arrowhead, and the value text (caption stays
  `#6b7280`, and still says the plain-words failure — the word
  "unhandled" is the point, add it as the caption text or immediately
  after it).
- No boxes, no shadows, no gradients, no icons anywhere — the only line
  decoration is each branch's arrowhead.
- Fits phone width with no horizontal scroll (`viewBox` + `width="100%"`).
- These rules apply to every branch in the diagram, not just the first
  one — check the last branch as carefully as the first before finishing.

## Example

Input: `/error-flow the checkout handler in orders.ts`

Resolved: `orders.ts`, function `handleCheckout`.

Failures extracted, in path order:
1. Parse request body → `undefined` / "a value is missing" (the `email`
   field is read off `req.body` with no check) — unhandled.
2. Validate email format → `email: "abc"` / "a user enters bad data" —
   handled, returns `400` (orders.ts:42).
3. Call payment API → `500` / "a request fails" — handled, caught and
   mapped to a `500` response (orders.ts:58).
4. Save order to DB → `QueryFailedError` / "the query throws" — unhandled,
   no try/catch around the `INSERT`.
5. Render confirmation email template → `"<html>…"` / "a format you
   didn't expect" — handled, falls back to a plain-text template
   (orders.ts:81).

That list is what gets rendered as five branches along the happy-path
line, in that left-to-right order, with branches 1 and 4 drawn in the
dimmer unhandled red.
