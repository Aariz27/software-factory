#!/usr/bin/env node
// A1 Harness `sf` wrapper — the one way a skill hands a step to another model.
//
//   node .harness/sf.mjs run <command> "<prompt>"          prompt as an argument
//   node .harness/sf.mjs run <command> --prompt-file f     prompt from a file
//   node .harness/sf.mjs run <command> -                   prompt from stdin
//   node .harness/sf.mjs run <command> --skill "<args>"    run the project's /<command> skill on the assigned model
//     options: --cli claude|codex|agy|ollama  --model <id>   override blueprint/harness.json
//              --independent                               (audit) pick a model different from the one that built
//              --parent <session-id>                       the host session that delegated (default: host-session.json)
//              --permissions read-only|write               override the command's write class (see PERMISSIONS)
//              --worktree                                  run a write-capable command in .worktrees/<branch>
//              --json      print {sessionId, cli, model, text, tokensIn, tokensOut, exitCode} instead of the text
//              --quiet     no progress lines on stderr
//   node .harness/sf.mjs usage [--once] [--interval 60]    the usage-window poller (usage-poller.mjs)
//
// What `run` does, in order:
//   1. picks the model for <command> from blueprint/harness.json (commands.<command> → default)
//   2. reads blueprint/.state/usage.json; a blocked model is swapped for its backup and the swap is printed
//   3. maps the command's write class to the CLI's permission flags (claude --allowedTools / codex -s / agy --mode)
//   4. takes blueprint/.state/sf.lock for a write-capable command (one writer per repo; read-only runs go parallel)
//   5. launches the CLI headless with a fresh session id, streams its JSON events
//   6. writes the session, every tool call and the token totals to blueprint/.state/trace.db
//   7. backstop: a read-only run that changed files, or a write run outside "Files in scope", is recorded as a failed gate
//   8. prints the model's final text on stdout; exit code = the child's exit code
// Exit 3 = no usable model (routing missing, or primary and backup both blocked, or no model different from the builder).
// Exit 4 = another write-capable run holds the lock.

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { findRepo, openTrace } from "./trace.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// path.matchesGlob is experimental on Node 22/23; the warning is noise here.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...r) => { const t = typeof r[0] === "string" ? r[0] : r[0]?.type; if (t !== "ExperimentalWarning") emitWarning.call(process, w, ...r); };

// ── args ─────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-") { o.positional.push("-"); continue; }
    if (!a.startsWith("--")) { o.positional.push(a); continue; }
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const same = (a, b) => !!a && !!b && a.cli === b.cli && a.model === b.model;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// ── routing + usage ──────────────────────────────────────────────────────────
// Which usage.json group a model draws from. Mirrors usage-poller.mjs.
export function usageGroup(cli, model) {
  if (cli === "agy") return /^gemini/.test(model) ? "agy-gemini" : "agy-3p";
  return cli;
}

// Feature 19: the model that built the current work — last write-class session in trace.db,
// else the routing for /implement.
export function builderModel(repo, routing, trace) {
  try {
    const row = trace?.db.prepare("SELECT cli, model FROM sessions WHERE command IN ('implement','autopilot','continuous','fix') AND cli IS NOT NULL ORDER BY started_at DESC LIMIT 1").get();
    if (row?.cli) return { cli: row.cli, model: row.model };
  } catch {}
  const per = routing?.commands?.implement;
  return per?.cli ? { cli: per.cli, model: per.model } : routing?.default ?? null;
}

// Every distinct cli:model the user configured, in preference order.
function configuredModels(routing) {
  const all = [routing?.default, routing?.backup];
  for (const c of Object.values(routing?.commands ?? {})) { if (c?.cli) all.push({ cli: c.cli, model: c.model }); if (c?.backup?.cli) all.push(c.backup); }
  const seen = new Set(), outList = [];
  for (const c of all) { if (!c?.cli) continue; const k = `${c.cli}:${c.model}`; if (!seen.has(k)) { seen.add(k); outList.push({ cli: c.cli, model: c.model }); } }
  return outList;
}

