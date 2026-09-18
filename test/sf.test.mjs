// Tests for the pure/exported parts of template/.harness/sf.mjs.
// Importing the module must not run anything: it guards its CLI behind
// `process.argv[1] === fileURLToPath(import.meta.url)`, which is false when imported
// by the test runner, so this import alone is also the "importing does not run" check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SF = join(here, "..", "template", ".harness", "sf.mjs");

const {
  parseArgs,
  usageGroup,
  pickModel,
  permissionClass,
  PERMISSIONS,
  READ_ONLY,
  takeLock,
  lockHolder,
  summarizeToolInput,
} = await import(SF);

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "sf-sf-"));
  mkdirSync(join(dir, "blueprint", ".state"), { recursive: true });
  return dir;
}
function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }
function writeHarness(repo, cfg) { writeFileSync(join(repo, "blueprint", "harness.json"), JSON.stringify(cfg)); }
function writeUsage(repo, doc) { writeFileSync(join(repo, "blueprint", ".state", "usage.json"), JSON.stringify(doc)); }

// ── parseArgs ────────────────────────────────────────────────────────────────

test("parseArgs: flags, values, camelCase, and positionals", () => {
  const o = parseArgs(["run", "implement", "--skill", "foo bar", "--cli", "claude"]);
  assert.deepEqual(o.positional, ["run", "implement"]);
  assert.equal(o.skill, "foo bar");
  assert.equal(o.cli, "claude");
});

test("parseArgs: a flag immediately followed by another flag is boolean true", () => {
  const o = parseArgs(["run", "audit", "--independent", "--cli", "codex"]);
  assert.equal(o.independent, true);
  assert.equal(o.cli, "codex");
});

test("parseArgs: a bare \"-\" is kept as a positional (stdin prompt marker)", () => {
  const o = parseArgs(["run", "implement", "-"]);
  assert.deepEqual(o.positional, ["run", "implement", "-"]);
});

test("parseArgs: kebab-case flags are converted to camelCase keys", () => {
  const o = parseArgs(["run", "implement", "--prompt-file", "f.txt"]);
  assert.equal(o.promptFile, "f.txt");
});

// ── usageGroup ───────────────────────────────────────────────────────────────

test("usageGroup: agy gemini models use the agy-gemini group, others agy-3p", () => {
  assert.equal(usageGroup("agy", "gemini-3.8-flash-high"), "agy-gemini");
  assert.equal(usageGroup("agy", "claude-opus-5"), "agy-3p");
});

test("usageGroup: non-agy clis pass through unchanged", () => {
  assert.equal(usageGroup("claude", "claude-sonnet-5"), "claude");
  assert.equal(usageGroup("codex", "gpt-5.5"), "codex");
  assert.equal(usageGroup("ollama", "qwen3:4b"), "ollama");
});

// ── pickModel ────────────────────────────────────────────────────────────────

function baseHarness() {
  return {
    schemaVersion: 1,
    usageBlockPercent: 95,
    default: { cli: "claude", model: "claude-sonnet-5" },
    backup: { cli: "codex", model: "gpt-5.5" },
    commands: {
      implement: { cli: "agy", model: "gemini-3.8-flash-high" },
      audit: { cli: "claude", model: "claude-opus-5", backup: { cli: "codex", model: "gpt-5.5" } },
    },
  };
}

test("pickModel: default is used when the command has no per-command entry", () => {
  const repo = scratch();
  try {
    writeHarness(repo, baseHarness());
    const r = pickModel(repo, "feature", {}, {});
    assert.deepEqual(r.choice, { cli: "claude", model: "claude-sonnet-5" });
    assert.equal(r.source, "harness.json default");
    assert.equal(r.blocked, null);
  } finally { cleanup(repo); }
});

test("pickModel: a per-command entry wins over default", () => {
  const repo = scratch();
  try {
    writeHarness(repo, baseHarness());
    const r = pickModel(repo, "implement", {}, {});
    assert.deepEqual(r.choice, { cli: "agy", model: "gemini-3.8-flash-high" });
    assert.equal(r.source, "harness.json commands.implement");
  } finally { cleanup(repo); }
});

