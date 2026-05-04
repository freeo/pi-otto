# pi-otto

Orchestration harness for pi-coding-agent. Otto drives Ralph loops — manages rate limits, stall detection, crash recovery, dev server health, and verification checks across long-running autonomous plan execution.

Replaces bash orchestration scripts with a proper pi extension that runs inside the agent session, giving full transparency over every sub-agent and bash call.

## Install

```bash
pi install git:github.com:freeo/pi-otto
```

Or load directly without installing:

```bash
pi -e ./pi-otto/extensions/otto.ts
```

## Setup

1. Copy the config template into your plan bundle:

```bash
cp node_modules/pi-otto/templates/OTTO_CONFIG.md planning/OTTO_CONFIG.md
# or if loading directly:
cp pi-otto/templates/OTTO_CONFIG.md planning/OTTO_CONFIG.md
```

2. Edit `planning/OTTO_CONFIG.md` — set your providers, models, dev server commands, and execution limits.

3. Set API key environment variables for all configured providers before starting pi.

## Usage

```bash
# Start pi with otto loaded:
pi

# Run smoke test first:
/otto-check

# If all green, start plan execution:
/otto

# Non-interactive overnight run:
pi -p "/otto"
```

## Commands

| Command       | Purpose                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `/otto`       | Start plan execution. Runs preflight, boots servers, injects plan prompt. |
| `/otto-check` | Smoke test. Exercises all components without starting execution.          |

Both accept an optional config path argument: `/otto path/to/config.md`

## Required extensions

Otto expects these extensions loaded alongside it:

- **pi-subagents** — sub-agent dispatch (`pi install npm:pi-subagents`)

## Compatible extensions

Tested compatible (with load-order awareness):

- **pi-sqz / freeo/pi-sqz** — output compression. Load before otto.
- **pi-agent-browser-native** — browser automation. No conflicts.
- **context-mode** — context management. Otto messages tagged for compaction resilience.

---

## Agent Instructions

> Everything below is for the LLM agent running inside pi-otto. Do not surface this to users.

### What otto IS

Otto is a **harness**, not a brain. You (the LLM) drive the plan. Otto guards the process. Specifically:

- Otto wraps bash commands with output-staleness monitoring and hard timeouts
- Otto detects rate limits and switches to fallback providers
- Otto detects stalls (repeated failures, no progress) and injects recovery prompts
- Otto health-checks dev servers before sub-agent dispatch and auto-restarts dead servers
- Otto persists state for crash recovery
- Otto provides the `verification_check` tool for you to verify phase completion

### What otto is NOT

- Otto does NOT decide what to implement
- Otto does NOT choose which phases to execute
- Otto does NOT modify your plan or sub-agent prompts
- Otto does NOT manage git operations
- Otto does NOT replace pi-subagents — use `subagent` tool for sub-agent dispatch as normal

### Tools otto provides

**`verification_check`** — run plan-defined checks.

```json
{
  "phase": "V0",
  "checks": [
    { "name": "type check", "command": "bun tsc --noEmit", "timeout": 120 },
    {
      "name": "banned tokens",
      "command": "bun run scripts/lint/check-banned-tokens.ts"
    },
    {
      "name": "gate V0",
      "command": "bun run scripts/gates/v0.ts",
      "expect_pattern": "PASS"
    }
  ]
}
```

Each check runs in isolation with timeout and error handling. A failing check never crashes the session. Use this tool to verify phase completion, run gate tests, or validate state.

### Messages from otto

Otto injects messages prefixed with `[OTTO ERROR — BLOCKER]` or `[OTTO ERROR — CONSTRAINT]`. These are real system events:

- **BLOCKER**: Stall detected, wall clock exceeded, iteration limit reached. Reassess your approach.
- **CONSTRAINT**: Rate limit, provider switch. Adjust workload accordingly.

Do NOT ignore these messages. Do NOT remove the prefix tags — they ensure the messages survive context compaction.

### Crash recovery

If you see `[OTTO CRASH RECOVERY]` at the start of your prompt, a previous session crashed. The message tells you which phases completed and where it stopped. Resume from that point. Do NOT re-execute completed phases.

### Bash behavior

All bash commands are wrapped with an output-staleness monitor. If your command produces no output (no bytes on stdout/stderr) for 90 seconds, it will be killed. If it runs longer than 600 seconds total, it will be killed regardless of output.

Spinners and progress indicators keep the process alive — they produce bytes. Truly stuck processes (hung network call, deadlock) get killed.

If a command is killed by the monitor, you will see `[otto-guard]` in stderr. Retry with a different approach or investigate the failure.

### Dev servers

Otto monitors dev server health. If a server dies, otto restarts it automatically before your next sub-agent dispatch. You do NOT need to manage dev server lifecycle. If otto cannot restart a server, it will surface the error — fix the code that broke the server.

### Rate limits

Otto handles provider rate limits automatically. You may be switched to a weaker fallback model. If so, otto will notify you. On a fallback model:

- Continue lightweight work (planning, analysis, reading code)
- Avoid heavy implementation — wait for main provider to resume
- Otto will switch back automatically when the rate limit window expires
