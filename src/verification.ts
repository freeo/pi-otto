import { Type, type Static } from "@sinclair/typebox";
import { spawn } from "child_process";
import type { VerificationResult, CheckResult } from "./types.js";
import { OttoLogger } from "./utils.js";
import { StateManager } from "./state.js";

export const CheckDefSchema = Type.Object({
  name: Type.String({ description: "Human-readable check name" }),
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: from config)", default: 120 })),
  expect_exit_0: Type.Optional(Type.Boolean({ description: "Require exit code 0 (default: true)", default: true })),
  expect_pattern: Type.Optional(Type.String({ description: "Regex pattern that must appear in stdout" })),
  reject_pattern: Type.Optional(Type.String({ description: "Regex pattern that must NOT appear in stdout" })),
});

export type CheckDef = Static<typeof CheckDefSchema>;

export const VerificationParams = Type.Object({
  phase: Type.String({ description: "Phase being verified (e.g. V0, V1)" }),
  checks: Type.Array(CheckDefSchema, { description: "List of checks to run" }),
});

export type VerificationInput = Static<typeof VerificationParams>;

export async function runVerification(
  input: VerificationInput,
  configTimeout: number,
  logger: OttoLogger,
  state: StateManager,
  cwd: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const results: CheckResult[] = [];

  for (const check of input.checks) {
    if (signal?.aborted) {
      results.push({ name: check.name, passed: false, output: "", error: "aborted", durationMs: 0 });
      continue;
    }
    const result = await runSingleCheck(check, configTimeout, cwd);
    results.push(result);
    logger.phased("info", input.phase, state.get().iteration, `check "${check.name}": ${result.passed ? "PASS" : "FAIL"}`);
  }

  const allPassed = results.every((r) => r.passed);
  const verification: VerificationResult = {
    phase: input.phase,
    timestamp: new Date().toISOString(),
    checks: results,
    allPassed,
  };

  state.setVerification(verification);
  return verification;
}

async function runSingleCheck(check: CheckDef, defaultTimeout: number, cwd: string): Promise<CheckResult> {
  const timeoutSec = check.timeout ?? defaultTimeout;
  const start = Date.now();

  try {
    const { exitCode, stdout, stderr } = await execWithTimeout(check.command, timeoutSec * 1000, cwd);
    const combined = stdout + stderr;
    const durationMs = Date.now() - start;

    let passed = true;
    let error: string | null = null;

    if (check.expect_exit_0 !== false && exitCode !== 0) {
      passed = false;
      error = `exit code ${exitCode}`;
    }

    if (passed && check.expect_pattern) {
      const re = new RegExp(check.expect_pattern, "i");
      if (!re.test(combined)) {
        passed = false;
        error = `expected pattern /${check.expect_pattern}/ not found`;
      }
    }

    if (passed && check.reject_pattern) {
      const re = new RegExp(check.reject_pattern, "i");
      if (re.test(combined)) {
        passed = false;
        error = `rejected pattern /${check.reject_pattern}/ found in output`;
      }
    }

    const output = truncateOutput(combined, 2000);
    return { name: check.name, passed, output, error, durationMs };
  } catch (err) {
    return {
      name: check.name,
      passed: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

function execWithTimeout(
  cmd: string,
  timeoutMs: number,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn("bash", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, 5000);
      } catch {}
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 50_000) stdout = stdout.slice(-50_000);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000);
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ exitCode: 124, stdout, stderr: stderr + "\n[otto] killed: timeout" });
      } else {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: err.message });
    });
  });
}

function truncateOutput(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2) - 20;
  return text.slice(0, half) + `\n... [truncated ${text.length - maxLen} chars] ...\n` + text.slice(-half);
}

export function formatVerificationResult(result: VerificationResult): string {
  const lines = [`VERIFICATION: ${result.phase} — ${result.allPassed ? "ALL PASSED" : "FAILED"}`];
  for (const check of result.checks) {
    const icon = check.passed ? "✓" : "✗";
    const err = check.error ? ` (${check.error})` : "";
    lines.push(`  [${icon}] ${check.name} [${check.durationMs}ms]${err}`);
    if (!check.passed && check.output) {
      const preview = check.output.split("\n").slice(-5).join("\n");
      lines.push(`      ${preview.replace(/\n/g, "\n      ")}`);
    }
  }
  return lines.join("\n");
}
