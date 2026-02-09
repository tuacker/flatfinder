import { calculateWohnberatungIntervalsMs } from "../scrapers/wohnberatung/rate-limiter.js";
import type { FlatfinderState } from "../state/flatfinder-state.js";
import { registerScraperJobs } from "../runtime/scraper-jobs.js";
import { willhabenRefreshIntervalMs } from "../scrapers/willhaben/config.js";
import { derstandardRefreshIntervalMs } from "../scrapers/derstandard/config.js";

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const getNextWohnberatungJobAt = (
  state: FlatfinderState,
  key: "wohnungen" | "planungsprojekte",
  nowMs: number,
) => {
  const intervals = calculateWohnberatungIntervalsMs(state);
  const intervalMs =
    key === "wohnungen" ? intervals.wohnungenIntervalMs : intervals.planungsprojekteIntervalMs;
  const lastRunAt =
    key === "wohnungen" ? state.lastWohnungenFetchAt : state.lastPlanungsprojekteFetchAt;
  const lastRunMs = parseTimestampMs(lastRunAt ?? null);
  const elapsed = Number.isFinite(lastRunMs) ? nowMs - lastRunMs : intervalMs;
  let delay = Math.max(0, intervalMs - elapsed);
  const retryAt =
    key === "wohnungen" ? state.nextWohnungenRetryAt : state.nextPlanungsprojekteRetryAt;
  if (!state.wohnberatungAuthError && retryAt) {
    const retryMs = parseTimestampMs(retryAt);
    if (Number.isFinite(retryMs)) {
      delay = Math.min(delay, Math.max(0, retryMs - nowMs));
    }
  }
  return nowMs + delay;
};

export const getNextWohnberatungRefreshAt = (state: FlatfinderState) => {
  const nowMs = Date.now();
  return Math.min(
    getNextWohnberatungJobAt(state, "wohnungen", nowMs),
    getNextWohnberatungJobAt(state, "planungsprojekte", nowMs),
  );
};

export const getNextWillhabenRefreshAt = (state: FlatfinderState) => {
  const nowMs = Date.now();
  const lastRunMs = parseTimestampMs(state.lastWillhabenFetchAt ?? null);
  if (!Number.isFinite(lastRunMs)) return nowMs;
  const elapsed = nowMs - lastRunMs;
  if (elapsed >= willhabenRefreshIntervalMs) return nowMs;
  return lastRunMs + willhabenRefreshIntervalMs;
};

export const getNextDerstandardRefreshAt = (state: FlatfinderState) => {
  const nowMs = Date.now();
  const lastRunMs = parseTimestampMs(state.lastDerstandardFetchAt ?? null);
  if (!Number.isFinite(lastRunMs)) return nowMs;
  const elapsed = nowMs - lastRunMs;
  if (elapsed >= derstandardRefreshIntervalMs) return nowMs;
  return lastRunMs + derstandardRefreshIntervalMs;
};

export const getWohnberatungIntervalsMs = (state: FlatfinderState) =>
  calculateWohnberatungIntervalsMs(state);

export const startScraperJobs = (options: {
  nowIso: () => string;
  onSchedule: (
    key: "wohnungen" | "planungsprojekte" | "willhaben" | "derstandard",
    nextAt: number,
  ) => void;
  onUpdate: () => void;
}) => {
  registerScraperJobs(options);
};
