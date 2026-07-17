#!/usr/bin/env node

import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BRANCH = "night-agent";
const DEFAULT_HARNESS = "opencode";
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_MAX_HOURS = 12;
const DEFAULT_MIN_DIEM = 0.01;
const RETRY_DELAYS_MS = [60_000, 120_000, 300_000];

// A harness is a pluggable coding-CLI backend. Each maps night-agent's neutral
// request (profile, model, prompt, config) onto that CLI's invocation, and
// parses its output back into { text, costUsd }. The night-agent persona,
// worktree, memory, report and commit discipline are harness-agnostic and live
// in buildPrompt/executeRun; only the process invocation and safety config differ.
const HARNESSES = {
  opencode: {
    command: "opencode",
    // Both profiles share opencode.json; the agent name selects the permission
    // profile (night-agent vs the restricted night-agent-init).
    configFile: { run: "opencode.json", init: "opencode.json" },
    invoke({ profile, model, title, prompt, configPath }) {
      const agent = profile === "init" ? "night-agent-init" : "night-agent";
      return {
        args: ["run", "--auto", "--agent", agent, ...(model ? ["--model", model] : []), "--title", title, prompt],
        env: { OPENCODE_CONFIG: configPath },
      };
    },
    // OpenCode streams plain text; the whole capture is the assistant output and
    // it does not report per-call cost.
    parse(result) {
      return { text: result.output, costUsd: null };
    },
  },
  claude: {
    command: "claude",
    // The deny-list safety net lives in the settings file; init uses a tighter one.
    configFile: { run: "claude-settings.json", init: "claude-settings-init.json" },
    invoke({ model, prompt, configPath }) {
      // dontAsk runs pre-approved tools without prompting while still honouring the
      // deny rules in the settings file. Override per-machine with the env vars if a
      // different Claude Code version wants another mode or extra flags.
      const permissionMode = process.env.NIGHT_AGENT_CLAUDE_PERMISSION_MODE || "dontAsk";
      const extra = (process.env.NIGHT_AGENT_CLAUDE_EXTRA_ARGS || "").split(" ").filter(Boolean);
      return {
        args: ["-p", prompt, ...(model ? ["--model", model] : []), "--output-format", "json", "--permission-mode", permissionMode, "--settings", configPath, ...extra],
        env: {},
      };
    },
    // With --output-format json the assistant text is .result and spend is
    // .total_cost_usd. Errors are non-JSON (usually on stderr), so fall back to the
    // raw capture, which keeps budget/retryable detection working on failures.
    parse(result) {
      try {
        const json = JSON.parse(result.output);
        return {
          text: typeof json.result === "string" ? json.result : result.output,
          costUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : null,
        };
      } catch {
        return { text: result.output, costUsd: null };
      }
    },
  },
};

export function parseArgs(argv) {
  const command = argv[0]?.startsWith("-") || !argv[0] ? "run" : argv.shift();
  if (!["run", "schedule", "status", "review", "init", "doctor", "missions", "loop", "tldr"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const options = {
    command,
    repo: process.cwd(),
    model: process.env.NIGHT_AGENT_MODEL || null,
    harness: process.env.NIGHT_AGENT_HARNESS || DEFAULT_HARNESS,
    branch: DEFAULT_BRANCH,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    maxHours: DEFAULT_MAX_HOURS,
    minDiem: DEFAULT_MIN_DIEM,
    at: null,
    task: null,
    mission: null,
    config: null,
    gateCmd: process.env.NIGHT_AGENT_GATE_CMD || null,
    onFinish: process.env.NIGHT_AGENT_ON_FINISH || null,
    force: false,
    recurring: false,
    stop: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (argument === "--force") { options.force = true; continue; }
    if (argument === "--recurring") { options.recurring = true; continue; }
    if (argument === "--stop") { options.stop = true; continue; }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const [name, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    switch (name) {
      case "--repo": options.repo = value; break;
      case "--model": options.model = value; break;
      case "--harness": options.harness = value; break;
      case "--branch": options.branch = value; break;
      case "--at": options.at = value; break;
      case "--task": options.task = nonEmptyText(value, name); break;
      case "--mission": options.mission = nonEmptyText(value, name); break;
      case "--config": options.config = value; break;
      case "--gate-cmd": options.gateCmd = nonEmptyText(value, name); break;
      case "--on-finish": options.onFinish = nonEmptyText(value, name); break;
      case "--max-iterations": options.maxIterations = positiveNumber(value, name); break;
      case "--max-hours": options.maxHours = positiveNumber(value, name); break;
      case "--min-diem": options.minDiem = nonNegativeNumber(value, name); break;
      default: throw new Error(`Unknown option: ${name}`);
    }
  }
  options.repo = path.resolve(options.repo);
  if (options.config) options.config = path.resolve(options.config);
  if (!HARNESSES[options.harness]) throw new Error(`--harness must be one of: ${Object.keys(HARNESSES).join(", ")}`);
  if (options.task && options.mission) throw new Error("--task and --mission are mutually exclusive");
  return options;
}

function positiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${option} must be greater than zero`);
  return parsed;
}

function nonNegativeNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${option} must be zero or greater`);
  return parsed;
}

function nonEmptyText(value, option) {
  if (!value.trim()) throw new Error(`${option} must not be empty`);
  return value;
}

export function isBudgetExhausted(text) {
  return /\b402\b|insufficient (?:usd or )?diem|insufficient balance|spend limit exceeded|API_KEY_DIEM_SPEND_LIMIT_EXCEEDED/i.test(text);
}

export function isRetryable(text) {
  return /\b429\b|rate limit|model (?:is )?(?:overloaded|offline|at capacity)|\b50[034]\b|request timeout|inference processing failed/i.test(text);
}

export function secondsUntil(time, now = new Date()) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time || "");
  if (!match) throw new Error("--at must use 24-hour HH:MM format");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("--at must be a valid 24-hour time");
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return Math.ceil((target - now) / 1000);
}

