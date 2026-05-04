import type { OttoConfig } from "./types.js";
import { OttoLogger, wrapWithMonitor, formatDuration } from "./utils.js";
import { StateManager } from "./state.js";

export interface BashGuard {
  wrapCommand(cmd: string): string;
  recordStart(toolCallId: string, cmd: string): void;
  recordEnd(toolCallId: string): void;
  getStats(): BashStats;
}

export interface BashStats {
  totalCalls: number;
  totalTimeMs: number;
  longestCall: { cmd: string; durationMs: number } | null;
  timeouts: number;
}

export function createBashGuard(config: OttoConfig, logger: OttoLogger, monitorScript: string): BashGuard {
  const activeCalls = new Map<string, { cmd: string; startedAt: number }>();
  let totalCalls = 0;
  let totalTimeMs = 0;
  let longestCall: { cmd: string; durationMs: number } | null = null;
  let timeouts = 0;

  return {
    wrapCommand(cmd: string): string {
      return wrapWithMonitor(cmd, config.bashSilenceTimeout, config.bashHardTimeout, monitorScript);
    },

    recordStart(toolCallId: string, cmd: string) {
      activeCalls.set(toolCallId, { cmd: cmd.slice(0, 200), startedAt: Date.now() });
      totalCalls++;
    },

    recordEnd(toolCallId: string) {
      const call = activeCalls.get(toolCallId);
      activeCalls.delete(toolCallId);
      const durationMs = call ? Date.now() - call.startedAt : 0;

      totalTimeMs += durationMs;

      if (!longestCall || durationMs > longestCall.durationMs) {
        longestCall = { cmd: call?.cmd || "unknown", durationMs };
      }

      if (durationMs >= config.bashHardTimeout * 1000 - 1000) {
        timeouts++;
        logger.warn(`Bash timeout likely: ${call?.cmd?.slice(0, 100)} (${formatDuration(durationMs)})`);
      }
    },

    getStats(): BashStats {
      return { totalCalls, totalTimeMs, longestCall, timeouts };
    },
  };
}

export interface StallDetector {
  recordToolResult(toolName: string, success: boolean, output: string): void;
  checkForStall(): StallStatus;
  reset(): void;
}

export interface StallStatus {
  stalled: boolean;
  reason: string | null;
  consecutiveFailures: number;
  minutesSinceProgress: number;
}

export function createStallDetector(config: OttoConfig, state: StateManager, logger: OttoLogger): StallDetector {
  let lastProgressAt = Date.now();
  let consecutiveFailures = 0;
  let lastFailureSignature = "";
  let repeatedFailureCount = 0;

  function failureSignature(toolName: string, output: string): string {
    const firstLine = output.split("\n")[0]?.slice(0, 100) || "";
    return `${toolName}:${firstLine}`;
  }

  return {
    recordToolResult(toolName: string, success: boolean, output: string) {
      if (success) {
        consecutiveFailures = 0;
        lastFailureSignature = "";
        repeatedFailureCount = 0;
        lastProgressAt = Date.now();
        return;
      }

      consecutiveFailures++;
      const sig = failureSignature(toolName, output);
      if (sig === lastFailureSignature) {
        repeatedFailureCount++;
      } else {
        lastFailureSignature = sig;
        repeatedFailureCount = 1;
      }
    },

    checkForStall(): StallStatus {
      const minutesSinceProgress = (Date.now() - lastProgressAt) / 60_000;

      if (repeatedFailureCount >= config.stallMaxRetries) {
        const reason = `Same failure repeated ${repeatedFailureCount}x: ${lastFailureSignature.slice(0, 100)}`;
        logger.warn("Stall: repeated failure", { count: repeatedFailureCount, sig: lastFailureSignature });
        return { stalled: true, reason, consecutiveFailures, minutesSinceProgress };
      }

      if (minutesSinceProgress >= config.stallThresholdMinutes) {
        const reason = `No progress for ${Math.round(minutesSinceProgress)} minutes`;
        logger.warn("Stall: no progress", { minutes: minutesSinceProgress });
        return { stalled: true, reason, consecutiveFailures, minutesSinceProgress };
      }

      return { stalled: false, reason: null, consecutiveFailures, minutesSinceProgress };
    },

    reset() {
      lastProgressAt = Date.now();
      consecutiveFailures = 0;
      lastFailureSignature = "";
      repeatedFailureCount = 0;
    },
  };
}
