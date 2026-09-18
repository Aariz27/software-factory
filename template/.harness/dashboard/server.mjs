#!/usr/bin/env node
// A1 Harness dashboard — read-only localhost view of one project.
//
//   node .harness/dashboard/server.mjs [repo-dir] [--port 4747] [--open]
//
// Nothing here is written by a model. Every number on the page comes from a
// file on disk, a git command, the process table, or the trace database, read
// fresh on every /api/state request. The page polls that endpoint; if a poll
// fails or goes quiet the page shows STALE instead of pretending.

import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";

// node:sqlite is marked experimental on Node 22/23; the warning is noise here.
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });

const here = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();

function parseArgs(argv) {
  const o = { repo: process.cwd(), port: 4747, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--open") o.open = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else o.repo = resolve(a);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const REPO = opts.repo;
const STATE_DIR = join(REPO, "blueprint", ".state");

// ── helpers ──────────────────────────────────────────────────────────────────

function readText(p) { try { return readFileSync(p, "utf8"); } catch { return null; } }
function readJson(p) { const t = readText(p); if (t === null) return null; try { return JSON.parse(t); } catch { return { _invalid: true }; } }
function git(args) {
  try { return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd(); }
  catch { return null; }
}
function which(cmd) {
  try { execFileSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] }); return true; } catch { return false; }
}
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let names; try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(dir);
  return newest ? new Date(newest).toISOString() : null;
}

// ── data sources ─────────────────────────────────────────────────────────────

function repoInfo() {
  return {
    path: REPO,
    gitRepo: git(["rev-parse", "--is-inside-work-tree"]) === "true",
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    blueprintPresent: existsSync(join(REPO, "blueprint")),
    lastChange: newestMtime(join(REPO, "blueprint")),
  };
}

function runState() {
  const p = join(STATE_DIR, "run.json");
  const j = readJson(p);
  if (!j) return null;
  const updated = Date.parse(j.updatedAt || "");
  return { ...j, ageSeconds: Number.isFinite(updated) ? Math.round((Date.now() - updated) / 1000) : null };
}

// Parses the `### F-n [P0] <status>` findings-ledger headings the same way
// gates.mjs's review gate does, and counts only the ones still open.
function countOpenFindings(findings) {
  const counts = { P0: 0, P1: 0 };
  for (const m of findings.matchAll(/^###\s+(F-\d+)\s+\[(P[01])\]\s+(open|fixed)\b.*$/gim))
    if (/^open$/i.test(m[3])) counts[m[2]]++;
  return counts;
}

function pipeline() {
  const bp = readText(join(REPO, "blueprint", "build-plan.md")) || "";
  const items = [];
  for (const line of bp.split("\n")) {
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(?:(\d+)\.\s*)?(.*)$/);
    if (m) items.push({ done: m[1] !== " ", id: m[2] || null, title: m[3].replace(/\*\*/g, "").trim() });
  }
  const cf = readText(join(REPO, "blueprint", "context", "current-feature.md")) || "";
  const statusLine = (cf.match(/\*\*Status:\*\*\s*(.+)/) || [])[1] || null;
  const featureTitle = (cf.match(/^#\s+(?!Current Feature)(.+)$/m) || [])[1] || null;
  const inProgress = !/_Nothing in progress/.test(cf) && cf.trim().length > 0;
  const findings = readText(join(REPO, "blueprint", "context", "findings.md")) || "";
  const openCounts = countOpenFindings(findings);
  return {
    buildPlan: { total: items.length, done: items.filter((i) => i.done).length, items },
    currentFeature: { inProgress, title: featureTitle, status: statusLine },
    findings: { p0: openCounts.P0, p1: openCounts.P1 },
  };
}

function gitInfo() {
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
  const status = git(["status", "--porcelain"]) || "";
  const log = (git(["log", "--max-count=12", "--format=%h%x1f%s%x1f%ci%x1f%D"]) || "")
    .split("\n").filter(Boolean).map((l) => { const [hash, subject, date, refs] = l.split("\x1f"); return { hash, subject, date, refs }; });
  const worktrees = [];
  const wt = git(["worktree", "list", "--porcelain"]) || "";
  let cur = null;
  for (const line of wt.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9), branch: null }; worktrees.push(cur); }
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "");
  }
  const branches = (git(["branch", "--format=%(refname:short)|%(committerdate:iso-strict)"]) || "")
    .split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf("|"); return { name: l.slice(0, i), date: l.slice(i + 1) }; });
  const tags = (git(["tag", "--sort=-creatordate"]) || "").split("\n").filter(Boolean).slice(0, 10);
  return { dirtyFiles: status ? status.split("\n").length : 0, commits: log, worktrees, branches, tags };
}