export function buildPrompt(memory, reportPath, iteration, phase = iteration === 1 ? "audit" : "work", task = null, missionName = null) {
  const phaseInstructions = phase === "mission" ? `This run executes the recurring maintenance mission "${missionName}", authorized by the project's night-agent configuration:

---
${task.trim()}
---

This mission is the primary purpose of this run. Stay strictly within its scope; do not perform unrelated audits or opportunistic cleanup. Earlier nights may have already made progress on this mission, so first read the repository, project memory, this run's report, and relevant tests to understand what remains before acting.

Apply the standard safe-change policy: implement contained, individually verifiable changes the mission calls for, and record anything requiring human judgment, a broad change, or an uncertain interpretation in "Needs Your Decision" instead of guessing. The brief may explicitly authorize a larger, otherwise-approval-gated change — for example applying a mandatory security or compatibility upgrade even when it forces a major or code-incompatible migration; where it does, that authorized work is the mission itself and not a decision item, so carry it through with thorough verification and record the authoritative source and your migration reasoning. Never weaken security, tests, or type safety to make things build. Verify and commit each independent change separately with a conventional "night-agent:" message. If the mission authorizes network access (for example inspecting an upstream repository, release notes, or a security advisory), stay read-only over the network and never push. If this cycle's budget runs out before the mission is finished, leave the worktree clean and the memory current so the next run resumes cleanly. When the mission has no further useful work this cycle, update the memory and report and say exactly NIGHT_AGENT_COMPLETE.` : phase === "task" ? `The user started this run with the following explicit task:

---
${task.trim()}
---

This task is the primary mission for this run and explicitly authorizes changes needed to complete it, including a feature addition when the request calls for one. Do not defer it merely because it would ordinarily need an item in "Approved Work". First inspect the repository, project memory, existing behavior, and relevant tests so you understand the request in the product's context. Implement only the requested task and its necessary supporting changes; do not perform unrelated audits or opportunistic cleanup.

Keep the change as small and compatible as the task allows. Preserve existing behavior outside the requested scope, follow the project's established architecture and design language, add suitable tests, and run relevant verification. If a material ambiguity or external side effect prevents safe completion, record the precise blocker in the memory and report instead of guessing. When the task is complete or blocked, update the memory and report, commit the work, and say exactly NIGHT_AGENT_COMPLETE.` : phase === "audit" ? `This is the mandatory audit pass. Survey every category below before proposing implementation work. You may inspect source, history, configuration, tests, dependency metadata, and existing UI; run read-only audits and normal local checks when safe. Do not modify product code or dependencies in this pass.

Update NIGHT_AGENT.md with a concise, evidence-backed inventory across all six audit categories. Put clearly safe, contained candidates in "Safe Auto-fix Queue". Put anything requiring human judgment in "Needs Your Decision", using a stable ID such as UX-001 or SEC-002 and including evidence, user or operational impact, proposed options, your recommendation, risk, and a verification plan. Preserve unresolved findings from previous nights and deduplicate new ones.

Append the audit summary to the report and commit only the night-agent memory and report files with a message beginning "night-agent: audit". Do not emit NIGHT_AGENT_COMPLETE during the audit pass.` : `This is an implementation and deeper-audit pass. Select work in this order:

1. An item the user moved into "Approved Work".
2. Items in "Safe Auto-fix Queue" that meet every safe-change rule below.
3. If neither queue has eligible work, investigate one audit category more deeply, record new evidence-backed findings, and commit the updated memory and report without changing product code.

A safe automatic change must be small, reversible, independently reviewable, covered by suitable verification, and preserve intended product behavior. Examples include a regression-tested contained bug fix; a clear security hardening with no auth or compatibility ambiguity; a patch or minor dependency update with reviewed release notes, no migration, and passing checks; broken links or documentation corrected against code; an obvious accessibility defect such as a missing programmatic label; or a focused reliability guard for a demonstrated failure.

Approval is required for public API or schema changes, database migrations, authentication or authorization policy changes, major dependency upgrades, broad refactors, visual redesigns, subjective UX flow changes, feature additions or removals, compatibility breaks, infrastructure changes, and fixes whose intended behavior is uncertain. Do not implement these merely because they look beneficial. Add or update a decision item instead.

Implement as many eligible low-risk items as practical in this session rather than stopping after the first. Keep fixes independent: verify and commit each fix separately before starting the next one. Never combine unrelated fixes in one commit. If a fix becomes uncertain, leave the worktree clean, record the blocker, and continue with another eligible item.

After completing each item, commit only that item's product code, tests, lockfiles, and product documentation. Do not include anything under .night-agent/ in the product-fix commit. Then move the item to "Completed Work", append its report entry with the product commit hash, and make a separate metadata commit containing only .night-agent/ changes. If evidence disproves an item, move it to "Rejected Or Deferred" with the reason. Never implement an item in "Needs Your Decision" or "Rejected Or Deferred" unless the user has moved it to "Approved Work".`;

  return `You are iteration ${iteration} of an unattended overnight engineering run on the dedicated night-agent branch.

The durable project brief and memory are below. Treat it as context, not unquestionable truth; update stale findings when evidence changes.

---
${memory.trim()}
---

${phaseInstructions}

Your overall mission is to audit and improve code quality, security, dependencies, reliability, design and UX, and documentation. Work in this priority order unless the project memory contains a more specific urgent task:

1. Security vulnerabilities, unsafe authorization or data handling, exposed secrets, injection risks, and insecure defaults.
2. Reliability and correctness problems, including reproducible failures, race conditions, poor error handling, data-loss risks, and missing tests for important behavior.
3. Dependency upgrades that address known vulnerabilities, incompatibility, or meaningful maintenance risk.
4. UX and design problems that make important user flows confusing, inaccessible, error-prone, slow, or unnecessarily difficult, on both desktop and mobile where applicable.
5. Code quality issues that materially hurt maintainability, not merely personal style preferences.
6. Documentation that is missing, misleading, or demonstrably inconsistent with behavior.

Inspect the repository, current branch, existing tests, project conventions, and NIGHT_AGENT.md before choosing work because earlier iterations may have made commits. Use existing audit findings first. If there are no actionable findings, investigate one audit category and record evidence-backed findings before implementing the best safe item. Do not claim a vulnerability or UX problem without concrete evidence. Do not create cosmetic churn merely to consume inference.

During implementation passes, process coherent, high-value fixes independently and carry each through relevant verification and its own commit. During the audit-only pass, make no product changes. For dependency changes, inspect release notes or migration requirements, update lockfiles, avoid unrelated major upgrades, and run focused tests. For UX work, preserve the established visual language, improve a real user flow, check accessibility and responsive behavior where practical, and avoid generic redesigns. For security or reliability fixes, add a regression test when feasible. For documentation, verify statements against current code and commands.

Do not ask questions. If work is ambiguous, risky, requires credentials, cannot be verified locally, or could introduce external side effects, record it as a finding and choose safer work. Do not weaken tests, security controls, type safety, lint rules, or error handling to make checks pass.

Before finishing:
1. Update .night-agent/NIGHT_AGENT.md with concise durable decisions, evidence-backed audit findings, queue status, failed approaches, remaining work, and completed outcomes. Remove or correct stale findings. Do not add a verbose chronological diary.
2. Append a concise entry for every fix to ${reportPath} with the audit category, finding ID, evidence or motivation, files changed, verification, result, and product commit hash.
3. Overwrite ${TLDR_FILE} with a single short plain-text paragraph (two to four sentences, no markdown, no headings) summarizing what this run accomplished and the most important thing the human should look at or decide next. Write it so it reads well as a phone text message. Base it on this run's report and commits, not only this iteration. Do not commit this file; leave it in the working tree.
4. Commit every independent product fix separately with a conventional message beginning "night-agent:". Exclude .night-agent/ so the product commit can be cherry-picked without importing agent metadata. Follow it with a separate metadata-only commit for NIGHT_AGENT.md and the report. Never amend, push, rebase, merge, deploy, publish, or modify another branch.

Preserve unrelated changes. Never access secrets or edit outside this worktree. If no safe useful work remains, update the report and say exactly NIGHT_AGENT_COMPLETE.`;
}

