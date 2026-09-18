#!/usr/bin/env node
// A1 Harness usage-window poller — writes blueprint/.state/usage.json.
//
//   node .harness/usage-poller.mjs [--once] [--interval 60] [--quiet]     (also: node .harness/sf.mjs usage …)
//
// Every interval it asks each logged-in CLI for its subscription windows:
//   claude  `claude -p "/usage" --output-format json`   → "Current session: N% used · resets …" / "Current week (all models): N% used"
//   agy     `agy -p "/usage" --output-format json`       → command.data.groups[].buckets[] (remaining_fraction, reset_time)
//   codex   `codex app-server` JSON-RPC `account/rateLimits/read` → primary/secondary {usedPercent, windowDurationMins, resetsAt}
//   ollama  no windows; present when `ollama list` works
// A group is `blocked` when its 5-hour or weekly window reaches usageBlockPercent
// from blueprint/harness.json (default 95). Shape: .harness/usage.schema.json.
// The file is replaced atomically; nothing else is written. sf.mjs reads it before
// every launch, the hooks before every delegation, the dashboard for its rail.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findRepo } from "./trace.mjs";

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const which = (cmd) => spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;

// Run a command with stdin text, collect stdout, give up after `timeout` ms.
function exec(cmd, args, { stdin = null, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] }); }
    catch (e) { return resolve({ ok: false, out: "", err: e.message }); }
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeout);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err: err.slice(-500) }); });
    if (stdin !== null) { child.stdin.write(stdin); }
  });
}

// ── model lists (once per process; only used to label the groups) ────────────
function modelLists() {
  const codexCache = readJson(join(homedir(), ".codex", "models_cache.json"));
  const agyOut = which("agy") ? spawnSync("agy", ["models"], { encoding: "utf8", timeout: 30000 }).stdout || "" : "";
  const agy = agyOut.split("\n").filter((l) => l.includes("\t")).map((l) => l.split("\t")[0].trim());
  const ollamaOut = which("ollama") ? spawnSync("ollama", ["list"], { encoding: "utf8", timeout: 10000 }).stdout || "" : "";
  return {
    claude: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    codex: (codexCache?.models || []).map((m) => m.slug || m.id).filter(Boolean),
    "agy-gemini": agy.filter((m) => /^gemini/.test(m)),
    "agy-3p": agy.filter((m) => !/^gemini/.test(m)),
    ollama: ollamaOut.split("\n").slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean),
  };
}

// ── probes: each resolves to {groupId: {label, fiveHour, weekly}} or {error} ─
// "Sep 19 at 2:20am (Asia/Kuala_Lumpur)" → ISO, assuming the next such date from now.
function claudeResetToIso(text) {
  const m = text.match(/([A-Z][a-z]{2}) (\d{1,2})(?: at (\d{1,2})(?::(\d{2}))?(am|pm))?/);
  if (!m) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mo = months.indexOf(m[1]); if (mo < 0) return null;
  let h = m[3] ? Number(m[3]) % 12 : 0; if (m[5] === "pm") h += 12;
  const now = new Date();
  let d = new Date(now.getFullYear(), mo, Number(m[2]), h, Number(m[4] || 0));
  if (d.getTime() < now.getTime() - 86400e3) d = new Date(now.getFullYear() + 1, mo, Number(m[2]), h, Number(m[4] || 0));
  return d.toISOString();
}

async function probeClaude() {
  const r = await exec("claude", ["-p", "/usage", "--output-format", "json"], { timeout: 60000 });
  let text = "";
  try { text = JSON.parse(r.out).result || ""; } catch { return { error: `claude: ${r.err || "no JSON"}`.trim() }; }
  const five = text.match(/Current session:\s*(\d+)% used(?:\s*·\s*resets ([^\n]+))?/);
  const week = text.match(/Current week[^:]*:\s*(\d+)% used(?:\s*·\s*resets ([^\n]+))?/);
  if (!five && !week) return { error: `claude: could not find "% used" in /usage output` };
  const win = (m) => (m ? { usedPercent: Number(m[1]), resetsAt: m[2] ? claudeResetToIso(m[2]) : null, resetsText: m[2] ?? null } : null);
  return { claude: { label: "Claude Code", fiveHour: win(five), weekly: win(week) } };
}

async function probeAgy() {
  const r = await exec("agy", ["-p", "/usage", "--output-format", "json"], { timeout: 60000 });
  let groups;
  try { groups = JSON.parse(r.out).command?.data?.groups; } catch { return { error: `agy: ${r.err || "no JSON"}`.trim() }; }
  if (!Array.isArray(groups)) return { error: "agy: /usage returned no groups" };
  const out = {};
  for (const g of groups) {
    const id = /gemini/i.test(g.name) ? "agy-gemini" : "agy-3p";
    const win = (w) => { const b = (g.buckets || []).find((x) => x.window === w); return b ? { usedPercent: Math.round((1 - (b.remaining_fraction ?? 1)) * 100), resetsAt: b.reset_time ?? null } : null; };
    out[id] = { label: `Antigravity — ${g.name}`, fiveHour: win("5h"), weekly: win("weekly") };
  }
  return out;
}