const CLIS = [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity"], ["ollama", "Ollama"]];
function clis() { return CLIS.map(([cmd, label]) => ({ cmd, label, found: which(cmd) })); }

// Child agents = processes whose command line is one of the CLIs running headless.
function agents() {
  let out; try { out = execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,args="], { encoding: "utf8" }); } catch { return []; }
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, lstart, args] = m;
    const bin = (args.split(/\s+/)[0] || "").split("/").pop();
    if (!["claude", "codex", "agy", "ollama"].includes(bin)) continue;
    const headless = /(^|\s)(-p|--print|exec)(\s|$)/.test(args);
    const model = (args.match(/--model[= ]([^\s]+)/) || [])[1] || null;
    // Keep the tail of the command line: the flags are what matter, not the install path.
    const shortArgs = args.length > 110 ? "…" + args.slice(-110) : args;
    rows.push({ pid: Number(pid), ppid: Number(ppid), cli: bin, headless, model, startedAt: lstart.trim(), args: shortArgs });
  }
  return rows;
}

function usage() {
  const j = readJson(join(STATE_DIR, "usage.json"));
  if (!j) return null;
  const polled = Date.parse(j.polledAt || "");
  return { ...j, ageSeconds: Number.isFinite(polled) ? Math.round((Date.now() - polled) / 1000) : null };
}

let sqlite = null, sqliteError = null;
try { sqlite = await import("node:sqlite"); } catch (e) { sqliteError = e.message; }

function trace() {
  const dbPath = join(STATE_DIR, "trace.db");
  if (!sqlite) return { available: false, reason: `node:sqlite unavailable (${sqliteError}); Node >= 22.13 needed` };
  if (!existsSync(dbPath)) return { available: false, reason: "no trace.db yet — written once hooks or the sf run wrapper exist" };
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const all = (sql, ...p) => db.prepare(sql).all(...p);
    const openSessions = all("SELECT session_id, parent_session_id, command, cli, model, pid, sandbox, permission_mode, allowed_tools, disallowed_tools, allowed_paths, started_at FROM sessions WHERE ended_at IS NULL ORDER BY started_at");
    const recentSessions = all("SELECT session_id, parent_session_id, command, cli, model, started_at, ended_at, exit_code FROM sessions ORDER BY started_at DESC LIMIT 20");
    const tokens = all("SELECT s.command, s.cli, s.model, COALESCE(SUM(e.tokens_in),0) AS tokens_in, COALESCE(SUM(e.tokens_out),0) AS tokens_out FROM sessions s LEFT JOIN events e ON e.session_id = s.session_id GROUP BY s.command, s.cli, s.model ORDER BY tokens_in + tokens_out DESC");
    const events = all("SELECT id, ts, session_id, kind, name, tokens_in, tokens_out FROM events ORDER BY id DESC LIMIT 40");
    const gates = all("SELECT ts, session_id, command, gate, passed, substr(evidence,1,300) AS evidence FROM gates ORDER BY id DESC LIMIT 20");
    const files = all("SELECT ts, session_id, path, claimed, actual, in_scope, reverted FROM files_touched ORDER BY id DESC LIMIT 40");
    return { available: true, openSessions, recentSessions, tokens, events, gates, files };
  } catch (e) {
    return { available: false, reason: `trace.db unreadable: ${e.message}` };
  } finally { try { db?.close(); } catch {} }
}

function hardware() {
  const [l1] = os.loadavg();
  return {
    cpus: os.cpus().length, load1: Number(l1.toFixed(2)),
    freeMemGb: Number((os.freemem() / 2 ** 30).toFixed(2)), totalMemGb: Number((os.totalmem() / 2 ** 30).toFixed(2)),
    hardwareJson: readJson(join(STATE_DIR, "hardware.json")),
  };
}

function config() { return readJson(join(REPO, "blueprint", "config.json")); }
function routing() { return readJson(join(REPO, "blueprint", "harness.json")); }

function state() {
  return {
    server: { startedAt: STARTED_AT, now: new Date().toISOString(), pid: process.pid, node: process.version },
    repo: repoInfo(), run: runState(), pipeline: pipeline(), git: gitInfo(),
    clis: clis(), agents: agents(), usage: usage(), trace: trace(), hardware: hardware(), config: config(), routing: routing(),
  };
}

// ── http ─────────────────────────────────────────────────────────────────────

let INDEX;
try {
  INDEX = readFileSync(join(here, "index.html"));
} catch (e) {
  console.error(`[a1-harness] cannot read ${join(here, "index.html")}: ${e.message}`);
  process.exit(1);
}
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/state") {
    let body;
    try { body = JSON.stringify(state()); }
    catch (e) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(INDEX);
    return;
  }
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end("not found");
});

server.listen(opts.port, "127.0.0.1", () => {
  const url = `http://localhost:${opts.port}`;
  console.log(`[a1-harness] dashboard  ${url}\n[a1-harness] reading     ${REPO}`);
  if (opts.open) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); } catch {}
  }
});
