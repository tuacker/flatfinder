import * as cheerio from "cheerio";
import { fetchWithTimeout } from "../../shared/http.js";
import { parseArea, parseCurrency } from "../../shared/parsing.js";
import type {
  DerstandardDetail,
  DerstandardRecord,
  DerstandardSearchConfig,
  FlatfinderState,
} from "../../state/flatfinder-state.js";
import {
  derstandardDetailRefreshIgnoredIntervalMs,
  derstandardDetailRefreshIntervalMs,
  derstandardDistricts,
  derstandardMaxPages,
  derstandardRequestTimeoutMs,
  derstandardSearchBaseUrl,
} from "./config.js";

export type DerstandardScrapeResult = {
  ok: boolean;
  updated: boolean;
  message?: string | null;
};

const normalizeText = (value: string | null | undefined) =>
  value
    ? value
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim()
    : null;

const normalizeDescription = (value: string | null | undefined) => {
  if (!value) return null;
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const pickImageFromSrcset = (srcset: string | null | undefined) => {
  if (!srcset) return null;
  const candidates = srcset
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+/)[0] ?? "")
    .filter(Boolean);
  const nonAvif = candidates.find((entry) => !/format:avif|\.avif(?:$|[?#/])/i.test(entry));
  return nonAvif ?? candidates[0] ?? null;
};

const parseDistrictFromPostalCode = (postalCode: string | null) => {
  if (!postalCode) return null;
  const match = postalCode.match(/^1(\d{2})\d$/);
  if (!match?.[1]) return null;
  const district = Number.parseInt(match[1], 10);
  return Number.isFinite(district) ? String(district) : null;
};

const parsePostalCode = (address: string | null) => {
  if (!address) return null;
  const match = address.match(/\b(\d{4})\b/);
  return match?.[1] ?? null;
};

const parseIdFromHref = (href: string | null | undefined) => {
  if (!href) return null;
  const match = href.match(/\/detail\/(\d+)/);
  return match?.[1] ?? null;
};

const toAbsoluteUrl = (href: string | null | undefined) => {
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("/")) return `https://immobilien.derstandard.at${href}`;
  return `https://immobilien.derstandard.at/${href}`;
};

const parseCard = (
  element: cheerio.Cheerio<cheerio.AnyNode>,
  now: string,
  existing: Map<string, DerstandardRecord>,
): DerstandardRecord | null => {
  const detailHref =
    element.find("a.sc-listing-card-gallery-link").first().attr("href") ??
    element.find("a.sc-listing-card-content-background-link").first().attr("href") ??
    null;
  const id = parseIdFromHref(detailHref);
  if (!id) return null;

  const previous = existing.get(id);
  const title = normalizeText(element.find(".sc-listing-card-title").first().text());
  const address = normalizeText(
    element.find(".ListingCardAddress_ListingCardAddress_____D2").first().text(),
  );
  const postalCode = parsePostalCode(address);
  const district = parseDistrictFromPostalCode(postalCode);

  const footerItems = element
    .find(".sc-listing-card-footer .sc-listing-card-footer-item")
    .map((_, item) => normalizeText(element.find(item).text()))
    .get()
    .filter((value): value is string => Boolean(value));

  const size = footerItems.find((value) => value.includes("m²")) ?? previous?.size ?? null;
  const rooms =
    footerItems
      .find((value) => /zimmer/i.test(value))
      ?.replace(/zimmer/i, "")
      .trim() ??
    previous?.rooms ??
    null;
  const primaryCost =
    footerItems.find((value) => value.includes("€")) ?? previous?.primaryCost ?? null;

  const srcset =
    element
      .find("a.sc-listing-card-gallery-link source[type='image/jpg']")
      .first()
      .attr("srcset") ??
    element
      .find("a.sc-listing-card-gallery-link source[type='image/jpeg']")
      .first()
      .attr("srcset") ??
    element.find("a.sc-listing-card-gallery-link source").first().attr("srcset") ??
    null;
  const imageSrc = element.find("a.sc-listing-card-gallery-link img").first().attr("src") ?? null;
  const thumbnailUrl =
    normalizeImageUrl(pickImageFromSrcset(srcset) ?? imageSrc ?? "") ??
    previous?.thumbnailUrl ??
    null;

  return {
    id,
    title,
    location: address,
    address,
    postalCode,
    district,
    url: toAbsoluteUrl(detailHref),
    thumbnailUrl,
    images: previous?.images ?? [],
    size,
    rooms,
    primaryCost,
    primaryCostLabel: previous?.primaryCostLabel ?? null,
    costs: previous?.costs,
    totalCostValue: parseCurrency(primaryCost) ?? previous?.totalCostValue ?? null,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastDetailCheckAt: previous?.lastDetailCheckAt ?? null,
    expired: previous?.expired ?? null,
    seenAt: previous?.seenAt ?? null,
    hiddenAt: previous?.hiddenAt ?? null,
    detail: previous?.detail,
    interest: previous?.interest,
    telegramNotifiedAt: previous?.telegramNotifiedAt ?? null,
  } satisfies DerstandardRecord;
};

const getSelectedDistrictIds = (config?: DerstandardSearchConfig | null) => {
  const selected = new Set(config?.districts ?? []);
  const defaults = derstandardDistricts.map((district) => district.id);
  if (selected.size === 0) return defaults;
  const ids = derstandardDistricts
    .filter((district) => selected.has(district.code))
    .map((district) => district.id);
  return ids.length > 0 ? ids : defaults;
};

const buildSearchUrl = (page: number, config?: DerstandardSearchConfig | null) => {
  const districtIds = getSelectedDistrictIds(config);
  const locationPath = `multi-${districtIds.join("-")}`;
  const params = new URLSearchParams();
  const minArea = config?.minArea ?? null;
  const maxArea = config?.maxArea ?? null;
  const minCost = config?.minTotalCost ?? null;
  const maxCost = config?.maxTotalCost ?? null;
  if (minArea !== null) params.set("areaFrom", String(minArea));
  if (maxArea !== null) params.set("areaTo", String(maxArea));
  if (minCost !== null) params.set("priceFrom", String(minCost));
  if (maxCost !== null) params.set("priceTo", String(maxCost));
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `${derstandardSearchBaseUrl}/${locationPath}/mieten-wohnung${query ? `?${query}` : ""}`;
};

const parseSearchPage = (html: string, now: string, existing: Map<string, DerstandardRecord>) => {
  const $ = cheerio.load(html);
  const cards = $("li.sc-listing-card");
  const records = cards
    .map((_, card) => parseCard($(card), now, existing))
    .get()
    .filter((item): item is DerstandardRecord => Boolean(item));

  const nextButton = $("button.pagination--next").first();
  const hasNext = nextButton.length > 0 && !nextButton.is("[disabled]");
  return { records, hasNext };
};

const isOutsideConfiguredRange = (
  record: DerstandardRecord,
  config?: DerstandardSearchConfig | null,
) => {
  const minArea = config?.minArea ?? null;
  const maxArea = config?.maxArea ?? null;
  const area = parseArea(record.size);
  if (minArea !== null && area !== null && area < minArea) return true;
  if (maxArea !== null && area !== null && area > maxArea) return true;

  const minCost = config?.minTotalCost ?? null;
  const maxCost = config?.maxTotalCost ?? null;
  const cost = record.totalCostValue ?? parseCurrency(record.primaryCost);
  if (minCost !== null && cost !== null && cost < minCost) return true;
  if (maxCost !== null && cost !== null && cost > maxCost) return true;

  return false;
};

const normalizeImageUrl = (url: string) => {
  let normalized = url.trim();
  if (!normalized) return null;
  const firstSpace = normalized.indexOf(" ");
  if (firstSpace > 0) {
    normalized = normalized.slice(0, firstSpace);
  }
  if (!/^https?:\/\//i.test(normalized)) {
    return null;
  }
  normalized = normalized.replace(/[),]+$/g, "");
  try {
    return new URL(normalized).toString();
  } catch {
    return null;
  }
};

