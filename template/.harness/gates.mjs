#!/usr/bin/env node
// A1 Harness gate scripts — deterministic checks the skills call instead of
// trusting a model's own report.
//
//   node .harness/gates.mjs artifacts <file>...   declared artifacts exist and are not empty
//   node .harness/gates.mjs claimed <file>...     every file the builder claims it changed exists
//   node .harness/gates.mjs review [receipt]      review verdict agrees with its own findings
//   node .harness/gates.mjs test [--tail N]       the AGENTS.md `Verify:` command exits 0
//   node .harness/gates.mjs commit-ready          refuse a commit when there is nothing to commit
//   node .harness/gates.mjs diff [base]           print the real git diff for the reviewer
//   node .harness/gates.mjs scope [base]          every changed file is listed in "Files in scope"
//
// Output is stdout only: one PASS/FAIL line per gate plus detail lines.
// Exit 0 = pass, 1 = fail, 2 = bad usage. Nothing is written to disk.
//
// "Files in scope" patterns (one per `-` bullet, path in backticks): an exact
// path, a path ending in `/` meaning "everything under that directory", or a
// glob per node:path's matchesGlob (e.g. `**` allows every changed path,
// `src/**` allows everything under src) — no glob syntax is special-cased.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, matchesGlob, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// path.matchesGlob is marked experimental on Node 22/23; the warning is noise here.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type !== "ExperimentalWarning") emitWarning.call(process, warning, ...rest);
};
// A reader that stops early (`| head`) is not a gate failure.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(process.exitCode ?? 0); throw e; });

// Always run from ROOT, regardless of the caller's actual cwd, so every path
// git prints (ls-files, diff --name-only, ...) is repo-root-relative like the
// paths in current-feature.md, findings.md and everywhere else in this file.
const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

let ROOT;
try {
  ROOT = git("rev-parse", "--show-toplevel").trim();
} catch {
  console.log("FAIL: not inside a git repository");
  process.exit(1);
}

const read = (rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

function result(gate, problems, okMessage) {
  if (problems.length === 0) {
    console.log(`PASS ${gate}: ${okMessage}`);
    return 0;
  }
  console.log(`FAIL ${gate}:`);
  for (const p of problems) console.log(`  - ${p}`);
  return 1;
}

// Text under a markdown heading, up to the next heading of the same or higher level.
function section(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const level = heading.match(/^#+/)[0].length;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^(#+)\s/);
    if (m && m[1].length <= level) break;
    out.push(l);
  }
  return out.join("\n");
}

const bullets = (text) =>
  (text ?? "").split("\n").map((l) => l.match(/^\s*-\s+(.*\S)/)?.[1]).filter(Boolean);

function changedFiles(base) {
  const tracked = git("diff", "--name-only", base).split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked].filter(Boolean))];
}

