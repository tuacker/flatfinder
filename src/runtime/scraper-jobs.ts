import {
  createRateLimiter,
  scrapePlanungsprojekte,
  scrapeWohnungen,
} from "../scrapers/wohnberatung/wohnberatung-service.js";
import { calculateWohnberatungIntervalsMs } from "../scrapers/wohnberatung/rate-limiter.js";
import {
  refreshWillhabenDetails,
  scrapeWillhaben,
} from "../scrapers/willhaben/willhaben-service.js";
import { willhabenRefreshIntervalMs } from "../scrapers/willhaben/config.js";
import {
  refreshDerstandardDetails,
  scrapeDerstandard,
} from "../scrapers/derstandard/derstandard-service.js";
import { derstandardRefreshIntervalMs } from "../scrapers/derstandard/config.js";
import {
  loadDerstandardConfig,
  loadState,
  loadTelegramConfig,
  loadWillhabenConfig,
  updateMeta,
  type FlatfinderState,
} from "../state/flatfinder-state.js";
import { notifyTelegramNewItems } from "../telegram.js";
import { rateLimitMonthly } from "../scrapers/wohnberatung/config.js";
import { saveScrapedItems, updateItemsColumns } from "../db.js";
import { scheduleJob } from "./scheduler.js";

const fortyEightHoursMs = 48 * 60 * 60 * 1000;

type ScrapeKey = "wohnungen" | "planungsprojekte" | "willhaben" | "derstandard";

type ScraperJobsOptions = {
  nowIso: () => string;
  onSchedule: (key: ScrapeKey, nextAt: number) => void;
  onUpdate: () => void;
};

const saveCollection = (key: ScrapeKey, state: FlatfinderState, now: string) => {
  if (key === "wohnungen") {
    saveScrapedItems("wohnberatung", "wohnungen", state.wohnungen, now);
    return;
  }
  if (key === "planungsprojekte") {
    saveScrapedItems("wohnberatung", "planungsprojekte", state.planungsprojekte, now);
    return;
  }
  if (key === "willhaben") {
    saveScrapedItems("willhaben", "wohnungen", state.willhaben, now);
    return;
  }
  saveScrapedItems("derstandard", "wohnungen", state.derstandard, now);
};

const updateScrapeMeta = (options: {
  key: ScrapeKey;
  updatedAt?: string | null;
  now: string;
  state: FlatfinderState;
  recordFetch: boolean;
}) => {
  const { key, updatedAt, now, state, recordFetch } = options;
  const patch: Partial<FlatfinderState> = {
    updatedAt: updatedAt ?? undefined,
  };

  if (recordFetch) {
    patch.lastScrapeAt = now;
    if (key === "wohnungen") patch.lastWohnungenFetchAt = now;
    if (key === "planungsprojekte") patch.lastPlanungsprojekteFetchAt = now;
    if (key === "willhaben") patch.lastWillhabenFetchAt = now;
    if (key === "derstandard") patch.lastDerstandardFetchAt = now;
  }

  if (key === "wohnungen") {
    patch.nextWohnungenRetryAt = state.nextWohnungenRetryAt ?? null;
  }
  if (key === "planungsprojekte") {
    patch.nextPlanungsprojekteRetryAt = state.nextPlanungsprojekteRetryAt ?? null;
  }

  if (key === "wohnungen" || key === "planungsprojekte") {
    patch.wohnberatungAuthError = state.wohnberatungAuthError ?? null;
  }

  updateMeta(patch);
};

const markTelegramNotified = (
  source: "wohnberatung" | "willhaben" | "derstandard",
  type: "wohnungen" | "planungsprojekte",
  ids: string[],
  now: string,
) => {
  if (ids.length === 0) return;
  const updates = ids.map((id) => ({ id, values: [now] }));
  updateItemsColumns(source, type, ["telegram_notified_at"], updates, now);
};

const notifyNewItems = async (key: ScrapeKey, state: FlatfinderState, now: string) => {
  try {
    const telegramConfig = await loadTelegramConfig();
    const notified = await notifyTelegramNewItems(telegramConfig, {
      wohnungen: key === "wohnungen" ? state.wohnungen : [],
      planungsprojekte: key === "planungsprojekte" ? state.planungsprojekte : [],
      willhaben: key === "willhaben" ? state.willhaben : [],
      derstandard: key === "derstandard" ? state.derstandard : [],
      now,
    });
    if (notified) {
      markTelegramNotified("wohnberatung", "wohnungen", notified.wohnungen, now);
      markTelegramNotified("wohnberatung", "planungsprojekte", notified.planungsprojekte, now);
      markTelegramNotified("willhaben", "wohnungen", notified.willhaben, now);
      markTelegramNotified("derstandard", "wohnungen", notified.derstandard, now);
    }
  } catch (error) {
    console.warn(
      `[${key}] Telegram notification failed:`,
      error instanceof Error ? error.message : String(error),
    );
  }
};

