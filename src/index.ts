import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import type { OttoConfig } from "./types.js";
import { OttoLogger } from "./utils.js";
import { parseOttoConfig } from "./config.js";
import { StateManager } from "./state.js";
import { VerificationParams, runVerification, formatVerificationResult } from "./verification.js";
import { createRateLimitHandler, type RateLimitHandler } from "./rate-limit.js";
import { createBashGuard, createStallDetector, type BashGuard, type StallDetector } from "./guards.js";
import { createProgressTracker, type ProgressTracker } from "./progress.js";
import { runSmokeTest, formatSmokeReport } from "./smoke.js";
import { createHealthWatchdog, type HealthWatchdog } from "./health.js";

interface OttoRuntime {
  config: OttoConfig;
  state: StateManager;
  logger: OttoLogger;
  rateLimit: RateLimitHandler;
  bashGuard: BashGuard;
  stallDetector: StallDetector;
  progress: ProgressTracker;
  health: HealthWatchdog;
  active: boolean;
  activeSubagents: number;
  lastEvent: string;
  setWidget: (lines: string[]) => void;
}

let otto: OttoRuntime | null = null;

function setActivity(event: string) {
  if (!otto) return;
  otto.lastEvent = event;
  otto.logger.info(event);
  refreshWidget();
}

function refreshWidget() {
  if (!otto) return;
  const s = otto.state.get();
  const clock = otto.progress.checkWallClock();
  const bashStats = otto.bashGuard.getStats();
  const phase = s.currentPhase || "-";
  const done = s.phasesCompleted.length;
  const tier = otto.rateLimit.currentTier();

  const line1Parts = [
    "otto",
    `iter ${s.iteration}/${otto.config.maxIterations}`,
    clock.elapsed,
    `phase: ${phase}`,
    `done: ${done}`,
  ];
  if (otto.activeSubagents > 0) line1Parts.push(`agents: ${otto.activeSubagents}`);
  if (bashStats.totalCalls > 0) line1Parts.push(`bash: ${bashStats.totalCalls}`);
  if (tier !== "main") line1Parts.push(`provider: ${tier}`);
  if (s.rateLimits.length > 0) line1Parts.push(`ratelimits: ${s.rateLimits.length}`);
  if (s.stalls.length > 0) line1Parts.push(`stalls: ${s.stalls.length}`);

  const lines = [line1Parts.join(" | ")];
  if (otto.lastEvent) {
    lines.push(`  last: ${otto.lastEvent}`);
  }

  otto.setWidget(lines);
}

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONITOR_SCRIPT = resolve(PKG_ROOT, "bin", "bash-monitor.ts");

