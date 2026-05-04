import { readFileSync } from "fs";
import type { OttoConfig, ServerConfig } from "./types.js";

export function parseOttoConfig(filePath: string): OttoConfig {
  const raw = readFileSync(filePath, "utf-8");
  const values = extractKeyValues(raw);

  const servers = parseServers(values);

  return {
    entryPoint: req(values, "ENTRY_POINT"),
    runLog: val(values, "RUN_LOG", "planning/RUN_LOG.md"),
    stateDir: val(values, "STATE_DIR", ".pi-otto"),

    mainProvider: req(values, "MAIN_PROVIDER"),
    mainModel: req(values, "MAIN_MODEL"),
    mainThinking: val(values, "MAIN_THINKING", "high"),

    fallbackFreeProvider: val(values, "FALLBACK_FREE_PROVIDER", ""),
    fallbackFreeModel: val(values, "FALLBACK_FREE_MODEL", ""),
    fallbackPaidProvider: val(values, "FALLBACK_PAID_PROVIDER", ""),
    fallbackPaidModel: val(values, "FALLBACK_PAID_MODEL", ""),

    maxIterations: num(values, "MAX_ITERATIONS", 15),
    maxWallClockHours: num(values, "MAX_WALL_CLOCK_HOURS", 12),
    stallThresholdMinutes: num(values, "STALL_THRESHOLD_MINUTES", 20),
    stallMaxRetries: num(values, "STALL_MAX_RETRIES", 3),
    bashSilenceTimeout: num(values, "BASH_SILENCE_TIMEOUT", 90),
    bashHardTimeout: num(values, "BASH_HARD_TIMEOUT", 600),

    servers,
    healthCheckInterval: num(values, "HEALTH_CHECK_INTERVAL", 60),

    verificationTimeout: num(values, "VERIFICATION_TIMEOUT", 120),
    maxReverification: num(values, "MAX_REVERIFICATION", 2),
  };
}

function extractKeyValues(md: string): Map<string, string> {
  const kv = new Map<string, string>();
  const codeBlocks = md.match(/```[\s\S]*?```/g) || [];
  for (const block of codeBlocks) {
    const lines = block.replace(/```\w*/g, "").trim().split("\n");
    for (const line of lines) {
      const match = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (match) kv.set(match[1].trim(), match[2].trim());
    }
  }
  return kv;
}

function parseServers(values: Map<string, string>): ServerConfig[] {
  const servers: ServerConfig[] = [];
  const portKeys = [...values.keys()].filter((k) => k.endsWith("_PORT"));
  for (const pk of portKeys) {
    const prefix = pk.replace(/_PORT$/, "");
    const port = parseInt(values.get(pk) || "0", 10);
    const cmd = values.get(`${prefix}_CMD`) || "";
    if (port > 0 && cmd) {
      servers.push({ name: prefix.toLowerCase(), port, cmd });
    }
  }
  return servers;
}

function req(kv: Map<string, string>, key: string): string {
  const v = kv.get(key);
  if (!v) throw new Error(`OTTO_CONFIG missing required key: ${key}`);
  return v;
}

function val(kv: Map<string, string>, key: string, fallback: string): string {
  return kv.get(key) || fallback;
}

function num(kv: Map<string, string>, key: string, fallback: number): number {
  const v = kv.get(key);
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}
