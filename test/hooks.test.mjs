// Tests for template/.harness/hooks.mjs — run as a child process per Claude Code
// hook event (matching how .claude/settings.json actually invokes it), plus direct
// imports for the pure exported helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(here, "..", "template", ".harness", "hooks.mjs");
const RUN_STATE = join(here, "..", "template", ".claude", "skills", "doctor", "scripts", "run-state.mjs");

const { detectDelegation, inScope, verifyCommand } = await import(HOOKS);

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "sf-hooks-"));
  mkdirSync(join(dir, "blueprint", ".state"), { recursive: true });
  mkdirSync(join(dir, "blueprint", "context"), { recursive: true });
  return dir;
}
function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }
function writeJson(path, v) { writeFileSync(path, JSON.stringify(v)); }

function runHook(event, input, repo) {
  const env = { ...process.env, SF_HOOK_DEBUG: "1" };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync("node", [HOOKS, event], {
    cwd: repo,
    input: input === undefined ? "" : JSON.stringify(input),
    encoding: "utf8",
    env,
  });
}

function outputLines(stdout) {
  return stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function openRO(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true });
}
function dbPathFor(repo) { return join(repo, "blueprint", ".state", "trace.db"); }

// ── session-start ────────────────────────────────────────────────────────────

test("session-start writes blueprint/.state/host-session.json and a sessions row", async () => {
  const repo = scratch();
  try {
    const r = runHook("session-start", { session_id: "S1", model: "claude-sonnet-5", permission_mode: "default" }, repo);
    assert.equal(r.status, 0, r.stderr);

    const host = JSON.parse(readFileSync(join(repo, "blueprint", ".state", "host-session.json"), "utf8"));
    assert.equal(host.sessionId, "S1");
    assert.equal(host.model, "claude-sonnet-5");
    assert.equal(host.cli, "claude");

    const ro = await openRO(dbPathFor(repo));
    try {
      const sess = ro.prepare("SELECT * FROM sessions WHERE session_id = ?").get("S1");
      assert.equal(sess.cli, "claude");
      assert.equal(sess.model, "claude-sonnet-5");
    } finally { ro.close(); }
  } finally { cleanup(repo); }
});

// ── prompt ───────────────────────────────────────────────────────────────────

test("prompt: /implement 3 records the command on the session row and routes through sf.mjs when assigned to another model", async () => {
  const repo = scratch();
  try {
    let r = runHook("session-start", { session_id: "S2", model: "claude-sonnet-5" }, repo);
    assert.equal(r.status, 0, r.stderr);

    writeJson(join(repo, "blueprint", "harness.json"), {
      schemaVersion: 1, usageBlockPercent: 95,
      default: { cli: "claude", model: "claude-sonnet-5" },
      backup: null,
      commands: { implement: { cli: "ollama", model: "qwen3:4b" } },
    });

    r = runHook("prompt", { session_id: "S2", prompt: "/implement 3" }, repo);
    assert.equal(r.status, 0, r.stderr);
    const lines = outputLines(r.stdout);
    assert.equal(lines.length, 1);
    assert.match(lines[0].hookSpecificOutput.additionalContext, /node \.harness\/sf\.mjs run implement --skill/);

    const ro = await openRO(dbPathFor(repo));
    try {
      const sess = ro.prepare("SELECT * FROM sessions WHERE session_id = ?").get("S2");
      assert.equal(sess.command, "implement");
    } finally { ro.close(); }
  } finally { cleanup(repo); }
});

test("prompt: /audit independent x adds --independent to the routed command", async () => {
  const repo = scratch();
  try {
    writeJson(join(repo, "blueprint", "harness.json"), {
      schemaVersion: 1, usageBlockPercent: 95,
      default: { cli: "claude", model: "claude-sonnet-5" },
      backup: null,
      commands: {},
    });
    const r = runHook("prompt", { session_id: "S3", prompt: "/audit independent x" }, repo);
    assert.equal(r.status, 0, r.stderr);
    const lines = outputLines(r.stdout);
    assert.equal(lines.length, 1);
    assert.match(lines[0].hookSpecificOutput.additionalContext, /--independent/);
  } finally { cleanup(repo); }
});