test("pickModel: a blocked primary swaps to the backup, with swapped set", () => {
  const repo = scratch();
  try {
    writeHarness(repo, baseHarness());
    writeUsage(repo, { groups: { "agy-gemini": { blocked: true, reason: "fiveHour 96% >= 95%" } } });
    const r = pickModel(repo, "implement", {}, {});
    assert.deepEqual(r.choice, { cli: "codex", model: "gpt-5.5" });
    assert.deepEqual(r.swapped, { cli: "agy", model: "gemini-3.8-flash-high" });
    assert.equal(r.blocked, "fiveHour 96% >= 95%");
  } finally { cleanup(repo); }
});

test("pickModel: primary and backup both blocked yields choice null", () => {
  const repo = scratch();
  try {
    writeHarness(repo, baseHarness());
    writeUsage(repo, { groups: {
      "agy-gemini": { blocked: true, reason: "fiveHour 96% >= 95%" },
      codex: { blocked: true, reason: "weekly 99% >= 95%" },
    } });
    const r = pickModel(repo, "implement", {}, {});
    assert.equal(r.choice, null);
    assert.match(r.blocked, /agy:gemini-3.8-flash-high fiveHour 96% >= 95%/);
    assert.match(r.blocked, /codex:gpt-5.5 weekly 99% >= 95%/);
  } finally { cleanup(repo); }
});

test("pickModel: --cli/--model override wins even when blocked", () => {
  const repo = scratch();
  try {
    writeHarness(repo, baseHarness());
    writeUsage(repo, { groups: { claude: { blocked: true, reason: "weekly 97% >= 95%" } } });
    const r = pickModel(repo, "implement", { cli: "claude", model: "claude-sonnet-5" }, {});
    assert.deepEqual(r.choice, { cli: "claude", model: "claude-sonnet-5" });
    assert.equal(r.source, "--cli/--model");
    assert.equal(r.blocked, "weekly 97% >= 95%");
  } finally { cleanup(repo); }
});

test("pickModel: independent with a builder equal to the primary picks the first differing configured model", () => {
  const repo = scratch();
  try {
    writeHarness(repo, baseHarness());
    const builder = { cli: "claude", model: "claude-opus-5" }; // == commands.audit primary
    const r = pickModel(repo, "audit", {}, { independent: true, builder });
    assert.deepEqual(r.choice, { cli: "codex", model: "gpt-5.5" }); // audit's own backup, differs from builder
    assert.match(r.source, /independent of builder claude:claude-opus-5/);
  } finally { cleanup(repo); }
});

test("pickModel: independent with every configured model equal to the builder yields choice null", () => {
  const repo = scratch();
  try {
    const only = { cli: "claude", model: "claude-opus-5" };
    writeHarness(repo, { schemaVersion: 1, usageBlockPercent: 95, default: only, backup: only, commands: { audit: { cli: only.cli, model: only.model } } });
    const r = pickModel(repo, "audit", {}, { independent: true, builder: only });
    assert.equal(r.choice, null);
    assert.match(r.blocked, /every configured model is claude:claude-opus-5/);
  } finally { cleanup(repo); }
});

test("pickModel: missing harness.json yields choice null with the run /models source", () => {
  const repo = scratch(); // no harness.json written
  try {
    const r = pickModel(repo, "feature", {}, {});
    assert.equal(r.choice, null);
    assert.match(r.source, /run \/models/);
  } finally { cleanup(repo); }
});

// ── permissionClass ──────────────────────────────────────────────────────────

test("permissionClass: audit is read-only, implement is write, by default classification", () => {
  const repo = scratch();
  try {
    writeHarness(repo, baseHarness());
    assert.equal(permissionClass(repo, "audit", undefined), "read-only");
    assert.equal(permissionClass(repo, "implement", undefined), "write");
    assert.ok(READ_ONLY.has("audit"));
    assert.ok(!READ_ONLY.has("implement"));
  } finally { cleanup(repo); }
});

