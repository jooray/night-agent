# Night Agent

Night Agent runs bounded, unattended engineering sessions against a repository, using **OpenCode** (with the Venice provider configured on this machine) and/or **Claude Code** as the backend. It gives every project durable memory, works in an isolated Git worktree on a `night-agent` branch, commits coherent changes, writes a report, and never pushes.

Beyond a default open-ended audit, it rotates through a preset list of recurring **missions** — dependency reviews, upstream protocol and library compatibility, fork merges, and whatever else you define — always picking the most neglected one, rotating models, and running inside per-provider spend windows so subscription or DIEM credits get used before they reset. A mission interrupted when the budget runs out is resumed next time rather than dropped. When a run ends it can fire a hook — for example, text yourself a one-paragraph TLDR of what happened and what to act on.

## Quick start

The fastest path needs no hand-edited config. Open the target repository with an agent (OpenCode or Claude Code) and ask it to **"set up Night Agent for me."** `AGENTS.md` drives a short interview — which backends, which models, which missions, when to run, how to deliver the summary — and the agent writes the config, initializes the project, and starts the schedule for you.

Prefer to do it yourself? Follow **[docs/SETUP.md](docs/SETUP.md)** for the manual walkthrough (including running both backends at once), or read the sections below.

## How it works

The default mission is an evidence-based audit of security, reliability, dependencies, design/UX, code quality, and documentation. The first session of a run audits every category without changing product code; later sessions implement approved or clearly safe work until a limit is reached. Each run:

1. Creates or reuses the `night-agent` branch and a persistent isolated worktree, leaving your normal checkout untouched.
2. Reads `.night-agent/NIGHT_AGENT.md` for project policy, decisions, prior findings, failed approaches, and remaining tasks.
3. Runs fresh backend sessions — continuity comes from the repo, commits, memory, and report, not an ever-growing conversation.
4. Requires separate verification and a separate commit for every independent fix.
5. Stops on budget exhaustion, completion, an unrecoverable error, or the configured time/iteration limits.

Sessions run with permission auto-approval, but each backend's deny-list still applies (see **Safety Boundaries**).

## Backends (`--harness`)

Choose the backend with `--harness` (default `opencode`); `NIGHT_AGENT_HARNESS` sets the default. The persona, worktree, memory, report, and commit discipline are identical across backends — only the process invocation and its safety config differ.

- `opencode` — `opencode run --auto --agent night-agent`, permissions from `opencode.json`, budget from Venice's DIEM balance.
- `claude` — `claude -p … --output-format json --settings claude-settings.json`, permissions from the deny-list in `claude-settings.json` (init uses the tighter `claude-settings-init.json`). Per-iteration `total_cost_usd` is recorded in status.

Two Claude caveats worth knowing before an unattended run:

- **Permission mode.** The runner passes `--permission-mode dontAsk` so pre-approved tools run without prompting while the settings deny-list still blocks pushes, `gh`, `sudo`, `rm -rf`, publish, and deploy-like commands. Confirm this behaves as expected on your installed Claude Code version; override with `NIGHT_AGENT_CLAUDE_PERMISSION_MODE` or add flags with `NIGHT_AGENT_CLAUDE_EXTRA_ARGS`. Avoid `--dangerously-skip-permissions`: it bypasses the deny-list too.
- **No usage API.** Claude Code does not expose remaining usage or the weekly-limit reset time programmatically. "Spend before the reset" is therefore a configured window anchor (below), not something detected — and a run stops gracefully when it hits a limit string.

## Install

No packages are required. Node.js 20+, Git, and tmux must be on `PATH`, plus whichever backend you use (`opencode` and/or `claude`).

Optionally make the command global:

```bash
npm link --prefix /path/to/night-agent
```

Otherwise use `node /path/to/night-agent/src/night-agent.js` in place of `night-agent` below. With no `--model` and no config pool, each backend uses its own default model selection; `--model` or `NIGHT_AGENT_MODEL` overrides it.

## Initialize a project

From any Git repository:

```bash
night-agent init
```

This creates the dedicated branch and worktree, asks the backend to read repository docs, manifests, CI, and representative source, and generates `.night-agent/NIGHT_AGENT.md` with project-specific context and exact commands. The file is validated and committed only on `night-agent`. Initialization uses a restricted profile: it may read the repo and Git history but may edit only `.night-agent/NIGHT_AGENT.md`, and cannot use the web, install dependencies, run arbitrary commands, or commit directly.

Review the generated policy with `night-agent review --repo /path/to/project`. You can curate its queues (`Approved Work`, `Safe Auto-fix Queue`, `Needs Your Decision`, …) between runs, but no manual setup is required. See `example/night-agent.md` for the structure.

## Missions and rotation

A one-off `--task` is for tonight. **Missions** are the recurring jobs you want run again and again, defined once in `night-agent.config.json` at the repo root. See `example/night-agent.config.json` for calibrated examples. Each mission is a named brief (or `"builtin": "audit"` for the default audit loop) with a `cadenceDays`:

