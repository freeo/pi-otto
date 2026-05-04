#!/usr/bin/env bun
import { spawn } from "child_process";

const silenceTimeoutSec = parseInt(process.argv[2] || "90", 10);
const hardTimeoutSec = parseInt(process.argv[3] || "600", 10);
const cmd = process.argv.slice(4).join(" ");

if (!cmd) {
  process.stderr.write("[otto-guard] No command provided\n");
  process.exit(127);
}

const silenceMs = silenceTimeoutSec * 1000;
const hardMs = hardTimeoutSec * 1000;
let lastByteAt = Date.now();
const startedAt = Date.now();
let exited = false;

const child = spawn("bash", ["-c", cmd], {
  stdio: ["inherit", "pipe", "pipe"],
});

function onData(chunk: Buffer, target: NodeJS.WriteStream) {
  lastByteAt = Date.now();
  target.write(chunk);
}

child.stdout?.on("data", (chunk: Buffer) => onData(chunk, process.stdout));
child.stderr?.on("data", (chunk: Buffer) => onData(chunk, process.stderr));

const watchdog = setInterval(() => {
  if (exited) return;

  const silenceElapsed = Date.now() - lastByteAt;
  const totalElapsed = Date.now() - startedAt;

  if (silenceElapsed > silenceMs) {
    process.stderr.write(
      `\n[otto-guard] Process silent for ${Math.round(silenceElapsed / 1000)}s (threshold: ${silenceTimeoutSec}s) — killing\n`,
    );
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 5000);
    clearInterval(watchdog);
    return;
  }

  if (totalElapsed > hardMs) {
    process.stderr.write(
      `\n[otto-guard] Hard timeout ${hardTimeoutSec}s reached — killing\n`,
    );
    try { child.kill("SIGKILL"); } catch {}
    clearInterval(watchdog);
    return;
  }
}, 5000);

child.on("close", (code: number | null) => {
  exited = true;
  clearInterval(watchdog);
  process.exit(code ?? 1);
});

child.on("error", (err: Error) => {
  exited = true;
  clearInterval(watchdog);
  process.stderr.write(`[otto-guard] Spawn error: ${err.message}\n`);
  process.exit(127);
});
