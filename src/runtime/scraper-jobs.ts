import {
  planungsprojekteIntervalMinutes,
  wohnungssucheIntervalMinutes,
} from "../scrapers/wohnberatung/config.js";
import {
  scrapePlanungsprojekte,
  scrapeWohnungen,
} from "../scrapers/wohnberatung/wohnberatung-service.js";
import { scrapeWillhaben } from "../scrapers/willhaben/willhaben-service.js";
import { willhabenRefreshIntervalMs } from "../scrapers/willhaben/config.js";
import type { FlatfinderState } from "../scrapers/wohnberatung/state.js";
import type { RateLimiter } from "../scrapers/wohnberatung/rate-limiter.js";
import type { JobRunner } from "./scheduler.js";
import { scheduleJob } from "./scheduler.js";
import type { TelegramConfig } from "../scrapers/wohnberatung/state.js";
import { notifyTelegramNewItems } from "../telegram.js";

const fortyEightHoursMs = 48 * 60 * 60 * 1000;

type ScrapeKey = "wohnungen" | "planungsprojekte" | "willhaben";

type ScraperJobsOptions = {
  state: FlatfinderState;
  rateLimiter: RateLimiter;
  runExclusive: JobRunner;
  nowIso: () => string;
  persistState: (updatedAt?: string) => Promise<string>;
  getTelegramConfig: () => TelegramConfig;
  onSchedule: (key: "wohnungen" | "planungsprojekte" | "willhaben", nextAt: number) => void;
};

export const registerScraperJobs = (options: ScraperJobsOptions) => {
  const recordLastFetch = (key: ScrapeKey, now: string) => {
    options.state.lastScrapeAt = now;
    if (key === "wohnungen") options.state.lastWohnungenFetchAt = now;
    if (key === "planungsprojekte") options.state.lastPlanungsprojekteFetchAt = now;
    if (key === "willhaben") options.state.lastWillhabenFetchAt = now;
  };

  const notifyAndPersist = async (key: ScrapeKey) => {
    try {
      await notifyTelegramNewItems(options.getTelegramConfig(), {
        wohnungen: key === "wohnungen" ? options.state.wohnungen : [],
        planungsprojekte: key === "planungsprojekte" ? options.state.planungsprojekte : [],
        willhaben: key === "willhaben" ? options.state.willhaben : [],
      });
    } catch (error) {
      console.warn(
        `[${key}] Telegram notification failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    const now = options.nowIso();
    recordLastFetch(key, now);
    await options.persistState(now);
  };

  scheduleJob({
    name: "wohnungssuche",
    intervalMs: wohnungssucheIntervalMinutes * 60 * 1000,
    lastRunAt: options.state.lastWohnungenFetchAt,
    runner: options.runExclusive,
    onSchedule: (nextAt) => options.onSchedule("wohnungen", nextAt),
    run: async () => {
      await scrapeWohnungen(options.state, options.rateLimiter);
      await notifyAndPersist("wohnungen");
    },
  });

  scheduleJob({
    name: "planungsprojekte",
    intervalMs: planungsprojekteIntervalMinutes * 60 * 1000,
    lastRunAt: options.state.lastPlanungsprojekteFetchAt,
    runner: options.runExclusive,
    onSchedule: (nextAt) => options.onSchedule("planungsprojekte", nextAt),
    run: async () => {
      await scrapePlanungsprojekte(options.state, options.rateLimiter);
      await notifyAndPersist("planungsprojekte");
    },
  });

  scheduleJob({
    name: "willhaben",
    intervalMs: willhabenRefreshIntervalMs,
    lastRunAt: options.state.lastWillhabenFetchAt,
    runner: options.runExclusive,
    onSchedule: (nextAt) => options.onSchedule("willhaben", nextAt),
    run: async () => {
      const lastFetch = options.state.lastWillhabenFetchAt
        ? new Date(options.state.lastWillhabenFetchAt).getTime()
        : Number.NaN;
      const recentOnly = Number.isFinite(lastFetch) && Date.now() - lastFetch <= fortyEightHoursMs;
      await scrapeWillhaben(options.state, { recentOnly });
      await notifyAndPersist("willhaben");
    },
  });
};
