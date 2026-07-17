import test from "node:test";
import assert from "node:assert/strict";

import { INIT_PROMPT, buildPrompt, isBudgetExhausted, isRetryable, nextReset, parseArgs, secondsUntil, selectMission, selectModel, validateConfig, validateMemory } from "../src/night-agent.js";

const MISSIONS = [
  { name: "audit", builtin: "audit", cadenceDays: 3 },
  { name: "deps", brief: "deps", cadenceDays: 7 },
  { name: "nips", brief: "nips", cadenceDays: 7, harness: "opencode" },
];

test("parseArgs handles commands and run limits", () => {
  const options = parseArgs(["schedule", "--repo", "/tmp/example", "--at", "23:30", "--max-iterations=3", "--min-diem", "0"]);
  assert.equal(options.command, "schedule");
  assert.equal(options.repo, "/tmp/example");
  assert.equal(options.at, "23:30");
  assert.equal(options.maxIterations, 3);
  assert.equal(options.minDiem, 0);
});

test("parseArgs retains an explicit custom task", () => {
  const options = parseArgs(["run", "--task", "Add keyboard navigation to the command palette"]);
  assert.equal(options.task, "Add keyboard navigation to the command palette");
  assert.throws(() => parseArgs(["run", "--task", "  "]), /must not be empty/);
});

test("parseArgs recognizes the read-only doctor command", () => {
  assert.equal(parseArgs(["doctor", "--repo", "/tmp/example"]).command, "doctor");
});

test("parseArgs rejects invalid limits", () => {
  assert.throws(() => parseArgs(["--max-hours", "0"]), /greater than zero/);
  assert.throws(() => parseArgs(["--min-diem", "-1"]), /zero or greater/);
});

test("detects Venice budget exhaustion", () => {
  assert.equal(isBudgetExhausted("HTTP 402 INSUFFICIENT_BALANCE"), true);
  assert.equal(isBudgetExhausted("API_KEY_DIEM_SPEND_LIMIT_EXCEEDED"), true);
  assert.equal(isBudgetExhausted("HTTP 429 model overloaded"), false);
});

test("detects retryable provider errors", () => {
  assert.equal(isRetryable("429 rate limit exceeded"), true);
  assert.equal(isRetryable("503 MODEL_AT_CAPACITY"), true);
  assert.equal(isRetryable("invalid model"), false);
});

test("prompt includes safety boundaries and completion marker", () => {
  const prompt = buildPrompt("Fix known bugs.", ".night-agent/reports/run.md", 2, "work");
  assert.match(prompt, /iteration 2/);
  assert.match(prompt, /Commit every independent product fix separately/);
  assert.match(prompt, /Never amend, push/);
  assert.match(prompt, /Security vulnerabilities/);
  assert.match(prompt, /UX and design problems/);
  assert.match(prompt, /dependency changes, inspect release notes/);
  assert.match(prompt, /NIGHT_AGENT_COMPLETE/);
});

test("default run ceiling allows continued work until budget exhaustion", () => {
  const options = parseArgs(["run", "--repo", "/tmp/example"]);
  assert.equal(options.maxIterations, 100);
  assert.equal(options.maxHours, 12);
});

test("leaves the model unspecified by default", () => {
  const previousModel = process.env.NIGHT_AGENT_MODEL;
  delete process.env.NIGHT_AGENT_MODEL;
  try {
    assert.equal(parseArgs(["run"]).model, null);
  } finally {
    if (previousModel === undefined) delete process.env.NIGHT_AGENT_MODEL;
    else process.env.NIGHT_AGENT_MODEL = previousModel;
  }
});

test("first pass audits all categories without product changes", () => {
  const prompt = buildPrompt("No findings yet.", ".night-agent/reports/run.md", 1, "audit");
  assert.match(prompt, /mandatory audit pass/);
  assert.match(prompt, /Do not modify product code or dependencies/);
  assert.match(prompt, /Safe Auto-fix Queue/);
  assert.match(prompt, /Needs Your Decision/);
  assert.match(prompt, /Do not emit NIGHT_AGENT_COMPLETE/);
});

