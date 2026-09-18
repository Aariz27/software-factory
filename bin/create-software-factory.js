#!/usr/bin/env node
// create-software-factory — installs the A1 Harness workflow files
// (AI Blueprint 1.9.0 + our additions) into an existing project directory.
//
// Usage:  npx create-software-factory [target-dir] [--force] [--dry-run]
//
// Copies every file under template/ into the target. Existing files are left
// alone unless --force is given. Writes blueprint/.state/manifest.json with a
// sha256 per managed file so later updates can tell what the user has edited.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const TEMPLATE_DIR = join(here, "..", "template");
const BLUEPRINT_VERSION = "1.9.0";

const Y = "\x1b[33m", R = "\x1b[31m", G = "\x1b[32m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

const BANNER = `
${Y}   █████╗  ██╗
  ██╔══██╗███║
  ███████║╚██║
  ██╔══██║ ██║
  ██║  ██║ ██║
  ╚═╝  ╚═╝ ╚═╝
  ██╗  ██╗ █████╗ ██████╗ ███╗   ██╗███████╗███████╗███████╗
  ██║  ██║██╔══██╗██╔══██╗████╗  ██║██╔════╝██╔════╝██╔════╝
  ███████║███████║██████╔╝██╔██╗ ██║█████╗  ███████╗███████╗
  ██╔══██║██╔══██║██╔══██╗██║╚██╗██║██╔══╝  ╚════██║╚════██║
  ██║  ██║██║  ██║██║  ██║██║ ╚████║███████╗███████║███████║
  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚══════╝${X}
  ${D}A1 Harness v${pkg.version} · built on AI Blueprint ${BLUEPRINT_VERSION}${X}
`;

// Thrown for bad CLI usage so the top-level handler can exit 2 instead of the
// generic 1 used for real failures (target missing, dashboard not installed).
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

// Flag names a user might type without their leading dashes by mistake. A bare
// positional matching one of these is almost certainly a typo'd flag, not a
// target directory, so it is rejected instead of silently becoming the target.
const KNOWN_FLAG_NAMES = new Set(["force", "dry-run", "no-dashboard", "port", "help", "h"]);

function parseArgs(argv) {
  const opts = { target: process.cwd(), force: false, dryRun: false, help: false, dashboard: true, port: 4747, command: "install" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-dashboard") opts.dashboard = false;
    else if (a === "--port") {
      const value = argv[++i];
      const port = Number(value);
      if (value === undefined || !Number.isInteger(port)) throw new UsageError(`--port needs a number, got ${value ?? "nothing"}`);
      opts.port = port;
    }
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "dashboard" && i === 0) opts.command = "dashboard";
    else if (a === "onboard" && i === 0) opts.command = "onboard";
    else if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    else if (KNOWN_FLAG_NAMES.has(a)) throw new UsageError(`"${a}" looks like a flag missing its dashes — did you mean --${a}?`);
    else opts.target = resolve(a);
  }
  return opts;
}