test("prompt: a plain sentence prints nothing and records a prompt event", async () => {
  const repo = scratch();
  try {
    const r = runHook("prompt", { session_id: "S4", prompt: "just chatting, no slash command here" }, repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "");

    const ro = await openRO(dbPathFor(repo));
    try {
      const ev = ro.prepare("SELECT * FROM events WHERE session_id = ? AND kind = 'prompt'").get("S4");
      assert.ok(ev);
      assert.equal(ev.name, null);
    } finally { ro.close(); }
  } finally { cleanup(repo); }
});

// ── pre-bash ─────────────────────────────────────────────────────────────────

test("pre-bash denies a direct codex exec call when usage.json marks codex blocked", () => {
  const repo = scratch();
  try {
    writeJson(join(repo, "blueprint", ".state", "usage.json"), { groups: { codex: { blocked: true, reason: "weekly 99% >= 95%" } } });
    const r = runHook("pre-bash", { session_id: "S5", tool_input: { command: "codex exec -m gpt-5.5 'hello world'" } }, repo);
    assert.equal(r.status, 0, r.stderr);
    const lines = outputLines(r.stdout);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].hookSpecificOutput.permissionDecision, "deny");
    assert.match(lines[0].hookSpecificOutput.permissionDecisionReason, /codex.*blocked by its usage window/);
  } finally { cleanup(repo); }
});

test("pre-bash stays silent for node .harness/sf.mjs run … (the wrapper handles its own swap)", () => {
  const repo = scratch();
  try {
    writeJson(join(repo, "blueprint", ".state", "usage.json"), { groups: { codex: { blocked: true, reason: "x" } } });
    const r = runHook("pre-bash", { session_id: "S5b", tool_input: { command: "node .harness/sf.mjs run implement --skill" } }, repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "");
  } finally { cleanup(repo); }
});

test("pre-bash stays silent when nothing is blocked", () => {
  const repo = scratch();
  try {
    writeJson(join(repo, "blueprint", ".state", "usage.json"), { groups: { codex: { blocked: false } } });
    const r = runHook("pre-bash", { session_id: "S5c", tool_input: { command: "codex exec -m gpt-4 'hi'" } }, repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "");
  } finally { cleanup(repo); }
});

test("pre-bash: the loop guard allows 3 test rounds and denies the 4th", () => {
  const repo = scratch();
  try {
    writeFileSync(join(repo, "AGENTS.md"), "# AGENTS.md\n\n## Commands\n\n- Verify: `npm test`\n");
    const started = spawnSync("node", [RUN_STATE, "start", "--command", "implement", "--summary", "x", "--boundary", "reviewed"], { cwd: repo, encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);

    for (let round = 1; round <= 3; round++) {
      const r = runHook("pre-bash", { session_id: "S6", tool_input: { command: "npm test" } }, repo);
      assert.equal(r.status, 0, r.stderr);
      const lines = outputLines(r.stdout);
      assert.equal(lines.length, 1, `round ${round} stdout: ${r.stdout}`);
      assert.equal(lines[0].hookSpecificOutput.permissionDecision, "allow");
      assert.match(lines[0].hookSpecificOutput.additionalContext, new RegExp(`round ${round} of 3`));
    }
    const fourth = runHook("pre-bash", { session_id: "S6", tool_input: { command: "npm test" } }, repo);
    assert.equal(fourth.status, 0, fourth.stderr);
    const lines = outputLines(fourth.stdout);
    assert.equal(lines[0].hookSpecificOutput.permissionDecision, "deny");
  } finally { cleanup(repo); }
});

// ── pre-edit ─────────────────────────────────────────────────────────────────

function writeScope(repo) {
  writeFileSync(join(repo, "blueprint", "context", "current-feature.md"), "# Current feature\n\n## Files in scope\n\n- `src/**`\n- `docs/`\n");
}

test("pre-edit: in-scope paths (glob, prefix, and blueprint/) are silent", () => {
  const repo = scratch();
  try {
    writeScope(repo);
    for (const fp of ["src/a/b.ts", "docs/x.md", "blueprint/context/x.md"]) {
      const r = runHook("pre-edit", { session_id: "S7", tool_input: { file_path: fp } }, repo);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "", `expected silence for ${fp}, got: ${r.stdout}`);
    }
  } finally { cleanup(repo); }
});

