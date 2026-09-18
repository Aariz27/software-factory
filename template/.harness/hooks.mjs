#!/usr/bin/env node
// A1 Harness hooks — wired by .claude/settings.json, one process per event:
//
//   node .harness/hooks.mjs session-start   SessionStart     remember the host session + model, open its trace row
//   node .harness/hooks.mjs prompt          UserPromptSubmit record the /command; route it through sf.mjs when
//                                                            harness.json assigns another cli:model; start run.json
//   node .harness/hooks.mjs pre-bash        PreToolUse Bash  usage hard block for direct `claude -p` / `codex exec` /
//                                                            `agy -p` calls; bounded loops (3 test→fix, 2 review→revise)
//   node .harness/hooks.mjs pre-edit        PreToolUse Edit|Write|MultiEdit|NotebookEdit
//                                                            deny edits outside "## Files in scope" of current-feature.md
//   node .harness/hooks.mjs post-tool       PostToolUse      tool call → trace.db; edits → files_touched; gates.mjs → gates
//   node .harness/hooks.mjs subagent-start  SubagentStart    trace event
//   node .harness/hooks.mjs subagent-stop   SubagentStop     trace event
//   node .harness/hooks.mjs stop            Stop             token delta from the transcript → trace.db; close run.json
//
// Headless children (`claude -p`, launched by sf.mjs) already have their own trace
// rows, so the trace/run.json hooks exit early when the parent process is a
// `-p` / `--print` claude. The two blocking hooks (pre-bash, pre-edit) run everywhere.
// A hook never fails the host: every error is swallowed and exits 0.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepo, openTrace } from "./trace.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...r) => { const t = typeof r[0] === "string" ? r[0] : r[0]?.type; if (t !== "ExperimentalWarning") emitWarning.call(process, w, ...r); };

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const writeJsonAtomic = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p + ".tmp", JSON.stringify(v, null, 2) + "\n"); renameSync(p + ".tmp", p); };
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// Is the process that launched this hook a headless claude? (`claude -p …` / `--print`)
export function parentIsHeadless(ppid = process.ppid) {
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(ppid)], { encoding: "utf8" });
    return /(^|\s)(-p|--print)(\s|$)/.test(args);
  } catch { return false; }
}

// Commands Blueprint tracks in run.json (AGENTS.md "Dashboard activity").
const TRACKED = new Set(["onboard", "adopt", "discovery", "overview", "feature", "fix", "rollback", "implement", "debug", "check", "audit", "tests", "ci", "prototype", "autopilot", "continuous", "complete", "release", "plan"]);
const LOOPING = new Set(["implement", "autopilot", "continuous", "fix"]);
// Feature 17: which deterministic gates a command must run before it reports done.
const GATES_FOR = {
  implement: ["test", "scope", "claimed <every file you say you changed>"],
  fix: ["test", "scope", "claimed <every file you say you changed>"],
  autopilot: ["test", "scope", "claimed <every file you say you changed>"],
  continuous: ["test", "scope", "claimed <every file you say you changed>"],
  audit: ["diff", "review"],
  check: ["test"],
  complete: ["commit-ready", "test", "scope", "review"],
  ci: ["test"],
};
const MAX_TEST_FIX = 3, MAX_REVIEW_REVISE = 2;