test("permissionClass: harness.json commands.<cmd>.permissions overrides the default classification", () => {
  const repo = scratch();
  try {
    const cfg = baseHarness();
    cfg.commands.implement.permissions = "read-only";
    cfg.commands.audit.permissions = "write";
    writeHarness(repo, cfg);
    assert.equal(permissionClass(repo, "implement", undefined), "read-only");
    assert.equal(permissionClass(repo, "audit", undefined), "write");
  } finally { cleanup(repo); }
});

test("permissionClass: the --permissions argument overrides both defaults and harness.json", () => {
  const repo = scratch();
  try {
    const cfg = baseHarness();
    cfg.commands.implement.permissions = "read-only";
    writeHarness(repo, cfg);
    assert.equal(permissionClass(repo, "implement", "write"), "write");
    assert.equal(permissionClass(repo, "audit", "write"), "write");
  } finally { cleanup(repo); }
});

// ── PERMISSIONS ──────────────────────────────────────────────────────────────

test("PERMISSIONS: read-only disallows Edit and Write for claude", () => {
  assert.ok(PERMISSIONS["read-only"].claude.disallowedTools.includes("Edit"));
  assert.ok(PERMISSIONS["read-only"].claude.disallowedTools.includes("Write"));
});

test("PERMISSIONS: write disallows a git push for claude", () => {
  assert.ok(PERMISSIONS.write.claude.disallowedTools.includes("Bash(git push:*)"));
});

// ── takeLock ─────────────────────────────────────────────────────────────────

test("takeLock: first call succeeds, second call while held returns null, released it can be taken again", () => {
  const repo = scratch();
  try {
    const release1 = takeLock(repo, { command: "implement", cli: "claude", model: "claude-sonnet-5" });
    assert.equal(typeof release1, "function");
    const release2 = takeLock(repo, { command: "implement", cli: "claude", model: "claude-sonnet-5" });
    assert.equal(release2, null);
    release1();
    const release3 = takeLock(repo, { command: "implement", cli: "claude", model: "claude-sonnet-5" });
    assert.equal(typeof release3, "function");
    release3();
  } finally { cleanup(repo); }
});

test("takeLock: a lock whose pid is dead is treated as stale and replaced", () => {
  const repo = scratch();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(join(repo, "blueprint", ".state"), { recursive: true });
    writeFileSync(join(repo, "blueprint", ".state", "sf.lock"), JSON.stringify({ command: "old", cli: "codex", model: "gpt-5.5", pid: dead, takenAt: new Date().toISOString() }) + "\n");
    const release = takeLock(repo, { command: "implement", cli: "claude", model: "claude-sonnet-5" });
    assert.equal(typeof release, "function");
    assert.equal(lockHolder(repo).pid, process.pid);
    release();
  } finally { cleanup(repo); }
});

// ── summarizeToolInput ───────────────────────────────────────────────────────

test("summarizeToolInput: Bash command is truncated to 200 chars and nothing else leaks", () => {
  const long = "x".repeat(300);
  const r = summarizeToolInput("Bash", { command: long, env: { SECRET: "shh" } });
  assert.equal(r.command.length, 200);
  assert.equal(r.command, long.slice(0, 200));
  assert.equal(r.env, undefined);
});

test("summarizeToolInput: Edit returns only file_path, never file contents", () => {
  const r = summarizeToolInput("Edit", { file_path: "/repo/src/a.ts", old_string: "SECRET OLD", new_string: "SECRET NEW" });
  assert.deepEqual(r, { file_path: "/repo/src/a.ts" });
});

test("summarizeToolInput: Write with content is never returned", () => {
  const r = summarizeToolInput("Write", { file_path: "/repo/a.ts", content: "top secret file contents" });
  assert.deepEqual(r, { file_path: "/repo/a.ts" });
  assert.equal(JSON.stringify(r).includes("secret"), false);
});
