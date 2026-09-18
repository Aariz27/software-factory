#!/usr/bin/env node
// A1 Harness onboarding — which model runs which /command.
//
//   node .harness/onboard.mjs                 interactive (terminal, or answers piped on stdin)
//   node .harness/onboard.mjs --list          JSON: CLIs found, login state, models each exposes
//   node .harness/onboard.mjs --show          print blueprint/harness.json
//   node .harness/onboard.mjs --default agy:gemini-3.8-flash-high --backup claude:claude-sonnet-5 \
//        --set plan=claude:claude-opus-5 --set implement=agy:gemini-3.8-flash-high [--threshold 95] [--force]
//
// Writes blueprint/harness.json (user-owned, committed). It never touches
// blueprint/config.json: Blueprint's /doctor rejects unknown keys there.
// Nothing here calls a model; detection is CLI status commands and cache files.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

const REPO = process.cwd();
const OUT = join(REPO, "blueprint", "harness.json");
const Y = "\x1b[33m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

function run(cmd, args, timeout = 20000) {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}

function which(cmd) { return run("which", [cmd]) !== null; }

// ── detection ────────────────────────────────────────────────────────────────
// Each entry: how we know it is logged in, and where its model list comes from.
const CLIS = {
  claude: {
    label: "Claude Code",
    loggedIn() { const out = run("claude", ["auth", "status"]); try { return !!JSON.parse(out).loggedIn; } catch { return false; } },
    // Claude Code has no "list models" command; these are the ids it accepts today.
    models() { return { source: "builtin", ids: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"] }; },
  },
  codex: {
    label: "Codex",
    // `codex login status` prints "Logged in using ChatGPT" to stderr, exit 0.
    loggedIn() { const r = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 20000 }); return r.status === 0 && /logged in/i.test((r.stdout || "") + (r.stderr || "")); },
    models() {
      try {
        const cache = JSON.parse(readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8"));
        const ids = (cache.models || []).map((m) => m.slug || m.id).filter(Boolean);
        return { source: "~/.codex/models_cache.json", ids };
      } catch { return { source: "none", ids: [] }; }
    },
  },
  agy: {
    label: "Antigravity",
    loggedIn() { return this.models().ids.length > 0; },
    models() {
      if (this._cache) return this._cache;
      const out = run("agy", ["models"], 30000) || "";
      const ids = out.split("\n").filter((l) => l.includes("\t")).map((l) => l.split("\t")[0].trim());
      return (this._cache = { source: "agy models", ids });
    },
  },
  ollama: {
    label: "Ollama",
    loggedIn() { return run("ollama", ["list"]) !== null; },
    models() {
      const out = run("ollama", ["list"]) || "";
      const ids = out.split("\n").slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean);
      return { source: "ollama list", ids };
    },
  },
};

function detect() {
  return Object.entries(CLIS).map(([cmd, c]) => {
    const found = which(cmd);
    const loggedIn = found ? c.loggedIn() : false;
    const models = found ? c.models() : { source: "none", ids: [] };
    return { cmd, label: c.label, found, loggedIn, models: models.ids, modelsSource: models.source };
  });
}

// Commands = every skill installed in this project (Blueprint's + ours).
function commands() {
  const dir = join(REPO, ".claude", "skills");
  try { return readdirSync(dir).filter((n) => existsSync(join(dir, n, "SKILL.md"))).sort(); } catch { return []; }
}

// ── config ───────────────────────────────────────────────────────────────────
function parseChoice(s, label) {
  const m = String(s || "").match(/^([a-z]+):(.+)$/);
  if (!m) throw new Error(`${label}: expected <cli>:<model>, got "${s}"`);
  return { cli: m[1], model: m[2] };
}
function validate(choice, clis, force) {
  const c = clis.find((x) => x.cmd === choice.cli);
  if (!c) throw new Error(`unknown cli "${choice.cli}" (known: ${clis.map((x) => x.cmd).join(", ")})`);
  if (!c.found && !force) throw new Error(`${choice.cli} is not installed on this machine (use --force to record it anyway)`);
  if (!c.loggedIn && !force) throw new Error(`${choice.cli} is not logged in (use --force to record it anyway)`);
  if (c.models.length && !c.models.includes(choice.model) && !force)
    throw new Error(`${choice.cli} does not list model "${choice.model}" (it lists: ${c.models.join(", ")}). Use --force to record it anyway.`);
}
function load() { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return null; } }
function save(cfg) {
  const tmp = OUT + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, OUT);
}
function fresh() { return { schemaVersion: 1, usageBlockPercent: 95, default: null, backup: null, commands: {} }; }

function printTable(clis) {
  for (const c of clis) {
    const state = !c.found ? `${D}not installed${X}` : c.loggedIn ? `${G}logged in${X}` : `${R}not logged in${X}`;
    console.log(`  ${B}${c.cmd.padEnd(7)}${X} ${c.label.padEnd(12)} ${state}`);
    if (c.found) console.log(`          ${D}models (${c.modelsSource}):${X} ${c.models.join(", ") || "—"}`);
  }
}

