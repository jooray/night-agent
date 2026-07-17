# Practical Night Agent Workflow

This workflow separates discovery, safe automatic work, and human-approved work. The goal is to spend the available Venice inference budget productively without letting an unattended agent make subjective or structurally risky decisions.

## The Nightly Cycle

Every run has two phases.

### Phase 1: Broad Audit

The first OpenCode session is audit-only. It surveys all categories:

- Security
- Reliability and correctness
- Dependencies
- Design and UX
- Code quality
- Documentation

It may read the source, tests, Git history, configuration, dependency metadata, and existing UI. It may run local checks and read-only audits. It does not change product code or dependencies.

The result is an evidence-backed inventory in `.night-agent/NIGHT_AGENT.md`. Findings are deduplicated against previous nights and assigned stable IDs such as `SEC-001`, `REL-003`, or `UX-002`.

### Phase 2: Safe Work Until The Budget Ends

Later sessions continue until Venice returns an insufficient-balance response, the runtime limit is reached, or there is no useful work left.

Each session may handle several low-risk items. It chooses:

1. Work you explicitly approved after an earlier run.
2. A safe automatic fix identified during the audit.
3. Deeper investigation that improves the evidence and decision queue without changing product code.

The agent verifies and commits each independent fix before beginning the next. A session can therefore produce several small commits, but unrelated fixes are never bundled. Product commits exclude `.night-agent/`; memory and report changes are saved in separate metadata commits. It never pushes.

## What Can Be Fixed Automatically

A change must be small, reversible, independently reviewable, verifiable locally, and preserve intended behavior.

Typical safe candidates:

- A contained bug with a clear expected result and a regression test.
- Input validation or defensive error handling for a demonstrated failure.
- Security hardening with no ambiguity about authorization or compatibility.
- A patch or minor dependency update with reviewed release notes, no migration, and passing checks.
- Broken documentation, commands, links, or examples verified against current code.
- An obvious accessibility defect such as a missing label, invalid association, or keyboard trap with a contained fix.
- Removal of dead code only when references and behavior can be conclusively checked.

The category does not determine safety by itself. A one-line authorization change may be high risk, while a larger test-only change may be safe.

## What Requires Your Approval

The agent records these under `Needs Your Decision` instead of implementing them:

- Public API, protocol, or persisted schema changes.
- Database migrations or data backfills.
- Authentication and authorization policy decisions.
- Major dependency or framework upgrades.
- Broad refactors or architecture changes.
- Visual redesigns and subjective UX flow changes.
- New features, removed features, and compatibility breaks.
- Infrastructure, deployment, production, billing, or external-service changes.
- Any fix where intended behavior is unclear.

Each proposal should include evidence, impact, options, a recommendation, risks, and a verification plan. This turns the morning review into a decision rather than another code investigation.

## Set Up A Project

Initialize by pointing at the repository:

```bash
night-agent init --repo /path/to/project
```

Initialization is automatic. It:

1. Creates or reuses the dedicated `night-agent` branch and isolated worktree.
2. Seeds the required memory structure.
3. Runs a restricted OpenCode agent that reads local instructions, README files, docs, contributor guides, architecture and security notes, manifests, lockfiles, CI workflows, test configuration, deployment metadata, and representative entry points.
4. Infers the product purpose, architecture, users, critical flows, commands, trust boundaries, generated paths, and unsafe unattended operations from repository evidence.
5. Validates and commits `.night-agent/NIGHT_AGENT.md` automatically on `night-agent`.

The initialization agent cannot use the web, install packages, run arbitrary project commands, change product files, or commit. The runner performs the final commit after validating the generated structure.

Review what it inferred:

```bash
night-agent review --repo /path/to/project
```

Correct the generated policy only if repository documentation was incomplete or stale. Useful context includes:

- Primary users and critical user flows.
- Sensitive data and authorization boundaries.
- Supported browsers, devices, runtimes, and platforms.
- Areas the agent must not touch.
- Commands that are safe to run unattended.

Any corrections are made and committed in the review worktree printed by `night-agent review`, not in the normal checkout.

## Run Or Schedule

Run immediately:

```bash
night-agent run --repo /path/to/project --max-hours 12
```

Schedule the next local occurrence of 23:30 in tmux:

```bash
night-agent schedule --repo /path/to/project --at 23:30 --max-hours 12
```

The default iteration cap is 100. This is a safety ceiling, not a work target. The run normally ends because DIEM is exhausted, time expires, or no useful work remains.

If `VENICE_API_KEY` is exported, the runner checks DIEM before each session and preserves the `--min-diem` reserve. With the E2EE proxy alone, it stops when OpenCode receives Venice's HTTP 402 response.

## Monitor During The Night

Show live state:

```bash
night-agent status --repo /path/to/project
```

Attach to the scheduled session:

```bash
tmux attach -t night-agent-PROJECT_NAME
```

Detaching with `Ctrl-b d` leaves the run active.

## Morning Review

Start with:

```bash
night-agent review --repo /path/to/project
```

This prints the durable memory and the exact locations and Git commands for that project. Then review:

```bash
git -C /path/to/project log --oneline HEAD..night-agent
git -C /path/to/project diff HEAD...night-agent
```

Review commits individually. The report is under `.night-agent/reports/` in the dedicated worktree and branch. Check the claimed verification and run important tests yourself before integrating code.

## Vet Findings For The Next Night

Open the memory path printed by `night-agent review`. Curate the queues:

- Move an accepted ID from `Needs Your Decision` to `Approved Work`.
- Add scope, acceptance criteria, and conditions to approved items.
- Move declined items to `Rejected Or Deferred` and state why.
- Leave unresolved proposals in `Needs Your Decision` if more evidence is needed.
- Reorder approved items to express priority.

Commit your curation directly in the dedicated worktree:

```bash
git -C /path/printed/by/review add .night-agent/NIGHT_AGENT.md
git -C /path/printed/by/review commit -m "night-agent: approve next work"
```

The following night's audit preserves these decisions. It must not implement a decision item unless you moved it to `Approved Work`.

## Integrate Accepted Changes

Cherry-pick selected product commits into your normal branch:

```bash
git -C /path/to/project cherry-pick COMMIT_HASH
```

Do not cherry-pick commits that only update `.night-agent/NIGHT_AGENT.md` or `.night-agent/reports/`. Those commits are branch-local memory and reporting. Product commits deliberately exclude these files.

Avoid merging the complete `night-agent` branch unless you explicitly want Night Agent memory and reports on your normal branch. The agent never integrates or pushes changes itself. Keep the dedicated branch because it contains project memory and historical reports.

If your normal branch advances independently, reconcile `night-agent` manually before the next run. The runner intentionally refuses to merge or rebase automatically because conflict resolution requires human judgment.

## Recommended First Week

1. Start with a low-risk project and `--max-hours 1 --max-iterations 5`.
2. Inspect whether audit findings are concrete and whether automatic fixes match your risk tolerance.
3. Tighten project-specific constraints and commands in `NIGHT_AGENT.md`.
4. Increase runtime after two or three clean reviews.
5. Export a direct `VENICE_API_KEY` only if you want pre-session balance checks; it is not required for the E2EE flow.

The quality of unattended work depends heavily on project context and verification commands. Treat `NIGHT_AGENT.md` as an operating policy, not just a backlog.
