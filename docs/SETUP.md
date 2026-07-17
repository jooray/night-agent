# Setup Guide: OpenCode and Claude Code Together

This walks through running Night Agent with **both** backends at once — OpenCode (Venice) and Claude Code — against one repository. Each backend rotates its own models and runs in its own spend window, so the two coexist without stepping on each other.

Prefer not to edit JSON by hand? Open the repo with an agent (OpenCode or Claude Code) and say "set up Night Agent for me" — `AGENTS.md` drives an interview that produces everything below for you. This guide is the manual path.

## 1. Prerequisites

On `PATH`: Node 20+, `git`, `tmux`, and both backends —

- **OpenCode** configured with the Venice provider (the same setup you already use interactively). Optionally export `VENICE_API_KEY` so the runner can read your DIEM balance and stop at a reserve.
- **Claude Code** (`claude`) logged in. Check your weekly limit reset with `/usage` inside Claude Code — you'll need the weekday and time.

Install the CLI globally (optional):

```bash
npm link --prefix /path/to/night-agent
```

Otherwise use `node /path/to/night-agent/src/night-agent.js` wherever `night-agent` appears below.

## 2. Initialize the project

From the repository you want maintained (run once; the memory file is shared by both backends):

```bash
cd /path/to/project
night-agent init
```

This creates the dedicated `night-agent` branch and worktree and generates `.night-agent/NIGHT_AGENT.md`. Review it with `night-agent review`.

## 3. Write the config

Create `night-agent.config.json` at the repo root. This example runs a nightly Venice window and a weekly Claude window, sharing the same mission list:

```json
{
  "defaults": { "harness": "opencode", "maxHours": 12 },
  "harnesses": {
    "opencode": {
      "models": ["venice/qwen3-235b", "venice/deepseek-r1-671b", "venice/llama-3.3-70b"],
      "minDiem": 0.01,
      "window": { "type": "daily", "resetAnchor": "00:00", "utc": true, "leadHours": 8 }
    },
    "claude": {
      "models": ["opus", "sonnet"],
      "window": { "type": "weekly", "resetAnchor": "wed 09:00", "leadHours": 4 }
    }
  },
  "missions": [
    { "name": "audit", "builtin": "audit", "cadenceDays": 3 },
    { "name": "deps",  "cadenceDays": 7, "brief": "Review outdated or vulnerable dependencies; apply safe patch/minor upgrades with reviewed release notes, updated lockfiles, and focused tests. Record major upgrades as decision items." }
  ]
}
```

Set `claude.window.resetAnchor` to *your* weekly reset (weekday + local time from `/usage`); `leadHours: 4` opens the window four hours before it so the run spends what's left. `opencode.window` is anchored to the Venice DIEM daily reset (`00:00 UTC` here). Copy `example/night-agent.config.json` for fuller briefs, including a `compat` mission that watches upstream protocols and libraries and applies mandatory security/compatibility upgrades, and an `upstream` fork-merge mission.

Verify what each backend would pick and when its window opens:

```bash
night-agent missions --harness opencode
night-agent missions --harness claude
```

## 4. Start both loops

Each backend gets its own detached `tmux` session:

```bash
night-agent schedule --harness opencode --recurring
night-agent schedule --harness claude --recurring
```

The OpenCode loop wakes nightly, opens its window 8h before the DIEM reset, and runs the most-neglected mission until the budget or the window runs out. The Claude loop does the same weekly, 4h before your subscription resets. A mission interrupted by an exhausted budget is resumed on the next run rather than rotated away. Inspect either with `tmux attach -t night-agent-<project>-<harness>`.

Stop everything for this repo:

```bash
night-agent schedule --stop
```

## 5. Morning summary

Wire your texting command so each finished run pings your phone. The one-paragraph TLDR the agent wrote is passed as the last argument:

```bash
night-agent schedule --harness opencode --recurring --on-finish simplex-msg
night-agent schedule --harness claude   --recurring --on-finish simplex-msg
```

Or read it any time, plus the review commands:

```bash
night-agent tldr
```

## 6. First-run hygiene

- Start against a low-risk repository and watch the first real run of each backend.
- Review the branch before trusting it: `git log --oneline main..night-agent` and `git diff main...night-agent`. Cherry-pick product commits; they exclude `.night-agent/` so they carry no agent metadata.
- On the very first Claude run, confirm the `dontAsk` permission mode auto-runs tools while the `claude-settings.json` deny-list still blocks push/`gh`/`sudo`/`rm -rf`/publish/deploy. Adjust with `NIGHT_AGENT_CLAUDE_PERMISSION_MODE` if your Claude Code version differs.
- `tmux` sessions don't survive a reboot — re-run the `schedule --recurring` commands (they're idempotent), or drive `night-agent loop …` from a `launchd` agent / cron `@reboot` entry.