async function probeCodex() {
  const req = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "a1-harness", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  // app-server keeps running until stdin closes; we close it after it answers id 2.
  const r = await new Promise((resolve) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch {} resolve({ ok, out, err }); };
    const timer = setTimeout(() => finish(false), 30000);
    child.stdout.on("data", (d) => { out += d; if (/"id":2[,}]/.test(out)) finish(true); });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { err += e.message; finish(false); });
    child.on("close", () => finish(false));
    child.stdin.write(req);
  });
  const line = r.out.split("\n").find((l) => /"id":2[,}]/.test(l));
  let rl;
  try { rl = JSON.parse(line).result?.rateLimits; } catch { return { error: `codex: ${r.err.slice(-200) || "no rateLimits reply"}`.trim() }; }
  if (!rl) return { error: "codex: rateLimits missing in reply" };
  const win = (w) => (w ? { usedPercent: w.usedPercent ?? null, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null, windowMinutes: w.windowDurationMins ?? null } : null);
  // Codex names its windows by length, not by "5h"/"weekly": ≤ 10 h counts as the short window.
  const wins = [rl.primary, rl.secondary].filter(Boolean).map(win);
  const fiveHour = wins.find((w) => w.windowMinutes && w.windowMinutes <= 600) ?? null;
  const weekly = wins.find((w) => !w.windowMinutes || w.windowMinutes > 600) ?? null;
  return { codex: { label: `Codex (${rl.planType ?? "ChatGPT"})`, fiveHour, weekly } };
}

async function probeOllama() {
  const r = await exec("ollama", ["list"], { timeout: 10000 });
  return r.ok ? { ollama: { label: "Local Ollama", fiveHour: null, weekly: null } } : { error: "ollama: not running" };
}

// ── one poll ─────────────────────────────────────────────────────────────────
export async function pollOnce(repo, models, log = () => {}) {
  const threshold = readJson(join(repo, "blueprint", "harness.json"))?.usageBlockPercent ?? 95;
  const probes = { claude: probeClaude, agy: probeAgy, codex: probeCodex, ollama: probeOllama };
  const results = await Promise.all(Object.entries(probes).map(async ([cli, fn]) => (which(cli) ? fn() : { error: `${cli}: not installed` })));
  const groups = {}, errors = [];
  for (const r of results) {
    if (r.error) { errors.push(r.error); continue; }
    for (const [id, g] of Object.entries(r)) {
      const over = ["fiveHour", "weekly"].filter((w) => g[w] && g[w].usedPercent != null && g[w].usedPercent >= threshold);
      groups[id] = {
        label: g.label, models: models[id] ?? [], fiveHour: g.fiveHour, weekly: g.weekly,
        blocked: over.length > 0,
        reason: over.length ? over.map((w) => `${w} ${g[w].usedPercent}% >= ${threshold}%`).join("; ") : null,
      };
    }
  }
  const doc = { polledAt: new Date().toISOString(), thresholdPercent: threshold, groups, errors };
  const stateDir = join(repo, "blueprint", ".state");
  mkdirSync(stateDir, { recursive: true });
  const out = join(stateDir, "usage.json"), tmp = out + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, out);
  const summary = Object.entries(groups).map(([id, g]) => `${id} ${g.fiveHour?.usedPercent ?? "–"}%/${g.weekly?.usedPercent ?? "–"}%${g.blocked ? " BLOCKED" : ""}`).join("  ");
  log(`${doc.polledAt}  ${summary}${errors.length ? `  (${errors.join("; ")})` : ""}`);
  return doc;
}

export async function main(argv = []) {
  const once = argv.includes("--once"), quiet = argv.includes("--quiet");
  const iv = argv.indexOf("--interval");
  const interval = Math.max(10, Number(iv >= 0 ? argv[iv + 1] : 60)) * 1000;
  const repo = findRepo();
  const log = quiet ? () => {} : (s) => console.error(`[usage] ${s}`);
  const models = modelLists();
  if (!once) log(`polling every ${interval / 1000}s → blueprint/.state/usage.json (ctrl-c to stop)`);
  for (;;) {
    try { await pollOnce(repo, models, log); } catch (e) { log(`poll failed: ${e.message}`); }
    if (once) return 0;
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2)).catch((e) => { console.error(`[usage] ${e.message}`); return 1; });
}