export default function (pi: ExtensionAPI) {
  // --- /otto command ---
  pi.registerCommand("otto", {
    description: "Start Otto orchestration — reads OTTO_CONFIG.md, validates, and begins plan execution",
    args: [
      { name: "config", description: "Path to OTTO_CONFIG.md (default: planning/OTTO_CONFIG.md)", required: false },
    ],
    async handler(args: any, ctx: any) {
      const cwd = ctx.cwd;
      const configPath = (typeof args === "string" ? args.trim() : args?.config) || "planning/OTTO_CONFIG.md";
      const fullConfigPath = resolve(cwd, configPath);

      ctx.ui.notify("Otto: loading config...", "info");

      if (!existsSync(fullConfigPath)) {
        ctx.ui.notify(`Config not found: ${fullConfigPath}`, "error");
        return;
      }

      let config: OttoConfig;
      try {
        config = parseOttoConfig(fullConfigPath);
      } catch (err) {
        ctx.ui.notify(`Config parse error: ${err}`, "error");
        return;
      }

      ctx.ui.notify(`Otto: config loaded (${config.mainProvider}/${config.mainModel}). Running checks...`, "info");

      const stateDir = resolve(cwd, config.stateDir);
      const logger = new OttoLogger(stateDir);
      const state = new StateManager(stateDir);

      logger.info("Otto starting", { configPath, recovery: state.isRecovery() });

      const allTools = pi.getAllTools().map((t: { name: string }) => t.name);
      const checks = await runSmokeTest(config, cwd, MONITOR_SCRIPT, allTools);
      const report = formatSmokeReport(checks);

      if (!checks.passed) {
        logger.error("Checks failed", { checks: checks.checks });
        ctx.ui.notify(report, "error");
        return;
      }

      ctx.ui.notify("Otto: all checks passed. Initializing runtime...", "info");

      const rateLimit = createRateLimitHandler(config, state, logger);
      const bashGuard = createBashGuard(config, logger, MONITOR_SCRIPT);
      const stallDetector = createStallDetector(config, state, logger);
      const progress = createProgressTracker(config, state, logger, bashGuard);
      const health = createHealthWatchdog(config, state, logger, cwd);
      const setWidgetFn = (lines: string[]) => ctx.ui?.setWidget?.("otto", lines);

      otto = {
        config, state, logger, rateLimit, bashGuard, stallDetector, progress, health,
        active: true, activeSubagents: 0, lastEvent: "initializing",
        setWidget: setWidgetFn,
      };

      health.startPeriodicCheck(config.healthCheckInterval * 1000);
      refreshWidget();

      const entryContent = readFileSync(resolve(cwd, config.entryPoint), "utf-8");
      let prompt = entryContent;

      if (state.isRecovery()) {
        const recovery = state.buildRecoveryContext();
        prompt = `${recovery}\n\n---\n\n${entryContent}`;
        setActivity("crash recovery context injected");
      }

      state.incrementIteration();

      const mode = state.isRecovery() ? "recovery" : "fresh start";
      ctx.ui.notify(`Otto: ${mode}, iteration ${state.get().iteration}. Dispatching plan prompt...`, "info");
      setActivity("plan prompt dispatched");

      pi.sendUserMessage(prompt);
    },
  });

  // --- /otto-check command (smoke test) ---
  pi.registerCommand("otto-check", {
    description: "Run Otto smoke test — exercises all components without starting plan execution",
    args: [
      { name: "config", description: "Path to OTTO_CONFIG.md (default: planning/OTTO_CONFIG.md)", required: false },
    ],
    async handler(args: any, ctx: any) {
      const cwd = ctx.cwd;
      const configPath = (typeof args === "string" ? args.trim() : args?.config) || "planning/OTTO_CONFIG.md";
      const fullConfigPath = resolve(cwd, configPath);

      if (!existsSync(fullConfigPath)) {
        ctx.ui.notify(`Config not found: ${fullConfigPath}`, "error");
        return;
      }

      let config: OttoConfig;
      try {
        config = parseOttoConfig(fullConfigPath);
      } catch (err) {
        ctx.ui.notify(`Config parse error: ${err}`, "error");
        return;
      }

      ctx.ui.notify("Running Otto smoke test...", "info");

      const allTools = pi.getAllTools().map((t: { name: string }) => t.name);
      const result = await runSmokeTest(config, cwd, MONITOR_SCRIPT, allTools);
      const report = formatSmokeReport(result);

      ctx.ui.notify(report, result.passed ? "info" : "error");
    },
  });

  // --- verification_check tool ---
  pi.registerTool({
    name: "verification_check",
    description: `Run plan-defined verification checks. Each check is a shell command with pass/fail criteria.
Every check runs in isolation with timeout and error handling — a failing check never crashes the session.
Returns structured results per check. Use this to verify phase completion, run gate tests, or validate state.`,
    parameters: VerificationParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!otto) {
        return {
          content: [{ type: "text", text: "Otto not initialized. Run /otto first." }],
          details: { error: "not_initialized" },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Running ${params.checks.length} checks for ${params.phase}...` }] });

      const result = await runVerification(params, otto.config.verificationTimeout, otto.logger, otto.state, ctx.cwd, signal);
      const formatted = formatVerificationResult(result);

      return {
        content: [{ type: "text", text: formatted }],
        details: { phase: params.phase, allPassed: result.allPassed, checkCount: result.checks.length },
      };
    },
  });

  // --- Event handlers ---

  // Bash guard: wrap commands with monitor (output staleness + hard timeout).
  // Uses event.input.command (pi's actual property name, matching pi-sqz pattern).
  // Mutates directly — sqz does the same, handlers chain by mutation order.
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!otto?.active) return;
    if (event.tool !== "bash" || !event.input?.command) return;

    const original = event.input.command;
    const wrapped = otto.bashGuard.wrapCommand(original);
    otto.bashGuard.recordStart(event.toolCallId, original);

    if (wrapped !== original) {
      event.input.command = wrapped;
    }
    setActivity(`bash: ${original.slice(0, 80)}`);
  });

  // Guard ctx_execute and ctx_batch_execute (context-mode tools that bypass bash).
  // These run shell commands in sandboxed subprocesses — without guarding, LLM can
  // run unbounded commands through context-mode instead of bash.
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!otto?.active) return;
    if (event.tool !== "ctx_execute" && event.tool !== "ctx_batch_execute") return;

    const cmd = event.input?.code || event.input?.command || "";
    if (cmd) {
      otto.bashGuard.recordStart(event.toolCallId, cmd);
      otto.stallDetector.recordToolResult(event.tool, true, "");
    }
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!otto?.active) return;

    const toolName = event.tool || "unknown";
    const output = extractText(event);

    if (toolName === "bash" || toolName === "ctx_execute" || toolName === "ctx_batch_execute") {
      otto.bashGuard.recordEnd(event.toolCallId);
    }

    if (toolName === "subagent") {
      otto.activeSubagents = Math.max(0, otto.activeSubagents - 1);
      const status = event.error ? "failed" : "completed";
      setActivity(`subagent ${status} (${otto.activeSubagents} active)`);

      if (output && otto.rateLimit.check(output)) {
        otto.logger.warn("Rate limit detected in subagent result (not switching parent model)", {
          output: output.slice(0, 200),
        });
        otto.state.addRateLimit({
          timestamp: new Date().toISOString(),
          provider: "subagent",
          message: output.slice(0, 500),
          waitSeconds: 0,
        });
        return;
      }
    }

    const success = !event.error && event.exitCode !== 1;
    otto.stallDetector.recordToolResult(toolName, success, output);

    const stallStatus = otto.stallDetector.checkForStall();
    if (stallStatus.stalled) {
      otto.state.addStall({
        timestamp: new Date().toISOString(),
        description: stallStatus.reason || "unknown stall",
        resolution: "injecting recovery prompt",
      });
      otto.stallDetector.reset();
      setActivity(`STALL detected: ${stallStatus.reason?.slice(0, 60)}`);

      pi.sendUserMessage(
        `[OTTO ERROR — BLOCKER] Stall detected: ${stallStatus.reason}\n` +
        `Consecutive failures: ${stallStatus.consecutiveFailures}. ` +
        `Minutes since progress: ${Math.round(stallStatus.minutesSinceProgress)}.\n` +
        `This is a blocking error. Reassess your current approach. Try a different strategy.`,
      );
    }

    if (toolName !== "subagent" && output && otto.rateLimit.check(output)) {
      setActivity(`rate limit detected on ${otto.rateLimit.currentTier()}`);
      await otto.rateLimit.handle(
        output,
        (model) => pi.setModel(model),
        (msg) => pi.sendUserMessage(`[OTTO ERROR — CONSTRAINT] ${msg}`),
      );
    }
  });

  pi.on("after_provider_response", async (event: any, ctx: any) => {
    if (!otto?.active) return;

    const text = typeof event.error === "string" ? event.error : JSON.stringify(event.error || "");
    if (text && otto.rateLimit.check(text)) {
      setActivity(`provider rate limit: ${text.slice(0, 60)}`);
      await otto.rateLimit.handle(
        text,
        (model) => pi.setModel(model),
        (msg) => pi.sendUserMessage(`[OTTO ERROR — CONSTRAINT] ${msg}`),
      );
    }
  });

  pi.on("turn_end", async (event: any, ctx: any) => {
    if (!otto?.active) return;

    otto.progress.onTurnEnd();
    refreshWidget();

    const clock = otto.progress.checkWallClock();
    if (clock.exceeded) {
      const summary = otto.progress.buildExitSummary(`Wall clock limit (${otto.config.maxWallClockHours}h) reached`);
      setActivity("SHUTDOWN: wall clock exceeded");
      otto.state.setExit("wall_clock_exceeded");
      otto.health.stopPeriodicCheck();
      pi.sendUserMessage(`[OTTO ERROR — BLOCKER] ${summary}\nGracefully shutting down.`);
      ctx.shutdown?.();
      return;
    }

    const iter = otto.progress.checkIterationLimit();
    if (iter.exceeded) {
      const summary = otto.progress.buildExitSummary(`Iteration limit (${iter.max}) reached`);
      setActivity("SHUTDOWN: iteration limit exceeded");
      otto.state.setExit("iteration_limit_exceeded");
      otto.health.stopPeriodicCheck();
      pi.sendUserMessage(`[OTTO ERROR — BLOCKER] ${summary}\nGracefully shutting down.`);
      ctx.shutdown?.();
      return;
    }
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!otto?.active) return;
    if (event.tool !== "subagent") return;

    otto.activeSubagents++;
    const agentName = event.input?.agent || event.input?.name || "unknown";
    setActivity(`subagent dispatched: ${agentName} (${otto.activeSubagents} active)`);

    const report = await otto.health.checkAll();
    if (!report.allHealthy) {
      const dead = report.servers.filter((s: any) => !s.healthy).map((s: any) => s.name);
      otto.logger.warn(`Dead servers before subagent dispatch: ${dead.join(", ")}`);
      const restarted = await otto.health.restartDead();
      if (restarted.length > 0) {
        setActivity(`restarted servers: ${restarted.join(", ")}`);
      }
    }
  });

  // Session shutdown: exit summary
  pi.on("session_shutdown", async (event: any, ctx: any) => {
    if (!otto) return;
    otto.health.stopPeriodicCheck();
    if (!otto.state.get().exitReason) {
      otto.state.setExit("session_shutdown");
    }
    const summary = otto.progress.buildExitSummary(otto.state.get().exitReason || "session_shutdown");
    otto.logger.info(summary);
  });

  // Session start: detect recovery
  pi.on("session_start", async (event: any, ctx: any) => {
    if (event.reason === "resume" && otto) {
      otto.logger.info("Session resumed — crash recovery context available via /otto");
    }
  });
}

function extractText(event: any): string {
  if (!event) return "";
  if (typeof event.text === "string") return event.text;
  if (event.content && Array.isArray(event.content)) {
    return event.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join("\n");
  }
  if (typeof event.output === "string") return event.output;
  return "";
}
