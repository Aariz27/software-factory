#!/usr/bin/env node
// A1 Harness trace writer — the only code that writes blueprint/.state/trace.db.
// Used as a library by sf.mjs and as a CLI by the hooks in .harness/hooks/.
// Schema: .harness/schema.sql. WAL mode so the dashboard can read while we write.
//
//   node .harness/trace.mjs session-start --id S [--parent P] --command c --cli claude --model m --pid N
//                                          [--sandbox 1] [--permission-mode m] [--allowed-tools JSON]
//                                          [--disallowed-tools JSON] [--allowed-paths JSON]
//   node .harness/trace.mjs session-end   --id S --exit N
//   node .harness/trace.mjs event         --session S --kind tool_call --name Bash [--payload JSON] [--in N] [--out N]
//   node .harness/trace.mjs gate          --session S --command c --gate scope --passed 1 [--evidence text]
//   node .harness/trace.mjs file          --session S --path p [--claimed 1] [--actual 1] [--in-scope 1] [--reverted 1]
//
// Every command is silent on success and exits 0; a failure prints one line to
// stderr and exits 1. Hooks must never fail the host over a trace write, so they
// call this with `|| true`.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// node:sqlite is marked experimental on Node 22/23; the warning is noise here.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type !== "ExperimentalWarning") emitWarning.call(process, warning, ...rest);
};

// Walk up from `start` to the directory that holds blueprint/ (same rule as run-state.mjs).
export function findRepo(start = process.cwd()) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "blueprint"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no blueprint/ directory above " + start);
    dir = parent;
  }
}

export async function openTrace(repo = findRepo()) {
  const { DatabaseSync } = await import("node:sqlite");
  const stateDir = join(repo, "blueprint", ".state");
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, "trace.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  const now = () => new Date().toISOString();
  const j = (v) => (v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v));

  const api = {
    db,
    sessionStart(s) {
      db.prepare(`INSERT OR REPLACE INTO sessions (session_id, parent_session_id, command, cli, model, pid, sandbox,
        permission_mode, allowed_tools, disallowed_tools, allowed_paths, started_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        s.id, s.parent ?? null, s.command ?? null, s.cli ?? null, s.model ?? null, s.pid ?? null,
        s.sandbox ? 1 : 0, s.permissionMode ?? null, j(s.allowedTools), j(s.disallowedTools), j(s.allowedPaths), now());
    },
    sessionEnd(id, exitCode) {
      db.prepare("UPDATE sessions SET ended_at = ?, exit_code = ? WHERE session_id = ?").run(now(), exitCode ?? null, id);
    },
    event(e) {
      db.prepare("INSERT INTO events (ts, session_id, kind, name, payload, tokens_in, tokens_out) VALUES (?,?,?,?,?,?,?)")
        .run(now(), e.session, e.kind, e.name ?? null, j(e.payload), e.tokensIn ?? null, e.tokensOut ?? null);
    },
    gate(g) {
      db.prepare("INSERT INTO gates (ts, session_id, command, gate, passed, evidence) VALUES (?,?,?,?,?,?)")
        .run(now(), g.session ?? null, g.command ?? null, g.gate, g.passed ? 1 : 0, g.evidence ?? null);
    },
    file(f) {
      db.prepare("INSERT INTO files_touched (ts, session_id, path, claimed, actual, in_scope, reverted) VALUES (?,?,?,?,?,?,?)")
        .run(now(), f.session ?? null, f.path, f.claimed ? 1 : 0, f.actual ? 1 : 0, f.inScope ?? null, f.reverted ? 1 : 0);
    },
    close() { try { db.close(); } catch {} },
  };
  return api;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) out[k] = true; else { out[k] = v; i++; }
  }
  return out;
}
const num = (v) => (v === undefined ? undefined : Number(v));
const bool = (v) => v === "1" || v === "true" || v === true;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  try {
    const t = await openTrace(f.repo ? f.repo : findRepo(f.cwd || process.cwd()));
    try {
      switch (cmd) {
        case "session-start":
          t.sessionStart({ id: f.id, parent: f.parent, command: f.command, cli: f.cli, model: f.model, pid: num(f.pid),
            sandbox: bool(f.sandbox), permissionMode: f.permissionMode, allowedTools: f.allowedTools,
            disallowedTools: f.disallowedTools, allowedPaths: f.allowedPaths });
          break;
        case "session-end": t.sessionEnd(f.id, num(f.exit)); break;
        case "event": t.event({ session: f.session, kind: f.kind, name: f.name, payload: f.payload, tokensIn: num(f.in), tokensOut: num(f.out) }); break;
        case "gate": t.gate({ session: f.session, command: f.command, gate: f.gate, passed: bool(f.passed), evidence: f.evidence }); break;
        case "file": t.file({ session: f.session, path: f.path, claimed: bool(f.claimed), actual: bool(f.actual), inScope: f.inScope === undefined ? null : bool(f.inScope) ? 1 : 0, reverted: bool(f.reverted) }); break;
        default: throw new Error(`unknown command "${cmd ?? ""}" (session-start, session-end, event, gate, file)`);
      }
    } finally { t.close(); }
  } catch (e) {
    console.error(`trace: ${e.message}`);
    process.exit(1);
  }
}
