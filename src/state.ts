import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { OttoState, VerificationResult, RateLimitEntry, StallEntry, ServerStateEntry } from "./types.js";

const EMPTY_STATE: OttoState = {
  iteration: 0,
  turns: 0,
  startedAt: new Date().toISOString(),
  currentPhase: null,
  phasesCompleted: [],
  lastVerification: null,
  rateLimits: [],
  stalls: [],
  devServers: {},
  exitReason: null,
  lastUpdated: new Date().toISOString(),
};

export class StateManager {
  private filePath: string;
  private state: OttoState;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.filePath = join(stateDir, "state.json");
    this.state = this.load();
  }

  private load(): OttoState {
    if (!existsSync(this.filePath)) {
      return { ...EMPTY_STATE, startedAt: new Date().toISOString() };
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as OttoState;
      if (parsed.turns === undefined) parsed.turns = 0;
      return parsed;
    } catch {
      return { ...EMPTY_STATE, startedAt: new Date().toISOString() };
    }
  }

  get(): OttoState {
    return this.state;
  }

  save() {
    this.state.lastUpdated = new Date().toISOString();
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2) + "\n");
    } catch {
      // state persistence must never crash the extension
    }
  }

  isRecovery(): boolean {
    if (this.state.iteration === 0) return false;
    return this.state.exitReason === null || this.state.exitReason === "session_shutdown";
  }

  prepareForRecovery() {
    this.state.exitReason = null;
    this.save();
  }

  incrementIteration() {
    this.state.iteration++;
    this.save();
  }

  incrementTurns() {
    this.state.turns++;
    this.save();
  }

  setPhase(phase: string) {
    this.state.currentPhase = phase;
    this.save();
  }

  completePhase(phase: string) {
    if (!this.state.phasesCompleted.includes(phase)) {
      this.state.phasesCompleted.push(phase);
    }
    this.state.currentPhase = null;
    this.save();
  }

  setVerification(result: VerificationResult) {
    this.state.lastVerification = result;
    this.save();
  }

  addRateLimit(entry: RateLimitEntry) {
    this.state.rateLimits.push(entry);
    if (this.state.rateLimits.length > 50) {
      this.state.rateLimits = this.state.rateLimits.slice(-50);
    }
    this.save();
  }

  addStall(entry: StallEntry) {
    this.state.stalls.push(entry);
    if (this.state.stalls.length > 50) {
      this.state.stalls = this.state.stalls.slice(-50);
    }
    this.save();
  }

  updateServer(name: string, update: Partial<ServerStateEntry>) {
    const existing = this.state.devServers[name] || { pid: null, port: 0, lastHealthy: null, restarts: 0 };
    this.state.devServers[name] = { ...existing, ...update };
    this.save();
  }

  setExit(reason: string) {
    this.state.exitReason = reason;
    this.save();
  }

  reset() {
    this.state = { ...EMPTY_STATE, startedAt: new Date().toISOString() };
    this.save();
  }

  buildRecoveryContext(): string {
    const s = this.state;
    const lines: string[] = [
      `[OTTO CRASH RECOVERY]`,
      `Previous run started: ${s.startedAt}`,
      `Iterations: ${s.iteration} | Turns: ${s.turns}`,
      `Phases completed: ${s.phasesCompleted.join(", ") || "none"}`,
      `Current phase at interruption: ${s.currentPhase || "unknown"}`,
    ];

    if (s.lastVerification) {
      const v = s.lastVerification;
      const failed = v.checks.filter((c) => !c.passed).map((c) => c.name);
      lines.push(`Last verification (${v.phase}): ${v.allPassed ? "PASSED" : "FAILED — " + failed.join(", ")}`);
    }

    if (s.rateLimits.length > 0) {
      const last = s.rateLimits[s.rateLimits.length - 1];
      lines.push(`Last rate limit: ${last.provider} at ${last.timestamp} (waited ${last.waitSeconds}s)`);
    }

    if (s.stalls.length > 0) {
      const last = s.stalls[s.stalls.length - 1];
      lines.push(`Last stall: ${last.description} — resolved: ${last.resolution}`);
    }

    lines.push(
      "",
      "Resume from where you left off. Do NOT re-execute completed phases.",
      "Read your run log to confirm which phases are actually complete.",
      "Execute phases strictly one at a time — never batch or combine phases.",
    );
    return lines.join("\n");
  }
}
