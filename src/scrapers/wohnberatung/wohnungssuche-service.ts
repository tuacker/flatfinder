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
import type { FlatfinderState, WohnungRecord } from "./state.js";
import type { RateLimiter } from "./rate-limiter.js";

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

const titleForWohnung = (item: { postalCode: string | null; address: string | null }) =>
  normalize([item.postalCode, item.address].filter(Boolean).join(" "));

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

const fetchWohnungssucheTargets = async (client: HttpClient) => {
  const suchprofilHtml = await client.fetchHtml(suchprofilUrl);
  const form = parseSuchprofilForm(suchprofilHtml);

  if (form.method !== "post") {
    throw new Error(`Unexpected form method: ${form.method}`);
  }

  const overviewHtml = await client.fetchHtml(form.action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: suchprofilUrl,
    },
    body: form.fields.toString(),
  });

  const $ = load(overviewHtml);
  return [extractTarget($, "gefoerdert", "gefoerdert"), extractTarget($, "gemeinde", "gemeinde")];
};

const ensureDetail = async (record: WohnungRecord, client: HttpClient) => {
  if (record.detail) return record.detail;
  if (!record.url) return null;
  const detailHtml = await client.fetchHtml(record.url);
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
});

export const scrapeWohnungen = async (state: FlatfinderState, rateLimiter: RateLimiter) => {
  if (!rateLimiter.consume(wohnungssuchePreviewCost)) {
    console.warn("Wohnungssuche skipped: monthly rate limit reached.");
    return;
  }

  const client = await createHttpClient();
  const now = new Date().toISOString();
  const targets = await fetchWohnungssucheTargets(client);

  const sourcesSkipped = new Set<WohnungRecord["source"]>();
  const existing = new Map(
    state.wohnungen.filter((item) => item.id).map((item) => [item.id!, item]),
  );
  const next: WohnungRecord[] = [];
  let didUpdate = false;

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

    const listHtml = await client.fetchHtml(absoluteUrl(target.href)!);
    const items = parseWohnungenList(listHtml);
    didUpdate = true;

    for (const item of items) {
      if (!item.id) continue;
      if (hasExcludedKeyword(titleForWohnung(item))) continue;

      const record = buildRecord(item, target.source, existing.get(item.id), now);
      const detail = await ensureDetail(record, client);
      if (!detail) continue;
      if (detail.superfoerderung?.toLowerCase() === "ja") continue;

      await ensureAssets(record, client);
      next.push(record);
    }
  }

  if (didUpdate) {
    const preserved = state.wohnungen.filter((item) => sourcesSkipped.has(item.source));
    state.wohnungen = [...preserved, ...next];
    state.updatedAt = now;
  }
};