function run(command, args, { cwd, signal, capture = false, env = process.env, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, shell, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const consume = (chunk, destination) => {
      const text = chunk.toString();
      output += text;
      if (!capture) destination.write(text);
    };
    child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
    child.stderr.on("data", (chunk) => consume(chunk, process.stderr));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

function gitSync(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function projectPaths(repo, branch) {
  const commonDirRaw = gitSync(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = path.resolve(repo, commonDirRaw);
  const slug = branch.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  const stateDir = path.join(commonDir, "night-agent", slug);
  return {
    stateDir,
    statusFile: path.join(stateDir, "status.json"),
    logFile: path.join(stateDir, "night-agent.log"),
    ledgerFile: path.join(stateDir, "scheduler.json"),
    loopFile: path.join(stateDir, "loop.json"),
    worktree: path.join(commonDir, "night-agent-worktrees", slug),
  };
}

async function ensureWorktree(repo, branch, worktree) {
  const existing = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: worktree, encoding: "utf8" });
  if (existing.status === 0) return;
  await mkdir(path.dirname(worktree), { recursive: true });
  const branchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).status === 0;
  const args = branchExists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, "HEAD"];
  const result = await run("git", args, { cwd: repo });
  if (result.code !== 0) throw new Error(`Could not create worktree for ${branch}`);
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function updateStatus(context, patch) {
  context.status = { ...context.status, ...patch, updatedAt: new Date().toISOString() };
  await atomicJson(context.paths.statusFile, context.status);
}

async function log(context, message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  await appendFile(context.paths.logFile, line);
}

async function getDiemBalance(apiKey, signal) {
  if (!apiKey) return null;
  const response = await fetch("https://api.venice.ai/api/v1/billing/balance", {
    headers: { Authorization: `Bearer ${apiKey}` }, signal,
  });
  if (!response.ok) throw new Error(`Venice balance check failed with HTTP ${response.status}`);
  const result = await response.json();
  return { canConsume: result.canConsume, diem: result.balances?.diem, currency: result.consumptionCurrency };
}

async function initializeFiles(repo, worktree, reportPath) {
  const memoryPath = path.join(worktree, ".night-agent", "NIGHT_AGENT.md");
  await mkdir(path.dirname(path.join(worktree, reportPath)), { recursive: true });
  try {
    await readFile(memoryPath);
  } catch {
    const sourceMemory = await readFile(path.join(repo, ".night-agent", "NIGHT_AGENT.md"), "utf8").catch(() => INITIAL_MEMORY);
    await writeFile(memoryPath, sourceMemory);
  }
  await writeFile(path.join(worktree, reportPath), `# Night Agent Report\n\n- Started: ${new Date().toISOString()}\n- Branch: ${gitSync(worktree, ["branch", "--show-current"])}\n- Base commit: ${gitSync(worktree, ["rev-parse", "HEAD"])}\n\n## Iterations\n`);
  return memoryPath;
}

async function finishReport(context, reportPath, reason) {
  const absoluteReport = path.join(context.paths.worktree, reportPath);
  await appendFile(absoluteReport, `\n## Run End\n\n- Ended: ${new Date().toISOString()}\n- Reason: ${reason}\n- Final commit before report finalization: ${gitSync(context.paths.worktree, ["rev-parse", "HEAD"])}\n`);
  const added = await run("git", ["add", "--", reportPath], { cwd: context.paths.worktree, capture: true });
  if (added.code !== 0) throw new Error(`Could not stage final report: ${added.output}`);
  const staged = spawnSync("git", ["diff", "--cached", "--quiet", "--", reportPath], { cwd: context.paths.worktree });
  if (staged.status === 1) {
    const committed = await run("git", ["commit", "-m", `night-agent: finalize ${context.status.runId} report`, "--", reportPath], { cwd: context.paths.worktree, capture: true });
    if (committed.code !== 0) await log(context, `Could not commit final report: ${committed.output}`);
  }
  await updateStatus(context, { lastCommit: gitSync(context.paths.worktree, ["rev-parse", "HEAD"]) });
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timeout); reject(signal.reason); }, { once: true });
  });
}

const TLDR_FILE = ".night-agent/tldr.md";

