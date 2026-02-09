import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import {
  assetsDir,
  baseUrl,
  suchprofilUrl,
  wohnungssuchePreviewCost,
  wohnungssucheResultCost,
} from "./config.js";
import { hasExcludedKeyword } from "./filter.js";
import { createHttpClient, type HttpClient } from "./http-client.js";
import { parseSuchprofilForm } from "./parse-suchprofil-form.js";
import { parseWohnungDetail } from "./parse-wohnung-detail.js";
import { parseWohnungenList, type WohnungListItem } from "./parse-wohnungen-list.js";
import type { FlatfinderState, WohnungRecord } from "../../state/flatfinder-state.js";
import type { RateLimiter } from "./rate-limiter.js";
import { isLoginPage } from "./wohnberatung-client.js";
import type { ScrapeResult } from "./scrape-result.js";
import { getErrorMessage, isTransientError } from "../../shared/errors.js";

type WohnungssucheTarget = {
  source: "gefoerdert" | "gemeinde";
  href: string | null;
  count: number;
};

const normalize = (value: string | null | undefined) =>
  value
    ? value
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim()
    : null;

const absoluteUrl = (href: string | null) => {
  if (!href) return null;
  return new URL(href.replace(/&amp;/g, "&"), baseUrl).toString();
};

const parseCount = (value: string | null) => {
  if (!value) return 0;
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : 0;
};

const isAuthErrorMessage = (message: string) =>
  message.includes("Login required.") || message.includes("Suchprofil form not found");

const titleForWohnung = (item: {
  postalCode: string | null;
  address: string | null;
  foerderungstyp: string | null;
}) => normalize([item.postalCode, item.address, item.foerderungstyp].filter(Boolean).join(" "));

const downloadAsset = async (
  downloader: (url: string) => Promise<Buffer | null>,
  url: string | null,
  targetDir: string,
) => {
  if (!url) return null;
  const filename = path.basename(new URL(url).pathname);
  const relativePath = path.posix.join(targetDir, filename);
  const targetPath = path.resolve(assetsDir, relativePath);

  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await fs.access(targetPath);
    return relativePath;
  } catch {
    // continue
  }

  const buffer = await downloader(url);
  if (!buffer) return null;
  await fs.writeFile(targetPath, buffer);
  return relativePath;
};

const extractTarget = (
  $: ReturnType<typeof load>,
  art: string,
  source: WohnungssucheTarget["source"],
): WohnungssucheTarget => {
  const link = $(`a[href*='art=${art}']`).first();
  const container = link.closest(".col-md-6");
  const titleText = normalize(container.find("h3.thumbnail-menu-caption-title").text());
  return {
    source,
    href: link.attr("href") ?? null,
    count: parseCount(titleText),
  };
};

const fetchWohnungssucheTargets = async (client: HttpClient, rateLimiter: RateLimiter) => {
  const suchprofilHtml = await client.fetchHtml(suchprofilUrl);
  if (isLoginPage(suchprofilHtml)) {
    throw new Error("Login required.");
  }
  const form = parseSuchprofilForm(suchprofilHtml);

  if (form.method !== "post") {
    throw new Error(`Unexpected form method: ${form.method}`);
  }

  if (!rateLimiter.canConsume(wohnungssuchePreviewCost)) {
    console.warn("Wohnungssuche skipped: monthly rate limit reached.");
    return null;
  }

  const overviewHtml = await client.fetchHtml(form.action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: suchprofilUrl,
    },
    body: form.fields.toString(),
  });

  if (isLoginPage(overviewHtml)) {
    throw new Error("Login required.");
  }

  if (!rateLimiter.consume(wohnungssuchePreviewCost)) {
    console.warn("Wohnungssuche skipped: monthly rate limit reached.");
    return null;
  }

  const $ = load(overviewHtml);
  return [extractTarget($, "gefoerdert", "gefoerdert"), extractTarget($, "gemeinde", "gemeinde")];
};

const ensureDetail = async (record: WohnungRecord, client: HttpClient) => {
  if (record.detail) return record.detail;
  if (!record.url) return null;
  const detailHtml = await client.fetchHtml(record.url);
  if (isLoginPage(detailHtml)) {
    throw new Error("Login required.");
  }
  record.detail = parseWohnungDetail(detailHtml);
  return record.detail;
};

const ensureAssets = async (record: WohnungRecord, client: HttpClient) => {
  if (record.assets) return;
  const assetsKey = record.id ?? "unknown";
  record.assets = {
    thumbnail: await downloadAsset(client.download, record.thumbnailUrl, assetsKey),
    images: [],
  };

  const images: string[] = [];
  for (const url of record.detail?.imageUrls ?? []) {
    const asset = await downloadAsset(client.download, url, assetsKey);
    if (asset) images.push(asset);
  }
  record.assets.images = images;
};

const buildRecord = (
  item: WohnungListItem,
  source: WohnungRecord["source"],
  previous: WohnungRecord | undefined,
  now: string,
): WohnungRecord => ({
  ...item,
  source,
  firstSeenAt: previous?.firstSeenAt ?? now,
  lastSeenAt: now,
  seenAt: previous?.seenAt ?? (item.flags.angemeldet ? now : null),
  hiddenAt: previous?.hiddenAt ?? null,
  detail: previous?.detail,
  assets: previous?.assets,
  interest: previous?.interest,
  telegramNotifiedAt: previous?.telegramNotifiedAt ?? null,
});