export function pickModel(repo, command, override = {}, { independent = false, builder = null } = {}) {
  const routing = readJson(join(repo, "blueprint", "harness.json"));
  const usage = readJson(join(repo, "blueprint", ".state", "usage.json"));
  const blockedReason = (c) => {
    if (!c || !usage?.groups) return null;
    const g = usage.groups[usageGroup(c.cli, c.model)];
    return g?.blocked ? g.reason || "blocked" : null;
  };

  if (override?.cli && override?.model) {
    const c = { cli: override.cli, model: override.model };
    if (independent && same(c, builder)) return { choice: null, source: "--cli/--model", blocked: `${c.cli}:${c.model} is the model that built this work; --independent needs a different one` };
    return { choice: c, source: "--cli/--model", blocked: blockedReason(c), swapped: null };
  }
  if (!routing?.default) return { choice: null, source: "blueprint/harness.json missing or has no default — run /models", blocked: null, swapped: null };

  const per = routing.commands?.[command];
  let primary = per?.cli && per?.model ? { cli: per.cli, model: per.model } : routing.default;
  let backup = per?.backup?.cli ? per.backup : routing.backup;
  let source = per?.cli ? `harness.json commands.${command}` : "harness.json default";

  if (independent && builder) {
    // Walk primary → backup → any other configured model until one differs from the builder.
    const candidates = [primary, backup, ...configuredModels(routing)].filter((c) => c && !same(c, builder));
    if (!candidates.length) return { choice: null, source, blocked: `every configured model is ${builder.cli}:${builder.model}, the one that built this work — add another model with /models` };
    if (!same(candidates[0], primary)) source += ` → independent of builder ${builder.cli}:${builder.model}`;
    primary = candidates[0]; backup = candidates[1] ?? null;
  }

  const pb = blockedReason(primary);
  if (!pb) return { choice: primary, source, blocked: null, swapped: null };
  if (!backup) return { choice: null, source, blocked: pb, swapped: null, primary };
  const bb = blockedReason(backup);
  if (bb) return { choice: null, source, blocked: `${primary.cli}:${primary.model} ${pb}; backup ${backup.cli}:${backup.model} ${bb}`, swapped: null, primary };
  return { choice: backup, source: `${source} → backup`, blocked: pb, swapped: primary };
}

// ── feature 16: write class per command → CLI flags ─────────────────────────
// read-only commands never change files; everything else may edit the repo (never push).
export const READ_ONLY = new Set(["explore", "brief", "status", "doctor", "debug", "audit"]);
export function permissionClass(repo, command, override) {
  if (override === "read-only" || override === "write") return override;
  const cfg = readJson(join(repo, "blueprint", "harness.json"))?.commands?.[command]?.permissions;
  if (cfg === "read-only" || cfg === "write") return cfg;
  return READ_ONLY.has(command) ? "read-only" : "write";
}
export const PERMISSIONS = {
  "read-only": {
    claude: { permissionMode: "default", allowedTools: ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git show:*)", "Bash(node .harness/gates.mjs:*)"], disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"] },
    codex: { sandbox: "read-only" },
    agy: { mode: "plan", sandbox: true },
  },
  write: {
    claude: { permissionMode: "acceptEdits", allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"], disallowedTools: ["Bash(git push:*)", "Bash(gh pr:*)", "Bash(gh release:*)"] },
    codex: { sandbox: "workspace-write" },
    agy: { mode: "accept-edits", sandbox: false },
  },
};