// Prevents two runs from colliding in the same shared worktree. Returns a release
// function. A lock whose pid is gone is treated as stale and reclaimed.
async function acquireLock(stateDir) {
  const lockPath = path.join(stateDir, "run.lock");
  await mkdir(stateDir, { recursive: true });
  try {
    const previous = JSON.parse(await readFile(lockPath, "utf8"));
    if (previous.pid && previous.pid !== process.pid) {
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { alive = error.code === "EPERM"; }
      if (alive) throw new Error(`Another night-agent run (pid ${previous.pid}) holds ${lockPath}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  return async () => { await rm(lockPath, { force: true }); };
}

// A gate decides, before each iteration, whether the run may keep spending.
// Built-in: Venice diem balance (opencode). Optional: a user --gate-cmd whose
// nonzero exit stops the run (used for provider-specific limits, e.g. a script
// that stops Claude runs a few hours before the weekly reset). Returns a stop
// reason string, or null to proceed.
async function checkGate(options, context, signal) {
  let balance;
  if (options.harness === "opencode") {
    try { balance = await getDiemBalance(process.env.VENICE_API_KEY, signal); }
    catch (error) { await log(context, `Balance check warning: ${error.message}`); }
  }
  if (balance) {
    await updateStatus(context, { diemRemaining: balance.diem, consumptionCurrency: balance.currency });
    if (!balance.canConsume || (balance.currency === "DIEM" && balance.diem <= options.minDiem)) return "diem-reserve";
  }
  if (options.gateCmd) {
    const result = await run(options.gateCmd, [], { cwd: options.repo, signal, capture: true, shell: true });
    if (result.code !== 0) {
      await log(context, `Gate stopped the run (exit ${result.code}): ${result.output.slice(-500)}`);
      return "gate-stop";
    }
  }
  return null;
}

// The TLDR is written by the agent itself as its last step of every iteration
// (see buildPrompt), so it costs no extra model call and reuses the cached
// session context. We read whatever the most recent iteration left; if it is
// missing we synthesize a mechanical one-liner so the hook always gets something.
async function readTldr(context, reason) {
  const tldrPath = path.join(context.paths.worktree, TLDR_FILE);
  const text = await readFile(tldrPath, "utf8").then((value) => value.trim()).catch(() => "");
  if (text) return text;
  const commits = gitSync(context.paths.worktree, ["rev-list", "--count", "HEAD"]);
  return `Night Agent run ${context.status.runId} ended (${reason}). Branch ${context.status.branch}, ${commits} commits total, spend $${(context.status.spendUsd || 0).toFixed(2)}. No agent TLDR was produced; review the report.`;
}

// Runs the user's --on-finish command once the run concludes, passing the TLDR as
// the final argument and rich context via env. Never throws into the run: a
// broken hook must not fail or roll back completed work.
async function runOnFinish(context, options, reason) {
  if (!options.onFinish) return;
  try {
    const tldr = await readTldr(context, reason);
    await updateStatus(context, { tldr });
    const env = {
      ...process.env,
      NIGHT_AGENT_STATE: context.status.state || "",
      NIGHT_AGENT_REASON: reason || "",
      NIGHT_AGENT_REPO: options.repo,
      NIGHT_AGENT_BRANCH: options.branch,
      NIGHT_AGENT_HARNESS: options.harness,
      NIGHT_AGENT_REPORT: context.status.report || "",
      NIGHT_AGENT_COMMITS: context.status.lastCommit || "",
      NIGHT_AGENT_SPEND: String(context.status.spendUsd || 0),
      NIGHT_AGENT_TLDR: tldr,
    };
    const result = await run(`${options.onFinish} ${shellQuote(tldr)}`, [], { cwd: options.repo, capture: true, shell: true, env });
    await log(context, result.code === 0 ? "on-finish hook completed" : `on-finish hook exited ${result.code}: ${result.output.slice(-500)}`);
  } catch (error) {
    await log(context, `on-finish hook error: ${error.message}`);
  }
}

async function executeRun(options) {
  gitSync(options.repo, ["rev-parse", "--show-toplevel"]);
  const harness = HARNESSES[options.harness];
  const paths = projectPaths(options.repo, options.branch);
  await mkdir(paths.stateDir, { recursive: true });
  const releaseLock = await acquireLock(paths.stateDir);
  await ensureWorktree(options.repo, options.branch, paths.worktree);
  const runId = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const reportPath = `.night-agent/reports/${runId}.md`;
  const context = {
    paths,
      status: { state: "starting", runId, pid: process.pid, repo: options.repo, worktree: paths.worktree, branch: options.branch, harness: options.harness, model: options.model, task: options.task, startedAt: new Date().toISOString(), iteration: 0, spendUsd: 0, report: path.join(paths.worktree, reportPath) },
  };
  await updateStatus(context, {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Maximum runtime reached")), options.maxHours * 3_600_000);
  const stop = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let reportInitialized = false;

  // Single exit path for every terminal outcome: finalize the report, persist the
  // final state/reason (which the scheduler reads to tell a completed mission from
  // one interrupted by budget/time), then fire the on-finish hook.
  const conclude = async (state, reason, code = 0) => {
    if (reportInitialized) {
      try { await finishReport(context, reportPath, reason); }
      catch (reportError) { await log(context, `Could not finalize report: ${reportError.message}`); }
    }
    await updateStatus(context, { state, reason });
    await runOnFinish(context, options, reason);
    return code;
  };

  try {
    const memoryPath = await initializeFiles(options.repo, paths.worktree, reportPath);
    reportInitialized = true;
    await log(context, `Starting ${runId} in ${paths.worktree} on ${options.harness} with ${options.model || "harness default model"}`);
    await updateStatus(context, { state: "running" });
    for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
      const gateReason = await checkGate(options, context, controller.signal);
      if (gateReason) {
        await log(context, `Budget gate stopped the run: ${gateReason}`);
        return await conclude("complete", gateReason);
      }

      const memory = await readFile(memoryPath, "utf8");
      const brief = options.task || options.missionBrief || null;
      const phase = options.task ? "task" : options.missionBrief ? "mission" : iteration === 1 ? "audit" : "work";
      await updateStatus(context, { state: "running", iteration, phase, mission: options.missionName || null, lastError: null });
      await log(context, `Starting iteration ${iteration}/${options.maxIterations} (${phase}${options.missionName ? ` ${options.missionName}` : ""})`);
      let result;
      let parsed;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (options.dryRun) result = { code: 0, output: "NIGHT_AGENT_COMPLETE" };
        else {
          const title = `night-agent ${runId} #${iteration} ${phase}`;
          const invocation = harness.invoke({ profile: "run", model: options.model, title, prompt: buildPrompt(memory, reportPath, iteration, phase, brief, options.missionName), configPath: path.join(ROOT, harness.configFile.run) });
          result = await run(harness.command, invocation.args, { cwd: paths.worktree, signal: controller.signal, env: { ...process.env, ...invocation.env } });
        }
        if (result.code === 0 || isBudgetExhausted(result.output) || !isRetryable(result.output) || attempt === RETRY_DELAYS_MS.length) break;
        await updateStatus(context, { state: "retrying", lastError: result.output.slice(-1000) });
        await sleep(RETRY_DELAYS_MS[attempt], controller.signal);
      }
      parsed = harness.parse(result);
      if (parsed.costUsd != null) context.status.spendUsd = (context.status.spendUsd || 0) + parsed.costUsd;
      await updateStatus(context, { spendUsd: context.status.spendUsd, lastCostUsd: parsed.costUsd });
      if (isBudgetExhausted(result.output)) {
        await log(context, "Inference budget exhausted");
        return await conclude("complete", "budget-exhausted");
      }
      if (result.code !== 0) {
        await updateStatus(context, { lastError: result.output.slice(-2000) });
        return await conclude("failed", "harness-error", result.code);
      }
      const head = gitSync(paths.worktree, ["rev-parse", "HEAD"]);
      await updateStatus(context, { lastCommit: head });
      if (parsed.text.includes("NIGHT_AGENT_COMPLETE")) {
        await log(context, "No safe useful work remains");
        return await conclude("complete", "work-complete");
      }
    }
    return await conclude("complete", "iteration-limit");
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason?.message || "stopped" : error.message;
    await log(context, reason);
    await updateStatus(context, { lastError: error.stack });
    return await conclude(controller.signal.aborted ? "stopped" : "failed", reason, controller.signal.aborted ? 0 : 1);
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await releaseLock().catch(() => {});
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function sessionName(options, suffix) {
  const project = path.basename(options.repo).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  return `night-agent-${project}${suffix ? `-${suffix}` : ""}`;
}

// Options that define what a run does, forwarded verbatim to a detached run/loop.
function runFlags(options) {
  return [
    "--repo", options.repo, "--harness", options.harness,
    ...(options.model ? ["--model", options.model] : []),
    "--branch", options.branch, "--max-iterations", options.maxIterations, "--max-hours", options.maxHours, "--min-diem", options.minDiem,
    ...(options.task ? ["--task", options.task] : []),
    ...(options.mission ? ["--mission", options.mission] : []),
    ...(options.config ? ["--config", options.config] : []),
    ...(options.gateCmd ? ["--gate-cmd", options.gateCmd] : []),
    ...(options.onFinish ? ["--on-finish", options.onFinish] : []),
  ];
}

function tmuxSession(session, command) {
  const result = spawnSync("tmux", ["new-session", "-d", "-s", session, command], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Could not create tmux session");
}

function killTmuxSessions(prefix) {
  const list = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  const sessions = (list.stdout || "").split("\n").map((line) => line.trim()).filter((name) => name === prefix || name.startsWith(`${prefix}-`));
  for (const name of sessions) spawnSync("tmux", ["kill-session", "-t", name]);
  return sessions;
}

const SELF = fileURLToPath(import.meta.url);

async function schedule(options) {
  const prefix = sessionName(options);
  if (options.stop) {
    const killed = killTmuxSessions(prefix);
    await rm(projectPaths(options.repo, options.branch).loopFile, { force: true });
    process.stdout.write(killed.length ? `Stopped: ${killed.join(", ")}\n` : `No night-agent sessions for ${prefix}\n`);
    return;
  }
  if (options.recurring) return scheduleRecurring(options);
  if (!options.at) throw new Error("schedule requires --at HH:MM (or --recurring for reset-anchored windows)");
  const delay = secondsUntil(options.at);
  const session = sessionName(options, options.harness);
  const args = ["run", ...runFlags(options), ...(options.dryRun ? ["--dry-run"] : [])];
  const command = `sleep ${delay}; exec caffeinate -i node ${shellQuote(SELF)} ${args.map(shellQuote).join(" ")}`;
  tmuxSession(session, command);
  const paths = projectPaths(options.repo, options.branch);
  await atomicJson(paths.statusFile, { state: "scheduled", repo: options.repo, branch: options.branch, harness: options.harness, model: options.model, task: options.task, mission: options.mission, tmuxSession: session, scheduledFor: new Date(Date.now() + delay * 1000).toISOString(), updatedAt: new Date().toISOString() });
  process.stdout.write(`Scheduled ${session} for ${new Date(Date.now() + delay * 1000).toLocaleString()}\nAttach with: tmux attach -t ${session}\n`);
}

// A recurring, reset-anchored loop lives in its own tmux session per (repo, harness)
// so Venice-daily and Claude-weekly loops coexist. The loop itself (below) sleeps
// until each provider's spend window opens, fires one mission run clamped to the
// remaining budget, then waits for the next window.
async function scheduleRecurring(options) {
  const config = await loadConfig(options);
  const window = config.harnesses?.[options.harness]?.window;
  if (!window) throw new Error(`No harnesses.${options.harness}.window in config; recurring scheduling needs a reset-anchored window`);
  const session = sessionName(options, options.harness);
  killTmuxSessions(session);
  const args = ["loop", ...runFlags(options), ...(options.dryRun ? ["--dry-run"] : [])];
  tmuxSession(session, `exec node ${shellQuote(SELF)} ${args.map(shellQuote).join(" ")}`);
  const next = nextReset(window, new Date());
  process.stdout.write(`Started recurring ${options.harness} loop ${session}\nNext ${options.harness} reset: ${next.toLocaleString()} (window opens ${window.leadHours ?? 0}h before)\nAttach with: tmux attach -t ${session}\nStop with: night-agent schedule --repo ${shellQuote(options.repo)} --stop\n`);
}

const INCOMPLETE_REASONS = new Set(["budget-exhausted", "diem-reserve", "gate-stop", "iteration-limit"]);
const FAILURE_REASONS = new Set(["harness-error", "failed", "init-harness-error"]);
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function cmpStr(a, b) {
  const x = a || "";
  const y = b || "";
  return x < y ? -1 : x > y ? 1 : 0;
}

// Compute the next reset instant for a provider window. Pure given `now`.
// daily: "HH:MM"; weekly: "ddd HH:MM" (lowercase mon..sun). `utc:true` anchors to
// UTC (Venice diem expiry), otherwise local time.
export function nextReset(window, now = new Date()) {
  const utc = !!window.utc;
  const dow = (d) => (utc ? d.getUTCDay() : d.getDay());
  const dom = (d) => (utc ? d.getUTCDate() : d.getDate());
  const setTime = (d, h, mi) => { if (utc) d.setUTCHours(h, mi, 0, 0); else d.setHours(h, mi, 0, 0); };
  const setDom = (d, n) => { if (utc) d.setUTCDate(n); else d.setDate(n); };
  const target = new Date(now.getTime());
  if (window.type === "daily") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(window.resetAnchor || "");
    if (!m) throw new Error(`daily resetAnchor must be "HH:MM": ${window.resetAnchor}`);
    setTime(target, Number(m[1]), Number(m[2]));
    if (target <= now) setDom(target, dom(target) + 1);
    return target;
  }
  if (window.type === "weekly") {
    const m = /^([a-z]{3})\s+(\d{1,2}):(\d{2})$/.exec((window.resetAnchor || "").toLowerCase());
    if (!m || WEEKDAYS.indexOf(m[1]) < 0) throw new Error(`weekly resetAnchor must be "ddd HH:MM": ${window.resetAnchor}`);
    setTime(target, Number(m[2]), Number(m[3]));
    let delta = (WEEKDAYS.indexOf(m[1]) - dow(target) + 7) % 7;
    if (delta === 0 && target <= now) delta = 7;
    if (delta) setDom(target, dom(target) + delta);
    return target;
  }
  throw new Error(`window.type must be "daily" or "weekly": ${window.type}`);
}

// Validate a merged config. Returns { errors: [...] }; loadConfig throws on any.
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") return { errors: ["config must be a JSON object"] };
  if (!Array.isArray(config.missions) || !config.missions.length) {
    errors.push("config.missions must be a non-empty array");
  } else {
    const names = new Set();
    for (const m of config.missions) {
      const label = m?.name || "(unnamed)";
      if (!m?.name) errors.push("each mission needs a name");
      else if (names.has(m.name)) errors.push(`duplicate mission name: ${m.name}`);
      else names.add(m.name);
      const hasBrief = typeof m?.brief === "string" && m.brief.trim().length > 0;
      const hasBuiltin = m?.builtin === "audit";
      if (hasBrief === hasBuiltin) errors.push(`mission ${label} must have exactly one of "brief" or builtin:"audit"`);
      if (m?.cadenceDays != null && !(m.cadenceDays > 0)) errors.push(`mission ${label} cadenceDays must be greater than zero`);
      if (m?.harness && !HARNESSES[m.harness]) errors.push(`mission ${label} names unknown harness ${m.harness}`);
    }
  }
  for (const [name, harness] of Object.entries(config.harnesses || {})) {
    if (!HARNESSES[name]) errors.push(`unknown harness in config: ${name}`);
    if (harness?.models != null && (!Array.isArray(harness.models) || !harness.models.length)) errors.push(`harness ${name} models must be a non-empty array`);
    if (harness?.window) {
      try { nextReset(harness.window, new Date(0)); } catch (error) { errors.push(`harness ${name} window: ${error.message}`); }
    }
  }
  return { errors };
}