// Stray local session files that must never be copied into a target project,
// even if one exists in this checkout of template/ (see template/.npmignore
// for the matching npm-publish exclusion).
const SKIP_NAMES = new Set([".sessions-state.json", "sessions.json"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_NAMES.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function which(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(finder, [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(dir) {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`  Usage: npx create-software-factory [target-dir] [--force] [--dry-run] [--no-dashboard] [--port N]
         npx create-software-factory dashboard [target-dir] [--port N]   start the read-only dashboard for an installed project
         npx create-software-factory onboard   [target-dir]              choose which model runs each /command, then open the dashboard\n`);
    return;
  }
  console.log(BANNER);
  if (opts.command === "dashboard") {
    if (opts.dryRun) {
      console.log(`  ${D}dashboard not started in dry run${X}\n`);
      return;
    }
    startDashboard(opts.target, opts.port, { detached: false, open: true });
    return;
  }
  if (opts.command === "onboard") {
    // Interactive model routing, then re-open the dashboard so the choices are visible.
    const script = join(opts.target, ".harness", "onboard.mjs");
    if (!existsSync(script)) throw new Error(`harness not installed at ${opts.target}`);
    const r = spawnSync(process.execPath, [script], { cwd: opts.target, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
    startDashboard(opts.target, opts.port, { detached: true, open: true });
    return;
  }

  const target = opts.target;
  if (!existsSync(target)) throw new Error(`target directory does not exist: ${target}`);
  console.log(`  ${B}Target${X}  ${target}`);
  console.log(`  ${B}Git${X}     ${isGitRepo(target) ? `${G}repository found${X}` : `${R}not a git repository${X} — run \`git init\` before using /complete`}`);

  const files = walk(TEMPLATE_DIR);
  const written = [], skipped = [], manifest = {};
  for (const src of files) {
    const rel = relative(TEMPLATE_DIR, src);
    // npm never publishes a nested .gitignore (or .npmignore), so the source
    // file is named "gitignore" and renamed on the way out.
    const destRel = rel === "gitignore" ? ".gitignore" : rel;
    const dst = join(target, destRel);
    const buf = readFileSync(src);
    manifest[destRel] = sha256(buf);
    if (existsSync(dst) && !opts.force) {
      skipped.push(destRel);
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, buf);
    }
    written.push(destRel);
  }

  const manifestPath = join(target, "blueprint", ".state", "manifest.json");
  // installedAt is set once, on the first install, and preserved across
  // re-runs; updatedAt tracks the most recent one.
  let installedAt = new Date().toISOString();
  try {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (previous?.installedAt) installedAt = previous.installedAt;
  } catch {}
  const manifestBody = JSON.stringify(
    {
      schemaVersion: 1,
      source: pkg.name,
      version: pkg.version,
      blueprintVersion: BLUEPRINT_VERSION,
      adapters: ["claude", "codex"],
      installedAt,
      updatedAt: new Date().toISOString(),
      managedFiles: Object.fromEntries(Object.entries(manifest).sort()),
    },
    null,
    2,
  );
  if (!opts.dryRun) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, manifestBody + "\n");
  }

  console.log(`\n  ${B}Files${X}   ${G}${written.length} written${X}, ${D}${skipped.length} skipped (already exist)${X}${opts.dryRun ? `  ${Y}[dry run — nothing touched]${X}` : ""}`);
  if (skipped.length) console.log(skipped.map((f) => `    ${D}skip${X} ${f}`).join("\n"));
  console.log(`    ${D}manifest${X} blueprint/.state/manifest.json`);

  console.log(`\n  ${B}CLIs on this machine${X}`);
  for (const [cmd, label] of [["claude", "Claude Code"], ["codex", "Codex"], ["agy", "Antigravity"], ["ollama", "Ollama"]]) {
    console.log(`    ${which(cmd) ? `${G}✓${X}` : `${D}·${X}`} ${label.padEnd(12)} ${D}${cmd}${X}`);
  }

  console.log(`
  ${B}Next${X}
    1. Open this project in Claude Code or Codex.
    2. Write the five docs by hand in blueprint/: spec.md, data_contract.md, features.md, ux.md, ui.md.
    3. Run /plan  → build-plan.md + project-plan.md from those docs.
    4. Run \`npx create-software-factory onboard\` (or /models) to pick which model runs each /command.
    5. Run /onboard, then /overview, then /feature → /implement → /check → /audit → /complete.
    6. Diagrams: /control-flow, /data-flow, /error-flow, /io <file | function | feature>.
`);

  if (opts.dashboard && !opts.dryRun) {
    startDashboard(target, opts.port, { detached: true, open: true });
  } else if (opts.dashboard) {
    console.log(`  ${D}dashboard not started in dry run${X}\n`);
  }
}

// Starts .harness/dashboard/server.mjs from the installed copy in the target.
// detached=true: keeps running after this installer exits, so the page the
// browser just opened stays live. `npx create-software-factory dashboard`
// runs it in the foreground instead.
function startDashboard(target, port, { detached, open }) {
  const script = join(target, ".harness", "dashboard", "server.mjs");
  if (!existsSync(script)) throw new Error(`dashboard not installed at ${script}`);
  const args = [script, target, "--port", String(port), ...(open ? ["--open"] : [])];
  const child = spawn(process.execPath, args, detached ? { detached: true, stdio: "ignore" } : { stdio: "inherit" });
  if (detached) {
    child.unref();
    console.log(`  ${B}Dashboard${X}  ${G}http://localhost:${port}${X}  ${D}(pid ${child.pid}; restart later with: npx create-software-factory dashboard)${X}\n`);
  }
}

try {
  main();
} catch (err) {
  console.error(`\n  ${R}error${X} ${err.message}\n`);
  process.exit(err.exitCode ?? 1);
}
