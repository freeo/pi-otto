import type { OttoConfig, ServerConfig } from "./types.js";
import { OttoLogger, checkPort, spawnBackground, waitForPort, killPid, pidAlive } from "./utils.js";
import { StateManager } from "./state.js";

export interface HealthWatchdog {
  checkAll(): Promise<HealthReport>;
  restartDead(): Promise<string[]>;
  stopAll(): void;
  startPeriodicCheck(intervalMs: number): void;
  stopPeriodicCheck(): void;
}

export interface HealthReport {
  allHealthy: boolean;
  servers: { name: string; port: number; healthy: boolean; pid: number | null }[];
}

export function createHealthWatchdog(
  config: OttoConfig,
  state: StateManager,
  logger: OttoLogger,
  cwd: string,
): HealthWatchdog {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function checkSingle(server: ServerConfig): Promise<{ healthy: boolean; pid: number | null }> {
    const stored = state.get().devServers[server.name];
    const pid = stored?.pid || null;

    if (pid && !pidAlive(pid)) {
      state.updateServer(server.name, { pid: null });
      return { healthy: false, pid: null };
    }

    const healthy = await checkPort(server.port);
    if (healthy) {
      state.updateServer(server.name, { lastHealthy: new Date().toISOString() });
    }
    return { healthy, pid };
  }

  async function restartServer(server: ServerConfig): Promise<boolean> {
    const stored = state.get().devServers[server.name];
    if (stored?.pid) {
      killPid(stored.pid);
    }

    logger.info(`Restarting server: ${server.name} on port ${server.port}`);

    try {
      const child = spawnBackground(server.cmd, cwd);
      const pid = child.pid || null;
      const restarts = (stored?.restarts || 0) + 1;
      state.updateServer(server.name, { pid, port: server.port, restarts });

      const ready = await waitForPort(server.port, 30_000);
      if (ready) {
        state.updateServer(server.name, { lastHealthy: new Date().toISOString() });
        logger.info(`Server ${server.name} restarted (pid ${pid}, attempt #${restarts})`);
        return true;
      }

      logger.error(`Server ${server.name} not healthy after restart`);
      return false;
    } catch (err) {
      logger.error(`Server ${server.name} restart failed: ${err}`);
      return false;
    }
  }

  return {
    async checkAll(): Promise<HealthReport> {
      const results = await Promise.all(
        config.servers.map(async (s) => {
          const { healthy, pid } = await checkSingle(s);
          return { name: s.name, port: s.port, healthy, pid };
        }),
      );
      return { allHealthy: results.every((r) => r.healthy), servers: results };
    },

    async restartDead(): Promise<string[]> {
      const restarted: string[] = [];
      for (const server of config.servers) {
        const { healthy } = await checkSingle(server);
        if (!healthy) {
          const ok = await restartServer(server);
          if (ok) restarted.push(server.name);
        }
      }
      return restarted;
    },

    stopAll() {
      for (const server of config.servers) {
        const stored = state.get().devServers[server.name];
        if (stored?.pid) {
          killPid(stored.pid);
          state.updateServer(server.name, { pid: null });
        }
      }
    },

    startPeriodicCheck(intervalMs: number) {
      if (intervalHandle) return;
      intervalHandle = setInterval(async () => {
        const report = await this.checkAll();
        if (!report.allHealthy) {
          const dead = report.servers.filter((s) => !s.healthy).map((s) => s.name);
          logger.warn(`Health check: dead servers: ${dead.join(", ")}`);
          await this.restartDead();
        }
      }, intervalMs);
    },

    stopPeriodicCheck() {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
  };
}