test("work pass requires approval for risky changes", () => {
  const prompt = buildPrompt("UX-001 needs a decision.", ".night-agent/reports/run.md", 3, "work");
  assert.match(prompt, /An item the user moved into "Approved Work"/);
  assert.match(prompt, /major dependency upgrades/);
  assert.match(prompt, /Never implement an item in "Needs Your Decision"/);
  assert.match(prompt, /as many eligible low-risk items as practical/);
  assert.match(prompt, /Never combine unrelated fixes in one commit/);
  assert.match(prompt, /Commit every independent product fix separately/);
  assert.match(prompt, /Do not include anything under \.night-agent\/ in the product-fix commit/);
  assert.match(prompt, /separate metadata-only commit/);
});

test("task pass makes the explicit task the primary mission", () => {
  const prompt = buildPrompt("Project context.", ".night-agent/reports/run.md", 1, "task", "Add a CSV export for invoices.");
  assert.match(prompt, /explicit task/);
  assert.match(prompt, /Add a CSV export for invoices\./);
  assert.match(prompt, /primary mission/);
  assert.match(prompt, /explicitly authorizes changes needed to complete it/);
  assert.match(prompt, /Do not defer it merely because it would ordinarily need an item in "Approved Work"/);
  assert.match(prompt, /do not perform unrelated audits or opportunistic cleanup/);
});

test("secondsUntil schedules today or tomorrow", () => {
  const now = new Date(2026, 0, 1, 20, 0, 0);
  assert.equal(secondsUntil("21:30", now), 5400);
  assert.equal(secondsUntil("19:00", now), 23 * 3600);
  assert.throws(() => secondsUntil("25:00", now), /valid 24-hour time/);
});

test("init prompt infers policy from repository evidence only", () => {
  assert.match(INIT_PROMPT, /Read the repository before editing/);
  assert.match(INIT_PROMPT, /runner has created \.night-agent\/NIGHT_AGENT\.md from the standard template/);
  assert.match(INIT_PROMPT, /missing-template blocker/);
  assert.match(INIT_PROMPT, /Preserve every top-level heading in the bootstrap template/);
  assert.match(INIT_PROMPT, /exact commands supported by manifests, scripts, CI, or documentation/);
  assert.match(INIT_PROMPT, /Do not use the web/);
  assert.match(INIT_PROMPT, /Do not commit/);
  assert.match(INIT_PROMPT, /Unknown/);
});

test("parseArgs rejects task and mission together", () => {
  assert.throws(() => parseArgs(["run", "--task", "x", "--mission", "deps"]), /mutually exclusive/);
  assert.equal(parseArgs(["run", "--mission", "auto", "--harness", "claude"]).harness, "claude");
});

test("mission pass makes the recurring mission the primary purpose", () => {
  const prompt = buildPrompt("Project context.", ".night-agent/reports/run.md", 2, "mission", "Track upstream library compatibility.", "compat");
  assert.match(prompt, /recurring maintenance mission "compat"/);
  assert.match(prompt, /Track upstream library compatibility\./);
  assert.match(prompt, /budget runs out before the mission is finished/);
  assert.match(prompt, /NIGHT_AGENT_COMPLETE/);
  // The brief may authorize an otherwise-approval-gated mandatory upgrade.
  assert.match(prompt, /mandatory security or compatibility upgrade/);
  assert.match(prompt, /authorized work is the mission itself and not a decision item/);
  assert.match(prompt, /Never weaken security, tests, or type safety/);
});

test("selectMission picks audit first, then rotates by neglect", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  assert.equal(selectMission(MISSIONS, { missions: {} }, now, "opencode").name, "audit");
  const ledger = { missions: { audit: { lastStartedAt: "2026-07-16T11:00:00Z", lastCompletedAt: "2026-07-16T11:00:00Z", lastResult: "work-complete" } } };
  assert.equal(selectMission(MISSIONS, ledger, now, "opencode").name, "deps");
});

test("selectMission honours cooldown and harness scoping", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const justRan = { missions: { audit: { lastStartedAt: "2026-07-16T11:00:00Z", lastCompletedAt: "2026-07-16T11:00:00Z", lastResult: "work-complete" }, deps: { lastStartedAt: "2026-07-16T11:00:00Z", lastCompletedAt: "2026-07-16T11:00:00Z", lastResult: "work-complete" }, nips: { lastStartedAt: "2026-07-16T11:00:00Z", lastCompletedAt: "2026-07-16T11:00:00Z", lastResult: "work-complete" } } };
  assert.equal(selectMission(MISSIONS, justRan, now, "opencode"), null);
  // nips is opencode-only, so it is not a candidate under claude.
  assert.equal(selectMission(MISSIONS, { missions: {} }, now, "claude").name, "audit");
  assert.equal(selectMission([MISSIONS[2]], { missions: {} }, now, "claude"), null);
});

