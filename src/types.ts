export interface OttoConfig {
  entryPoint: string;
  runLog: string;
  stateDir: string;

  mainProvider: string;
  mainModel: string;
  mainThinking: string;

  fallbackFreeProvider: string;
  fallbackFreeModel: string;
  fallbackPaidProvider: string;
  fallbackPaidModel: string;

  maxIterations: number;
  maxWallClockHours: number;
  stallThresholdMinutes: number;
  stallMaxRetries: number;
  bashSilenceTimeout: number;
  bashHardTimeout: number;

  servers: ServerConfig[];
  healthCheckInterval: number;

  verificationTimeout: number;
  maxReverification: number;
}

export interface ServerConfig {
  name: string;
  port: number;
  cmd: string;
}

export interface OttoState {
  iteration: number;
  turns: number;
  startedAt: string;
  currentPhase: string | null;
  phasesCompleted: string[];
  lastVerification: VerificationResult | null;
  rateLimits: RateLimitEntry[];
  stalls: StallEntry[];
  devServers: Record<string, ServerStateEntry>;
  exitReason: string | null;
  lastUpdated: string;
}

export interface VerificationResult {
  phase: string;
  timestamp: string;
  checks: CheckResult[];
  allPassed: boolean;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
  error: string | null;
  durationMs: number;
}

export interface RateLimitEntry {
  timestamp: string;
  provider: string;
  message: string;
  waitSeconds: number;
}

export interface StallEntry {
  timestamp: string;
  description: string;
  resolution: string;
}

export interface ServerStateEntry {
  pid: number | null;
  port: number;
  lastHealthy: string | null;
  restarts: number;
}

