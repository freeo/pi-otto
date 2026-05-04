import { existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";
import type { OttoConfig } from "./types.js";
import { OttoLogger, checkPort, isRateLimitSignal, wrapWithMonitor, shouldSkipGuard } from "./utils.js";
import { StateManager } from "./state.js";
import { createStallDetector } from "./guards.js";

export interface SmokeResult {
  passed: boolean;
  checks: SmokeCheck[];
  durationMs: number;
}

export interface SmokeCheck {
  name: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

export async function runSmokeTest(
  config: OttoConfig,
  cwd: string,
  monitorScript: string,
  allToolNames: string[],
): Promise<SmokeResult> {
  const start = Date.now();
  const checks: SmokeCheck[] = [];

  checks.push(checkConfigParsed(config));
  checks.push(checkEntryPoint(config, cwd));
  checks.push(await checkBashMonitor(monitorScript, cwd));
  checks.push(checkSqzCompatibility(monitorScript));
  checks.push(checkRateLimitDetection());
  checks.push(checkStallDetection(config));
  checks.push(await checkStatePersistence(config, cwd));
  checks.push(checkSubagentTool(allToolNames));
  checks.push(checkVerificationTool(allToolNames));

  for (const server of config.servers) {
    checks.push(await checkDevServer(server.name, server.port));
  }

  if (config.mainProvider) {
    checks.push(await checkProviderReachable("main", config.mainProvider, config.mainModel));
  }
  if (config.fallbackFreeModel) {
    checks.push(await checkProviderReachable("fallback-free", config.fallbackFreeProvider, config.fallbackFreeModel));
  }
  if (config.fallbackPaidModel) {
    checks.push(await checkProviderReachable("fallback-paid", config.fallbackPaidProvider, config.fallbackPaidModel));
  }

  return { passed: checks.every((c) => c.passed), checks, durationMs: Date.now() - start };
}

function timed(name: string, fn: () => { passed: boolean; message: string }): SmokeCheck {
  const t0 = Date.now();
  try {
    const result = fn();
    return { name, ...result, durationMs: Date.now() - t0 };
  } catch (err) {
    return { name, passed: false, message: `threw: ${err}`, durationMs: Date.now() - t0 };
  }
}

async function timedAsync(name: string, fn: () => Promise<{ passed: boolean; message: string }>): Promise<SmokeCheck> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { name, ...result, durationMs: Date.now() - t0 };
  } catch (err) {
    return { name, passed: false, message: `threw: ${err}`, durationMs: Date.now() - t0 };
  }
}

function checkConfigParsed(config: OttoConfig): SmokeCheck {
  return timed("Config parsing", () => {
    const required = [config.entryPoint, config.mainProvider, config.mainModel];
    const missing = required.filter((v) => !v);
    if (missing.length > 0) {
      return { passed: false, message: `missing required values` };
    }
    return {
      passed: true,
      message: `${config.mainProvider}/${config.mainModel} | ${config.servers.length} servers | max ${config.maxIterations} iterations`,
    };
  });
}

function checkEntryPoint(config: OttoConfig, cwd: string): SmokeCheck {
  return timed("Entry point", () => {
    const full = resolve(cwd, config.entryPoint);
    if (!existsSync(full)) {
      return { passed: false, message: `${config.entryPoint} not found` };
    }
    const content = readFileSync(full, "utf-8");
    const lines = content.split("\n").length;
    return { passed: true, message: `${config.entryPoint} (${lines} lines)` };
  });
}