test("selectMission resumes a budget-interrupted mission before rotating", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const ledger = { missions: {
    audit: { lastStartedAt: "2026-07-01T00:00:00Z", lastCompletedAt: "2026-07-01T00:00:00Z", lastResult: "work-complete" },
    deps: { lastStartedAt: "2026-07-16T11:00:00Z", lastResult: "budget-exhausted" },
  } };
  // deps just ran (inside cooldown) and audit is badly overdue, but the interrupted deps wins.
  assert.equal(selectMission(MISSIONS, ledger, now, "opencode").name, "deps");
});

test("selectMission backs off a persistently failing mission", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const eightDaysAgo = "2026-07-08T12:00:00Z";
  const failing = { missions: {
    audit: { lastStartedAt: "2026-07-15T12:00:00Z", lastCompletedAt: "2026-07-15T12:00:00Z", lastResult: "work-complete" },
    deps: { lastStartedAt: eightDaysAgo, lastCompletedAt: eightDaysAgo, lastResult: "failed", consecutiveFailures: 3 },
    nips: { lastStartedAt: eightDaysAgo, lastCompletedAt: eightDaysAgo, lastResult: "work-complete" },
  } };
  // Both 8 days idle on a 7-day cadence, but deps' 3 failures multiply its cadence 8x, so nips wins.
  assert.equal(selectMission(MISSIONS, failing, now, "opencode").name, "nips");
});

test("selectModel rotates least-recently-used and honours pins", () => {
  const ledger = { models: { "opencode:a": { lastUsedAt: "2026-07-16T11:00:00Z" } } };
  assert.equal(selectModel(["a", "b"], ledger, "opencode", { name: "x" }), "b");
  assert.equal(selectModel(["a", "b"], { models: {} }, "opencode", { name: "x" }), "a");
  assert.equal(selectModel(["a", "b"], ledger, "opencode", { name: "x", model: "pinned" }), "pinned");
});

test("nextReset computes daily and weekly anchors", () => {
  const now = new Date("2026-07-16T12:00:00Z"); // Thursday
  assert.equal(nextReset({ type: "daily", resetAnchor: "00:00", utc: true }, now).toISOString(), "2026-07-17T00:00:00.000Z");
  assert.equal(nextReset({ type: "daily", resetAnchor: "18:00", utc: true }, now).toISOString(), "2026-07-16T18:00:00.000Z");
  // next Wednesday 09:00 UTC after Thu Jul 16 is Jul 22.
  assert.equal(nextReset({ type: "weekly", resetAnchor: "wed 09:00", utc: true }, now).toISOString(), "2026-07-22T09:00:00.000Z");
  assert.throws(() => nextReset({ type: "weekly", resetAnchor: "09:00", utc: true }, now), /ddd HH:MM/);
});

test("validateConfig catches malformed missions and windows", () => {
  assert.deepEqual(validateConfig({ missions: [{ name: "audit", builtin: "audit", cadenceDays: 3 }] }).errors, []);
  const bad = validateConfig({ missions: [{ name: "x", brief: "b", builtin: "audit" }, { name: "x" }] });
  assert.ok(bad.errors.some((e) => /exactly one of/.test(e)));
  assert.ok(bad.errors.some((e) => /duplicate mission name/.test(e)));
  assert.ok(validateConfig({ missions: [] }).errors.some((e) => /non-empty array/.test(e)));
  assert.ok(validateConfig({ missions: [{ name: "a", brief: "b" }], harnesses: { opencode: { window: { type: "weekly", resetAnchor: "bad" } } } }).errors.some((e) => /window/.test(e)));
});

test("memory validation identifies required headings and generic placeholders", () => {
  const incomplete = validateMemory("## Objective\n\n- Tests: replace with the project's command\n");
  assert.equal(incomplete.generic, true);
  assert.deepEqual(incomplete.missingHeadings, [
    "## Priorities",
    "## Constraints",
    "## Project Commands",
    "## Project Context",
    "## Approved Work",
    "## Safe Auto-fix Queue",
    "## Needs Your Decision",
    "## Rejected Or Deferred",
    "## Audit Findings",
    "## Decisions",
    "## Failed Approaches",
    "## Completed Work",
  ]);
});
