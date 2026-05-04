import { existsSync, readFileSync } from "fs";
import type { OttoConfig, PreflightResult, PreflightCheck } from "./types.js";
import { checkPort, spawnBackground, waitForPort, OttoLogger } from "./utils.js";
import { StateManager } from "./state.js";

export async function runPreflight(
  config: OttoConfig,
  state: StateManager,
  logger: OttoLogger,
  cwd: string,
  allToolNames: string[],
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  checks.push(checkFile("Entry point", config.entryPoint, cwd));
  checks.push(checkFile("Run log dir", config.runLog.replace(/\/[^/]+$/, ""), cwd));

  checks.push(checkProvider("Main provider", config.mainProvider, config.mainModel));

  if (config.fallbackFreeProvider) {
    checks.push(checkProvider("Fallback (free)", config.fallbackFreeProvider, config.fallbackFreeModel));
  }
  if (config.fallbackPaidProvider) {
    checks.push(checkProvider("Fallback (paid)", config.fallbackPaidProvider, config.fallbackPaidModel));
  }

  checks.push(checkToolAvailable("pi-subagents", "subagent", allToolNames));

  for (const server of config.servers) {
    const serverCheck = await checkServer(server.name, server.port, server.cmd, cwd, state, logger);
    checks.push(serverCheck);
  }

  if (state.isRecovery()) {
    const s = state.get();
    checks.push({
      name: "Crash recovery",
      passed: true,
      message: `Recovering from iteration ${s.iteration}, phase ${s.currentPhase || "unknown"}. ${s.phasesCompleted.length} phases done.`,
    });
    logger.info("Crash recovery detected", { iteration: s.iteration, phase: s.currentPhase });
  }

  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

function checkFile(label: string, path: string, cwd: string): PreflightCheck {
  const full = path.startsWith("/") ? path : `${cwd}/${path}`;
  const exists = existsSync(full);
  return {
    name: label,
    passed: exists,
    message: exists ? `${path} found` : `${path} NOT FOUND`,
  };
}

function checkProvider(label: string, provider: string, model: string): PreflightCheck {
  const envMap: Record<string, string[]> = {
    openrouter: ["OPENROUTER_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
  };

  const envKeys = envMap[provider] || [`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
  const found = envKeys.some((k) => !!process.env[k]);

  if (provider === "opencode-go") {
    const hasAny = found || !!process.env["OPENCODE_API_KEY"];
    return {
      name: label,
      passed: hasAny,
      message: hasAny ? `${provider}/${model} — key found` : `${provider}/${model} — no API key (checked: ${envKeys.join(", ")})`,
    };
  }

  return {
    name: label,
    passed: found,
    message: found ? `${provider}/${model} — key found` : `${provider}/${model} — no API key (checked: ${envKeys.join(", ")})`,
  };
}

function checkToolAvailable(extName: string, toolName: string, allToolNames: string[]): PreflightCheck {
  const found = allToolNames.includes(toolName);
  return {
    name: `Extension: ${extName}`,
    passed: found,
    message: found ? `tool "${toolName}" registered` : `tool "${toolName}" NOT found — is ${extName} installed?`,
  };
}

async function checkServer(
  name: string,
  port: number,
  cmd: string,
  cwd: string,
  state: StateManager,
  logger: OttoLogger,
): Promise<PreflightCheck> {
  const alive = await checkPort(port);
  if (alive) {
    state.updateServer(name, { port, lastHealthy: new Date().toISOString() });
    return { name: `Server: ${name}`, passed: true, message: `port ${port} healthy` };
  }

  logger.info(`Server ${name} not responding on port ${port}, starting...`);
  try {
    const child = spawnBackground(cmd, cwd);
    const pid = child.pid || null;
    state.updateServer(name, { pid, port, restarts: (state.get().devServers[name]?.restarts || 0) + 1 });

    const ready = await waitForPort(port, 30_000);
    if (ready) {
      state.updateServer(name, { lastHealthy: new Date().toISOString() });
      return { name: `Server: ${name}`, passed: true, message: `started on port ${port} (pid ${pid})` };
    }
    return { name: `Server: ${name}`, passed: false, message: `started but port ${port} not responding after 30s` };
  } catch (err) {
    return { name: `Server: ${name}`, passed: false, message: `failed to start: ${err}` };
  }
}

export function formatPreflightReport(result: PreflightResult): string {
  const lines = ["OTTO PRE-FLIGHT CHECKLIST", "─".repeat(40)];
  for (const check of result.checks) {
    const icon = check.passed ? "✓" : "✗";
    lines.push(`  [${icon}] ${check.name}: ${check.message}`);
  }
  lines.push("─".repeat(40));
  lines.push(result.passed ? "ALL CHECKS PASSED — starting execution" : "PRE-FLIGHT FAILED — fix issues above");
  return lines.join("\n");
}
