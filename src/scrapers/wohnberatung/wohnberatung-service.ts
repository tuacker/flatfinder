import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import {
  planungsprojekteRequestCost,
  wohnungssuchePreviewCost,
  wohnungssucheResultCost,
} from "./config.js";
import { ASSETS_DIR, BASE_URL, PLANUNGSPROJEKTE_URL, SUCHPROFIL_URL } from "./constants.js";
import { filterPlanungsprojekte, hasExcludedKeyword } from "./filter.js";
import { createHttpClient } from "./http-client.js";
import { parsePlanungsprojektDetail } from "./parse-planungsprojekt-detail.js";
import { parsePlanungsprojekte } from "./parse-planungsprojekte.js";
import { parseSuchprofilForm } from "./parse-suchprofil-form.js";
import { parseWohnungDetail } from "./parse-wohnung-detail.js";
import { parseWohnungenList } from "./parse-wohnungen-list.js";
import type { FlatfinderState, PlanungsprojektRecord, WohnungRecord } from "./state.js";

export type RateLimiter = {
  max: number;
  canConsume: (amount: number) => boolean;
  consume: (amount: number) => boolean;
};

export const createRateLimiter = (state: FlatfinderState, max: number): RateLimiter => {
  const ensureMonth = () => {
    const current = new Date().toISOString().slice(0, 7);
    if (state.rateLimit.month !== current) {
      state.rateLimit = { month: current, count: 0 };
    }
  };

  const canConsume = (amount: number) => {
    ensureMonth();
    return state.rateLimit.count + amount <= max;
  };

  const consume = (amount: number) => {
    if (!canConsume(amount)) return false;
    state.rateLimit.count += amount;
    return true;
  };

  return { max, canConsume, consume };
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
  return new URL(href.replace(/&amp;/g, "&"), BASE_URL).toString();
};

const parseCount = (value: string | null) => {
  if (!value) return 0;
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : 0;
};

const downloadAsset = async (
  downloader: (url: string) => Promise<Buffer | null>,
  url: string | null,
  targetDir: string,
) => {
  if (!url) return null;
  const filename = path.basename(new URL(url).pathname);
  const relativePath = path.posix.join(targetDir, filename);
  const targetPath = path.resolve(ASSETS_DIR, relativePath);

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

const titleForWohnung = (
  item: WohnungRecord | { postalCode: string | null; address: string | null },
) => normalize([item.postalCode, item.address].filter(Boolean).join(" "));

export const scrapePlanungsprojekte = async (state: FlatfinderState, rateLimiter: RateLimiter) => {
  if (!rateLimiter.consume(planungsprojekteRequestCost)) {
    console.warn("Planungsprojekte skipped: monthly rate limit reached.");
    return;
  }

  const client = await createHttpClient(BASE_URL);
  const now = new Date().toISOString();

  const html = await client.fetchHtml(PLANUNGSPROJEKTE_URL);
  const parsed = parsePlanungsprojekte(html);
  const filtered = filterPlanungsprojekte(parsed.items).included;

  const existing = new Map(state.planungsprojekte.map((item) => [item.id, item]));
  const next: PlanungsprojektRecord[] = [];

  for (const item of filtered) {
    if (!item.id) continue;
    const previous = existing.get(item.id ?? "");
    let detail = previous?.detail;

    if (!detail && item.url) {
      const detailHtml = await client.fetchHtml(item.url);
      detail = parsePlanungsprojektDetail(detailHtml);
    }

    next.push({
      ...item,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      detail,
    });
  }

  state.planungsprojekte = next;
  state.updatedAt = now;
};

type WohnungssucheTarget = {
  source: "gefoerdert" | "gemeinde";
  href: string | null;
  count: number;
};

const extractTarget = (html: string, art: string, source: WohnungssucheTarget["source"]) => {
  const $ = load(html);
  const link = $(`a[href*='art=${art}']`).first();
  const container = link.closest(".col-md-6");
  const titleText = normalize(container.find("h3.thumbnail-menu-caption-title").text());
  return {
    source,
    href: link.attr("href") ?? null,
    count: parseCount(titleText),
  } satisfies WohnungssucheTarget;
};

const fetchWohnungssucheTargets = async (client: Awaited<ReturnType<typeof createHttpClient>>) => {
  const suchprofilHtml = await client.fetchHtml(SUCHPROFIL_URL);
  const form = parseSuchprofilForm(suchprofilHtml);

  if (form.method !== "post") {
    throw new Error(`Unexpected form method: ${form.method}`);
  }

  const overviewHtml = await client.fetchHtml(form.action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: SUCHPROFIL_URL,
    },
    body: form.fields.toString(),
  });

  return {
    overviewHtml,
    targets: [
      extractTarget(overviewHtml, "gefoerdert", "gefoerdert"),
      extractTarget(overviewHtml, "gemeinde", "gemeinde"),
    ],
  };
};

