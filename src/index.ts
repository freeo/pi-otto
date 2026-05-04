import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import type { OttoConfig } from "./types.js";
import { OttoLogger } from "./utils.js";
import { parseOttoConfig } from "./config.js";
import { StateManager } from "./state.js";
import { runPreflight, formatPreflightReport } from "./preflight.js";
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
}

let otto: OttoRuntime | null = null;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONITOR_SCRIPT = resolve(PKG_ROOT, "bin", "bash-monitor.ts");

export default function (pi: ExtensionAPI) {
  // --- /otto command ---
  pi.registerCommand("otto", {
    description: "Start Otto orchestration — reads OTTO_CONFIG.md, validates, and begins plan execution",
    args: [
      { name: "config", description: "Path to OTTO_CONFIG.md (default: planning/OTTO_CONFIG.md)", required: false },
    ],
    async execute(args: any, ctx: any) {
      const cwd = ctx.cwd;
      const configPath = (typeof args === "string" ? args.trim() : args?.config) || "planning/OTTO_CONFIG.md";
      const fullConfigPath = resolve(cwd, configPath);

      if (!existsSync(fullConfigPath)) {
        ctx.ui.notify(`Config not found: ${fullConfigPath}`, "error");
        return;
      }

      // Parse config
      let config: OttoConfig;
      try {
        config = parseOttoConfig(fullConfigPath);
      } catch (err) {
        ctx.ui.notify(`Config parse error: ${err}`, "error");
        return;
      }

      const stateDir = resolve(cwd, config.stateDir);
      const logger = new OttoLogger(stateDir);
      const state = new StateManager(stateDir);

      logger.info("Otto starting", { configPath, recovery: state.isRecovery() });

      // Pre-flight
      const allTools = pi.getAllTools().map((t: { name: string }) => t.name);
      const preflight = await runPreflight(config, state, logger, cwd, allTools);
      const report = formatPreflightReport(preflight);

      if (!preflight.passed) {
        logger.error("Pre-flight failed", { checks: preflight.checks });
        ctx.ui.notify(report, "error");
        return;
      }

      // Initialize runtime
      const rateLimit = createRateLimitHandler(config, state, logger);
      const bashGuard = createBashGuard(config, logger, MONITOR_SCRIPT);
      const stallDetector = createStallDetector(config, state, logger);
      const progress = createProgressTracker(config, state, logger, bashGuard);
      const health = createHealthWatchdog(config, state, logger, cwd);

      otto = { config, state, logger, rateLimit, bashGuard, stallDetector, progress, health, active: true };

      // Start health watchdog
      health.startPeriodicCheck(config.healthCheckInterval * 1000);

      // Status widget
      ctx.ui.setWidget("otto", progress.buildStatusWidget());

      // Build prompt
      const entryContent = readFileSync(resolve(cwd, config.entryPoint), "utf-8");
      let prompt = entryContent;

      if (state.isRecovery()) {
        const recovery = state.buildRecoveryContext();
        prompt = `${recovery}\n\n---\n\n${entryContent}`;
        logger.info("Injecting crash recovery context");
      }

      state.incrementIteration();
      logger.info("Dispatching plan", { iteration: state.get().iteration });

      // Send the plan prompt — LLM takes over from here
      pi.sendUserMessage(prompt);
    },
  });

  // --- /otto-check command (smoke test) ---
  pi.registerCommand("otto-check", {
    description: "Run Otto smoke test — exercises all components without starting plan execution",
    args: [
      { name: "config", description: "Path to OTTO_CONFIG.md (default: planning/OTTO_CONFIG.md)", required: false },
    ],
    async execute(args: any, ctx: any) {
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

      pi.sendMessage(report);
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
      otto.logger.info("Bash guard: wrapped command", { original: original.slice(0, 100) });
      event.input.command = wrapped;
    }
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

  // Track tool results for stall detection + rate limit detection
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (!otto?.active) return;

    const toolName = event.tool || "unknown";
    const output = extractText(event);

    // Bash tracking
    if (toolName === "bash" || toolName === "ctx_execute" || toolName === "ctx_batch_execute") {
      otto.bashGuard.recordEnd(event.toolCallId);
    }

    // Rate limit from subagent results — don't switch parent model, just log.
    // Sub-agents are separate sessions; switching parent model won't help them.
    if (toolName === "subagent" && output && otto.rateLimit.check(output)) {
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

    // Stall detection
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

      // Use "error"/"blocker" keywords so context-mode classifies this as P2 (High)
      // and preserves it through compaction.
      pi.sendMessage(
        `[OTTO ERROR — BLOCKER] Stall detected: ${stallStatus.reason}\n` +
        `Consecutive failures: ${stallStatus.consecutiveFailures}. ` +
        `Minutes since progress: ${Math.round(stallStatus.minutesSinceProgress)}.\n` +
        `This is a blocking error. Reassess your current approach. Try a different strategy.`,
      );
    }

    // Rate limit detection from non-subagent tool output
    if (toolName !== "subagent" && output && otto.rateLimit.check(output)) {
      await otto.rateLimit.handle(
        output,
        (model) => pi.setModel(model),
        (msg) => pi.sendMessage(`[OTTO ERROR — CONSTRAINT] ${msg}`),
      );
    }
  });

  // Rate limit detection from provider responses
  pi.on("after_provider_response", async (event: any, ctx: any) => {
    if (!otto?.active) return;

    const text = typeof event.error === "string" ? event.error : JSON.stringify(event.error || "");
    if (text && otto.rateLimit.check(text)) {
      await otto.rateLimit.handle(
        text,
        (model) => pi.setModel(model),
        (msg) => pi.sendMessage(`[OTTO ERROR — CONSTRAINT] ${msg}`),
      );
    }
  });

  // Turn end: persist state, check limits, update widget
  pi.on("turn_end", async (event: any, ctx: any) => {
    if (!otto?.active) return;

    otto.progress.onTurnEnd();

    ctx.ui?.setWidget?.("otto", otto.progress.buildStatusWidget());

    const clock = otto.progress.checkWallClock();
    if (clock.exceeded) {
      const summary = otto.progress.buildExitSummary(`Wall clock limit (${otto.config.maxWallClockHours}h) reached`);
      otto.logger.error("Wall clock exceeded");
      otto.state.setExit("wall_clock_exceeded");
      otto.health.stopPeriodicCheck();
      pi.sendMessage(`[OTTO ERROR — BLOCKER] ${summary}\nGracefully shutting down.`);
      ctx.shutdown?.();
      return;
    }

    const iter = otto.progress.checkIterationLimit();
    if (iter.exceeded) {
      const summary = otto.progress.buildExitSummary(`Iteration limit (${iter.max}) reached`);
      otto.logger.error("Iteration limit exceeded");
      otto.state.setExit("iteration_limit_exceeded");
      otto.health.stopPeriodicCheck();
      pi.sendMessage(`[OTTO ERROR — BLOCKER] ${summary}\nGracefully shutting down.`);
      ctx.shutdown?.();
      return;
    }
  });

  // Dev server health: check before sub-agent dispatch
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!otto?.active) return;
    if (event.tool !== "subagent") return;

    const report = await otto.health.checkAll();
    if (!report.allHealthy) {
      const dead = report.servers.filter((s: any) => !s.healthy).map((s: any) => s.name);
      otto.logger.warn(`Dead servers before subagent dispatch: ${dead.join(", ")}`);
      const restarted = await otto.health.restartDead();
      if (restarted.length > 0) {
        otto.logger.info(`Restarted servers: ${restarted.join(", ")}`);
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