```json
{
  "harnesses": {
    "opencode": { "models": ["venice/qwen3-235b", "venice/deepseek-r1-671b"], "window": { "type": "daily", "resetAnchor": "00:00", "utc": true, "leadHours": 8 } },
    "claude":   { "models": ["opus", "sonnet"], "window": { "type": "weekly", "resetAnchor": "wed 09:00", "leadHours": 4 } }
  },
  "missions": [
    { "name": "audit",  "builtin": "audit", "cadenceDays": 3 },
    { "name": "deps",   "cadenceDays": 7,  "brief": "Review outdated or vulnerable dependencies…" },
    { "name": "compat", "cadenceDays": 7,  "brief": "Track upstream protocol/library changes; apply mandatory security or compatibility upgrades…" }
  ]
}
```

A `compat` mission is the one to reach for when a project tracks fast-moving protocols or load-bearing libraries: it infers which protocols and dependencies matter, watches upstream for security advisories and breaking changes, and — uniquely — is authorized to apply an *authoritative, mandatory* upgrade (a CVE/advisory affecting a version in use, or a required protocol transition) even when it forces a major, code-incompatible migration, while merely-available upgrades still route to a decision. See `example/night-agent.config.json` for the full brief.

Run the most neglected mission that is due, letting Night Agent pick the mission and rotate the model:

```bash
night-agent run --repo /path/to/project --mission auto
```

Selection is deterministic and decoupled from scheduling:

- **Neglect, weighted by cadence.** The most overdue mission (idle time ÷ cadence) wins; never-run and newly added missions go first. A just-run mission is on cooldown and is not reselected.
- **Model rotation.** The least-recently-used model from the harness's pool is chosen unless the mission pins one or you pass `--model`.
- **Resume on token exhaustion.** If a run ends because the budget or time ran out mid-mission — not because the agent finished — that same mission is pinned and resumed on the next run until it completes with `NIGHT_AGENT_COMPLETE`. Persistent failures back off (doubling the effective cadence, capped) so a broken mission never starves the queue.

Run a specific mission by name with `night-agent run --mission deps`, ignore cooldowns with `--force`, and inspect the ledger, overdue ratios, and next pick with:

```bash
night-agent missions --repo /path/to/project --harness claude
```

The ledger lives at `.git/night-agent/<branch>/scheduler.json`. Config values fill in only what you didn't pass on the command line; CLI flags and env vars win. `defaults`/`harnesses` may also live in `~/.config/night-agent/config.json` for machine-wide settings, while `missions` come only from the repo file. `--task` and `--mission` are mutually exclusive.

## Recurring, reset-anchored scheduling

Provider credits reset on their own cadence — Venice DIEM daily, a Claude subscription weekly — and the goal is to spend them before they expire. A recurring loop opens a **window** a configured number of hours before each provider's reset and fires one mission run, clamping its `--max-hours` to the time left before reset:

```bash
night-agent schedule --repo /path/to/project --harness opencode --recurring
night-agent schedule --repo /path/to/project --harness claude --recurring
```

Each command starts one tmux session per `(repo, harness)`, so a Venice-daily and a Claude-weekly loop coexist. `leadHours` in the harness's `window` is exactly the "run N hours before the reset" control (`4` = start four hours before the Wednesday 09:00 weekly reset). Because Claude's reset time is not queryable, the window is anchored to the reset time you assert in the config — verify the computed window with `night-agent missions`. Stop the loops with:

```bash
night-agent schedule --repo /path/to/project --stop
```

`caffeinate` wraps only the active run, so the Mac may sleep between windows; the loop wakes and starts a (shortened) run if it comes up mid-window. tmux sessions do not survive a reboot — re-run `schedule --recurring` (it is idempotent: kill-and-replace), or drive `night-agent loop …` from a `launchd` agent or cron `@reboot` entry for reboot survival.

## Finish hook and morning TLDR

As its last step each iteration, the agent writes a one-paragraph plain-text TLDR to `.night-agent/tldr.md` in the worktree — reusing the already-cached session context, so it costs no extra model call. Pass `--on-finish CMD` (or set `NIGHT_AGENT_ON_FINISH`) to run a command when the run ends; the TLDR is appended as the final argument and also provided as `NIGHT_AGENT_TLDR`, alongside `NIGHT_AGENT_STATE`, `_REASON`, `_REPO`, `_BRANCH`, `_HARNESS`, `_COMMITS`, and `_SPEND`. To text yourself the summary with a `simplex-msg`-style command:

```bash
night-agent run --repo /path/to/project --mission auto --on-finish simplex-msg
```

A broken hook is logged but never fails or rolls back the run; if the agent left no TLDR (for example the run was killed), a mechanical one-line summary is sent instead. Print the latest TLDR any time with `night-agent tldr --repo /path/to/project`.

## Custom budget gate

Before each iteration a gate decides whether the run may keep spending. The built-in gate for OpenCode is the Venice DIEM balance check (stops at `--min-diem`). Supply your own with `--gate-cmd CMD` (or `NIGHT_AGENT_GATE_CMD`, or `gateCmd` in the harness config): it runs before each iteration and a nonzero exit stops the run cleanly with reason `gate-stop`. Use it for limits Night Agent cannot see — for example a script that stops a Claude run once a locally tracked weekly budget is used up.

