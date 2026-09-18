// Tests for template/.harness/usage-poller.mjs — pure parsing/build functions only.
// No real AI CLI is invoked and no network call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MODULE = join(here, "..", "template", ".harness", "usage-poller.mjs");

const {
  parseClaudeUsage,
  claudeResetToIso,
  parseAgyUsage,
  parseCodexRateLimits,
  buildUsageDoc,
} = await import(MODULE);

test("parseClaudeUsage: real text shape yields fiveHour + weekly windows", () => {
  const text = "Current session: 50% used · resets Sep 19 at 2:20am (Asia/Kuala_Lumpur)\nCurrent week (all models): 36% used · resets Sep 22 at 2pm (Asia/Kuala_Lumpur)";
  const r = parseClaudeUsage(text);
  assert.equal(r.claude.label, "Claude Code");
  assert.equal(r.claude.fiveHour.usedPercent, 50);
  assert.equal(r.claude.fiveHour.resetsText, "Sep 19 at 2:20am (Asia/Kuala_Lumpur)");
  assert.ok(r.claude.fiveHour.resetsAt); // ISO string, exact value covered by claudeResetToIso tests
  assert.equal(r.claude.weekly.usedPercent, 36);
  assert.equal(r.claude.weekly.resetsText, "Sep 22 at 2pm (Asia/Kuala_Lumpur)");
});

test("parseClaudeUsage: no \"% used\" in text returns {error}", () => {
  const r = parseClaudeUsage("Claude Code has no usage information right now.");
  assert.ok(r.error);
  assert.match(r.error, /could not find/);
});

test("claudeResetToIso: a date earlier this year rolls to next year", () => {
  const now = new Date(2026, 8, 19); // Sep 19 2026 (month is 0-indexed)
  const iso = claudeResetToIso("Jan 5 at 3pm (Asia/Kuala_Lumpur)", now);
  const d = new Date(iso);
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 15);
});

test("claudeResetToIso: \"2pm\" resolves to 14:00", () => {
  const now = new Date(2026, 8, 19);
  const iso = claudeResetToIso("Sep 22 at 2pm (Asia/Kuala_Lumpur)", now);
  const d = new Date(iso);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 0);
});

test("claudeResetToIso: no time in text defaults to 00:00", () => {
  const now = new Date(2026, 8, 19);
  const iso = claudeResetToIso("Sep 25", now);
  const d = new Date(iso);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test("parseAgyUsage: real shape splits gemini vs 3p groups with correct usedPercent", () => {
  const json = {
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { window: "5h", remaining_fraction: 0.25, reset_time: "2026-09-19T10:00:00Z" },
              { window: "weekly", remaining_fraction: 1, reset_time: "2026-09-25T00:00:00Z" },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              { window: "5h", remaining_fraction: 0.9, reset_time: "2026-09-19T10:00:00Z" },
              { window: "weekly", remaining_fraction: 0.5, reset_time: "2026-09-25T00:00:00Z" },
            ],
          },
        ],
      },
    },
  };
  const r = parseAgyUsage(json);
  assert.equal(r["agy-gemini"].label, "Antigravity — Gemini Models");
  assert.equal(r["agy-gemini"].fiveHour.usedPercent, 75);
  assert.equal(r["agy-gemini"].weekly.usedPercent, 0);
  assert.equal(r["agy-3p"].label, "Antigravity — Claude and GPT models");
  assert.equal(r["agy-3p"].fiveHour.usedPercent, 10);
  assert.equal(r["agy-3p"].weekly.usedPercent, 50);
});

test("parseAgyUsage: missing groups returns {error}", () => {
  assert.ok(parseAgyUsage({}).error);
  assert.ok(parseAgyUsage({ command: {} }).error);
  assert.ok(parseAgyUsage(null).error);
});

test("parseCodexRateLimits: windowDurationMins 300 -> fiveHour, 43200 -> weekly", () => {
  const resetSeconds = Math.floor(Date.UTC(2026, 8, 19, 10, 0, 0) / 1000);
  const rl = {
    planType: "Plus",
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: resetSeconds },
    secondary: { usedPercent: 12, windowDurationMins: 43200, resetsAt: resetSeconds },
  };
  const r = parseCodexRateLimits(rl);
  assert.equal(r.codex.label, "Codex (Plus)");
  assert.equal(r.codex.fiveHour.usedPercent, 40);
  assert.equal(r.codex.fiveHour.windowMinutes, 300);
  assert.equal(r.codex.fiveHour.resetsAt, new Date(resetSeconds * 1000).toISOString());
  assert.equal(r.codex.weekly.usedPercent, 12);
  assert.equal(r.codex.weekly.windowMinutes, 43200);
});

test("parseCodexRateLimits: null rl returns {error}", () => {
  const r = parseCodexRateLimits(null);
  assert.ok(r.error);
  assert.match(r.error, /rateLimits missing/);
});

test("buildUsageDoc: marks a group blocked with a reason when either window >= threshold", () => {
  const results = [
    { claude: { label: "Claude Code", fiveHour: { usedPercent: 96, resetsAt: null }, weekly: { usedPercent: 10, resetsAt: null } } },
    { codex: { label: "Codex", fiveHour: { usedPercent: 5, resetsAt: null }, weekly: { usedPercent: 99, resetsAt: null } } },
    { error: "ollama: not running" },
  ];
  const models = { claude: ["claude-sonnet-5"], codex: ["gpt-5.5"] };
  const doc = buildUsageDoc(results, models, 95, "2026-09-19T00:00:00.000Z");
  assert.equal(doc.polledAt, "2026-09-19T00:00:00.000Z");
  assert.equal(doc.thresholdPercent, 95);
  assert.equal(doc.groups.claude.blocked, true);
  assert.match(doc.groups.claude.reason, /fiveHour 96% >= 95%/);
  assert.deepEqual(doc.groups.claude.models, ["claude-sonnet-5"]);
  assert.equal(doc.groups.codex.blocked, true);
  assert.match(doc.groups.codex.reason, /weekly 99% >= 95%/);
  assert.deepEqual(doc.errors, ["ollama: not running"]);
});

test("buildUsageDoc: a group under threshold is not blocked and has a null reason", () => {
  const results = [{ claude: { label: "Claude Code", fiveHour: { usedPercent: 10, resetsAt: null }, weekly: { usedPercent: 20, resetsAt: null } } }];
  const doc = buildUsageDoc(results, { claude: ["m"] }, 95);
  assert.equal(doc.groups.claude.blocked, false);
  assert.equal(doc.groups.claude.reason, null);
  assert.deepEqual(doc.errors, []);
});