export const scrapeWohnungen = async (state: FlatfinderState, rateLimiter: RateLimiter) => {
  if (!rateLimiter.consume(wohnungssuchePreviewCost)) {
    console.warn("Wohnungssuche skipped: monthly rate limit reached.");
    return;
  }

  const client = await createHttpClient(BASE_URL);
  const now = new Date().toISOString();

  const { targets } = await fetchWohnungssucheTargets(client);

  const listItems: WohnungRecord[] = [];
  const sourcesFetched = new Set<WohnungRecord["source"]>();
  const sourcesSkipped = new Set<WohnungRecord["source"]>();

  for (const target of targets) {
    if (!target.href) continue;

    if (target.count === 0) {
      sourcesFetched.add(target.source);
      continue;
    }

    if (!rateLimiter.consume(wohnungssucheResultCost)) {
      console.warn(`Wohnungssuche skipped for ${target.source}: rate limit reached.`);
      sourcesSkipped.add(target.source);
      continue;
    }

    const listHtml = await client.fetchHtml(absoluteUrl(target.href)!);
    const parsed = parseWohnungenList(listHtml);
    sourcesFetched.add(target.source);

    for (const item of parsed.items) {
      if (!item.id) continue;
      const title = titleForWohnung(item);
      if (hasExcludedKeyword(title)) continue;
      listItems.push({
        ...item,
        source: target.source,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }

  const preserved = state.wohnungen.filter((item) => sourcesSkipped.has(item.source));
  const existing = new Map(state.wohnungen.map((item) => [item.id, item]));
  const next: WohnungRecord[] = [...preserved];

  for (const item of listItems) {
    const previous = existing.get(item.id ?? "");
    const record: WohnungRecord = {
      ...item,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      detail: previous?.detail,
      assets: previous?.assets,
    };

    if (!record.detail) {
      const detailHtml = await client.fetchHtml(record.url ?? "");
      const detail = parseWohnungDetail(detailHtml);
      record.detail = detail;

      const superfoerderung = detail.superfoerderung?.toLowerCase() ?? "";
      if (superfoerderung === "ja") {
        continue;
      }

      const assetsDir = record.id ?? "unknown";
      record.assets = {
        thumbnail: await downloadAsset(client.download, record.thumbnailUrl, assetsDir),
        mapImage: await downloadAsset(client.download, detail.mapImageUrl, assetsDir),
        images: [],
      };

      const images: string[] = [];
      for (const url of detail.imageUrls) {
        const asset = await downloadAsset(client.download, url, assetsDir);
        if (asset) images.push(asset);
      }
      record.assets.images = images;
    } else {
      const superfoerderung = record.detail.superfoerderung?.toLowerCase() ?? "";
      if (superfoerderung === "ja") {
        continue;
      }
    }

    next.push(record);
  }

  if (sourcesFetched.size > 0 || sourcesSkipped.size > 0) {
    state.wohnungen = next;
    state.updatedAt = now;
  }
};
