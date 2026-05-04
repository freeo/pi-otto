import type { OttoConfig, RateLimitEntry } from "./types.js";
import { OttoLogger, isRateLimitSignal, extractWaitSeconds, sleep } from "./utils.js";
import { StateManager } from "./state.js";

export type ProviderTier = "main" | "fallback_free" | "fallback_paid";

const DEFAULT_WAIT_SECONDS: Record<ProviderTier, number> = {
  main: 3600,
  fallback_free: 300,
  fallback_paid: 600,
};

export interface RateLimitHandler {
  check(text: string): boolean;
  handle(
    errorText: string,
    setModel: (model: string) => void,
    notify: (msg: string) => void,
  ): Promise<{ resumed: boolean; provider: ProviderTier }>;
  currentTier(): ProviderTier;
}

export function createRateLimitHandler(
  config: OttoConfig,
  state: StateManager,
  logger: OttoLogger,
): RateLimitHandler {
  let tier: ProviderTier = "main";

  function modelForTier(t: ProviderTier): string {
    switch (t) {
      case "main":
        return `${config.mainProvider}/${config.mainModel}`;
      case "fallback_free":
        return config.fallbackFreeModel
          ? `${config.fallbackFreeProvider}/${config.fallbackFreeModel}`
          : "";
      case "fallback_paid":
        return config.fallbackPaidModel
          ? `${config.fallbackPaidProvider}/${config.fallbackPaidModel}`
          : "";
    }
  }

  function nextTier(current: ProviderTier): ProviderTier | null {
    if (current === "main" && modelForTier("fallback_free")) return "fallback_free";
    if (current === "main" && modelForTier("fallback_paid")) return "fallback_paid";
    if (current === "fallback_free" && modelForTier("fallback_paid")) return "fallback_paid";
    return null;
  }

  return {
    check(text: string): boolean {
      return isRateLimitSignal(text);
    },

    async handle(
      errorText: string,
      setModel: (model: string) => void,
      notify: (msg: string) => void,
    ): Promise<{ resumed: boolean; provider: ProviderTier }> {
      const waitSec = extractWaitSeconds(errorText);
      const actualWait = waitSec > 0 ? waitSec : DEFAULT_WAIT_SECONDS[tier];

      logger.warn(`Rate limit on ${tier}`, { wait: actualWait, error: errorText.slice(0, 200) });

      state.addRateLimit({
        timestamp: new Date().toISOString(),
        provider: tier,
        message: errorText.slice(0, 500),
        waitSeconds: actualWait,
      });

      const next = nextTier(tier);

      if (next) {
        const model = modelForTier(next);
        logger.info(`Switching to ${next}: ${model}`);
        notify(`[OTTO] Rate limited on ${tier}. Switching to ${next} (${model}). Will retry main after ${actualWait}s.`);
        tier = next;
        setModel(model);

        scheduleMainResume(actualWait, config, setModel, notify, logger);
        return { resumed: true, provider: tier };
      }

      logger.warn(`All providers rate limited. Sleeping ${actualWait}s before retry.`);
      notify(`[OTTO] All providers rate limited. Sleeping ${actualWait}s...`);

      await sleep(actualWait * 1000);

      tier = "main";
      const mainModel = modelForTier("main");
      setModel(mainModel);
      notify(`[OTTO] Sleep complete. Resumed on main provider (${mainModel}).`);
      logger.info("Resumed on main provider after sleep");

      return { resumed: true, provider: "main" };
    },

    currentTier(): ProviderTier {
      return tier;
    },
  };
}

function scheduleMainResume(
  waitSec: number,
  config: OttoConfig,
  setModel: (model: string) => void,
  notify: (msg: string) => void,
  logger: OttoLogger,
) {
  setTimeout(() => {
    const model = `${config.mainProvider}/${config.mainModel}`;
    logger.info(`Timer expired, switching back to main: ${model}`);
    setModel(model);
    notify(`[OTTO] Rate limit window elapsed. Switched back to main provider (${model}).`);
  }, waitSec * 1000);
}