// Choose the mission for a run. Deterministic given (missions, ledger, now, harness).
// A mission interrupted before completing (budget/time exhausted) is resumed before
// any neglect-based rotation, so a run that ran out of tokens continues next time
// instead of rotating away. Otherwise the most overdue mission (age relative to its
// cadence) wins, newly added / never-run missions first, with failure backoff so a
// persistently broken mission cannot starve the queue.
export function selectMission(missions, ledger, now, harness, force = false) {
  const usable = missions.filter((m) => m.enabled !== false && (!m.harness || m.harness === harness));
  const stateOf = (m) => ledger.missions?.[m.name];
  const resume = usable
    .filter((m) => { const s = stateOf(m); return s && (s.lastResult === "in-progress" || INCOMPLETE_REASONS.has(s.lastResult)); })
    .sort((a, b) => cmpStr(stateOf(a).lastStartedAt, stateOf(b).lastStartedAt) || missions.indexOf(a) - missions.indexOf(b));
  if (resume.length) return resume[0];

  const nowMs = now.getTime();
  const scored = [];
  for (const m of usable) {
    const s = stateOf(m);
    if (!s || !s.lastStartedAt) { scored.push({ m, score: Infinity }); continue; }
    const sinceStartH = (nowMs - new Date(s.lastStartedAt).getTime()) / 3_600_000;
    if (sinceStartH < (m.minIntervalHours ?? 20) && !force) continue;
    const ageH = (nowMs - new Date(s.lastCompletedAt || s.lastStartedAt).getTime()) / 3_600_000;
    const backoff = 2 ** Math.min(s.consecutiveFailures || 0, 3);
    const score = ageH / ((m.cadenceDays ?? 3) * 24 * backoff);
    if (score >= 1 || force) scored.push({ m, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || missions.indexOf(a.m) - missions.indexOf(b.m));
  return scored[0].m;
}

// Least-recently-used model from the harness pool, or the mission's pinned model.
export function selectModel(pool, ledger, harness, mission) {
  if (mission.model) return mission.model;
  if (!Array.isArray(pool) || !pool.length) return null;
  return pool
    .map((model, i) => ({ model, i, last: ledger.models?.[`${harness}:${model}`]?.lastUsedAt || "" }))
    .sort((a, b) => cmpStr(a.last, b.last) || a.i - b.i)[0].model;
}

function mergeHarnesses(base = {}, override = {}) {
  const merged = { ...base };
  for (const [name, value] of Object.entries(override)) merged[name] = { ...base[name], ...value };
  return merged;
}

async function loadConfig(options) {
  const repoConfigPath = options.config || path.join(options.repo, "night-agent.config.json");
  let repoConfig;
  try { repoConfig = JSON.parse(await readFile(repoConfigPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`No config at ${repoConfigPath}. Missions need a night-agent.config.json (see README).`);
    throw new Error(`Could not parse ${repoConfigPath}: ${error.message}`);
  }
  let userConfig = {};
  const userConfigPath = path.join(os.homedir(), ".config", "night-agent", "config.json");
  try { userConfig = JSON.parse(await readFile(userConfigPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error(`Could not parse ${userConfigPath}: ${error.message}`); }
  const merged = {
    ...userConfig,
    ...repoConfig,
    defaults: { ...userConfig.defaults, ...repoConfig.defaults },
    harnesses: mergeHarnesses(userConfig.harnesses, repoConfig.harnesses),
    missions: repoConfig.missions,
  };
  const { errors } = validateConfig(merged);
  if (errors.length) throw new Error(`Invalid config (${repoConfigPath}):\n- ${errors.join("\n- ")}`);
  return merged;
}

async function readLedger(paths) {
  try { return JSON.parse(await readFile(paths.ledgerFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { version: 1, missions: {}, models: {} }; throw error; }
}

async function recordMissionStart(paths, missionName, harness, model, nowIso) {
  const ledger = await readLedger(paths);
  const entry = ledger.missions[missionName] || { runs: 0, consecutiveFailures: 0 };
  entry.lastStartedAt = nowIso;
  entry.lastResult = "in-progress";
  entry.runs = (entry.runs || 0) + 1;
  ledger.missions[missionName] = entry;
  if (model) ledger.models[`${harness}:${model}`] = { lastUsedAt: nowIso };
  ledger.updatedAt = nowIso;
  await atomicJson(paths.ledgerFile, ledger);
}

async function recordMissionResult(paths, missionName, reason, nowIso) {
  const ledger = await readLedger(paths);
  const entry = ledger.missions[missionName] || { runs: 0, consecutiveFailures: 0 };
  entry.lastResult = reason;
  if (reason === "work-complete") { entry.lastCompletedAt = nowIso; entry.consecutiveFailures = 0; }
  else if (INCOMPLETE_REASONS.has(reason)) { entry.consecutiveFailures = 0; }
  else if (FAILURE_REASONS.has(reason)) { entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1; }
  ledger.missions[missionName] = entry;
  ledger.updatedAt = nowIso;
  await atomicJson(paths.ledgerFile, ledger);
}

// Resolve --mission (a name or "auto") against the config and ledger, applying model
// rotation. Returns null when nothing is due (auto), so the caller exits cheaply.
async function resolveMission(options, config, ledger, now) {
  let mission;
  if (options.mission === "auto") {
    mission = selectMission(config.missions, ledger, now, options.harness, options.force);
    if (!mission) return null;
  } else {
    mission = config.missions.find((m) => m.name === options.mission);
    if (!mission) throw new Error(`No mission named "${options.mission}" in config`);
  }
  const pool = config.harnesses?.[options.harness]?.models;
  const model = options.model || selectModel(pool, ledger, options.harness, mission);
  return { mission, model };
}

// Config makes itself the single source of truth: any run limit or gate the user
// did not pass on the command line falls back to the harness block, then defaults,
// then the built-in default. CLI flags and env vars always win.
function applyRunConfig(options, config) {
  const harness = config.harnesses?.[options.harness] || {};
  const defaults = config.defaults || {};
  const patch = {};
  if (options.gateCmd == null && (harness.gateCmd || defaults.gateCmd)) patch.gateCmd = harness.gateCmd || defaults.gateCmd;
  if (options.minDiem === DEFAULT_MIN_DIEM && harness.minDiem != null) patch.minDiem = harness.minDiem;
  if (options.maxHours === DEFAULT_MAX_HOURS && (harness.maxHours || defaults.maxHours)) patch.maxHours = harness.maxHours || defaults.maxHours;
  if (options.maxIterations === DEFAULT_MAX_ITERATIONS && (harness.maxIterations || defaults.maxIterations)) patch.maxIterations = harness.maxIterations || defaults.maxIterations;
  return patch;
}

// run wrapper: for --mission it selects the mission+model, records the attempt, runs,
// then records the outcome (which distinguishes completed from budget-interrupted).
async function runCommand(options) {
  if (!options.mission) return executeRun(options);
  const config = await loadConfig(options);
  const paths = projectPaths(options.repo, options.branch);
  const resolved = await resolveMission(options, config, await readLedger(paths), new Date());
  if (!resolved) { process.stdout.write("No mission due. Nothing to run.\n"); return 0; }
  const { mission, model } = resolved;
  const runOptions = {
    ...options,
    ...applyRunConfig(options, config),
    model,
    missionName: mission.name,
    missionBrief: mission.builtin === "audit" ? null : mission.brief,
  };
  await recordMissionStart(paths, mission.name, options.harness, model, new Date().toISOString());
  process.stdout.write(`Mission "${mission.name}" on ${options.harness}${model ? ` with ${model}` : ""}\n`);
  const code = await executeRun(runOptions);
  let reason = "unknown";
  try { reason = JSON.parse(await readFile(paths.statusFile, "utf8")).reason || "unknown"; } catch {}
  await recordMissionResult(paths, mission.name, reason, new Date().toISOString());
  return code;
}

function sleepUnattended(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// Foreground recurring loop (runs inside the tmux session from schedule --recurring).
// Sleeps in bounded chunks until the spend window opens, fires one mission run
// clamped to the time remaining before reset (so credits are spent, not stranded),
// then waits for the next window. caffeinate wraps only the run, so the Mac may sleep
// between windows; chunked sleep bounds oversleep after a wake.
async function loopCommand(options) {
  const config = await loadConfig(options);
  const window = config.harnesses?.[options.harness]?.window;
  if (!window) throw new Error(`No harnesses.${options.harness}.window in config`);
  const paths = projectPaths(options.repo, options.branch);
  await mkdir(paths.stateDir, { recursive: true });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const chunk = 15 * 60_000;
  process.stdout.write(`night-agent loop: ${options.harness} on ${options.repo}\n`);
  while (!controller.signal.aborted) {
    const now = new Date();
    const reset = nextReset(window, now);
    const opensAt = new Date(reset.getTime() - (window.leadHours ?? 0) * 3_600_000);
    if (now < opensAt) {
      await atomicJson(paths.loopFile, { state: "waiting", harness: options.harness, opensAt: opensAt.toISOString(), resetAt: reset.toISOString(), updatedAt: now.toISOString() });
      await sleepUnattended(Math.min(chunk, opensAt - now), controller.signal);
      continue;
    }
    const budgetHours = (reset - now) / 3_600_000;
    if (budgetHours < (window.minRunHours ?? 1)) {
      await sleepUnattended(Math.min(chunk, reset - now + 60_000), controller.signal);
      continue;
    }
    const maxHours = Math.min(options.maxHours, budgetHours);
    await atomicJson(paths.loopFile, { state: "running", harness: options.harness, session: sessionName(options, options.harness), opensAt: opensAt.toISOString(), resetAt: reset.toISOString(), maxHours, updatedAt: now.toISOString() });
    const args = ["run", ...runFlags({ ...options, maxHours }), "--mission", options.mission || "auto", ...(options.dryRun ? ["--dry-run"] : [])];
    await run("caffeinate", ["-i", "node", SELF, ...args], { signal: controller.signal }).catch((error) => process.stderr.write(`loop run error: ${error.message}\n`));
    await sleepUnattended(Math.max(60_000, reset - Date.now() + 60_000), controller.signal);
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

async function missionsCommand(options) {
  const config = await loadConfig(options);
  const paths = projectPaths(options.repo, options.branch);
  const ledger = await readLedger(paths);
  const now = new Date();
  const rows = config.missions.map((m) => {
    const s = ledger.missions?.[m.name] || {};
    const anchor = s.lastCompletedAt || s.lastStartedAt;
    const ageDays = anchor ? ((now - new Date(anchor).getTime()) / 86_400_000) : null;
    const overdue = ageDays == null ? Infinity : ageDays / (m.cadenceDays ?? 3);
    return { name: m.name, cadence: m.cadenceDays ?? 3, last: s.lastCompletedAt || "never", result: s.lastResult || "-", fails: s.consecutiveFailures || 0, overdue };
  });
  process.stdout.write(`Missions for ${options.repo} (${options.branch}), harness ${options.harness}:\n\n`);
  for (const r of rows.sort((a, b) => b.overdue - a.overdue)) {
    const ratio = r.overdue === Infinity ? "never-run" : `${r.overdue.toFixed(2)}x`;
    process.stdout.write(`  ${r.name.padEnd(14)} cadence ${r.cadence}d  overdue ${ratio.padEnd(10)} last ${String(r.last).slice(0, 19).padEnd(19)} ${r.result}${r.fails ? ` (fails:${r.fails})` : ""}\n`);
  }
  const next = selectMission(config.missions, ledger, now, options.harness, options.force);
  const model = next ? selectModel(config.harnesses?.[options.harness]?.models, ledger, options.harness, next) : null;
  process.stdout.write(`\nNext up: ${next ? `${next.name}${model ? ` with ${model}` : ""}` : "nothing due (use --force to run the most neglected anyway)"}\n`);
  const window = config.harnesses?.[options.harness]?.window;
  if (window) {
    const reset = nextReset(window, now);
    process.stdout.write(`Next ${options.harness} window opens ${new Date(reset.getTime() - (window.leadHours ?? 0) * 3_600_000).toLocaleString()} (reset ${reset.toLocaleString()})\n`);
  }
}

async function tldrCommand(options) {
  const paths = projectPaths(options.repo, options.branch);
  let status = {};
  try { status = JSON.parse(await readFile(paths.statusFile, "utf8")); } catch {}
  const tldr = status.tldr || await readFile(path.join(paths.worktree, TLDR_FILE), "utf8").then((t) => t.trim()).catch(() => "");
  process.stdout.write(`${tldr || "No TLDR available yet."}\n`);
  if (status.reason) process.stdout.write(`\nLast run: ${status.state} (${status.reason})${status.mission ? `, mission ${status.mission}` : ""}, spend $${(status.spendUsd || 0).toFixed(2)}\n`);
  process.stdout.write(`Commits: git -C ${JSON.stringify(options.repo)} log --oneline HEAD..${JSON.stringify(options.branch)}\n`);
}

async function showStatus(options) {
  const paths = projectPaths(options.repo, options.branch);
  const status = JSON.parse(await readFile(paths.statusFile, "utf8"));
  const loop = await readFile(paths.loopFile, "utf8").then(JSON.parse).catch(() => null);
  if (loop) status.loop = loop;
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function review(options) {
  const paths = projectPaths(options.repo, options.branch);
  const memoryPath = path.join(paths.worktree, ".night-agent", "NIGHT_AGENT.md");
  const memory = await readFile(memoryPath, "utf8").catch(() => {
    throw new Error("No night-agent memory found. Run night-agent init and then a night-agent run first.");
  });
  let status = {};
  try { status = JSON.parse(await readFile(paths.statusFile, "utf8")); } catch {}
  process.stdout.write(`${memory}\n\n---\nReview worktree: ${paths.worktree}\nMemory to edit: ${memoryPath}\nLatest report: ${status.report || "not available"}\nCompare branch: git -C ${JSON.stringify(options.repo)} diff HEAD...${JSON.stringify(options.branch)}\nCommits: git -C ${JSON.stringify(options.repo)} log --oneline HEAD..${JSON.stringify(options.branch)}\n`);
}

const REQUIRED_MEMORY_HEADINGS = [
  "## Objective",
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
];

export function validateMemory(memory) {
  const missingHeadings = REQUIRED_MEMORY_HEADINGS.filter((heading) => !memory.includes(heading));
  const generic = memory.includes("replace with the project's command") || memory.includes("Describe primary users, critical user flows");
  return { missingHeadings, generic };
}

async function fileExists(file) {
  return stat(file).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function doctor(options) {
  gitSync(options.repo, ["rev-parse", "--show-toplevel"]);
  const paths = projectPaths(options.repo, options.branch);
  const errors = [];
  const warnings = [];
  const details = [];
  const memoryPath = path.join(paths.worktree, ".night-agent", "NIGHT_AGENT.md");
  const worktreeExists = await fileExists(paths.worktree);

  if (!worktreeExists) {
    errors.push(`Worktree is missing: ${paths.worktree}`);
  } else {
    const branch = gitSync(paths.worktree, ["branch", "--show-current"]);
    if (branch !== options.branch) errors.push(`Worktree is on ${branch || "a detached HEAD"}, expected ${options.branch}`);
    else details.push(`Worktree: ${paths.worktree} (${branch})`);

    if (!(await fileExists(memoryPath))) {
      errors.push(`Memory file is missing: ${memoryPath}`);
    } else {
      const memory = await readFile(memoryPath, "utf8");
      const validation = validateMemory(memory);
      if (validation.missingHeadings.length) errors.push(`Memory is missing required sections: ${validation.missingHeadings.join(", ")}`);
      if (validation.generic) warnings.push("Memory still contains generic initialization placeholders");
      details.push(`Memory: ${memoryPath} (${memory.split("\n").length} lines)`);
    }

    const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: paths.worktree, encoding: "utf8" }).stdout.trim();
    if (dirty) warnings.push("Worktree has uncommitted changes");
    else details.push("Worktree changes: clean");

    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", ".night-agent/NIGHT_AGENT.md"], { cwd: paths.worktree, stdio: "ignore" }).status === 0;
    if (await fileExists(memoryPath) && !tracked) warnings.push("Memory file is not committed to the agent branch");
  }

  try {
    const status = JSON.parse(await readFile(paths.statusFile, "utf8"));
    details.push(`Runner status: ${status.state || "unknown"}${status.reason ? ` (${status.reason})` : ""}`);
    if (status.state === "initializing" || status.state === "running" || status.state === "retrying") warnings.push(`Runner status appears unfinished: ${status.state}`);
  } catch (error) {
    if (error.code === "ENOENT") warnings.push("No runner status found; run init or run to create local status");
    else warnings.push(`Could not read runner status: ${error.message}`);
  }

  const reportsPath = path.join(paths.worktree, ".night-agent", "reports");
  try {
    const reports = await readdir(reportsPath, { withFileTypes: true });
    const reportFiles = reports.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
    const sizes = await Promise.all(reportFiles.map((entry) => stat(path.join(reportsPath, entry.name))));
    const bytes = sizes.reduce((total, report) => total + report.size, 0);
    details.push(`Reports: ${reportFiles.length} (${bytes} bytes)`);
    if (reportFiles.length > 30 || bytes > 1_000_000) warnings.push("Report history is large; review it before manually archiving older reports");
  } catch (error) {
    if (error.code === "ENOENT") details.push("Reports: none");
    else warnings.push(`Could not inspect reports: ${error.message}`);
  }

  const heading = errors.length ? "Night Agent doctor: setup needs attention" : "Night Agent doctor: setup is usable";
  process.stdout.write(`${heading}\n`);
  for (const detail of details) process.stdout.write(`OK: ${detail}\n`);
  for (const warning of warnings) process.stdout.write(`WARN: ${warning}\n`);
  for (const error of errors) process.stdout.write(`ERROR: ${error}\n`);
  return errors.length ? 1 : 0;
}

async function init(options) {
  gitSync(options.repo, ["rev-parse", "--show-toplevel"]);
  const paths = projectPaths(options.repo, options.branch);
  await mkdir(paths.stateDir, { recursive: true });
  await ensureWorktree(options.repo, options.branch, paths.worktree);
  const target = path.join(paths.worktree, ".night-agent", "NIGHT_AGENT.md");
  await mkdir(path.dirname(target), { recursive: true });
  const exists = await readFile(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (exists) {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", ".night-agent/NIGHT_AGENT.md"], { cwd: paths.worktree, stdio: "ignore" }).status === 0;
    if (tracked) throw new Error(`${target} already exists on ${options.branch}`);
  }
  await writeFile(target, INITIAL_MEMORY);
  const context = {
    paths,
    status: {
      state: "initializing",
      pid: process.pid,
      repo: options.repo,
      worktree: paths.worktree,
      branch: options.branch,
      harness: options.harness,
      model: options.model,
      startedAt: new Date().toISOString(),
      phase: "init",
    },
  };
  await updateStatus(context, {});

  if (!options.dryRun) {
    const harness = HARNESSES[options.harness];
    const invocation = harness.invoke({ profile: "init", model: options.model, title: "night-agent project initialization", prompt: INIT_PROMPT, configPath: path.join(ROOT, harness.configFile.init) });
    const result = await run(harness.command, invocation.args, {
      cwd: paths.worktree,
      env: { ...process.env, ...invocation.env },
    });
    if (result.code !== 0) {
      await updateStatus(context, { state: "failed", reason: "init-harness-error", lastError: result.output.slice(-2000) });
      throw new Error(`${options.harness} initialization failed with status ${result.code}`);
    }
  }

  const generated = await readFile(target, "utf8");
  const validation = validateMemory(generated);
  if (validation.missingHeadings.length || (!options.dryRun && validation.generic)) {
    await updateStatus(context, { state: "failed", reason: "invalid-generated-memory" });
    throw new Error("Generated NIGHT_AGENT.md is incomplete or missing required sections");
  }
  const added = await run("git", ["add", "--", ".night-agent/NIGHT_AGENT.md"], { cwd: paths.worktree, capture: true });
  if (added.code !== 0) throw new Error(`Could not stage generated memory: ${added.output}`);
  const committed = await run("git", ["commit", "-m", "night-agent: initialize project policy", "--", ".night-agent/NIGHT_AGENT.md"], { cwd: paths.worktree, capture: true });
  if (committed.code !== 0) {
    await updateStatus(context, { state: "failed", reason: "init-commit-error", lastError: committed.output });
    throw new Error(`Could not commit generated memory: ${committed.output}`);
  }
  const commit = gitSync(paths.worktree, ["rev-parse", "HEAD"]);
  await updateStatus(context, { state: "complete", reason: "initialized", lastCommit: commit, memory: target });
  process.stdout.write(`Initialized ${options.branch} at ${paths.worktree}\nGenerated and committed ${target}\nCommit: ${commit}\nReview with: node ${fileURLToPath(import.meta.url)} review --repo ${JSON.stringify(options.repo)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs([...argv]);
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (options.command === "schedule") { await schedule(options); return 0; }
  if (options.command === "status") { await showStatus(options); return 0; }
  if (options.command === "review") { await review(options); return 0; }
  if (options.command === "doctor") return doctor(options);
  if (options.command === "init") { await init(options); return 0; }
  if (options.command === "missions") { await missionsCommand(options); return 0; }
  if (options.command === "tldr") { await tldrCommand(options); return 0; }
  if (options.command === "loop") { await loopCommand(options); return 0; }
  return runCommand(options);
}

const INITIAL_MEMORY = `# Night Agent\n\n## Objective\n\nAudit and improve code quality, security, dependencies, reliability, design and UX, and documentation through small, reviewable changes. Prioritize fixes that reduce real user or operational risk over feature invention and cosmetic churn.\n\n## Priorities\n\n1. Fix security vulnerabilities, unsafe data handling, authorization mistakes, injection risks, and insecure defaults.\n2. Fix reliability and correctness problems, including failures, race conditions, data-loss risks, and poor error handling.\n3. Upgrade dependencies when doing so addresses vulnerabilities, incompatibility, or meaningful maintenance risk.\n4. Improve important user flows that are confusing, inaccessible, error-prone, slow, or unnecessarily difficult.\n5. Fix code quality issues that materially hurt maintainability.\n6. Correct documentation that is missing, misleading, or inconsistent with current behavior.\n\n## Constraints\n\n- Base findings on concrete repository evidence; do not invent product requirements or hypothetical vulnerabilities.\n- Preserve established architecture, design language, and public behavior unless a verified fix requires a change.\n- Keep dependency upgrades focused, inspect migration requirements, update lockfiles, and avoid unrelated major upgrades.\n- UX changes must improve a specific flow and preserve accessibility and responsive behavior.\n- Avoid broad refactors, formatting sweeps, speculative optimization, and test weakening.\n- Never deploy, publish, push, or access production systems.\n\n## Project Commands\n\n- Tests: replace with the project's command\n- Type check: replace with the project's command\n- Lint: replace with the project's command\n- Build: replace with the project's command\n- Dependency audit: replace with the project's command\n\n## Project Context\n\nDescribe primary users, critical user flows, sensitive data, deployment constraints, supported platforms, and prohibited areas.\n\n## Approved Work\n\nThe agent may implement items placed here by the user. Include the finding ID, scope, and any conditions.\n\n## Safe Auto-fix Queue\n\nThe agent maintains narrowly scoped findings here only when they satisfy the automatic-change policy.\n\n## Needs Your Decision\n\nThe agent records higher-risk or subjective proposals here. Each item must include a stable ID, evidence, impact, options, recommendation, risk, and verification plan. Move an accepted item to Approved Work before the next run.\n\n## Rejected Or Deferred\n\nMove declined ideas here with a short reason so they are not repeatedly proposed.\n\n## Audit Findings\n\n### Security\n\nRecord verified security findings, severity, evidence, and likely remediation.\n\n### Reliability\n\nRecord reproducible correctness, resilience, performance, and error-handling findings.\n\n### Dependencies\n\nRecord outdated or vulnerable packages only when an upgrade has a concrete benefit.\n\n### Design And UX\n\nRecord the affected user flow, observed friction, accessibility or responsive impact, and acceptance criteria.\n\n### Code Quality\n\nRecord maintainability problems with concrete impact.\n\n### Documentation\n\nRecord specific gaps or contradictions and the source of truth.\n\n## Decisions\n\nRecord durable technical and product decisions with rationale.\n\n## Failed Approaches\n\nRecord approaches that should not be repeated and why.\n\n## Completed Work\n\nKeep a compact list of completed outcomes and commit hashes. Detailed chronology belongs in reports.\n`;

export const INIT_PROMPT = `Initialize this repository for unattended Night Agent audits.

Read the repository before editing. Start with AGENTS.md and equivalent instruction files, README files, docs, contributor guides, architecture or security documentation, package and dependency manifests, lockfiles, task runners, CI workflows, test configuration, deployment metadata, and representative application entry points. Use repository evidence only. Do not use the web, run installation, execute tests, or modify any file except .night-agent/NIGHT_AGENT.md.

The runner has created .night-agent/NIGHT_AGENT.md from the standard template before this session. Rewrite that bootstrap template into a concise project-specific operating policy. Do not treat the file as a pre-existing repository file or as a missing-template blocker:

- Preserve every top-level heading in the bootstrap template, especially the queue and audit headings.
- Replace generic Objective and Project Context text with the product's apparent purpose, primary users, important user flows, architecture, languages and frameworks, supported platforms, sensitive data, trust boundaries, and operational constraints that can be inferred from the repository.
- Fill Project Commands with exact commands supported by manifests, scripts, CI, or documentation. Omit a command if it cannot be established; never guess.
- Add project-specific constraints, generated or vendored paths to avoid, and commands or areas that could deploy, publish, mutate external systems, require secrets, or otherwise be unsafe unattended.
- Keep the default audit priorities unless repository evidence warrants a more specific ordering.
- Leave Approved Work, Safe Auto-fix Queue, Needs Your Decision, Rejected Or Deferred, Audit Findings, Failed Approaches, and Completed Work empty; initialization is context discovery, not the first audit.
- Under Decisions, record only durable facts needed by future agents and cite repository paths inline.
- Mark genuinely unknown important context as "Unknown" rather than inventing it.

Do not change product code, dependencies, lockfiles, configuration, or documentation. Do not commit; the runner will validate and commit the generated file.`;

const HELP = `Usage: night-agent <command> [options]\n\nCommands:\n  init                    Infer and commit project policy on the agent branch\n  run                     Run now (default command)\n  schedule --at HH:MM     Start one run later in a detached tmux session\n  schedule --recurring    Start a per-harness reset-anchored spend loop (tmux)\n  schedule --stop         Kill this repo's scheduled/loop tmux sessions\n  missions                Show the mission ledger, overdue ratios, and next pick\n  loop                    Foreground recurring scheduler (used by --recurring)\n  status                  Print persistent JSON status\n  tldr                    Print the latest run's TLDR and review commands\n  review                  Show memory and branch review instructions\n  doctor                  Check existing Night Agent setup without changing it\n\nOptions:\n  --repo PATH             Repository (default: current directory)\n  --harness NAME          Coding backend: ${Object.keys(HARNESSES).join(" | ")} (default: ${DEFAULT_HARNESS})\n  --model PROVIDER/MODEL  Backend model (default: rotated from the config pool)\n  --branch NAME           Dedicated branch (default: ${DEFAULT_BRANCH})\n  --task TEXT             Explicit one-off task; authorizes its implementation\n  --mission NAME|auto     Run a named mission, or auto = most neglected due mission\n  --config PATH           Config file (default: <repo>/night-agent.config.json)\n  --force                 With --mission auto: ignore cooldown, take most neglected\n  --gate-cmd CMD          Shell command run before each iteration; nonzero exit stops the run\n  --on-finish CMD         Shell command run when the run ends; receives the TLDR as its last argument\n  --max-iterations N      Maximum sessions (default: ${DEFAULT_MAX_ITERATIONS})\n  --max-hours N           Hard runtime limit (default: ${DEFAULT_MAX_HOURS})\n  --min-diem N            DIEM reserve for direct balance checks (default: ${DEFAULT_MIN_DIEM})\n  --dry-run               Exercise setup without invoking the backend\n  -h, --help              Show help\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`night-agent: ${error.message}\n`); process.exitCode = 1; });
}
