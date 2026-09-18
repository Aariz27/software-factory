#!/usr/bin/env node
// A1 Harness `sf` wrapper — the one way a skill hands a step to another model.
//
//   node .harness/sf.mjs run <command> "<prompt>"          prompt as an argument
//   node .harness/sf.mjs run <command> --prompt-file f     prompt from a file
//   node .harness/sf.mjs run <command> -                   prompt from stdin
//     options: --cli claude|codex|agy|ollama  --model <id>   override blueprint/harness.json
//              --parent <session-id>                       the host session that delegated (also $SF_PARENT_SESSION)
//              --permission-mode <m> --allowed-tools "A,B" --disallowed-tools "A,B"   (claude)
//              --sandbox <read-only|workspace-write|danger-full-access>              (codex)
//              --mode <accept-edits|plan> --agy-sandbox                              (agy)
//              --json      print {sessionId, cli, model, text, tokensIn, tokensOut, exitCode} instead of the text
//              --quiet     no progress lines on stderr
//   node .harness/sf.mjs usage [--once] [--interval 60]    the usage-window poller (usage-poller.mjs)
//
// What `run` does, in order:
//   1. picks the model for <command> from blueprint/harness.json (commands.<command> → default)
//   2. reads blueprint/.state/usage.json; a blocked model is swapped for its backup and the swap is printed
//   3. launches the CLI headless with a fresh session id, streams its JSON events
//   4. writes the session, every tool call and the token totals to blueprint/.state/trace.db
//   5. prints the model's final text on stdout; exit code = the child's exit code
// Exit 3 = no usable model (routing missing, or primary and backup both blocked).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { findRepo, openTrace } from "./trace.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
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

// ── routing + usage ──────────────────────────────────────────────────────────
// Which usage.json group a model draws from. Mirrors usage-poller.mjs.
export function usageGroup(cli, model) {
  if (cli === "agy") return /^gemini/.test(model) ? "agy-gemini" : "agy-3p";
  return cli;
}

export function pickModel(repo, command, override) {
  const routing = readJson(join(repo, "blueprint", "harness.json"));
  const usage = readJson(join(repo, "blueprint", ".state", "usage.json"));
  const blockedReason = (c) => {
    if (!c || !usage?.groups) return null;
    const g = usage.groups[usageGroup(c.cli, c.model)];
    return g?.blocked ? g.reason || "blocked" : null;
  };

  if (override?.cli && override?.model) {
    const c = { cli: override.cli, model: override.model };
    return { choice: c, source: "--cli/--model", blocked: blockedReason(c), swapped: null };
  }
  if (!routing?.default) return { choice: null, source: "blueprint/harness.json missing or has no default — run /models", blocked: null, swapped: null };

  const per = routing.commands?.[command];
  const primary = per?.cli && per?.model ? { cli: per.cli, model: per.model } : routing.default;
  const backup = per?.backup?.cli ? per.backup : routing.backup;
  const source = per?.cli ? `harness.json commands.${command}` : "harness.json default";

  const pb = blockedReason(primary);
  if (!pb) return { choice: primary, source, blocked: null, swapped: null };
  if (!backup) return { choice: null, source, blocked: pb, swapped: null, primary };
  const bb = blockedReason(backup);
  if (bb) return { choice: null, source, blocked: `${primary.cli}:${primary.model} ${pb}; backup ${backup.cli}:${backup.model} ${bb}`, swapped: null, primary };
  return { choice: backup, source: `${source} → backup`, blocked: pb, swapped: primary };
}

