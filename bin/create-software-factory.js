#!/usr/bin/env node
// create-software-factory — installs the Software Factory workflow files
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
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const TEMPLATE_DIR = join(here, "..", "template");
const BLUEPRINT_VERSION = "1.9.0";

const Y = "\x1b[33m", R = "\x1b[31m", G = "\x1b[32m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

const BANNER = `
${Y}  ███████╗ ██████╗ ███████╗████████╗██╗    ██╗ █████╗ ██████╗ ███████╗
  ██╔════╝██╔═══██╗██╔════╝╚══██╔══╝██║    ██║██╔══██╗██╔══██╗██╔════╝
  ███████╗██║   ██║█████╗     ██║   ██║ █╗ ██║███████║██████╔╝█████╗
  ╚════██║██║   ██║██╔══╝     ██║   ██║███╗██║██╔══██║██╔══██╗██╔══╝
  ███████║╚██████╔╝██║        ██║   ╚██╔╝╚██╔╝██║  ██║██║  ██║███████╗
  ╚══════╝ ╚═════╝ ╚═╝        ╚═╝    ╚═╝  ╚═╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝
  ███████╗ █████╗  ██████╗████████╗ ██████╗ ██████╗ ██╗   ██╗
  ██╔════╝██╔══██╗██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗╚██╗ ██╔╝
  █████╗  ███████║██║        ██║   ██║   ██║██████╔╝ ╚████╔╝
  ██╔══╝  ██╔══██║██║        ██║   ██║   ██║██╔══██╗  ╚██╔╝
  ██║     ██║  ██║╚██████╗   ██║   ╚██████╔╝██║  ██║   ██║
  ╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝   ╚═╝${X}
  ${D}create-software-factory v${pkg.version} · built on AI Blueprint ${BLUEPRINT_VERSION}${X}
`;

function parseArgs(argv) {
  const opts = { target: process.cwd(), force: false, dryRun: false, help: false };
  for (const a of argv) {
    if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else opts.target = resolve(a);
  }
  return opts;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
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
  try {
    execFileSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
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
  console.log(BANNER);
  if (opts.help) {
    console.log(`  Usage: npx create-software-factory [target-dir] [--force] [--dry-run]\n`);
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
    const dst = join(target, rel);
    const buf = readFileSync(src);
    manifest[rel] = sha256(buf);
    if (existsSync(dst) && !opts.force) {
      skipped.push(rel);
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, buf);
    }
    written.push(rel);
  }

  const manifestPath = join(target, "blueprint", ".state", "manifest.json");
  const manifestBody = JSON.stringify(
    {
      schemaVersion: 1,
      source: pkg.name,
      version: pkg.version,
      blueprintVersion: BLUEPRINT_VERSION,
      adapters: ["claude", "codex"],
      installedAt: new Date().toISOString(),
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
    2. Fill in blueprint/project-plan.md and blueprint/build-plan.md (or run /discovery).
    3. Run /onboard, then /overview, then /feature to start the loop.
    4. Diagrams: /control-flow, /data-flow, /error-flow, /io <file | function | feature>.
`);
}

try {
  main();
} catch (err) {
  console.error(`\n  ${R}error${X} ${err.message}\n`);
  process.exit(1);
}