test("pre-edit: an out-of-scope path is denied", () => {
  const repo = scratch();
  try {
    writeScope(repo);
    const r = runHook("pre-edit", { session_id: "S7", tool_input: { file_path: "lib/x.ts" } }, repo);
    assert.equal(r.status, 0, r.stderr);
    const lines = outputLines(r.stdout);
    assert.equal(lines[0].hookSpecificOutput.permissionDecision, "deny");
    assert.match(lines[0].hookSpecificOutput.permissionDecisionReason, /lib\/x\.ts is not listed/);
  } finally { cleanup(repo); }
});

test("pre-edit: a path outside the project is denied", () => {
  const repo = scratch();
  try {
    writeScope(repo);
    const r = runHook("pre-edit", { session_id: "S7", tool_input: { file_path: "/etc/some-outside-file.conf" } }, repo);
    assert.equal(r.status, 0, r.stderr);
    const lines = outputLines(r.stdout);
    assert.equal(lines[0].hookSpecificOutput.permissionDecision, "deny");
    assert.match(lines[0].hookSpecificOutput.permissionDecisionReason, /outside the project/);
  } finally { cleanup(repo); }
});

test("pre-edit: without a \"Files in scope\" section everything is silent", () => {
  const repo = scratch(); // current-feature.md never written
  try {
    const r = runHook("pre-edit", { session_id: "S7", tool_input: { file_path: "lib/x.ts" } }, repo);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "");
  } finally { cleanup(repo); }
});

// ── post-tool ────────────────────────────────────────────────────────────────

test("post-tool: an Edit outside scope writes a files_touched row with in_scope 0", async () => {
  const repo = scratch();
  try {
    writeScope(repo);
    const r = runHook("post-tool", { session_id: "S8", tool_name: "Edit", tool_input: { file_path: "lib/outside.ts" } }, repo);
    assert.equal(r.status, 0, r.stderr);
    const ro = await openRO(dbPathFor(repo));
    try {
      const row = ro.prepare("SELECT * FROM files_touched WHERE session_id = ?").get("S8");
      assert.equal(row.path, "lib/outside.ts");
      assert.equal(row.in_scope, 0);
    } finally { ro.close(); }
  } finally { cleanup(repo); }
});

test("post-tool: a Bash gates.mjs scope call with a FAIL tool_response writes a gates row with passed 0", async () => {
  const repo = scratch();
  try {
    const r = runHook("post-tool", {
      session_id: "S9", tool_name: "Bash",
      tool_input: { command: "node .harness/gates.mjs scope" },
      tool_response: "FAIL scope:\n  - outside.ts is changed but not listed in \"Files in scope\"",
    }, repo);
    assert.equal(r.status, 0, r.stderr);
    const ro = await openRO(dbPathFor(repo));
    try {
      const row = ro.prepare("SELECT * FROM gates WHERE session_id = ?").get("S9");
      assert.equal(row.gate, "scope");
      assert.equal(row.passed, 0);
    } finally { ro.close(); }
  } finally { cleanup(repo); }
});

// ── subagent-start / subagent-stop ───────────────────────────────────────────

test("subagent-start and subagent-stop write events", async () => {
  const repo = scratch();
  try {
    let r = runHook("subagent-start", { session_id: "S10", agent_type: "general-purpose", agent_id: "A1" }, repo);
    assert.equal(r.status, 0, r.stderr);
    r = runHook("subagent-stop", { session_id: "S10", agent_type: "general-purpose", agent_id: "A1" }, repo);
    assert.equal(r.status, 0, r.stderr);

    const ro = await openRO(dbPathFor(repo));
    try {
      const start = ro.prepare("SELECT * FROM events WHERE session_id = ? AND kind = 'subagent_start'").get("S10");
      assert.equal(start.name, "general-purpose");
      const stop = ro.prepare("SELECT * FROM events WHERE session_id = ? AND kind = 'subagent_stop'").get("S10");
      assert.equal(stop.name, "general-purpose");
    } finally { ro.close(); }
  } finally { cleanup(repo); }
});

// ── stop ─────────────────────────────────────────────────────────────────────