// ── feature 13: the /<command> skill as a prompt for a non-claude model ─────
function skillPrompt(repo, cli, command, args) {
  if (cli === "claude") return `/${command} ${args}`.trim();          // claude -p expands the project's own skill
  const path = [".claude", ".agents"].map((d) => join(repo, d, "skills", command, "SKILL.md")).find(existsSync);
  if (!path) throw new Error(`no skill named "${command}" under .claude/skills or .agents/skills`);
  const body = readFileSync(path, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  return `You are running the /${command} step of this project's workflow in ${repo}. Read AGENTS.md first, then follow the instructions below exactly as written; they refer to files in this repository.\n\nArguments: ${args || "(none)"}\n\n---\n\n${body}`;
}

// ── launchers: each returns {cmd, args, parse(ev, ctx)} ─────────────────────
// ctx.tool(name, payload) records a tool call; ctx.text(s) sets the final text;
// ctx.tokens(in, out) sets the totals; ctx.note(s) is a progress line.
const LAUNCHERS = {
  claude({ model, prompt, sessionId, perms }) {
    const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--session-id", sessionId, "--permission-mode", perms.permissionMode];
    if (perms.allowedTools?.length) args.push("--allowedTools", ...perms.allowedTools);
    if (perms.disallowedTools?.length) args.push("--disallowedTools", ...perms.disallowedTools);
    return {
      cmd: "claude", args,
      parse(ev, ctx) {
        if (ev.type === "assistant") {
          for (const c of ev.message?.content ?? []) if (c.type === "tool_use") ctx.tool(c.name, summarizeToolInput(c.name, c.input));
        } else if (ev.type === "result") {
          ctx.text(ev.result ?? "");
          const u = ev.usage ?? {};
          ctx.tokens((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), u.output_tokens ?? 0);
          if (ev.is_error) ctx.note(`claude reported an error: ${ev.subtype}`);
          for (const d of ev.permission_denials ?? []) ctx.note(`permission denied: ${d.tool_name} ${JSON.stringify(summarizeToolInput(d.tool_name, d.tool_input)).slice(0, 120)}`);
        }
      },
    };
  },
  codex({ model, prompt, perms, cwd }) {
    const args = ["exec", "--json", "-m", model, "-C", cwd, "--skip-git-repo-check", "--color", "never", "-s", perms.sandbox, prompt];
    return {
      cmd: "codex", args,
      parse(ev, ctx) {
        if (ev.type === "item.completed") {
          const it = ev.item ?? {};
          if (it.type === "agent_message") ctx.text(it.text ?? "");
          else if (it.type === "command_execution") ctx.tool("command_execution", { command: String(it.command ?? "").slice(0, 200), exit_code: it.exit_code });
          else if (it.type === "error") ctx.note(`codex: ${it.message}`);
          else if (it.type !== "reasoning") ctx.tool(it.type, { id: it.id });
        } else if (ev.type === "turn.completed") {
          const u = ev.usage ?? {};
          ctx.tokens(u.input_tokens ?? 0, u.output_tokens ?? 0);
        } else if (ev.type === "turn.failed" || ev.type === "error") {
          ctx.note(`codex: ${ev.error?.message ?? ev.message ?? "turn failed"}`);
          ctx.failed();
        }
      },
    };
  },
  agy({ model, prompt, perms }) {
    const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--mode", perms.mode];
    if (perms.sandbox) args.push("--sandbox");
    return {
      cmd: "agy", args,
      parse(ev, ctx) {
        if (ev.event === "step_update") {
          const s = ev.step_update ?? {};
          if (s.state === "DONE" && s.step_type && !["user_input", "agent_response"].includes(s.step_type)) ctx.tool(s.step_type, { step: s.step_index });
        } else if (ev.event === "result") {
          const r = ev.result ?? {};
          ctx.text(r.response ?? "");
          ctx.tokens(r.usage?.input_tokens ?? 0, r.usage?.output_tokens ?? 0);
          if (r.status && r.status !== "SUCCESS") { ctx.note(`agy status ${r.status}`); ctx.failed(); }
        }
      },
    };
  },
};

// Never store a prompt or file contents; keep what the dashboard needs to name the call.
export function summarizeToolInput(name, input = {}) {
  if (name === "Bash") return { command: String(input.command ?? "").slice(0, 200) };
  if (input.file_path) return { file_path: input.file_path };
  if (input.pattern) return { pattern: input.pattern };
  return {};
}

// Ollama has no CLI JSON stream; one HTTP call to the local server. It cannot touch files.
async function runOllama({ model, prompt }, ctx) {
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
  });
  if (!res.ok) { ctx.note(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); ctx.failed(); return 1; }
  const j = await res.json();
  ctx.text(j.message?.content ?? "");
  ctx.tokens(j.prompt_eval_count ?? 0, j.eval_count ?? 0);
  return 0;
}

// ── feature 22: one writer per repo ─────────────────────────────────────────
const lockPath = (repo) => join(repo, "blueprint", ".state", "sf.lock");
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
export function takeLock(repo, info) {
  const p = lockPath(repo);
  mkdirSync(dirname(p), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(p, JSON.stringify({ ...info, pid: process.pid, takenAt: new Date().toISOString() }) + "\n", { flag: "wx" }); return () => { try { if (readJson(p)?.pid === process.pid) rmSync(p); } catch {} }; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = readJson(p);
      if (held?.pid && pidAlive(held.pid)) return null;             // a live writer holds it
      try { rmSync(p); } catch {}                                    // stale lock from a dead process
    }
  }
  return null;
}
export function lockHolder(repo) { return readJson(lockPath(repo)); }

// Feature 22: a write-capable command may run in its own worktree, .worktrees/<branch>.
function worktreeFor(repo) {
  const branch = git(repo, "branch", "--show-current");
  if (!branch) throw new Error("--worktree needs a checked-out branch (detached HEAD)");
  const path = join(repo, ".worktrees", branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
  if (existsSync(path)) return { path, branch, created: false };
  // git refuses a branch that is checked out elsewhere — that is the guard working, not a bug.
  try { execFileSync("git", ["worktree", "add", path, branch], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`git worktree add failed: ${String(e.stderr || e.message).trim().split("\n").pop()}. Check the branch out of the main tree first (git switch <other-branch>).`); }
  return { path, branch, created: true };
}

// Files changed between two `git status --porcelain` snapshots.
const porcelain = (cwd) => { try { return new Set(git(cwd, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3))); } catch { return new Set(); } };