// ── launchers: each returns {cmd, args, stdin?, parse(line, ctx)} ───────────
// ctx.tool(name, payload) records a tool call; ctx.text(s) sets the final text;
// ctx.tokens(in, out) sets the totals; ctx.note(s) is a progress line.
const LAUNCHERS = {
  claude({ model, prompt, sessionId, opts }) {
    const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--session-id", sessionId];
    if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
    if (opts.allowedTools) args.push("--allowedTools", ...list(opts.allowedTools));
    if (opts.disallowedTools) args.push("--disallowedTools", ...list(opts.disallowedTools));
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
        }
      },
    };
  },
  codex({ model, prompt, opts, cwd }) {
    const args = ["exec", "--json", "-m", model, "-C", cwd, "--skip-git-repo-check", "--color", "never"];
    if (opts.sandbox) args.push("-s", opts.sandbox);
    args.push(prompt);
    return {
      cmd: "codex", args,
      parse(ev, ctx) {
        if (ev.type === "item.completed") {
          const it = ev.item ?? {};
          if (it.type === "agent_message") ctx.text(it.text ?? "");
          else if (it.type === "command_execution") ctx.tool("command_execution", { command: it.command, exit_code: it.exit_code });
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
  agy({ model, prompt, opts }) {
    const args = ["-p", prompt, "--model", model, "--output-format", "stream-json"];
    if (opts.mode) args.push("--mode", opts.mode);
    if (opts.agySandbox) args.push("--sandbox");
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
function summarizeToolInput(name, input = {}) {
  if (name === "Bash") return { command: String(input.command ?? "").slice(0, 200) };
  if (input.file_path) return { file_path: input.file_path };
  if (input.pattern) return { pattern: input.pattern };
  return {};
}

// Ollama has no CLI JSON stream; one HTTP call to the local server.
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

// ── run ──────────────────────────────────────────────────────────────────────
async function run(argv) {
  const opts = parseArgs(argv);
  const [command, promptArg] = opts.positional;
  if (!command) { console.error("usage: sf run <command> <prompt | --prompt-file f | ->"); return 2; }
  let prompt = promptArg;
  if (opts.promptFile) prompt = readFileSync(opts.promptFile, "utf8");
  else if (prompt === "-" || prompt === undefined) prompt = readFileSync(0, "utf8");
  if (!prompt?.trim()) { console.error("sf run: empty prompt"); return 2; }

  const cwd = opts.cwd ? opts.cwd : process.cwd();
  const repo = findRepo(cwd);
  const log = (s) => { if (!opts.quiet) console.error(`[sf] ${s}`); };

  const pick = pickModel(repo, command, { cli: opts.cli, model: opts.model });
  if (!pick.choice) {
    console.error(`[sf] no usable model for /${command}: ${pick.blocked ?? pick.source}`);
    return 3;
  }
  if (pick.swapped) log(`${pick.swapped.cli}:${pick.swapped.model} is blocked (${pick.blocked}) → using backup ${pick.choice.cli}:${pick.choice.model}`);
  else if (pick.blocked) log(`warning: ${pick.choice.cli}:${pick.choice.model} is blocked (${pick.blocked}) but was forced with --cli/--model`);
  const { cli, model } = pick.choice;
  if (cli !== "ollama" && !LAUNCHERS[cli]) { console.error(`[sf] unknown cli "${cli}"`); return 3; }

  const sessionId = randomUUID();
  const parent = opts.parent || process.env.SF_PARENT_SESSION || null;
  const trace = await openTrace(repo);
  const state = { text: "", tokensIn: 0, tokensOut: 0, failed: false, tools: 0 };
  const ctx = {
    tool(name, payload) { state.tools++; trace.event({ session: sessionId, kind: "tool_call", name, payload }); log(`  ${name} ${JSON.stringify(payload)}`); },
    text(s) { state.text = s; },
    tokens(i, o) { state.tokensIn = i; state.tokensOut = o; },
    note(s) { log(s); trace.event({ session: sessionId, kind: "note", payload: { message: String(s).slice(0, 500) } }); },
    failed() { state.failed = true; },
  };

  const launch = cli === "ollama" ? null : LAUNCHERS[cli]({ model, prompt, sessionId, opts, cwd });
  trace.sessionStart({
    id: sessionId, parent, command, cli, model, pid: process.pid,
    sandbox: !!(opts.sandbox || opts.agySandbox), permissionMode: opts.permissionMode || opts.mode || opts.sandbox || null,
    allowedTools: opts.allowedTools ? list(opts.allowedTools) : null, disallowedTools: opts.disallowedTools ? list(opts.disallowedTools) : null,
  });
  trace.event({ session: sessionId, kind: "prompt", name: command, payload: { chars: prompt.length, source: pick.source } });
  log(`/${command} → ${cli}:${model}  (${pick.source})  session ${sessionId}`);

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
  } finally {
    if (exitCode === 0 && state.failed) exitCode = 1;
    trace.event({ session: sessionId, kind: "stop", name: command, tokensIn: state.tokensIn, tokensOut: state.tokensOut, payload: { tools: state.tools, chars: state.text.length } });
    trace.sessionEnd(sessionId, exitCode);
    trace.close();
  }
  log(`done  exit ${exitCode}  tokens in ${state.tokensIn} out ${state.tokensOut}  tool calls ${state.tools}`);

  if (opts.json) process.stdout.write(JSON.stringify({ sessionId, cli, model, text: state.text, tokensIn: state.tokensIn, tokensOut: state.tokensOut, exitCode }) + "\n");
  else process.stdout.write(state.text.endsWith("\n") || !state.text ? state.text : state.text + "\n");
  return exitCode;
}

// ── main ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sub, ...rest] = process.argv.slice(2);
  try {
    if (sub === "run") process.exitCode = await run(rest);
    else if (sub === "usage") {
      const poller = join(here, "usage-poller.mjs");
      if (!existsSync(poller)) throw new Error("usage-poller.mjs is missing");
      const { main } = await import(poller);
      process.exitCode = await main(rest);
    }
    else { console.error("usage: sf run <command> <prompt> | sf usage [--once]"); process.exitCode = 2; }
  } catch (e) {
    console.error(`[sf] ${e.message}`);
    process.exitCode = 1;
  }
}