async function checkBashMonitor(monitorScript: string, cwd: string): Promise<SmokeCheck> {
  return timedAsync("Bash monitor", async () => {
    if (!existsSync(monitorScript)) {
      return { passed: false, message: `${monitorScript} not found` };
    }

    try {
      const result = execSync(
        `bun run ${monitorScript} 5 10 'echo "otto-smoke-ok"'`,
        { cwd, timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      if (result.includes("otto-smoke-ok")) {
        return { passed: true, message: "monitor executed, output captured, exit code propagated" };
      }
      return { passed: false, message: `unexpected output: ${result.slice(0, 100)}` };
    } catch (err: any) {
      return { passed: false, message: `execution failed: ${err.message?.slice(0, 100)}` };
    }
  });
}

function checkSqzCompatibility(monitorScript: string): SmokeCheck {
  return timed("sqz compatibility", () => {
    const wrapped = wrapWithMonitor("git status", 90, 600, monitorScript);

    if (!wrapped.includes("OTTO_GUARD")) {
      return { passed: false, message: "wrapped command missing OTTO_GUARD marker" };
    }
    if (!wrapped.includes(";")) {
      return { passed: false, message: "wrapped command not compound (sqz won't skip)" };
    }
    if (!shouldSkipGuard(wrapped)) {
      return { passed: false, message: "shouldSkipGuard fails to detect already-wrapped command" };
    }

    const alreadySqzd = "git status 2>&1 | sqz compress --cmd git";
    const wrappedSqz = wrapWithMonitor(alreadySqzd, 90, 600, monitorScript);
    if (!wrappedSqz.includes("sqz compress")) {
      return { passed: false, message: "sqz-wrapped command lost sqz pipe after monitor wrapping" };
    }

    return { passed: true, message: "OTTO_GUARD present, compound for sqz skip, double-wrap safe" };
  });
}

function checkRateLimitDetection(): SmokeCheck {
  return timed("Rate limit detection", () => {
    const positives = [
      "Error 429: Too many requests",
      "rate limit exceeded, try again in 3600 seconds",
      "quota exceeded for model",
      "Request rate limit reached",
    ];
    const negatives = [
      "Successfully processed 429 records",
      "Port 4290 is open",
      "HTTP 200 OK",
    ];

    for (const text of positives) {
      if (!isRateLimitSignal(text)) {
        return { passed: false, message: `false negative: "${text}"` };
      }
    }
    for (const text of negatives) {
      if (isRateLimitSignal(text)) {
        return { passed: false, message: `false positive: "${text}"` };
      }
    }
    return { passed: true, message: `${positives.length} positives, ${negatives.length} negatives — all correct` };
  });
}

function checkStallDetection(config: OttoConfig): SmokeCheck {
  return timed("Stall detection", () => {
    const logger = new OttoLogger(resolve("/tmp", "otto-smoke-test"));
    const stateDir = resolve("/tmp", "otto-smoke-state-" + Date.now());
    const state = new StateManager(stateDir);
    const detector = createStallDetector(config, state, logger);

    for (let i = 0; i < config.stallMaxRetries + 1; i++) {
      detector.recordToolResult("bash", false, "Error: command not found");
    }
    const status = detector.checkForStall();

    try { unlinkSync(join(stateDir, "state.json")); } catch {}
    try { require("fs").rmdirSync(stateDir); } catch {}

    if (!status.stalled) {
      return { passed: false, message: `expected stall after ${config.stallMaxRetries + 1} repeated failures` };
    }
    return { passed: true, message: `stall triggered after ${config.stallMaxRetries + 1} repeated failures` };
  });
}

async function checkStatePersistence(config: OttoConfig, cwd: string): Promise<SmokeCheck> {
  return timedAsync("State persistence", async () => {
    const testDir = resolve(cwd, config.stateDir, "smoke-test");
    try {
      const state = new StateManager(testDir);
      state.setPhase("SMOKE_TEST");
      state.completePhase("SMOKE_TEST");

      const reloaded = new StateManager(testDir);
      const s = reloaded.get();

      if (!s.phasesCompleted.includes("SMOKE_TEST")) {
        return { passed: false, message: "state not persisted across reload" };
      }

      try { unlinkSync(join(testDir, "state.json")); } catch {}
      try { require("fs").rmdirSync(testDir); } catch {}

      return { passed: true, message: "write → reload → verify round-trip OK" };
    } catch (err) {
      return { passed: false, message: `persistence failed: ${err}` };
    }
  });
}

function checkSubagentTool(allToolNames: string[]): SmokeCheck {
  return timed("pi-subagents", () => {
    const found = allToolNames.includes("subagent");
    return {
      passed: found,
      message: found ? "subagent tool registered" : "subagent tool NOT found — pi-subagents not loaded?",
    };
  });
}

function checkVerificationTool(allToolNames: string[]): SmokeCheck {
  return timed("verification_check tool", () => {
    const found = allToolNames.includes("verification_check");
    return {
      passed: found,
      message: found ? "verification_check tool registered" : "verification_check NOT registered — otto initialization failed?",
    };
  });
}

async function checkDevServer(name: string, port: number): Promise<SmokeCheck> {
  return timedAsync(`Server: ${name}`, async () => {
    const healthy = await checkPort(port);
    return {
      passed: healthy,
      message: healthy ? `port ${port} responding` : `port ${port} not responding`,
    };
  });
}

async function checkProviderReachable(
  label: string,
  provider: string,
  model: string,
): Promise<SmokeCheck> {
  return timedAsync(`Provider: ${label}`, async () => {
    const envMap: Record<string, string[]> = {
      openrouter: ["OPENROUTER_API_KEY"],
      anthropic: ["ANTHROPIC_API_KEY"],
      google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
    };

    const envKeys = envMap[provider] || [`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
    const hasKey = envKeys.some((k) => !!process.env[k]);

    if (!hasKey) {
      return { passed: false, message: `${provider}/${model} — no API key (checked: ${envKeys.join(", ")})` };
    }

    return { passed: true, message: `${provider}/${model} — key present` };
  });
}

export function formatSmokeReport(result: SmokeResult): string {
  const lines = [
    "",
    "╔══════════════════════════════════════════════════╗",
    "║           OTTO SMOKE TEST                        ║",
    "╚══════════════════════════════════════════════════╝",
    "",
  ];

  const maxName = Math.max(...result.checks.map((c) => c.name.length));

  for (const check of result.checks) {
    const icon = check.passed ? "✓" : "✗";
    const pad = " ".repeat(maxName - check.name.length);
    const time = `${check.durationMs}ms`.padStart(6);
    lines.push(`  [${icon}] ${check.name}${pad}  ${time}  ${check.message}`);
  }

  const passed = result.checks.filter((c) => c.passed).length;
  const total = result.checks.length;

  lines.push("");
  lines.push(`  ${passed}/${total} checks passed in ${result.durationMs}ms`);
  lines.push("");

  if (result.passed) {
    lines.push("  ALL GREEN — safe to run /otto");
  } else {
    const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
    lines.push(`  FAILED: ${failed.join(", ")}`);
    lines.push("  Fix issues above before running /otto");
  }

  lines.push("");
  return lines.join("\n");
}