// ── shared readers ───────────────────────────────────────────────────────────
function section(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const level = heading.match(/^#+/)[0].length;
  const outLines = [];
  for (const l of lines.slice(start + 1)) { const m = l.match(/^(#+)\s/); if (m && m[1].length <= level) break; outLines.push(l); }
  return outLines.join("\n");
}
const bullets = (t) => (t ?? "").split("\n").map((l) => l.match(/^\s*-\s+(.*\S)/)?.[1]).filter(Boolean);

export function scopePatterns(repo) {
  const specPath = join(repo, "blueprint", "context", "current-feature.md");
  if (!existsSync(specPath)) return null;
  const spec = readFileSync(specPath, "utf8");
  const listed = section(spec, "## Files in scope");
  if (listed === null) return null;
  const pats = bullets(listed).map((b) => b.match(/^`([^`]+)`/)?.[1]).filter(Boolean);
  return pats.length ? pats : null;
}
export function inScope(relPath, patterns) {
  if (relPath.startsWith("blueprint/")) return true;                    // the workflow's own memory is always writable
  return patterns.some((p) => relPath === p || (p.endsWith("/") && relPath.startsWith(p)) || matchesGlob(relPath, p));
}

export function verifyCommand(repo) {
  const agents = existsSync(join(repo, "AGENTS.md")) ? readFileSync(join(repo, "AGENTS.md"), "utf8") : "";
  const m = agents.match(/^-\s*Verify:\s*`(.+)`\s*$/m);
  return m ? m[1].trim() : null;
}

const usageGroup = (cli, model) => (cli === "agy" ? (/^gemini/.test(model || "") ? "agy-gemini" : "agy-3p") : cli);

// Which CLI and model a shell command would launch, if it launches one directly.
export function detectDelegation(command) {
  const c = String(command || "");
  if (/\.harness\/sf\.mjs\s+run\b/.test(c)) return { cli: "sf" };                  // the wrapper swaps blocked models itself
  const model = c.match(/(?:--model|-m)[ =]([^\s"']+)/)?.[1] ?? null;
  if (/(^|[\s;&|(])claude\b[^;&|]*?(?:\s-p(?=\s|$)|\s--print\b)/.test(c)) return { cli: "claude", model };
  if (/(^|[\s;&|(])codex\s+exec\b/.test(c)) return { cli: "codex", model };
  if (/(^|[\s;&|(])agy\b[^;&|]*?(?:\s-p(?=\s|$)|\s--print\b|\s--prompt\b)/.test(c)) return { cli: "agy", model };
  return null;
}

function summarizeInput(tool, input = {}) {
  if (tool === "Bash") return { command: String(input.command ?? "").slice(0, 200) };
  if (input.file_path) return { file_path: input.file_path };
  if (input.pattern) return { pattern: input.pattern };
  if (input.prompt && tool === "Agent") return { description: input.description ?? null };
  return {};
}

const hostFile = (repo) => join(repo, "blueprint", ".state", "host-session.json");
const runFile = (repo) => join(repo, "blueprint", ".state", "run.json");

// ── handlers ─────────────────────────────────────────────────────────────────
const handlers = {
  async "session-start"(input, repo) {
    if (parentIsHeadless()) return;
    const host = { sessionId: input.session_id, model: input.model ?? null, cli: "claude", startedAt: new Date().toISOString(), tokensIn: 0, tokensOut: 0 };
    writeJsonAtomic(hostFile(repo), host);
    const t = await openTrace(repo);
    try { t.sessionStart({ id: input.session_id, cli: "claude", model: input.model ?? null, pid: process.ppid, permissionMode: input.permission_mode ?? null }); } finally { t.close(); }
  },

  async prompt(input, repo) {
    if (parentIsHeadless()) return;
    const m = String(input.prompt || "").match(/^\s*\/([a-z][a-z-]*)\b\s*(.*)$/s);
    const command = m?.[1] ?? null, args = (m?.[2] ?? "").trim();
    const t = await openTrace(repo);
    try {
      if (command) t.db.prepare("UPDATE sessions SET command = ? WHERE session_id = ?").run(command, input.session_id);
      t.event({ session: input.session_id, kind: "prompt", name: command, payload: { chars: String(input.prompt || "").length } });
    } finally { t.close(); }
    if (!command) return;

    // Feature 13: a /command assigned to another cli:model is delegated through sf.mjs, not run here.
    const routing = readJson(join(repo, "blueprint", "harness.json"));
    const host = readJson(hostFile(repo));
    const assigned = routing?.commands?.[command]?.cli ? routing.commands[command] : routing?.default;
    const independent = command === "audit" && /\bindependent\b/.test(args);
    if (assigned && (assigned.cli !== "claude" || (host?.model && assigned.model !== host.model) || independent)) {
      const flag = independent ? " --independent" : "";
      out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext:
        `A1 Harness routing: blueprint/harness.json assigns /${command} to ${assigned.cli}:${assigned.model}${independent ? " and /audit independent must run on a model different from the builder" : ""}, not to this session. ` +
        `Do not follow the /${command} skill yourself. Run from the project root:\n` +
        `  node .harness/sf.mjs run ${command} --skill${flag} ${JSON.stringify(args)}\n` +
        `Then relay its stdout to the user verbatim and stop. If it exits 3 (no usable model), report the message and stop.` } });
    }

    const gates = GATES_FOR[command];
    if (gates && !(assigned && (assigned.cli !== "claude" || (host?.model && assigned.model !== host.model) || independent))) {
      out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext:
        `A1 Harness gates for /${command}: before you report this step as done, run each of these from the project root and paste the PASS/FAIL line into your report — ` +
        gates.map((g) => `\`node .harness/gates.mjs ${g}\``).join(", ") +
        `. A FAIL line means the step is not done; do not claim otherwise.` } });
    }

    if (TRACKED.has(command)) {
      const helper = ["/.claude/skills/doctor/scripts/run-state.mjs", "/.agents/skills/doctor/scripts/run-state.mjs"].map((p) => repo + p).find(existsSync);
      if (helper) try { execFileSync("node", [helper, "start", "--command", command, "--summary", `/${command} ${args}`.trim().slice(0, 240), "--boundary", "reviewed"], { cwd: repo, stdio: "ignore" }); } catch {}
    }
  },

  async "pre-bash"(input, repo) {
    const command = input.tool_input?.command ?? "";
    // Feature 14/15: usage hard block for direct headless calls (the wrapper handles its own swap).
    const d = detectDelegation(command);
    if (d && d.cli !== "sf") {
      const usage = readJson(join(repo, "blueprint", ".state", "usage.json"));
      const g = usage?.groups?.[usageGroup(d.cli, d.model)];
      if (g?.blocked) return out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: `${d.cli}${d.model ? ":" + d.model : ""} is blocked by its usage window (${g.reason}). Use \`node .harness/sf.mjs run <command> …\`, which switches to the backup model from blueprint/harness.json.` } });
    }
    // Feature 18: bounded loops inside /implement (and the modes that wrap it).
    const run = readJson(runFile(repo));
    if (!run || run.status !== "running" || !LOOPING.has(run.command)) return;
    const verify = verifyCommand(repo);
    const isTest = verify && command.includes(verify) || /\.harness\/gates\.mjs\s+test\b/.test(command);
    const isReview = /\.harness\/gates\.mjs\s+review\b/.test(command) || /\.harness\/sf\.mjs\s+run\s+audit\b/.test(command);
    if (!isTest && !isReview) return;
    const loops = { testFix: 0, reviewRevise: 0, ...(run.loops ?? {}) };
    const key = isTest ? "testFix" : "reviewRevise", max = isTest ? MAX_TEST_FIX : MAX_REVIEW_REVISE;
    if (loops[key] >= max) return out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: `/${run.command} reached the limit of ${max} ${isTest ? "test→fix" : "review→revise"} rounds (run.json loops.${key}). Stop, report what still fails, and hand the decision to the user.` } });
    loops[key] += 1;
    writeJsonAtomic(runFile(repo), { ...run, loops, updatedAt: new Date().toISOString() });
    out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: `A1 Harness: ${key} round ${loops[key]} of ${max}.` } });
  },

  async "pre-edit"(input, repo) {
    const fp = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (!fp) return;
    const patterns = scopePatterns(repo);
    if (!patterns) return;                                                 // no spec / no section → nothing to enforce
    const rel = relative(repo, resolve(input.cwd || repo, fp));
    if (rel.startsWith("..")) return out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${fp} is outside the project` } });
    if (inScope(rel, patterns)) return;
    out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: `${rel} is not listed under "## Files in scope" in blueprint/context/current-feature.md (listed: ${patterns.join(", ")}). Add it to the spec with the user's approval, or leave the file alone.` } });
  },

  async "post-tool"(input, repo) {
    if (parentIsHeadless()) return;
    const tool = input.tool_name, ti = input.tool_input ?? {};
    const t = await openTrace(repo);
    try {
      t.event({ session: input.session_id, kind: "tool_call", name: tool, payload: summarizeInput(tool, ti) });
      if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) && (ti.file_path || ti.notebook_path)) {
        const rel = relative(repo, resolve(input.cwd || repo, ti.file_path || ti.notebook_path));
        const patterns = scopePatterns(repo);
        t.file({ session: input.session_id, path: rel, actual: 1, inScope: patterns ? (inScope(rel, patterns) ? 1 : 0) : null });
      }
      const gate = tool === "Bash" && String(ti.command || "").match(/\.harness\/gates\.mjs\s+([a-z-]+)/)?.[1];
      if (gate) {
        const text = typeof input.tool_response === "string" ? input.tool_response : JSON.stringify(input.tool_response ?? "");
        const verdict = text.match(/^(PASS|FAIL)\b/m)?.[1];
        if (verdict) t.gate({ session: input.session_id, command: readJson(runFile(repo))?.command ?? null, gate, passed: verdict === "PASS", evidence: text.slice(0, 1000) });
      }
    } finally { t.close(); }
  },

  async "subagent-start"(input, repo) {
    if (parentIsHeadless()) return;
    const t = await openTrace(repo);
    try { t.event({ session: input.session_id, kind: "subagent_start", name: input.agent_type ?? null, payload: { agent_id: input.agent_id ?? null } }); } finally { t.close(); }
  },
  async "subagent-stop"(input, repo) {
    if (parentIsHeadless()) return;
    const t = await openTrace(repo);
    try { t.event({ session: input.session_id, kind: "subagent_stop", name: input.agent_type ?? null, payload: { agent_id: input.agent_id ?? null } }); } finally { t.close(); }
  },

  async stop(input, repo) {
    if (parentIsHeadless()) return;
    // Tokens: the transcript holds every assistant message's usage; record this turn's delta.
    let tin = 0, tout = 0;
    try {
      for (const line of readFileSync(input.transcript_path, "utf8").split("\n")) {
        if (!line.includes('"usage"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const u = j.message?.usage; if (!u || j.type !== "assistant") continue;
        tin += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        tout += u.output_tokens ?? 0;
      }
    } catch {}
    const host = readJson(hostFile(repo)) ?? { sessionId: input.session_id, tokensIn: 0, tokensOut: 0 };
    const dIn = Math.max(0, tin - (host.tokensIn ?? 0)), dOut = Math.max(0, tout - (host.tokensOut ?? 0));
    writeJsonAtomic(hostFile(repo), { ...host, sessionId: input.session_id, tokensIn: tin, tokensOut: tout });
    const t = await openTrace(repo);
    try { t.event({ session: input.session_id, kind: "stop", name: input.stop_reason ?? null, tokensIn: dIn, tokensOut: dOut }); } finally { t.close(); }

    const run = readJson(runFile(repo));
    if (run?.status === "running") {
      const helper = ["/.claude/skills/doctor/scripts/run-state.mjs", "/.agents/skills/doctor/scripts/run-state.mjs"].map((p) => repo + p).find(existsSync);
      if (helper) try { execFileSync("node", [helper, "finish", "--status", "ready", "--summary", `/${run.command} turn ended — waiting for the user`], { cwd: repo, stdio: "ignore" }); } catch {}
    }
  },
};

// ── main ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const event = process.argv[2];
  try {
    const raw = readFileSync(0, "utf8");
    const input = raw.trim() ? JSON.parse(raw) : {};
    const repo = findRepo(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (handlers[event]) await handlers[event](input, repo);
    else console.error(`hooks: unknown event "${event}"`);
  } catch (e) {
    if (process.env.SF_HOOK_DEBUG) console.error(`hooks(${event}): ${e.message}`);
  }
  process.exit(0);
}
