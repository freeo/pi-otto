import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  phase: string;
  iteration: number;
  msg: string;
  data?: Record<string, unknown>;
}

export class OttoLogger {
  private logFile: string;

  constructor(stateDir: string) {
    const logDir = join(stateDir, "logs");
    mkdirSync(logDir, { recursive: true });
    this.logFile = join(logDir, `otto-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  private write(level: LogEntry["level"], msg: string, phase = "-", iteration = 0, data?: Record<string, unknown>) {
    const entry: LogEntry = { ts: new Date().toISOString(), level, phase, iteration, msg };
    if (data) entry.data = data;
    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
    } catch {
      // logging must never crash the extension
    }
  }

  info(msg: string, data?: Record<string, unknown>) { this.write("info", msg, undefined, undefined, data); }
  warn(msg: string, data?: Record<string, unknown>) { this.write("warn", msg, undefined, undefined, data); }
  error(msg: string, data?: Record<string, unknown>) { this.write("error", msg, undefined, undefined, data); }

  phased(level: LogEntry["level"], phase: string, iteration: number, msg: string, data?: Record<string, unknown>) {
    this.write(level, msg, phase, iteration, data);
  }
}

export async function checkPort(port: number, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const urls = [`http://localhost:${port}/healthz`, `http://localhost:${port}`];
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) return true;
      } catch {
        // try next URL
      }
    }
    clearTimeout(timer);
    return false;
  } catch {
    return false;
  }
}

export function spawnBackground(cmd: string, cwd: string): ChildProcess {
  const child = spawn("bash", ["-c", cmd], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();
  return child;
}

export function killPid(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPort(port: number, maxWaitMs = 30_000, intervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await checkPort(port)) return true;
    await sleep(intervalMs);
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RATE_LIMIT_PATTERNS = [
  /429/i,
  /rate.?limit/i,
  /quota.?exceed/i,
  /too.?many.?requests/i,
  /capacity.?exceeded/i,
  /try.?again.?later/i,
  /requests? per (minute|hour|day)/i,
];

export function isRateLimitSignal(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

export function extractWaitSeconds(text: string): number {
  const secMatch = text.match(/(\d+)\s*seconds?/i);
  if (secMatch) return parseInt(secMatch[1], 10);

  const minMatch = text.match(/(\d+)\s*minutes?/i);
  if (minMatch) return parseInt(minMatch[1], 10) * 60;

  const hourMatch = text.match(/(\d+)\s*hours?/i);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 3600;

  const isoMatch = text.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
  if (isoMatch) {
    const wait = new Date(isoMatch[1]).getTime() - Date.now();
    if (wait > 0) return Math.ceil(wait / 1000);
  }
  return -1;
}

export function shouldSkipGuard(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (/\s&\s*$/.test(trimmed)) return true;
  if (/^(vim|vi|nano|emacs|ssh|less|more|man|top|htop)\b/.test(trimmed)) return true;
  if (trimmed.startsWith("timeout ")) return true;
  if (trimmed.includes("bash-monitor")) return true;
  if (trimmed.includes("OTTO_GUARD")) return true;
  return false;
}

export function wrapWithMonitor(
  cmd: string,
  silenceTimeout: number,
  hardTimeout: number,
  monitorScript: string,
): string {
  if (shouldSkipGuard(cmd)) return cmd;
  const escaped = cmd.replace(/'/g, "'\\''");
  // OTTO_GUARD env var marks this as already-wrapped for sqz compatibility.
  // sqz's shouldCompress() skips compound commands — the semicolon makes this compound.
  // Exit code preserved: $? from subshell captures monitor's exit code before the marker.
  return `OTTO_GUARD=1 bun run ${monitorScript} ${silenceTimeout} ${hardTimeout} '${escaped}'; exit $?`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
