# AGENTS.md — Night Agent

This file guides an AI coding agent (OpenCode, Claude Code, or similar) that is working in or with this repository. It has two jobs: run the **setup interview** when a user wants Night Agent configured, and describe how to work on the code itself.

Night Agent runs bounded, unattended engineering sessions against a repository, using OpenCode (Venice) and/or Claude Code as the backend. It rotates through recurring *missions* by neglect, rotates models, runs inside per-provider spend windows, commits on a dedicated branch, never pushes, and can text the user a one-paragraph TLDR when a run ends. See `README.md` for the full feature reference and `docs/SETUP.md` for the manual dual-backend walkthrough.

---

## Setup interview

When the user asks you to "set up Night Agent", "configure it", "get it running", or similar, **do not tell them to edit config files by hand**. Interview them, then create `night-agent.config.json`, initialize the project, and start (or print) the schedule for them. Follow this protocol:

1. **Ask one topic at a time, in order.** Do not dump the whole questionnaire at once. Offer the recommended default in each question so the user can just say "default". Skip questions that later answers make irrelevant (e.g. don't ask about Venice models if they only use Claude).
2. **Confirm prerequisites before writing anything.** Node 20+, `git`, `tmux`, and each chosen backend (`opencode` with Venice configured, and/or `claude` logged in) must be on `PATH`. If a backend is missing, note it and continue with what is available.
3. **After the interview, act.** Write `night-agent.config.json` at the target repo root, run `night-agent init` there if it is not already initialized, verify with `night-agent missions`, do one `night-agent run --mission <name> --dry-run` to prove the wiring, and then either start the recurring loops or print the exact commands for the user to run. Show the user the config you generated and summarize what will happen each night.
4. **Never invent facts.** If you don't know the user's Claude weekly-reset time, their Venice DIEM reset cadence, or the project's protocols, ask. Mark anything still unknown and leave a sensible default the user can revise.

### Questions

**A. Backends and budgets**

1. *Which backend(s) do you want to run — OpenCode (Venice), Claude Code, or both?* (Both is fine; they run in separate windows and coexist.) Which should be the default for ad-hoc runs?
2. *OpenCode only:* Which Venice models should rotate? (Give 2–4; the runner cycles least-recently-used.) What DIEM reserve should stop a run (`minDiem`, default `0.01`)? When does your Venice DIEM allowance reset — usually daily at `00:00 UTC`? How many hours before that should the nightly window open (`leadHours`, default `8`)?
3. *Claude only:* Which models should rotate (e.g. `opus`, `sonnet`)? Claude does **not** expose the weekly-limit reset time, so ask the user to read it from `/usage` in Claude Code: which weekday and local time does their weekly limit reset? How many hours before it should the window open to spend the remaining allowance (`leadHours`, default `4`)?

**B. The repository and its missions**

4. *Which repository should Night Agent maintain?* (Absolute path.) Is it a low-risk repo suitable for a first unattended run?
5. *Which recurring missions do you want?* Present this menu and let them pick, with a cadence (days) for each:
   - `audit` — the built-in open-ended security/reliability/deps/UX/quality/docs audit. (Recommended, cadence 3.)
   - `deps` — dependency review and safe patch/minor upgrades. (Cadence 7.)
   - `compat` — **ecosystem compatibility.** Track upstream changes in the protocols and critical libraries the project depends on, and keep it working against the current software stack. The agent should infer the relevant protocols and load-bearing libraries from the repo; you don't need to enumerate them. The distinguishing rule of this mission: an *authoritative, applicable* mandate — a published security advisory (CVE/GHSA/vendor emergency notice) affecting a version in use, or a required protocol transition — is treated as **required work and applied even when it forces a major, code-incompatible upgrade plus the code migration to restore the build**; a merely-available upgrade with no mandate stays a decision item. (Recommended for anything with meaningful protocol/crypto/consensus surface; cadence 7. Pin it to a strong model.)
   - `upstream` — if this repo is a **fork**, review and merge clean upstream commits. Ask for the upstream URL; this mission needs read-only network access in its brief.
   - Anything else the user describes — turn it into a named mission brief.
   For each mission, write a specific brief (see the brief-writing rules below). Ask if any mission should be **pinned** to a particular model or harness (e.g. run `compat`/`upstream` on the strongest model).

**C. Delivery and scheduling**

6. *How do you want the morning summary delivered?* If they have a texting command (e.g. `simplex-msg`), wire it as `--on-finish`; the TLDR is passed as the final argument. Otherwise they can read it with `night-agent tldr`.
7. *Recurring or manual?* If recurring, you will start one loop per backend (`schedule --recurring --harness opencode` and/or `--harness claude`). Confirm the computed windows with them via `night-agent missions` before starting. If manual, just show the `run --mission auto` command.
8. *Any limits?* `maxHours` (hard runtime cap, default 12) and `maxIterations` (default 100). Usually leave default; the spend window and budget gate stop the run first.

### Writing mission briefs

A good brief is specific, scoped, and safe. Follow the tone of the built-in prompts: state the goal, name where evidence lives, forbid scope creep, require that risky/ambiguous work goes to "Needs Your Decision" rather than being guessed, and — for anything touching the network — authorize **read-only** fetches only and reiterate that the agent never pushes. When a mission must be allowed to make an otherwise-approval-gated change (like `compat` applying a mandatory security upgrade), say so explicitly and bound it to an *authoritative* trigger, so ordinary large upgrades still route to a decision. Keep each brief to a few sentences. See `example/night-agent.config.json` for calibrated examples (`deps`, `compat`, `upstream` fork merge).

### Config schema you will write

```jsonc
{
  "defaults": { "harness": "opencode", "maxIterations": 100, "maxHours": 12 },
  "harnesses": {
    "opencode": {
      "models": ["venice/model-a", "venice/model-b"],   // rotated least-recently-used
      "minDiem": 0.01,                                    // reserve; stops the run
      "gateCmd": null,                                    // optional extra budget gate (shell cmd)
      "window": { "type": "daily", "resetAnchor": "00:00", "utc": true, "leadHours": 8, "minRunHours": 1 }
    },
    "claude": {
      "models": ["opus", "sonnet"],
      "window": { "type": "weekly", "resetAnchor": "wed 09:00", "leadHours": 4, "minRunHours": 1 }
    }
  },
  "missions": [
    { "name": "audit", "builtin": "audit", "cadenceDays": 3 },
    { "name": "deps", "cadenceDays": 7, "brief": "..." },
    { "name": "upstream", "cadenceDays": 7, "model": "venice/model-b", "brief": "..." }
  ]
}
```

Rules the runner enforces (validate before finishing): `missions` is a non-empty array; each mission has a unique `name` and **exactly one** of `brief` or `builtin: "audit"`; `cadenceDays > 0`; window `type` is `daily` (`"HH:MM"`) or `weekly` (`"ddd HH:MM"`, lowercase `mon`..`sun`); model pools are non-empty. Config values fill in only what the user did not pass on the command line — CLI flags and env vars always win. `defaults`/`harnesses` may also live in `~/.config/night-agent/config.json` for machine-wide settings; `missions` come only from the repo file.

### Commands you will run

```bash
night-agent init --repo <path>                              # once, generates project memory
night-agent missions --repo <path> --harness <name>          # verify selection + windows
night-agent run --repo <path> --mission <name> --dry-run     # prove wiring without spending
night-agent schedule --repo <path> --harness opencode --recurring
night-agent schedule --repo <path> --harness claude --recurring
night-agent schedule --repo <path> --stop                    # stop all loops for this repo
```

Do not run a real (non-dry) unattended session as part of setup unless the user asks. Recommend the user watch the first real run and review the branch diff before trusting it overnight.

---

## Working on this codebase

- **Single file, zero runtime dependencies.** All logic lives in `src/night-agent.js` (Node 20+ builtins, plus `git`, `tmux`, `caffeinate`, and the backend CLIs at runtime). Do not add npm dependencies.
- **Tests:** `npm test` (`node --test`). Pure functions (`parseArgs`, `buildPrompt`, `selectMission`, `selectModel`, `nextReset`, `validateConfig`, `validateMemory`) are exported and unit-tested; add cases there rather than shelling out.
- **Backends** are a table (`HARNESSES`) mapping the neutral request onto each CLI plus its deny-list config (`opencode.json`, `claude-settings.json`, `claude-settings-init.json`). Keep the persona, worktree, memory, report, and commit discipline harness-agnostic.
- **State** is local JSON under `<git-common-dir>/night-agent/<branch>/` (`status.json`, `scheduler.json`, `loop.json`, `run.lock`); the memory (`.night-agent/NIGHT_AGENT.md`) and reports are committed on the agent branch only. Never write outside these conventions.
- Match the existing terse style; explain non-obvious decisions in short comments, not diaries.