const extractFromSrcset = (value: string | null | undefined) => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => entry.split(/\s+/)[0] ?? "")
    .filter(Boolean);
};

const extractImagesFromHtml = (html: string): string[] => {
  const urls = new Set<string>();
  const $ = cheerio.load(html);

  $(".sc-detail-image source").each((_, node) => {
    const srcset = $(node).attr("srcset") ?? $(node).attr("srcSet") ?? null;
    extractFromSrcset(srcset).forEach((url) => {
      const normalized = normalizeImageUrl(url);
      if (!normalized) return;
      urls.add(normalized);
    });
  });

  $(".sc-detail-image img").each((_, node) => {
    const src = $(node).attr("src") ?? null;
    if (!src) return;
    const normalized = normalizeImageUrl(src);
    if (!normalized) return;
    urls.add(normalized);
  });

  const regex =
    /https:\/\/(?:i\.prod\.mp-dst\.onyx60\.com|ic\.ds\.at)\/plain\/[^\s"']+?\/full\.(?:jpg|jpeg|png|webp)(?:\/[^\s"']*)?/gi;
  for (const match of html.matchAll(regex)) {
    const normalized = normalizeImageUrl(match[0]);
    if (!normalized) continue;
    urls.add(normalized);
  }

  const ordered = [...urls];
  const nonAvif = ordered.filter((url) => !/format:avif|\.avif(?:$|[?#/])/i.test(url));
  return nonAvif.length > 0 ? nonAvif : ordered;
};

const decodeFlightChunk = (chunk: string) => {
  try {
    return JSON.parse(`"${chunk}"`) as string;
  } catch {
    return null;
  }
};

const extractDescriptionFromFlight = (html: string) => {
  const regex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  const candidates: string[] = [];
  for (const match of html.matchAll(regex)) {
    if (!match[1]) continue;
    const decoded = decodeFlightChunk(match[1]);
    if (!decoded) continue;
    if (!decoded.includes("<br") && !decoded.includes("\n")) continue;
    if (decoded.startsWith(".") || decoded.startsWith("21:[") || decoded.startsWith("36:{")) {
      continue;
    }
    if (decoded.length < 80) continue;
    candidates.push(decoded);
  }
  return candidates[0] ?? null;
};

const parseCostSection = ($: cheerio.CheerioAPI) => {
  const costs = new Map<string, string>();
  const costSection = $("section.detail-section")
    .toArray()
    .find((section) => normalizeText($(section).find("h2").first().text()) === "Kosten");
  if (!costSection) {
    return {
      costs: {},
      primaryCost: null,
      primaryCostLabel: null,
    };
  }

  $(costSection)
    .find("li.sc-metadata-item")
    .each((_, item) => {
      const label = normalizeText($(item).find(".sc-metadata-label").first().text());
      const value = normalizeText($(item).find(".sc-metadata-value").first().text());
      if (!label || !value) return;
      costs.set(label, value);
    });

  $(costSection)
    .find(".CostSection_costSectionInfo__lVyaj")
    .each((_, item) => {
      const label = normalizeText(
        $(item).find(".CostSection_costSectionInfoDt__v1mi9").first().text(),
      );
      const value = normalizeText(
        $(item).find(".CostSection_costSectionInfoDd__DpuQl").first().text(),
      );
      if (!label || !value) return;
      costs.set(label, value);
    });

  const primaryLabel =
    (costs.has("Gesamtmiete") && "Gesamtmiete") ||
    (costs.has("Miete") && "Miete") ||
    (costs.has("Miete brutto") && "Miete brutto") ||
    (costs.has("Monatliche Kosten inkl. Ust") && "Monatliche Kosten inkl. Ust") ||
    null;

  return {
    costs: Object.fromEntries(costs.entries()),
    primaryCost: primaryLabel ? (costs.get(primaryLabel) ?? null) : null,
    primaryCostLabel: primaryLabel,
  };
};

const parseDescription = ($: cheerio.CheerioAPI, html: string) => {
  const descriptionSection = $("section.detail-section")
    .toArray()
    .find((section) => normalizeText($(section).find("h2").first().text()) === "Beschreibung");

  const fromDom = descriptionSection
    ? normalizeText(
        $(descriptionSection)
          .find("p")
          .toArray()
          .map((node) => $(node).text())
          .join("\n"),
      )
    : null;

  const fromFlightHtml = extractDescriptionFromFlight(html);
  const normalized = normalizeDescription(fromFlightHtml ?? fromDom);
  return {
    description: normalized,
    descriptionHtml: fromFlightHtml,
  };
};

const isExpiredResponse = (status: number, html: string) => {
  if (status === 404 || status === 410) return true;
  if (/"expired":true/i.test(html)) return true;
  return false;
};

const fetchDetail = async (record: DerstandardRecord): Promise<DerstandardDetail | null> => {
  if (!record.url) return null;
  const response = await fetchWithTimeout(record.url, {
    headers: { "user-agent": "flatfinder" },
    timeoutMs: derstandardRequestTimeoutMs,
  });

  const html = await response.text();
  if (isExpiredResponse(response.status, html)) {
    return { expired: true };
  }
  if (!response.ok) {
    throw new Error(`DerStandard detail failed (${response.status}) ${record.url}`);
  }

  const $ = cheerio.load(html);
  const images = extractImagesFromHtml(html);
  const costs = parseCostSection($);
  const description = parseDescription($, html);

  return {
    ...description,
    images,
    costs: costs.costs,
    primaryCost: costs.primaryCost,
    primaryCostLabel: costs.primaryCostLabel,
    expired: false,
  };
};

const applyDetail = (record: DerstandardRecord, detail: DerstandardDetail, checkedAt: string) => {
  record.detail = detail;
  record.lastDetailCheckAt = checkedAt;
  record.expired = detail.expired ?? false;

  if (detail.images?.length) {
    record.images = detail.images;
    record.thumbnailUrl = detail.images[0] ?? record.thumbnailUrl;
  }

  if (detail.costs && Object.keys(detail.costs).length > 0) {
    record.costs = detail.costs;
  }

  if (detail.primaryCost) {
    record.primaryCost = detail.primaryCost;
    record.primaryCostLabel = detail.primaryCostLabel ?? record.primaryCostLabel;
    record.totalCostValue = parseCurrency(detail.primaryCost);
  }
};

const shouldRefreshDetail = (record: DerstandardRecord, nowMs: number) => {
  const last = record.lastDetailCheckAt ? new Date(record.lastDetailCheckAt).getTime() : 0;
  const intervalMs = record.hiddenAt
    ? derstandardDetailRefreshIgnoredIntervalMs
    : derstandardDetailRefreshIntervalMs;
  return nowMs - last >= intervalMs;
};

export const scrapeDerstandard = async (
  state: FlatfinderState,
  config?: DerstandardSearchConfig | null,
): Promise<DerstandardScrapeResult> => {
  const now = new Date().toISOString();
  const existing = new Map(state.derstandard.map((item) => [item.id, item]));
  const recordsInOrder: DerstandardRecord[] = [];
  const seenIds = new Set<string>();

  try {
    for (let page = 1; page <= derstandardMaxPages; page += 1) {
      const url = buildSearchUrl(page, config);
      const response = await fetchWithTimeout(url, {
        headers: { "user-agent": "flatfinder" },
        timeoutMs: derstandardRequestTimeoutMs,
      });
      if (!response.ok) {
        throw new Error(`DerStandard search failed (${response.status}) ${url}`);
      }
      const html = await response.text();
      const parsed = parseSearchPage(html, now, existing);
      parsed.records.forEach((record) => {
        if (seenIds.has(record.id)) return;
        if (isOutsideConfiguredRange(record, config)) return;
        seenIds.add(record.id);
        recordsInOrder.push(record);
      });
      if (!parsed.hasNext) break;
    }
  } catch (error) {
    return {
      ok: false,
      updated: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const merged = [...recordsInOrder, ...state.derstandard.filter((item) => !seenIds.has(item.id))];
  state.derstandard = merged;
  state.updatedAt = now;

  return { ok: true, updated: true, message: null };
};

export const refreshDerstandardDetails = async (state: FlatfinderState) => {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const dueItems = state.derstandard.filter((item) => shouldRefreshDetail(item, nowMs));
  if (dueItems.length === 0) {
    return { checked: 0, removed: 0, updated: false };
  }

  const queue = [...dueItems];
  const removed = new Set<string>();
  let didUpdate = false;

  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      if (!item.url) {
        item.lastDetailCheckAt = now;
        didUpdate = true;
        continue;
      }

      let detail: DerstandardDetail | null = null;
      try {
        detail = await fetchDetail(item);
      } catch (error) {
        console.warn(
          "[derstandard] detail refresh failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!detail) {
        continue;
      }

      applyDetail(item, detail, now);
      didUpdate = true;
      if (detail.expired) {
        removed.add(item.id);
      }
    }
  });

  await Promise.all(workers);

  if (removed.size > 0) {
    state.derstandard = state.derstandard.filter((item) => !removed.has(item.id));
    didUpdate = true;
  }

  if (didUpdate) {
    state.updatedAt = now;
  }

  return {
    checked: dueItems.length,
    removed: removed.size,
    updated: didUpdate,
  };
};