// ── modes ────────────────────────────────────────────────────────────────────
async function interactive(clis, cmds) {
  // Lines are queued as they arrive so pasted or piped answers are never lost
  // while detection is still running; EOF answers every remaining question with "".
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const queue = [], waiters = [];
  let closed = false;
  rl.on("line", (l) => { if (waiters.length) waiters.shift()(l); else queue.push(l); });
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()(""); });
  const nextLine = () => queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve("") : new Promise((res) => waiters.push(res));
  const ask = async (q, def) => { process.stdout.write(`  ${q}${def ? ` ${D}[${def}]${X}` : ""}: `); const a = (await nextLine()).trim(); if (!process.stdin.isTTY) process.stdout.write(a + "\n"); return a || def || ""; };
  console.log(`\n${B}A1 Harness — model routing${X}\n`);
  printTable(clis);
  const usable = clis.filter((c) => c.found && c.loggedIn);
  if (!usable.length) { console.log(`\n  ${R}no CLI is installed and logged in — nothing to route to${X}\n`); rl.close(); return; }
  const cfg = load() || fresh();
  console.log(`\n  Answer as ${B}cli:model${X}, e.g. ${Y}agy:gemini-3.8-flash-high${X}. Leave empty to keep the current value.\n`);
  const d = await ask("Default model for every command", cfg.default ? `${cfg.default.cli}:${cfg.default.model}` : "");
  if (d) { cfg.default = parseChoice(d, "default"); validate(cfg.default, clis, false); }
  const b = await ask("Backup model when the default is blocked", cfg.backup ? `${cfg.backup.cli}:${cfg.backup.model}` : "");
  if (b) { cfg.backup = parseChoice(b, "backup"); validate(cfg.backup, clis, false); }
  const t = await ask("Block a model when its 5-hour or weekly window reaches (%)", String(cfg.usageBlockPercent));
  cfg.usageBlockPercent = Number(t) || 95;
  console.log(`\n  Commands: ${cmds.join(" ")}\n  Override any command? Type ${B}command=cli:model${X} (empty line to finish).`);
  for (;;) {
    const line = await ask("override", "");
    if (!line) break;
    const m = line.match(/^([a-z-]+)=(.+)$/);
    if (!m || !cmds.includes(m[1])) { console.log(`  ${R}unknown command${X} — one of: ${cmds.join(", ")}`); continue; }
    try { const ch = parseChoice(m[2], m[1]); validate(ch, clis, false); cfg.commands[m[1]] = { ...(cfg.commands[m[1]] || {}), ...ch }; console.log(`  ${G}✓${X} /${m[1]} → ${ch.cli}:${ch.model}`); }
    catch (e) { console.log(`  ${R}${e.message}${X}`); }
  }
  rl.close();
  if (!cfg.default) throw new Error("no default model chosen — nothing written");
  save(cfg);
  console.log(`\n  ${G}written${X} blueprint/harness.json\n`);
  show(cfg, cmds);
}

function show(cfg, cmds) {
  if (!cfg) { console.log(`  ${D}no blueprint/harness.json yet — run onboarding${X}`); return; }
  const fmt = (c) => (c ? `${c.cli}:${c.model}` : "—");
  console.log(`  ${B}default${X} ${fmt(cfg.default)}   ${B}backup${X} ${fmt(cfg.backup)}   ${B}block at${X} ${cfg.usageBlockPercent}%`);
  for (const cmd of cmds) {
    const o = cfg.commands[cmd];
    console.log(`  /${cmd.padEnd(14)} ${o ? `${Y}${fmt(o)}${X}${o.backup ? `  backup ${fmt(o.backup)}` : ""}` : `${D}${fmt(cfg.default)} (default)${X}`}`);
  }
}

function fromFlags(argv, clis, cmds) {
  const cfg = load() || fresh();
  const force = argv.includes("--force");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--default") { cfg.default = parseChoice(v, "--default"); validate(cfg.default, clis, force); i++; }
    else if (a === "--backup") { cfg.backup = parseChoice(v, "--backup"); validate(cfg.backup, clis, force); i++; }
    else if (a === "--threshold") { cfg.usageBlockPercent = Number(v); i++; }
    else if (a === "--set" || a === "--backup-for") {
      const m = String(v || "").match(/^([a-z-]+)=(.+)$/);
      if (!m) throw new Error(`${a}: expected <command>=<cli>:<model>`);
      if (!cmds.includes(m[1])) throw new Error(`unknown command "${m[1]}" — one of: ${cmds.join(", ")}`);
      const ch = parseChoice(m[2], m[1]); validate(ch, clis, force);
      cfg.commands[m[1]] = cfg.commands[m[1]] || {};
      if (a === "--set") Object.assign(cfg.commands[m[1]], ch); else cfg.commands[m[1]].backup = ch;
      i++;
    }
    else if (a === "--unset") { delete cfg.commands[v]; i++; }
    else if (a !== "--force") throw new Error(`unknown flag ${a}`);
  }
  if (!cfg.default) throw new Error("no default model set (use --default <cli>:<model>)");
  save(cfg);
  console.log(`${G}written${X} blueprint/harness.json`);
  show(cfg, cmds);
}

try {
  const argv = process.argv.slice(2);
  const cmds = commands();
  if (argv.includes("--show")) { show(load(), cmds); }
  else if (argv.includes("--list")) { console.log(JSON.stringify({ commands: cmds, clis: detect() }, null, 2)); }
  else if (argv.length === 0) {
    await interactive(detect(), cmds);   // works on a terminal or with answers piped on stdin
  }
  else fromFlags(argv, detect(), cmds);
} catch (e) {
  console.error(`${R}error${X} ${e.message}`);
  process.exit(1);
}
