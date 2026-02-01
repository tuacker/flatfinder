import { planungsprojekteRequestCost, planungsprojekteUrl } from "./config.js";
import { filterPlanungsprojekte } from "./filter.js";
import { createHttpClient, type HttpClient } from "./http-client.js";
import { parsePlanungsprojektDetail } from "./parse-planungsprojekt-detail.js";
import { parsePlanungsprojekte, type Planungsprojekt } from "./parse-planungsprojekte.js";
import type { PlanungsprojektRecord, FlatfinderState } from "./state.js";
import type { RateLimiter } from "./rate-limiter.js";
import { isLoginPage } from "./wohnberatung-client.js";
import type { ScrapeResult } from "./scrape-result.js";
import { getErrorMessage, isTransientError } from "../../shared/errors.js";

const buildRecord = async (
  item: Planungsprojekt,
  previous: PlanungsprojektRecord | undefined,
  client: HttpClient,
  now: string,
): Promise<{ record: PlanungsprojektRecord; hadTransientError: boolean }> => {
  let detail = previous?.detail;
  let hadTransientError = false;

  if (!detail && item.url) {
    try {
      const detailHtml = await client.fetchHtml(item.url);
      if (isLoginPage(detailHtml)) {
        throw new Error("Login required.");
      }
      detail = parsePlanungsprojektDetail(detailHtml);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("Login required.")) {
        throw error;
      }
      if (isTransientError(error)) {
        hadTransientError = true;
      }
      console.warn("[planungsprojekte]", message);
    }
  }

  return {
    record: {
      ...item,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      seenAt: previous?.seenAt ?? (item.flags.angemeldet ? now : null),
      hiddenAt: previous?.hiddenAt ?? null,
      detail,
      interest: previous?.interest,
      telegramNotifiedAt: previous?.telegramNotifiedAt ?? null,
    },
    hadTransientError,
  };
};

export const scrapePlanungsprojekte = async (
  state: FlatfinderState,
  rateLimiter: RateLimiter,
): Promise<ScrapeResult> => {
  if (state.wohnberatungAuthError) {
    return { status: "auth-error", updated: false, message: state.wohnberatungAuthError };
  }
  let client: HttpClient;
  try {
    client = await createHttpClient();
  } catch (error) {
    const message = getErrorMessage(error);
    state.wohnberatungAuthError = "Login required.";
    state.nextWohnungenRetryAt = null;
    state.nextPlanungsprojekteRetryAt = null;
    console.warn("[planungsprojekte]", message);
    return { status: "auth-error", updated: false, message };
  }
  const now = new Date().toISOString();
  if (!rateLimiter.canConsume(planungsprojekteRequestCost)) {
    console.warn("Planungsprojekte skipped: monthly rate limit reached.");
    return { status: "skipped", updated: false, message: "Rate limit reached." };
  }

  let html = "";
  try {
    html = await client.fetchHtml(planungsprojekteUrl);
  } catch (error) {
    const message = getErrorMessage(error);
    if (isTransientError(error)) {
      state.nextPlanungsprojekteRetryAt = new Date(Date.now() + 60_000).toISOString();
    }
    console.warn("[planungsprojekte]", message);
    return { status: "temp-error", updated: false, message };
  }

  if (isLoginPage(html)) {
    const changed = state.wohnberatungAuthError !== "Login required.";
    state.wohnberatungAuthError = "Login required.";
    state.nextWohnungenRetryAt = null;
    state.nextPlanungsprojekteRetryAt = null;
    state.updatedAt = now;
    if (changed) {
      console.warn("Planungsprojekte fetch returned login page.");
    }
    return { status: "auth-error", updated: true, message: "Login required." };
  }

  const hasContainer = html.includes("wsw_planungsprojekte");
  if (!hasContainer) {
    console.warn("Planungsprojekte fetch missing container; keeping previous list.");
    state.nextPlanungsprojekteRetryAt = new Date(Date.now() + 60_000).toISOString();
    return { status: "temp-error", updated: false, message: "Missing container." };
  }
  state.wohnberatungAuthError = null;
  state.nextPlanungsprojekteRetryAt = null;

  if (!rateLimiter.consume(planungsprojekteRequestCost)) {
    console.warn("Planungsprojekte skipped: monthly rate limit reached.");
    return { status: "skipped", updated: false, message: "Rate limit reached." };
  }

  let rawItems: Planungsprojekt[] = [];
  let items: Planungsprojekt[] = [];
  try {
    rawItems = parsePlanungsprojekte(html);
    items = filterPlanungsprojekte(rawItems);
  } catch (error) {
    const message = getErrorMessage(error);
    if (isTransientError(error)) {
      state.nextPlanungsprojekteRetryAt = new Date(Date.now() + 60_000).toISOString();
    }
    console.warn("[planungsprojekte]", message);
    return { status: "temp-error", updated: false, message };
  }

  if (rawItems.length === 0 && state.planungsprojekte.length > 0) {
    console.warn("Planungsprojekte fetch returned no items; keeping previous list.");
    state.nextPlanungsprojekteRetryAt = new Date(Date.now() + 60_000).toISOString();
    return { status: "temp-error", updated: false, message: "Empty list." };
  }

  const existing = new Map(
    state.planungsprojekte.filter((item) => item.id).map((item) => [item.id!, item]),
  );
  const next: PlanungsprojektRecord[] = [];

  let hadTransientError = false;
  for (const item of items) {
    if (!item.id) continue;
    try {
      const { record, hadTransientError: recordTransient } = await buildRecord(
        item,
        existing.get(item.id),
        client,
        now,
      );
      if (recordTransient) {
        hadTransientError = true;
      }
      next.push(record);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("Login required.")) {
        state.wohnberatungAuthError = "Login required.";
        state.nextWohnungenRetryAt = null;
        state.nextPlanungsprojekteRetryAt = null;
        return { status: "auth-error", updated: false, message };
      }
      if (isTransientError(error)) {
        state.nextPlanungsprojekteRetryAt = new Date(Date.now() + 60_000).toISOString();
        hadTransientError = true;
      }
      console.warn("[planungsprojekte]", message);
    }
  }

  state.planungsprojekte = next;
  state.updatedAt = now;
  if (hadTransientError) {
    state.nextPlanungsprojekteRetryAt = new Date(Date.now() + 60_000).toISOString();
  }

  return { status: "ok", updated: true, message: null };
};
