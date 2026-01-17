import { planungsprojekteRequestCost, planungsprojekteUrl } from "./config.js";
import { filterPlanungsprojekte } from "./filter.js";
import { createHttpClient, type HttpClient } from "./http-client.js";
import { parsePlanungsprojektDetail } from "./parse-planungsprojekt-detail.js";
import { parsePlanungsprojekte, type Planungsprojekt } from "./parse-planungsprojekte.js";
import type { PlanungsprojektRecord, FlatfinderState } from "./state.js";
import type { RateLimiter } from "./rate-limiter.js";

const buildRecord = async (
  item: Planungsprojekt,
  previous: PlanungsprojektRecord | undefined,
  client: HttpClient,
  now: string,
): Promise<PlanungsprojektRecord> => {
  let detail = previous?.detail;

  if (!detail && item.url) {
    const detailHtml = await client.fetchHtml(item.url);
    detail = parsePlanungsprojektDetail(detailHtml);
  }

  return {
    ...item,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    seenAt: previous?.seenAt ?? (item.flags.angemeldet ? now : null),
    hiddenAt: previous?.hiddenAt ?? null,
    detail,
    interest: previous?.interest,
  };
};

export const scrapePlanungsprojekte = async (state: FlatfinderState, rateLimiter: RateLimiter) => {
  if (!rateLimiter.consume(planungsprojekteRequestCost)) {
    console.warn("Planungsprojekte skipped: monthly rate limit reached.");
    return;
  }

  const client = await createHttpClient();
  const now = new Date().toISOString();

  const html = await client.fetchHtml(planungsprojekteUrl);
  const items = filterPlanungsprojekte(parsePlanungsprojekte(html));

  const existing = new Map(
    state.planungsprojekte.filter((item) => item.id).map((item) => [item.id!, item]),
  );
  const next: PlanungsprojektRecord[] = [];

  for (const item of items) {
    if (!item.id) continue;
    const record = await buildRecord(item, existing.get(item.id), client, now);
    next.push(record);
  }

  state.planungsprojekte = next;
  state.updatedAt = now;
};