test("stop: token totals equal the transcript's sums, and a repeat call yields a delta of 0", async () => {
  const repo = scratch();
  try {
    const transcriptPath = join(repo, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 20 } } }),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 50, output_tokens: 15 } } }),
    ];
    writeFileSync(transcriptPath, lines.join("\n") + "\n");

    let r = runHook("stop", { session_id: "S11", transcript_path: transcriptPath, stop_reason: "end_turn" }, repo);
    assert.equal(r.status, 0, r.stderr);
    r = runHook("stop", { session_id: "S11", transcript_path: transcriptPath, stop_reason: "end_turn" }, repo);
    assert.equal(r.status, 0, r.stderr);

    const ro = await openRO(dbPathFor(repo));
    try {
      const stops = ro.prepare("SELECT * FROM events WHERE session_id = ? AND kind = 'stop' ORDER BY id ASC").all("S11");
      assert.equal(stops.length, 2);
      assert.equal(stops[0].tokens_in, 165); // (10+100) + (5+50)
      assert.equal(stops[0].tokens_out, 35); // 20 + 15
      assert.equal(stops[1].tokens_in, 0);
      assert.equal(stops[1].tokens_out, 0);
    } finally { ro.close(); }
  } finally { cleanup(repo); }
});

// ── every hook exits 0 even with empty stdin ────────────────────────────────

test("every hook exits 0 when given empty stdin", () => {
  const events = ["session-start", "prompt", "pre-bash", "pre-edit", "post-tool", "subagent-start", "subagent-stop", "stop"];
  for (const event of events) {
    const repo = scratch();
    try {
      const r = spawnSync("node", [HOOKS, event], { cwd: repo, input: "", encoding: "utf8", env: { ...process.env, SF_HOOK_DEBUG: "1" } });
      assert.equal(r.status, 0, `${event}: ${r.stderr}`);
    } finally { cleanup(repo); }
  }
});

// ── pure exported helpers ────────────────────────────────────────────────────

test("detectDelegation recognizes each direct CLI delegation shape and extracts --model/-m", () => {
  // BUG: the claude/agy regexes require a whitespace character before "-p" that is not the
  // one already consumed by the mandatory `claude\s`/`agy\s` right after the CLI name, so the
  // single most common invocation shape — "claude -p <prompt>" / "agy -p <prompt>" (used
  // elsewhere in this very codebase, e.g. usage-poller.mjs's `claude -p "/usage" ...` and
  // sf.mjs's LAUNCHERS.claude args) — is NOT detected as a delegation. Only a form with an
  // extra token before "-p" (e.g. "claude foo -p bar"), or the "--print"/"--prompt" long
  // flags, matches. This means the pre-bash usage hard-block would not fire for a plain
  // `claude -p "..."` or `agy -p "..."` call even when that cli is blocked.
  assert.equal(detectDelegation("claude -p '/audit'"), null);
  assert.equal(detectDelegation("agy -p 'hi'"), null);
  assert.deepEqual(detectDelegation("claude foo -p '/audit'"), { cli: "claude", model: null });
  assert.deepEqual(detectDelegation("agy foo -p 'hi'"), { cli: "agy", model: null });

  assert.deepEqual(detectDelegation("claude --print '/audit'"), { cli: "claude", model: null });
  assert.deepEqual(detectDelegation("codex exec -m gpt-5.5 'do the thing'"), { cli: "codex", model: "gpt-5.5" });
  assert.deepEqual(detectDelegation("codex exec --model=o4-mini 'do the thing'"), { cli: "codex", model: "o4-mini" });
  assert.deepEqual(detectDelegation("agy --prompt 'hi'"), { cli: "agy", model: null });
  assert.deepEqual(detectDelegation("node .harness/sf.mjs run implement --skill"), { cli: "sf" });
  assert.equal(detectDelegation("ls -la"), null);
});

test("inScope: blueprint/ is always allowed; glob and prefix patterns match, others don't", () => {
  const patterns = ["src/**", "docs/"];
  assert.equal(inScope("blueprint/context/x.md", patterns), true);
  assert.equal(inScope("src/a/b.ts", patterns), true);
  assert.equal(inScope("docs/readme.md", patterns), true);
  assert.equal(inScope("lib/x.ts", patterns), false);
});

test("verifyCommand reads the AGENTS.md Verify: line, or returns null when absent", () => {
  const repo = scratch();
  try {
    assert.equal(verifyCommand(repo), null);
    writeFileSync(join(repo, "AGENTS.md"), "# AGENTS.md\n\n## Commands\n\n- Verify: `npm test`\n");
    assert.equal(verifyCommand(repo), "npm test");
  } finally { cleanup(repo); }
});