## Run a one-off task

Pass `--task` to make a specific request the run's primary mission. It is included in every session for that run and authorizes implementing the requested change without first adding it to `Approved Work`; existing safety boundaries, verification, and commit rules still apply.

```bash
night-agent run --repo /path/to/project --task "Add CSV export to the invoice list"
night-agent schedule --repo /path/to/project --at 23:30 --task "Add CSV export to the invoice list"
```

## One-shot tmux schedule

Schedule the next occurrence of a local 24-hour time in a detached tmux session that sleeps until then and runs under `caffeinate -i`:

```bash
night-agent schedule --repo /path/to/project --at 23:30
```

If the time has already passed today, it schedules tomorrow. This is one-shot; for recurring runs use `--recurring` above. The detached session inherits the current environment, so start it from a shell where your backend and (for OpenCode) the Venice proxy work.

## Status and reports

```bash
night-agent status --repo /path/to/project   # machine-readable JSON: state, iteration, spend, reason, loop window
night-agent tldr   --repo /path/to/project    # latest one-paragraph summary + review commands
night-agent review --repo /path/to/project    # memory plus exact review paths and Git commands
```

Operational state (status, scheduler ledger, loop window, lock, logs) is local under the repository's Git common directory and is not committed:

```text
.git/night-agent/<branch>/{status.json,scheduler.json,loop.json,run.lock,night-agent.log}
```

Human-readable reports are committed to the agent branch at `.night-agent/reports/<timestamp>.md`. Each independent product fix gets its own commit with focused tests but without `.night-agent/` files, followed by a metadata-only commit for memory and report — so product commits can be cherry-picked without importing agent files. Inspect without entering the worktree:

```bash
git log --oneline main..night-agent
git diff main...night-agent
```

The base branch may be `master` or another branch. Night Agent never merges, rebases, or pushes.

## Budget handling

With `VENICE_API_KEY` in the environment, the OpenCode runner calls Venice's authenticated `GET /billing/balance` before each iteration and stops at `--min-diem`. The key is never written to configuration, status, reports, logs, prompts, or arguments. Without a direct key (for example behind the E2EE proxy), it continues until the backend receives an HTTP 402 / insufficient-balance / spend-limit response. Runtime and iteration limits, the spend window, and any `--gate-cmd` remain active either way. Transient 429/500/503/504 failures use bounded backoff; other errors stop the run rather than repeatedly spending on a broken request.

## Safety boundaries

Each backend enforces a deny-list — `opencode.json` for OpenCode, `claude-settings.json` for Claude Code — covering:

- Pushes, tags, merges, rebases, branch switching, destructive Git cleanup, and resets.
- GitHub CLI operations.
- Package publishing, Docker pushes, deployment-like commands, `sudo`, and `rm -rf`.
- Reads or writes outside the isolated worktree (and, for `init`, edits outside the memory file).
- Interactive questions that would block overnight.

A recurring mission whose brief authorizes network access (an upstream fetch, a spec lookup) widens the unattended surface; keep such briefs read-only over the network, and remember missions never push. Commits are allowed only on the dedicated branch. Run this first against a low-risk repository and review all changes. Do not use it where ordinary test or build commands can deploy, publish, spend money, mutate production data, or reach sensitive infrastructure.

## Commands

```text
night-agent init [--repo PATH]
night-agent run [options]                 # add --mission auto to rotate missions
night-agent schedule --at HH:MM [options] # one-shot; or --recurring / --stop
night-agent missions [--repo PATH] [--harness NAME]
night-agent loop [options]                # foreground recurring scheduler (used by --recurring)
night-agent status [--repo PATH] [--branch NAME]
night-agent tldr [--repo PATH] [--branch NAME]
night-agent review [--repo PATH] [--branch NAME]
night-agent doctor [--repo PATH] [--branch NAME]

--repo PATH             Git repository (default: current directory)
--harness NAME          Coding backend: opencode | claude (default: opencode)
--model PROVIDER/MODEL  Backend model (default: rotated from the config pool)
--branch NAME           Dedicated branch (default: night-agent)
--task TEXT             Explicit one-off task; authorizes its implementation
--mission NAME|auto     Run a named mission, or auto = most neglected due mission
--config PATH           Config file (default: <repo>/night-agent.config.json)
--force                 With --mission auto: ignore cooldown, take most neglected
--gate-cmd CMD          Shell command run before each iteration; nonzero exit stops the run
--on-finish CMD         Shell command run when the run ends; receives the TLDR as its last argument
--max-iterations N      Maximum sessions (default: 100)
--max-hours N           Hard runtime limit (default: 12)
--min-diem N            Reserve for direct DIEM checks (default: 0.01)
--dry-run               Exercise setup without invoking the backend
```

See **[docs/SETUP.md](docs/SETUP.md)** for the dual-backend setup walkthrough, **[AGENTS.md](AGENTS.md)** for the agent-driven setup interview, and `docs/PRACTICAL-WORKFLOW.md` for the nightly/morning review process and approval policy.