export const registerScraperJobs = (options: ScraperJobsOptions) => {
  const scheduleWohnberatungJob = (
    key: "wohnungen" | "planungsprojekte",
    run: (state: FlatfinderState) => Promise<{
      ok: boolean;
      updated: boolean;
      updatedAt: string | null;
      notify: boolean;
    }>,
  ) => {
    let timer: NodeJS.Timeout | null = null;
    let running = false;

    const scheduleNext = async () => {
      if (timer) clearTimeout(timer);
      const state = await loadState();
      const intervals = calculateWohnberatungIntervalsMs(state);
      const intervalMs =
        key === "wohnungen" ? intervals.wohnungenIntervalMs : intervals.planungsprojekteIntervalMs;
      const lastRunAt =
        key === "wohnungen" ? state.lastWohnungenFetchAt : state.lastPlanungsprojekteFetchAt;
      const lastRunMs = lastRunAt ? new Date(lastRunAt).getTime() : Number.NaN;
      const elapsed = Number.isFinite(lastRunMs) ? Date.now() - lastRunMs : intervalMs;
      let delay = Math.max(0, intervalMs - elapsed);
      const retryAt =
        key === "wohnungen" ? state.nextWohnungenRetryAt : state.nextPlanungsprojekteRetryAt;
      if (!state.wohnberatungAuthError && retryAt) {
        const retryMs = new Date(retryAt).getTime();
        if (Number.isFinite(retryMs)) {
          const retryDelay = Math.max(0, retryMs - Date.now());
          delay = Math.min(delay, retryDelay);
        }
      }
      options.onSchedule(key, Date.now() + delay);
      timer = setTimeout(async () => {
        if (running) return;
        running = true;
        try {
          const fresh = await loadState();
          const result = await run(fresh);
          if (result.updated) {
            saveCollection(key, fresh, result.updatedAt ?? options.nowIso());
          }
          if (result.notify) {
            await notifyNewItems(key, fresh, options.nowIso());
          }
          updateScrapeMeta({
            key,
            updatedAt: fresh.updatedAt ?? null,
            now: options.nowIso(),
            state: fresh,
            recordFetch: result.ok,
          });
          options.onUpdate();
        } finally {
          running = false;
          void scheduleNext();
        }
      }, delay);
    };

    void scheduleNext();
  };

  scheduleWohnberatungJob("wohnungen", async (state) => {
    const rateLimiter = createRateLimiter(state, rateLimitMonthly);
    const result = await scrapeWohnungen(state, rateLimiter);
    return {
      ok: result.status === "ok",
      updated: result.updated,
      updatedAt: state.updatedAt,
      notify: result.status === "ok",
    };
  });

  scheduleWohnberatungJob("planungsprojekte", async (state) => {
    const rateLimiter = createRateLimiter(state, rateLimitMonthly);
    const result = await scrapePlanungsprojekte(state, rateLimiter);
    return {
      ok: result.status === "ok",
      updated: result.updated,
      updatedAt: state.updatedAt,
      notify: result.status === "ok",
    };
  });

  scheduleJob({
    name: "willhaben",
    intervalMs: willhabenRefreshIntervalMs,
    lastRunAt: undefined,
    onSchedule: (nextAt) => options.onSchedule("willhaben", nextAt),
    run: async () => {
      const state = await loadState();
      const lastFetch = state.lastWillhabenFetchAt
        ? new Date(state.lastWillhabenFetchAt).getTime()
        : Number.NaN;
      const recentOnly = Number.isFinite(lastFetch) && Date.now() - lastFetch <= fortyEightHoursMs;
      const config = await loadWillhabenConfig();
      const searchResult = await scrapeWillhaben(state, {
        recentOnly,
        config,
      });
      const detailResult = await refreshWillhabenDetails(state);
      const updatedAt = state.updatedAt ?? options.nowIso();
      const shouldSave = searchResult.updated || detailResult.updated;

      if (shouldSave) {
        saveCollection("willhaben", state, updatedAt);
      }

      if (searchResult.ok) {
        await notifyNewItems("willhaben", state, options.nowIso());
      }

      updateScrapeMeta({
        key: "willhaben",
        updatedAt: state.updatedAt ?? null,
        now: options.nowIso(),
        state,
        recordFetch: searchResult.ok,
      });
      options.onUpdate();
    },
  });

  scheduleJob({
    name: "derstandard",
    intervalMs: derstandardRefreshIntervalMs,
    lastRunAt: undefined,
    onSchedule: (nextAt) => options.onSchedule("derstandard", nextAt),
    run: async () => {
      const state = await loadState();
      const config = await loadDerstandardConfig();
      const searchResult = await scrapeDerstandard(state, config);
      const detailResult = await refreshDerstandardDetails(state);
      const shouldSave = searchResult.updated || detailResult.updated;

      if (shouldSave) {
        saveCollection("derstandard", state, state.updatedAt ?? options.nowIso());
      }

      if (searchResult.ok) {
        await notifyNewItems("derstandard", state, options.nowIso());
      }

      updateScrapeMeta({
        key: "derstandard",
        updatedAt: state.updatedAt ?? null,
        now: options.nowIso(),
        state,
        recordFetch: searchResult.ok,
      });
      options.onUpdate();
    },
  });
};
