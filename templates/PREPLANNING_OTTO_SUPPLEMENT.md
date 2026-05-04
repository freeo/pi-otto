# Pi-Otto Orchestration Supplement

Include this in your preplanning prompt. It ensures the generated plan bundle is compatible with pi-otto orchestration.

---

## How pi-otto executes your plan

Pi-otto is an extension that runs INSIDE the pi-coding-agent session. When the user types `/otto`, it:

1. Reads `planning/OTTO_CONFIG.md` for execution parameters
2. Runs smoke tests (config, tools, providers, bash monitor)
3. Reads the plan entry point (e.g. `planning/RALPH.md`) and injects it as the LLM prompt
4. The LLM then drives plan execution — otto monitors and guards the process

Otto provides:
- **Bash output-staleness monitoring** — kills commands that produce no output for 90s
- **Rate limit detection and provider fallback** — auto-switches to fallback models
- **Stall detection** — injects recovery prompts when the LLM makes repeated failing tool calls
- **Inactivity detection** — injects recovery prompts when no tool calls happen for N minutes
- **Dev server health watchdog** — auto-restarts dead servers before sub-agent dispatch
- **`verification_check` tool** — runs plan-defined checks with per-check isolation and timeout
- **Crash recovery** — persists state to disk, injects recovery context on next `/otto`
- **Statusline** — live widget showing turn count, elapsed time, current phase, active sub-agents

## Rules the plan MUST follow

### Strict sequential phase execution

Execute phases strictly one at a time, in order (V0 → V1 → ... → VN). The plan MUST include this instruction verbatim in the orchestrator runbook:

> Execute phases strictly one at a time in sequential order. Never batch, combine, skip, or "accelerate through" multiple phases. Each phase completes the full step sequence (read inputs → dispatch agents → integrate → verify → gate → log) before the next phase begins.

**Why this matters:** Otto tracks phase state. Batching phases breaks state tracking, prevents meaningful crash recovery, and produces sloppy work. The LLM will be tempted to "accelerate" late in a long run — the plan must explicitly prohibit this.

### Within a phase, parallel dispatch is fine

Within a single phase, implementer agents with non-overlapping file ownership CAN be dispatched in parallel. This is "parallel within one phase," NOT "multiple phases at once."

### Agent registration

Every agent referenced in task ownership MUST be registered before execution begins. The plan should list all required agents and verify their availability during bootstrap.

If using pi-subagents, agent configs live in `.pi/agents/<name>.yaml`. The plan's bootstrap step should verify:
```
For each agent referenced in any task: confirm the agent exists in .pi/agents/
```

If an agent is missing, the plan must halt and report — not silently skip or reassign tasks.

### Using verification_check

Otto provides a `verification_check` tool. The plan should instruct the LLM to use it for gate checks:

```json
{
  "phase": "V0",
  "checks": [
    { "name": "type check", "command": "bun tsc --noEmit", "timeout": 120 },
    { "name": "gate V0", "command": "bun run scripts/gates/v0.ts", "expect_pattern": "PASS" }
  ]
}
```

When `verification_check` runs:
- Otto sets the current phase in state tracking
- If all checks pass, otto marks the phase as complete
- The statusline updates to reflect phase progress

This is how otto knows which phases are done. If the LLM runs gate scripts via bash instead of `verification_check`, otto can't track phase progress.

### Handling otto messages

Otto injects messages with these prefixes:
- `[OTTO ERROR — BLOCKER]` — stall detected, inactivity, wall clock exceeded. **Stop and reassess.**
- `[OTTO ERROR — CONSTRAINT]` — rate limit, provider switch. **Adjust workload.**

The plan must instruct the LLM: "Do NOT ignore messages prefixed with [OTTO ERROR]. They are real system events from the orchestration harness."

### Dev servers

Otto manages dev server lifecycle via health watchdog. The plan should NOT instruct the LLM to manually start/stop dev servers during execution. Otto handles this automatically before sub-agent dispatch.

The plan's config lists server commands in `OTTO_CONFIG.md`. The plan should reference these servers but not manage their lifecycle.

## Crash recovery and resume

### How recovery works

When a session is interrupted (crash, abort, ctrl+c, or shutdown):
1. Otto saves state to `.pi-otto/state.json` (phases completed, current phase, stalls, rate limits)
2. On next `/otto`, otto detects the previous state
3. Otto injects `[OTTO CRASH RECOVERY]` context before the plan prompt
4. The recovery context tells the LLM which phases completed and where it stopped

### What the plan must include for recovery

The plan's bootstrap step must read a run log (e.g., `planning/RUN_LOG.md`) to determine the last completed phase. This is the ground truth — otto's state tracking is secondary confirmation.

The plan must include:
> If you see `[OTTO CRASH RECOVERY]` at the start of your prompt, a previous session was interrupted. Read the run log to confirm which phases are complete. Resume from the next incomplete phase. Do NOT re-execute completed phases.

### Fresh context resume

Recovery works from a fresh pi session. The user can:
1. Start a new pi session (fresh context window)
2. Run `/otto`
3. Otto reads state from disk and injects recovery context
4. The LLM reads the run log and resumes

This means the plan must be self-contained — the LLM must be able to understand the full execution state from the plan files + run log + otto recovery context, without needing prior conversation history.

## OTTO_CONFIG.md parameters the plan should document

The plan's config template should explain these fields:

| Field | Meaning |
|-------|---------|
| `maxIterations` | Max `/otto` invocations (crash recovery safety net). Set to ~10-20. |
| `maxWallClockHours` | Hard time limit per invocation. Otto shuts down after this. |
| `stallThresholdMinutes` | Minutes of no activity before otto injects recovery prompt. |
| `stallMaxRetries` | Consecutive identical failures before stall is declared. |
| `bashSilenceTimeout` | Seconds of no stdout/stderr before a bash command is killed. |
| `bashHardTimeout` | Absolute max seconds for any bash command. |
| `healthCheckInterval` | Seconds between dev server health probes. |
| `verificationTimeout` | Max seconds per verification check. |
