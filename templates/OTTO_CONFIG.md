# Otto Configuration — Plan Bundle Template

Copy this to your plan's directory (e.g. `planning/OTTO_CONFIG.md`) and fill in values.

## Entry Point
```
ENTRY_POINT=planning/RALPH.md
RUN_LOG=planning/RUN_LOG.md
STATE_DIR=.pi-otto
```

## Providers
```
MAIN_PROVIDER=opencode-go
MAIN_MODEL=deepseek-v4-pro
MAIN_THINKING=high
FALLBACK_FREE_PROVIDER=openrouter
FALLBACK_FREE_MODEL=qwen/qwen3-coder:free
FALLBACK_PAID_PROVIDER=openrouter
FALLBACK_PAID_MODEL=qwen/qwen3.5-9b
```

## Execution Limits
```
MAX_ITERATIONS=15
MAX_WALL_CLOCK_HOURS=12
STALL_THRESHOLD_MINUTES=20
STALL_MAX_RETRIES=3
BASH_SILENCE_TIMEOUT=90
BASH_HARD_TIMEOUT=600
```

## Dev Servers

Each server needs a `<NAME>_PORT` and `<NAME>_CMD` pair.
Otto health-checks each port and auto-restarts dead servers.

```
API_PORT=3000
API_CMD=cd apps/api && bun run dev
WEB_PORT=5173
WEB_CMD=cd apps/web && bun run dev
MOCK_PORT=6173
MOCK_CMD=cd mock && bun run dev -- --port 6173
HEALTH_CHECK_INTERVAL=60
```

## Verification
```
VERIFICATION_TIMEOUT=120
MAX_REVERIFICATION=2
```
