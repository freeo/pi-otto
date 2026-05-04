import type { OttoConfig } from "./types.js";
import { OttoLogger, formatDuration } from "./utils.js";
import { StateManager } from "./state.js";
import type { BashGuard, BashStats } from "./guards.js";

export interface ProgressTracker {
  onTurnEnd(): void;
  onPhaseDetected(phase: string): void;
  checkWallClock(): { exceeded: boolean; elapsed: string; remaining: string };
  checkIterationLimit(): { exceeded: boolean; current: number; max: number };
  buildExitSummary(reason: string): string;
  buildStatusWidget(): string[];
}

export function createProgressTracker(
  config: OttoConfig,
  state: StateManager,
  logger: OttoLogger,
  bashGuard: BashGuard,
): ProgressTracker {
  const startTime = Date.now();

  return {
    onTurnEnd() {
      state.save();
    },

    onPhaseDetected(phase: string) {
      const current = state.get().currentPhase;
      if (current !== phase) {
        logger.phased("info", phase, state.get().iteration, `Phase detected: ${phase} (was: ${current})`);
        state.setPhase(phase);
      }
    },

    checkWallClock(): { exceeded: boolean; elapsed: string; remaining: string } {
      const elapsedMs = Date.now() - startTime;
      const limitMs = config.maxWallClockHours * 3600_000;
      const remainingMs = Math.max(0, limitMs - elapsedMs);
      return {
        exceeded: elapsedMs >= limitMs,
        elapsed: formatDuration(elapsedMs),
        remaining: formatDuration(remainingMs),
      };
    },

    checkIterationLimit(): { exceeded: boolean; current: number; max: number } {
      const current = state.get().iteration;
      return { exceeded: current >= config.maxIterations, current, max: config.maxIterations };
    },

    buildExitSummary(reason: string): string {
      const s = state.get();
      const elapsedMs = Date.now() - startTime;
      const bashStats = bashGuard.getStats();

      const lines = [
        "",
        "═".repeat(50),
        "OTTO EXIT SUMMARY",
        "═".repeat(50),
        `Reason:     ${reason}`,
        `Iterations: ${s.iteration} / ${config.maxIterations}`,
        `Wall clock: ${formatDuration(elapsedMs)} / ${config.maxWallClockHours}h`,
        `Phases:     ${s.phasesCompleted.join(", ") || "none completed"}`,
        `Current:    ${s.currentPhase || "none"}`,
        `Rate limits: ${s.rateLimits.length}`,
        `Stalls:     ${s.stalls.length}`,
        formatBashStats(bashStats),
      ];

      if (s.lastVerification) {
        const v = s.lastVerification;
        const failed = v.checks.filter((c) => !c.passed);
        lines.push(`Last verification: ${v.phase} — ${v.allPassed ? "PASSED" : `FAILED (${failed.map((f) => f.name).join(", ")})`}`);
      }

      lines.push("═".repeat(50));
      return lines.join("\n");
    },

    buildStatusWidget(): string[] {
      const s = state.get();
      const elapsed = formatDuration(Date.now() - startTime);
      const phase = s.currentPhase || "-";
      const done = s.phasesCompleted.length;

      return [
        `otto | iter ${s.iteration}/${config.maxIterations} | ${elapsed} | phase: ${phase} | done: ${done}`,
      ];
    },
  };
}

function formatBashStats(stats: BashStats): string {
  const parts = [`Bash calls: ${stats.totalCalls}`];
  if (stats.totalCalls > 0) {
    parts.push(`total: ${formatDuration(stats.totalTimeMs)}`);
    parts.push(`timeouts: ${stats.timeouts}`);
  }
  if (stats.longestCall) {
    parts.push(`longest: ${formatDuration(stats.longestCall.durationMs)} (${stats.longestCall.cmd.slice(0, 60)})`);
  }
  return parts.join(" | ");
}