export const scrapeWohnungen = async (
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
    console.warn("[wohnungen]", message);
    return { status: "auth-error", updated: false, message };
  }
  const now = new Date().toISOString();
  let targets: WohnungssucheTarget[] | null = null;
  try {
    targets = await fetchWohnungssucheTargets(client, rateLimiter);
  } catch (error) {
    const message = getErrorMessage(error);
    const isAuthError = isAuthErrorMessage(message);
    if (isAuthError) {
      const changed = state.wohnberatungAuthError !== "Login required.";
      state.wohnberatungAuthError = "Login required.";
      state.nextWohnungenRetryAt = null;
      state.nextPlanungsprojekteRetryAt = null;
      state.updatedAt = now;
      if (changed) {
        console.warn("[wohnungen]", message);
      }
    } else {
      if (isTransientError(error)) {
        state.nextWohnungenRetryAt = new Date(Date.now() + 60_000).toISOString();
      }
      console.warn("[wohnungen]", message);
    }
    return { status: isAuthError ? "auth-error" : "temp-error", updated: false, message };
  }
  if (!targets) {
    return { status: "skipped", updated: false, message: "Rate limit reached." };
  }
  state.wohnberatungAuthError = null;
  state.nextWohnungenRetryAt = null;

  const sourcesSkipped = new Set<WohnungRecord["source"]>();
  const existing = new Map(
    state.wohnungen.filter((item) => item.id).map((item) => [item.id!, item]),
  );
  const next: WohnungRecord[] = [];
  let didUpdate = false;
  let hadTransientError = false;

  for (const target of targets) {
    if (!target.href) continue;

    if (target.count === 0) {
      didUpdate = true;
      continue;
    }

    if (!rateLimiter.consume(wohnungssucheResultCost)) {
      console.warn(`Wohnungssuche skipped for ${target.source}: rate limit reached.`);
      sourcesSkipped.add(target.source);
      didUpdate = true;
      continue;
    }

    let listHtml: string;
    try {
      listHtml = await client.fetchHtml(absoluteUrl(target.href)!);
    } catch (error) {
      const message = getErrorMessage(error);
      if (isTransientError(error)) {
        state.nextWohnungenRetryAt = new Date(Date.now() + 60_000).toISOString();
        hadTransientError = true;
      }
      console.warn("[wohnungen]", message);
      sourcesSkipped.add(target.source);
      continue;
    }
    if (isLoginPage(listHtml)) {
      state.wohnberatungAuthError = "Login required.";
      state.nextWohnungenRetryAt = null;
      state.nextPlanungsprojekteRetryAt = null;
      return { status: "auth-error", updated: false, message: "Login required." };
    }

    let items: WohnungListItem[] = [];
    try {
      items = parseWohnungenList(listHtml);
    } catch (error) {
      const message = getErrorMessage(error);
      if (isTransientError(error)) {
        state.nextWohnungenRetryAt = new Date(Date.now() + 60_000).toISOString();
        hadTransientError = true;
      }
      console.warn("[wohnungen]", message);
      sourcesSkipped.add(target.source);
      continue;
    }
    didUpdate = true;

    for (const item of items) {
      if (!item.id) continue;
      if (hasExcludedKeyword(titleForWohnung(item))) continue;

      const record = buildRecord(item, target.source, existing.get(item.id), now);
      let detail: Awaited<ReturnType<typeof ensureDetail>> | null = record.detail ?? null;
      try {
        detail = await ensureDetail(record, client);
      } catch (error) {
        const message = getErrorMessage(error);
        if (isAuthErrorMessage(message)) {
          state.wohnberatungAuthError = "Login required.";
          state.nextWohnungenRetryAt = null;
          state.nextPlanungsprojekteRetryAt = null;
          return { status: "auth-error", updated: false, message };
        }
        if (isTransientError(error)) {
          state.nextWohnungenRetryAt = new Date(Date.now() + 60_000).toISOString();
          hadTransientError = true;
        }
        console.warn("[wohnungen]", message);
      }
      if (detail && detail.superfoerderung?.toLowerCase() === "ja") continue;

      try {
        await ensureAssets(record, client);
      } catch (error) {
        const message = getErrorMessage(error);
        if (isTransientError(error)) {
          state.nextWohnungenRetryAt = new Date(Date.now() + 60_000).toISOString();
          hadTransientError = true;
        }
        console.warn("[wohnungen]", message);
      }
      next.push(record);
    }
  }

  if (didUpdate) {
    const preserved = state.wohnungen.filter((item) => sourcesSkipped.has(item.source));
    state.wohnungen = [...preserved, ...next];
    state.updatedAt = now;
  }
  if (hadTransientError && !state.wohnberatungAuthError) {
    state.nextWohnungenRetryAt = new Date(Date.now() + 60_000).toISOString();
  }

  const status = hadTransientError && !didUpdate ? "temp-error" : "ok";
  return { status, updated: didUpdate, message: null };
};