const gates = {
  artifacts(files) {
    if (files.length === 0) return usage("artifacts needs at least one file");
    const problems = [];
    for (const f of files) {
      const p = join(ROOT, f);
      if (!existsSync(p)) problems.push(`${f} does not exist`);
      else if (!statSync(p).isFile()) problems.push(`${f} is not a file`);
      else if (readFileSync(p, "utf8").trim() === "") problems.push(`${f} is empty`);
    }
    return result("artifacts", problems, `${files.length} file(s) exist and are not empty`);
  },

  claimed(files) {
    if (files.length === 0) return usage("claimed needs at least one file");
    const problems = [];
    for (const f of files) {
      const p = resolve(ROOT, f);
      if (p !== ROOT && !p.startsWith(ROOT + sep)) { problems.push(`${f} resolves outside the repo`); continue; }
      if (!existsSync(p)) problems.push(`${f} does not exist on disk`);
      else if (!statSync(p).isFile()) problems.push(`${f} is not a file`);
    }
    return result("claimed", problems, `${files.length} claimed file(s) exist`);
  },

  review([receipt = "blueprint/context/review.md"]) {
    const text = read(receipt);
    if (text === null) return result("review", [`${receipt} does not exist`]);
    const field = (name) => text.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`))?.[1].trim().toLowerCase();
    const verdict = field("Verdict");
    const check = field("Check result");
    const findings = bullets(section(text, "## Findings")).filter((b) => !/^none\b/i.test(b));
    const problems = [];

    if (!verdict) problems.push(`${receipt} has no **Verdict:** line (no completed review)`);
    else if (verdict === "passed") {
      if (check !== "passed" && check !== "not-required")
        problems.push(`verdict is passed but Check result is ${check ?? "missing"}`);
      for (const s of ["## Commands", "## Evidence", "## Findings", "## Remaining risk"])
        if (bullets(section(text, s)).length === 0) problems.push(`section ${s} has no entry`);
      const ledger = read("blueprint/context/findings.md") ?? "";
      for (const m of ledger.matchAll(/^###\s+(F-\d+)\s+\[(P[01])\]\s+(open|fixed)\b.*$/gim))
        problems.push(`verdict is passed but ${m[1]} [${m[2]}] is still ${m[3]} in findings.md`);
    } else if (verdict === "changes-requested") {
      if (findings.length === 0 && check !== "failed")
        problems.push("verdict is changes-requested but it names no finding and no failed check");
    } else problems.push(`verdict is "${verdict}", not passed or changes-requested`);

    return result("review", problems, `verdict ${verdict} is consistent with its findings and checks`);
  },

  test(args) {
    let tail = 2000;
    const i = args.indexOf("--tail");
    if (i !== -1) tail = Number(args[i + 1]);
    if (!Number.isInteger(tail) || tail < 0) return usage("--tail needs a whole number");

    const commands = section(read("AGENTS.md") ?? "", "## Commands");
    const cmd = (commands ?? "").match(/^\s*(?:-\s*)?Verify:\s*`?([^`\n]+?)`?\s*$/m)?.[1];
    if (!cmd) return result("test", ["AGENTS.md Commands has no `Verify:` line — run /ci to define one"]);

    console.log(`running: ${cmd}`);
    const run = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (run.status === 0) return result("test", [], `\`${cmd}\` exited 0`);
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    console.log(`--- last ${tail} characters of output ---`);
    console.log(output.slice(-tail));
    console.log("--- end of output ---");
    return result("test", [`\`${cmd}\` exited ${run.status ?? `by signal ${run.signal}`}`]);
  },

  "commit-ready"() {
    const status = git("status", "--porcelain");
    return result("commit-ready", status.trim() === "" ? ["git status is empty — nothing to commit"] : [],
      `${status.trim().split("\n").length} changed path(s)`);
  },

  diff([base = "HEAD"]) {
    process.stdout.write(git("diff", base));
    const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
    for (const f of untracked) {
      const d = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", f], { cwd: ROOT, encoding: "utf8" });
      process.stdout.write(d.stdout);
    }
    return 0;
  },

  scope([base = "HEAD"]) {
    const spec = read("blueprint/context/current-feature.md");
    if (spec === null) return result("scope", ["blueprint/context/current-feature.md does not exist"]);
    const listed = section(spec, "## Files in scope");
    if (listed === null) return result("scope", ["current-feature.md has no \"## Files in scope\" section"]);
    const patterns = bullets(listed).map((b) => b.match(/^`([^`]+)`/)?.[1]).filter(Boolean);
    if (patterns.length === 0) return result("scope", ["\"Files in scope\" lists no paths"]);

    // A pattern ending in "/" means "everything under that directory"; otherwise
    // an exact path or a matchesGlob pattern (see header comment for `**`).
    const matchesPattern = (f, p) => (p.endsWith("/") ? f.startsWith(p) : f === p || matchesGlob(f, p));

    const changed = changedFiles(base);
    // blueprint/ is the workflow's own memory (the spec's ticked steps, findings, review); always allowed.
    const outside = changed.filter(
      (f) => !f.startsWith("blueprint/") && !patterns.some((p) => matchesPattern(f, p)),
    );

    for (const p of patterns.filter((p) => !changed.some((f) => matchesPattern(f, p))))
      console.log(`  (note) "${p}" in "Files in scope" matched 0 changed files`);

    return result("scope", outside.map((f) => `${f} is changed but not listed in "Files in scope"`),
      `every changed file matches the ${patterns.length} listed path(s)`);
  },
};

function usage(message) {
  console.log(`usage error: ${message}`);
  console.log("gates: " + Object.keys(gates).join(", "));
  return 2;
}

const [name, ...rest] = process.argv.slice(2);
process.exitCode = gates[name] ? gates[name](rest) : usage(`unknown gate "${name ?? ""}"`);
