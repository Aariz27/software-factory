// Tests for template/.harness/gates.mjs — creates a scratch git repo per test
// under the OS temp dir and runs the real gate script as a child process, the
// same way a skill would call it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const GATES = join(here, "..", "template", ".harness", "gates.mjs");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// Builds a fresh scratch git repo with one committed file, blueprint/context/
// in place, and returns its path. Callers add more files/commits as needed.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gates-test-"));
  mkdirSync(join(dir, "blueprint", "context"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(join(dir, "tracked.txt"), "hello\n");
  git(dir, "add", "tracked.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function runGate(cwd, ...args) {
  return spawnSync(process.execPath, [GATES, ...args], { cwd, encoding: "utf8" });
}

test("artifacts: passes for a non-empty file, fails for missing/empty", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "out.txt"), "content\n");
  writeFileSync(join(dir, "empty.txt"), "");

  const ok = runGate(dir, "artifacts", "out.txt");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^PASS artifacts:/);

  const missing = runGate(dir, "artifacts", "does-not-exist.txt");
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /does not exist/);

  const empty = runGate(dir, "artifacts", "empty.txt");
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /is empty/);

  rmSync(dir, { recursive: true, force: true });
});

test("claimed: passes for a real file, rejects a directory and a path outside the repo", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "file.txt"), "x\n");

  const ok = runGate(dir, "claimed", "sub/file.txt");
  assert.equal(ok.status, 0);

  const isDir = runGate(dir, "claimed", "sub");
  assert.equal(isDir.status, 1);
  assert.match(isDir.stdout, /is not a file/);

  const traversal = runGate(dir, "claimed", "../../etc/hosts");
  assert.equal(traversal.status, 1);
  assert.match(traversal.stdout, /resolves outside the repo/);

  rmSync(dir, { recursive: true, force: true });
});

test("review: passed verdict is blocked by an open P0/P1 finding regardless of status case", () => {
  const dir = makeRepo();
  const review = `**Verdict:** passed
**Check result:** passed

## Commands
- npm test

## Evidence
- ok

## Findings
- none

## Remaining risk
- none
`;
  writeFileSync(join(dir, "blueprint", "context", "review.md"), review);

  const clean = runGate(dir, "review");
  assert.equal(clean.status, 0);

  // Capitalized status ("Open") must still be caught — this was the bug: the
  // ledger regex used to be case-sensitive.
  writeFileSync(join(dir, "blueprint", "context", "findings.md"), "### F-1 [P0] Open\nstill broken\n");
  const dirty = runGate(dir, "review");
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /F-1 \[P0\] is still Open/);

  rmSync(dir, { recursive: true, force: true });
});

test("test: Verify line with an embedded backtick still parses and runs", () => {
  const dir = makeRepo();
  writeFileSync(
    join(dir, "AGENTS.md"),
    "## Commands\n\n- Verify: `echo ok-`date +%s``\n",
  );
  const result = runGate(dir, "test");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /running: echo ok-`date \+%s`/);

  writeFileSync(join(dir, "AGENTS.md"), "## Commands\n\n- nothing here\n");
  const missing = runGate(dir, "test");
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /no `Verify:` line/);

  rmSync(dir, { recursive: true, force: true });
});

test("commit-ready: fails on a clean tree, passes once something changed", () => {
  const dir = makeRepo();
  const clean = runGate(dir, "commit-ready");
  assert.equal(clean.status, 1);
  assert.match(clean.stdout, /nothing to commit/);

  writeFileSync(join(dir, "tracked.txt"), "changed\n");
  const dirty = runGate(dir, "commit-ready");
  assert.equal(dirty.status, 0);

  rmSync(dir, { recursive: true, force: true });
});

test("diff: an untracked file's diff is not silently dropped when run from a subdirectory", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "newfile.txt"), "newcontent\n");

  const fromRoot = runGate(dir, "diff");
  assert.match(fromRoot.stdout, /sub\/newfile\.txt/);

  const fromSub = runGate(join(dir, "sub"), "diff");
  assert.match(fromSub.stdout, /sub\/newfile\.txt/, "diff must still find the untracked file from a subdirectory");

  rmSync(dir, { recursive: true, force: true });
});

test("scope: works from a subdirectory, dir/ matches everything under it, unmatched pattern warns without failing", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "newfile.txt"), "newcontent\n");
  writeFileSync(
    join(dir, "blueprint", "context", "current-feature.md"),
    "## Files in scope\n- `sub/`\n- `nomatch/thing.txt`\n",
  );

  // Bug: from a subdirectory, git ls-files --others returned cwd-relative
  // paths ("newfile.txt") compared against root-relative patterns
  // ("sub/newfile.txt"), producing a false FAIL.
  const fromSub = runGate(join(dir, "sub"), "scope");
  assert.equal(fromSub.status, 0, fromSub.stdout);

  const fromRoot = runGate(dir, "scope");
  assert.equal(fromRoot.status, 0);
  assert.match(fromRoot.stdout, /"nomatch\/thing\.txt".*matched 0 changed files/);
  assert.match(fromRoot.stdout, /^PASS scope:/m);

  rmSync(dir, { recursive: true, force: true });
});