// ── run ──────────────────────────────────────────────────────────────────────
async function run(argv) {
  const opts = parseArgs(argv);
  const [command, promptArg] = opts.positional;
  if (!command) { console.error("usage: sf run <command> <prompt | --prompt-file f | - | --skill \"<args>\">"); return 2; }
  const startCwd = opts.cwd ? opts.cwd : process.cwd();
  const repo = findRepo(startCwd);
  const log = (s) => { if (!opts.quiet) console.error(`[sf] ${s}`); };

  const trace = await openTrace(repo);
  const independent = !!opts.independent;
  const routing = readJson(join(repo, "blueprint", "harness.json"));
  const builder = independent ? builderModel(repo, routing, trace) : null;
  const pick = pickModel(repo, command, { cli: opts.cli, model: opts.model }, { independent, builder });
  if (!pick.choice) { trace.close(); console.error(`[sf] no usable model for /${command}: ${pick.blocked ?? pick.source}`); return 3; }
  if (pick.swapped) log(`${pick.swapped.cli}:${pick.swapped.model} is blocked (${pick.blocked}) → using backup ${pick.choice.cli}:${pick.choice.model}`);
  else if (pick.blocked) log(`warning: ${pick.choice.cli}:${pick.choice.model} is blocked (${pick.blocked}) but was forced with --cli/--model`);
  if (independent && builder) log(`independent review: builder was ${builder.cli}:${builder.model}`);
  const { cli, model } = pick.choice;
  if (cli !== "ollama" && !LAUNCHERS[cli]) { trace.close(); console.error(`[sf] unknown cli "${cli}"`); return 3; }

  let prompt;
  try {
    if (opts.skill !== undefined) prompt = skillPrompt(repo, cli, command, typeof opts.skill === "string" ? opts.skill : "");
    else if (opts.promptFile) prompt = readFileSync(opts.promptFile, "utf8");
    else if (promptArg === "-" || promptArg === undefined) prompt = readFileSync(0, "utf8");
    else prompt = promptArg;
  } catch (e) { trace.close(); console.error(`[sf] ${e.message}`); return 2; }
  if (!prompt?.trim()) { trace.close(); console.error("sf run: empty prompt"); return 2; }

  // Write class → flags, lock, worktree.
  const klass = cli === "ollama" ? "read-only" : permissionClass(repo, command, opts.permissions);
  const perms = PERMISSIONS[klass][cli] ?? {};
  let cwd = startCwd, release = null, wt = null;
  if (klass === "write") {
    release = takeLock(repo, { command, cli, model });
    if (!release) { const h = lockHolder(repo); trace.close(); console.error(`[sf] another write-capable run holds blueprint/.state/sf.lock: /${h?.command} ${h?.cli}:${h?.model} pid ${h?.pid} since ${h?.takenAt}. Wait for it, or run a read-only command.`); return 4; }
    if (opts.worktree) {
      try { wt = worktreeFor(repo); cwd = wt.path; log(`worktree ${wt.created ? "created" : "reused"}: ${wt.path} (${wt.branch})`); }
      catch (e) { release(); trace.close(); console.error(`[sf] ${e.message}`); return 2; }
    }
  }
  const scope = scopePatterns(repo);
  const before = porcelain(cwd);

  const sessionId = randomUUID();
  const parent = opts.parent || process.env.SF_PARENT_SESSION || readJson(join(repo, "blueprint", ".state", "host-session.json"))?.sessionId || null;
  const state = { text: "", tokensIn: 0, tokensOut: 0, failed: false, tools: 0 };
  const ctx = {
    tool(name, payload) { state.tools++; trace.event({ session: sessionId, kind: "tool_call", name, payload }); log(`  ${name} ${JSON.stringify(payload)}`); },
    text(s) { state.text = s; },
    tokens(i, o) { state.tokensIn = i; state.tokensOut = o; },
    note(s) { log(s); trace.event({ session: sessionId, kind: "note", payload: { message: String(s).slice(0, 500) } }); },
    failed() { state.failed = true; },
  };

  const launch = cli === "ollama" ? null : LAUNCHERS[cli]({ model, prompt, sessionId, perms, cwd });
  trace.sessionStart({
    id: sessionId, parent, command, cli, model, pid: process.pid,
    sandbox: !!(perms.sandbox), permissionMode: perms.permissionMode ?? perms.mode ?? perms.sandbox ?? klass,
    allowedTools: perms.allowedTools ?? null, disallowedTools: perms.disallowedTools ?? null, allowedPaths: klass === "write" ? scope : [],
  });
  trace.event({ session: sessionId, kind: "prompt", name: command, payload: { chars: prompt.length, source: pick.source, skill: opts.skill !== undefined, permissions: klass, worktree: wt?.path ?? null } });
  log(`/${command} → ${cli}:${model}  (${pick.source})  ${klass}  session ${sessionId}`);

  let exitCode = 0;
  try {
    if (cli === "ollama") exitCode = await runOllama({ model, prompt }, ctx);
    else {
      exitCode = await new Promise((resolve) => {
        const child = spawn(launch.cmd, launch.args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SF_SESSION: sessionId, SF_PARENT_SESSION: parent ?? "" } });
        trace.db.prepare("UPDATE sessions SET pid = ? WHERE session_id = ?").run(child.pid ?? null, sessionId);
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => {
          let ev; try { ev = JSON.parse(line); } catch { return; }   // codex prints log lines around its JSON
          try { launch.parse(ev, ctx); } catch (e) { ctx.note(`parse error: ${e.message}`); }
        });
        child.on("error", (e) => { ctx.note(`could not start ${launch.cmd}: ${e.message}`); resolve(127); });
        child.on("close", (code) => {
          if (code !== 0 && stderr.trim()) ctx.note(`${launch.cmd} stderr: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
          resolve(code ?? 1);
        });
      });
    }
    // Backstop (feature 16): what actually changed on disk, regardless of what the model says.
    const after = porcelain(cwd);
    const changed = [...after].filter((f) => !before.has(f) && !f.startsWith("blueprint/.state/"));   // our own trace/lock files are not the model's edits
    for (const f of changed) trace.file({ session: sessionId, path: f, actual: 1, inScope: scope ? (inScope(f, scope) ? 1 : 0) : null });
    if (klass === "read-only" && changed.length) {
      trace.gate({ session: sessionId, command, gate: "read-only", passed: 0, evidence: changed.join("\n") });
      log(`WARNING: read-only /${command} changed ${changed.length} file(s): ${changed.join(", ")}`);
      if (exitCode === 0) exitCode = 1;
    } else if (klass === "write" && scope && changed.length) {
      const outside = changed.filter((f) => !inScope(f, scope));
      trace.gate({ session: sessionId, command, gate: "scope", passed: outside.length ? 0 : 1, evidence: outside.length ? outside.join("\n") : `${changed.length} file(s), all in scope` });
      if (outside.length) log(`WARNING: /${command} changed files outside "Files in scope": ${outside.join(", ")}`);
    }
  } finally {
    if (exitCode === 0 && state.failed) exitCode = 1;
    trace.event({ session: sessionId, kind: "stop", name: command, tokensIn: state.tokensIn, tokensOut: state.tokensOut, payload: { tools: state.tools, chars: state.text.length } });
    trace.sessionEnd(sessionId, exitCode);
    trace.close();
    release?.();
  }
  log(`done  exit ${exitCode}  tokens in ${state.tokensIn} out ${state.tokensOut}  tool calls ${state.tools}`);

  if (opts.json) process.stdout.write(JSON.stringify({ sessionId, cli, model, text: state.text, tokensIn: state.tokensIn, tokensOut: state.tokensOut, exitCode, permissions: klass, worktree: wt?.path ?? null }) + "\n");
  else process.stdout.write(state.text.endsWith("\n") || !state.text ? state.text : state.text + "\n");
  return exitCode;
}

// "## Files in scope" of the current spec — same reading as hooks.mjs / gates.mjs.
function scopePatterns(repo) {
  const p = join(repo, "blueprint", "context", "current-feature.md");
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Files in scope");
  if (start === -1) return null;
  const pats = [];
  for (const l of lines.slice(start + 1)) { if (/^#{1,2}\s/.test(l)) break; const m = l.match(/^\s*-\s+`([^`]+)`/); if (m) pats.push(m[1]); }
  return pats.length ? pats : null;
}
const inScope = (f, pats) => f.startsWith("blueprint/") || pats.some((p) => f === p || (p.endsWith("/") && f.startsWith(p)) || matchesGlob(f, p));

// ── main ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sub, ...rest] = process.argv.slice(2);
  try {
    if (sub === "run") process.exitCode = await run(rest);
    else if (sub === "usage") {
      const { main } = await import(join(here, "usage-poller.mjs"));
      process.exitCode = await main(rest);
    }
    else { console.error("usage: sf run <command> <prompt> | sf usage [--once]"); process.exitCode = 2; }
  } catch (e) {
    console.error(`[sf] ${e.message}`);
    process.exitCode = 1;
  }
}
