import {
  willhabenDetailBaseUrl,
  willhabenDetailRefreshIgnoredIntervalMs,
  willhabenDetailRefreshIntervalMs,
  willhabenDistrictAreaIds,
  willhabenDistrictCount,
  willhabenExcludedKeywords,
  willhabenMaxTotalCost,
  willhabenMinArea,
  willhabenRecentPeriod,
  willhabenRoomBuckets,
  willhabenRowsPerPage,
  willhabenSearchUrl,
  willhabenViennaAreaId,
  willhabenRequestTimeoutMs,
} from "./config.js";
import { fetchWithTimeout } from "../../shared/http.js";
import { formatCurrency, parseArea, parseCurrency } from "../../shared/parsing.js";
import type {
  FlatfinderState,
  WillhabenDetail,
  WillhabenRecord,
  WillhabenSearchConfig,
} from "../wohnberatung/state.js";

type WillhabenAttribute = {
  name: string;
  values?: string[];
};

type WillhabenSummary = {
  id?: string | number | null;
  description?: string | null;
  attributes?: {
    attribute?: WillhabenAttribute[];
  };
  advertImageList?: {
    advertImage?: Array<{
      mainImageUrl?: string | null;
      thumbnailImageUrl?: string | null;
      referenceImageUrl?: string | null;
    }>;
  };
};

export type WillhabenScrapeResult = {
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

const extractNextData = (html: string) => {
  const match = html.match(/__NEXT_DATA__" type="application\/json"[^>]*>(.*)<\/script>/);
  if (!match) throw new Error("Unable to find __NEXT_DATA__ payload.");
  return JSON.parse(match[1]) as {
    props?: {
      pageProps?: {
        searchResult?: {
          rowsFound?: number;
          rowsReturned?: number;
          advertSummaryList?: { advertSummary?: WillhabenSummary[] };
        };
        advertDetails?: {
          attributes?: { attribute?: WillhabenAttribute[] };
          advertImageList?: { advertImage?: Array<{ mainImageUrl?: string | null }> };
          createdDate?: string | null;
          changedDate?: string | null;
          advertStatus?: {
            id?: string | null;
            description?: string | null;
            statusId?: number | null;
          };
          sellerProfileUserData?: { name?: string | null } | string | null;
        };
      };
    };
  };
};

const getAttributeValue = (attrs: WillhabenAttribute[], name: string) => {
  const found = attrs.find((attr) => attr.name === name);
  return found?.values?.[0] ?? null;
};

const getAreaIds = (config?: WillhabenSearchConfig | null) => {
  if (!config?.districts?.length) return [willhabenViennaAreaId];
  const normalized = config.districts
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= willhabenDistrictCount);
  if (normalized.some((value) => value > willhabenDistrictAreaIds.length)) {
    return [willhabenViennaAreaId];
  }
  const ids = normalized.map((value) => willhabenDistrictAreaIds[value - 1]).filter(Boolean);
  return ids.length ? ids : [willhabenViennaAreaId];
};

const buildSearchUrl = (options: {
  page: number;
  recentOnly: boolean;
  config?: WillhabenSearchConfig | null;
}) => {
  const params = new URLSearchParams();
  getAreaIds(options.config).forEach((id) => params.append("areaId", id));
  willhabenRoomBuckets.forEach((bucket) => params.append("NO_OF_ROOMS_BUCKET", bucket));
  const minArea = options.config?.minArea ?? willhabenMinArea;
  const maxArea = options.config?.maxArea ?? null;
  const minTotalCost = options.config?.minTotalCost ?? null;
  const maxTotalCost = options.config?.maxTotalCost ?? willhabenMaxTotalCost;
  if (minArea !== null) params.set("ESTATE_SIZE/LIVING_AREA_FROM", String(minArea));
  if (maxArea !== null) params.set("ESTATE_SIZE/LIVING_AREA_TO", String(maxArea));
  if (minTotalCost !== null) params.set("PRICE_FROM", String(minTotalCost));
  if (maxTotalCost !== null) params.set("PRICE_TO", String(maxTotalCost));
  params.set("rows", String(willhabenRowsPerPage));
  params.set("page", String(options.page));
  if (options.recentOnly) {
    params.set("periode", willhabenRecentPeriod);
  }
  return `${willhabenSearchUrl}?${params.toString()}`;
};

const humanizeCostLabel = (name: string) =>
  name
    .replace(/[_/]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();

const costLabelOverrides: Record<string, string> = {
  "RENTAL_PRICE/PER_MONTH_FOR_DISPLAY": "Gesamtmiete",
  "RENTAL_PRICE/PER_MONTH": "Gesamtmiete",
  "RENT/PER_MONTH_LETTINGS": "Gesamtmiete",
  "RENTAL_PRICE/TOTAL_ENCUMBRANCE": "Gesamtbelastung",
  "RENTAL_PRICE/GROSS": "Miete (brutto)",
  "RENTAL_PRICE/NET": "Miete (netto)",
  "RENTAL_PRICE/ADDITIONAL_COST_GROSS": "Betriebskosten (brutto)",
  "RENTAL_PRICE/ADDITIONAL_COST_NET": "Betriebskosten (netto)",
  "ADDITIONAL_COST/DEPOSIT": "Kaution",
  PRICE_FOR_DISPLAY: "Preis",
  PRICE: "Preis",
  OLD_PRICE_FOR_DISPLAY: "Preis (alt)",
  OLD_PRICE: "Preis (alt)",
  "RENTAL_PRICE/PRICE_DESCRIPTION": "Preisinfo",
};

const costPrimaryOrder = [
  "RENTAL_PRICE/PER_MONTH_FOR_DISPLAY",
  "RENTAL_PRICE/PER_MONTH",
  "RENT/PER_MONTH_LETTINGS",
  "RENTAL_PRICE/TOTAL_ENCUMBRANCE",
  "PRICE_FOR_DISPLAY",
  "PRICE",
];

const isCostAttribute = (name: string) =>
  /(PRICE|RENTAL_PRICE|RENT\/|ADDITIONAL_COST|DEPOSIT|BROKER)/i.test(name) && !/DATE/i.test(name);

const extractCosts = (attrs: WillhabenAttribute[]) => {
  const costs = new Map<string, string>();
  let primaryCost: string | null = null;
  let primaryLabel: string | null = null;

  for (const attr of attrs) {
    if (!attr.name || !isCostAttribute(attr.name)) continue;
    const value = attr.values?.[0];
    if (!value) continue;
    const label = costLabelOverrides[attr.name] ?? humanizeCostLabel(attr.name);
    const normalized = formatCurrency(value) ?? value;
    if (!costs.has(label)) {
      costs.set(label, normalized);
    }
    if (!primaryCost && costPrimaryOrder.includes(attr.name)) {
      primaryCost = normalized;
      primaryLabel = costLabelOverrides[attr.name] ?? label;
    }
  }

  return {
    costs: Object.fromEntries(costs.entries()),
    primaryCost,
    primaryLabel,
  };
};

const extractDistrictCode = (value: string | null | undefined) => {
  if (!value) return null;
  const match = value.match(/\b(0?[1-9]|1[0-9]|2[0-3])\.?\s*Bezirk/i);
  if (match) return match[1].padStart(2, "0");
  const postalMatch = value.match(/\b1(\d{2})\d\b/);
  if (postalMatch) return postalMatch[1];
  return null;
};

const matchesDistrict = (
  record: {
    district?: string | null;
    location?: string | null;
    postalCode?: string | null;
    address?: string | null;
  },
  config?: WillhabenSearchConfig | null,
) => {
  const selected = config?.districts ?? [];
  if (selected.length === 0 || selected.length >= willhabenDistrictCount) return true;
  const code =
    extractDistrictCode(record.district ?? null) ??
    extractDistrictCode(record.location ?? null) ??
    extractDistrictCode(record.postalCode ?? null) ??
    extractDistrictCode(record.address ?? null);
  if (!code) return false;
  const normalized = String(Number(code));
  return selected.includes(normalized);
};

const isIgnored = (record: { hiddenAt?: string | null; suppressed?: boolean | null }) =>
  Boolean(record.hiddenAt || record.suppressed);

const isAdvertActive = (status: string | null | undefined) => {
  if (!status) return true;
  const normalized = status.toLowerCase();
  return normalized === "active" || normalized === "reserved";
};

const shouldRefreshDetail = (
  record: { lastDetailCheckAt?: string | null } & {
    hiddenAt?: string | null;
    suppressed?: boolean | null;
  },
  nowMs: number,
) => {
  const last = record.lastDetailCheckAt ? new Date(record.lastDetailCheckAt).getTime() : 0;
  const intervalMs = isIgnored(record)
    ? willhabenDetailRefreshIgnoredIntervalMs
    : willhabenDetailRefreshIntervalMs;
  return nowMs - last >= intervalMs;
};

const pickTotalCostValue = (record: {
  primaryCost?: string | null;
  costs?: Record<string, string>;
}) => {
  const primary = parseCurrency(record.primaryCost);
  if (primary !== null) return primary;
  const costs = record.costs ?? {};
  const preferred = ["Gesamtmiete", "Gesamtbelastung", "Miete (brutto)", "Miete (netto)", "Preis"];
  for (const label of preferred) {
    const value = parseCurrency(costs[label]);
    if (value !== null) return value;
  }
  for (const [label, value] of Object.entries(costs)) {
    if (!/miete|gesamt|preis/i.test(label)) continue;
    const parsed = parseCurrency(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

const isOverMaxCost = (
  record: { primaryCost?: string | null; costs?: Record<string, string> },
  config?: WillhabenSearchConfig | null,
) => {
  const value = pickTotalCostValue(record);
  const max = config?.maxTotalCost ?? willhabenMaxTotalCost;
  if (max === null) return false;
  return value !== null && value > max;
};

const getTotalCostValue = (record: {
  primaryCost?: string | null;
  costs?: Record<string, string>;
}) => pickTotalCostValue(record);

const isUnderMinCost = (
  record: { primaryCost?: string | null; costs?: Record<string, string> },
  config?: WillhabenSearchConfig | null,
) => {
  const min = config?.minTotalCost ?? null;
  if (min === null) return false;
  const value = pickTotalCostValue(record);
  return value !== null && value < min;
};

const isOutsideArea = (record: { size?: string | null }, config?: WillhabenSearchConfig | null) => {
  const min = config?.minArea ?? null;
  const max = config?.maxArea ?? null;
  if (min === null && max === null) return false;
  const value = parseArea(record.size ?? null);
  if (value === null) return false;
  if (min !== null && value < min) return true;
  if (max !== null && value > max) return true;
  return false;
};

const normalizeDescription = (value: string | null | undefined) => {
  if (!value) return null;
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const normalizeImageUrl = (url: string | null | undefined) => {
  if (!url) return null;
  return url.replace(/_(hoved|thumb)(\.[a-z0-9]+)$/i, "$2");
};

const collectImages = (
  images: Array<{
    referenceImageUrl?: string | null;
    mainImageUrl?: string | null;
    thumbnailImageUrl?: string | null;
  }>,
) =>
  images
    .map(
      (img) =>
        normalizeImageUrl(img.referenceImageUrl) ??
        normalizeImageUrl(img.mainImageUrl) ??
        normalizeImageUrl(img.thumbnailImageUrl) ??
        null,
    )
    .filter((img): img is string => Boolean(img));

const buildMapUrl = (coordinates: string | null, location: string | null) => {
  if (coordinates) {
    return `https://www.google.com/maps?q=${coordinates}`;
  }
  if (location) {
    return `https://www.google.com/maps?q=${encodeURIComponent(location)}`;
  }
  return null;
};

const containsExcludedKeyword = (value: string | null | undefined) => {
  if (!value) return false;
  const lowered = value.toLowerCase();
  return willhabenExcludedKeywords.some((keyword) => lowered.includes(keyword));
};

const containsAutoHideKeyword = (value: string | null | undefined) => {
  if (!value) return false;
  const lowered = value.toLowerCase();
  if (willhabenExcludedKeywords.some((keyword) => lowered.includes(keyword))) return true;
  return /vormerkschein/i.test(lowered);
};

const applyAutoHide = (record: WillhabenRecord, now: string) => {
  if (record.hiddenAt) return;
  const description = record.detail?.description ?? record.detail?.descriptionHtml ?? null;
  if (!description) return;
  if (containsAutoHideKeyword(description)) {
    record.hiddenAt = now;
  }
};

const containsBannedProvider = (value: string | null | undefined) =>
  value ? /blueground/i.test(value) : false;

const applySuppression = (record: WillhabenRecord, now: string) => {
  if (record.suppressed) return;
  const candidates = [record.sellerName, record.detail?.sellerName];
  if (candidates.some((value) => containsBannedProvider(value))) {
    record.suppressed = true;
    record.hiddenAt = record.hiddenAt ?? now;
    record.seenAt = record.seenAt ?? now;
  }
};

const parseSummary = (
  summary: WillhabenSummary,
  existing: Map<string, WillhabenRecord>,
  now: string,
) => {
  const attrs = summary.attributes?.attribute ?? [];
  const id =
    getAttributeValue(attrs, "ADID") ??
    (summary.id !== null && summary.id !== undefined ? String(summary.id) : null);
  if (!id) return null;
  const previous = existing.get(id);

  const seoUrl = getAttributeValue(attrs, "SEO_URL");
  const url = seoUrl ? `${willhabenDetailBaseUrl}/${seoUrl.replace(/^\/+/, "")}` : null;
  const title = normalizeText(getAttributeValue(attrs, "HEADING") ?? summary.description ?? null);
  const location = normalizeText(getAttributeValue(attrs, "LOCATION"));
  const postalCode = normalizeText(getAttributeValue(attrs, "POSTCODE"));
  const address = normalizeText(getAttributeValue(attrs, "ADDRESS"));
  const district = normalizeText(getAttributeValue(attrs, "DISTRICT"));
  const size = normalizeText(
    getAttributeValue(attrs, "ESTATE_SIZE/LIVING_AREA") ?? getAttributeValue(attrs, "ESTATE_SIZE"),
  );
  const roomsRaw = normalizeText(
    getAttributeValue(attrs, "NUMBER_OF_ROOMS") ?? getAttributeValue(attrs, "ROOMS"),
  );
  const rooms = roomsRaw?.includes("X") ? roomsRaw.split("X")[0] : roomsRaw;
  const publishedRaw =
    getAttributeValue(attrs, "PUBLISHED_String") ?? getAttributeValue(attrs, "PUBLISHED");
  const publishedAt = publishedRaw
    ? publishedRaw.match(/^\d+$/)
      ? new Date(Number(publishedRaw)).toISOString()
      : publishedRaw
    : null;

  const summaryImages = collectImages(summary.advertImageList?.advertImage ?? []);
  const detailImages = previous?.detail?.images ?? [];
  const images = detailImages.length ? detailImages : summaryImages;
  const thumbnailUrl =
    detailImages[0] ??
    summary.advertImageList?.advertImage?.[0]?.thumbnailImageUrl ??
    images[0] ??
    null;

  const costsSummary = extractCosts(attrs);
  const mergedCosts =
    costsSummary.costs && Object.keys(costsSummary.costs).length > 0
      ? costsSummary.costs
      : (previous?.costs ?? {});
  const primaryCost = costsSummary.primaryCost ?? previous?.primaryCost ?? null;
  const primaryCostLabel =
    costsSummary.primaryLabel ?? previous?.primaryCostLabel ?? (primaryCost ? "Gesamtmiete" : null);
  const totalCostValue = getTotalCostValue({
    primaryCost,
    costs: mergedCosts,
  });

  return {
    id,
    title,
    location,
    address,
    postalCode,
    district,
    sellerName: previous?.sellerName ?? null,
    url,
    thumbnailUrl,
    images,
    size,
    rooms,
    publishedAt,
    costs: mergedCosts,
    primaryCost,
    primaryCostLabel,
    totalCostValue,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    createdAt: previous?.createdAt ?? null,
    changedAt: previous?.changedAt ?? null,
    advertStatusId: previous?.advertStatusId ?? null,
    advertStatus: previous?.advertStatus ?? null,
    advertStatusDescription: previous?.advertStatusDescription ?? null,
    lastDetailCheckAt: previous?.lastDetailCheckAt ?? null,
    seenAt: previous?.seenAt ?? null,
    hiddenAt: previous?.hiddenAt ?? null,
    suppressed: previous?.suppressed ?? null,
    detail: previous?.detail,
    interest: previous?.interest,
    telegramNotifiedAt: previous?.telegramNotifiedAt ?? null,
  } satisfies WillhabenRecord;
};

const fetchSearchPage = async (
  page: number,
  recentOnly: boolean,
  config?: WillhabenSearchConfig | null,
) => {
  const url = buildSearchUrl({ page, recentOnly, config });
  const response = await fetchWithTimeout(url, {
    headers: { "user-agent": "flatfinder" },
    timeoutMs: willhabenRequestTimeoutMs,
  });
  if (!response.ok) {
    throw new Error(`Willhaben search failed (${response.status}) ${url}`);
  }
  const html = await response.text();
  const json = extractNextData(html);
  const result = json.props?.pageProps?.searchResult;
  const summaries = result?.advertSummaryList?.advertSummary ?? [];
  return {
    summaries,
    rowsFound: result?.rowsFound ?? summaries.length,
    rowsReturned: result?.rowsReturned ?? summaries.length,
  };
};

const fetchDetail = async (record: WillhabenRecord): Promise<WillhabenDetail | null> => {
  if (!record.url) return null;
  const response = await fetchWithTimeout(record.url, {
    headers: { "user-agent": "flatfinder" },
    timeoutMs: willhabenRequestTimeoutMs,
  });
  if (!response.ok) {
    throw new Error(`Willhaben detail failed (${response.status}) ${record.url}`);
  }
  const html = await response.text();
  const redirectedUrl = response.url ?? "";
  const expiredMatch =
    redirectedUrl.match(/fromExpiredAdId=(\d+)/i) ?? html.match(/fromExpiredAdId=(\d+)/i);
  if (expiredMatch) {
    return {
      expired: true,
      expiredAdId: expiredMatch[1] ?? null,
      advertStatus: {
        id: "expired",
        description: "Expired",
        statusId: null,
      },
    };
  }
  let json: ReturnType<typeof extractNextData>;
  try {
    json = extractNextData(html);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Willhaben detail parse failed.");
  }
  const details = json.props?.pageProps?.advertDetails;
  if (!details) {
    const snippet = html.replace(/\s+/g, " ").slice(0, 500);
    throw new Error(
      `Willhaben detail missing payload (${response.status}) ${response.url}. Snippet: ${snippet}`,
    );
  }
  const attrs = details.attributes?.attribute ?? [];

  const descriptionRaw =
    getAttributeValue(attrs, "DESCRIPTION") ?? getAttributeValue(attrs, "BODY_DYN");
  const description = normalizeDescription(descriptionRaw);
  const coordinates = normalizeText(getAttributeValue(attrs, "COORDINATES"));
  const contactName = normalizeText(getAttributeValue(attrs, "CONTACT/NAME"));
  const contactCompany = normalizeText(getAttributeValue(attrs, "CONTACT/COMPANY"));
  const sellerProfile = details.sellerProfileUserData;
  const sellerProfileName =
    typeof sellerProfile === "string"
      ? normalizeText(sellerProfile)
      : normalizeText(sellerProfile?.name);
  const sellerName = sellerProfileName ?? contactCompany ?? contactName ?? null;
  const createdDate = typeof details.createdDate === "string" ? details.createdDate : null;
  const changedDate = typeof details.changedDate === "string" ? details.changedDate : null;
  const advertStatus = details.advertStatus ?? null;
  const images = collectImages(details.advertImageList?.advertImage ?? []);
  const costs = extractCosts(attrs);

  return {
    description,
    descriptionHtml: descriptionRaw ? String(descriptionRaw) : null,
    coordinates,
    images,
    mapUrl: buildMapUrl(coordinates, record.location),
    costs: costs.costs,
    primaryCost: costs.primaryCost,
    primaryCostLabel: costs.primaryLabel,
    sellerName,
    createdDate,
    changedDate,
    advertStatus,
    expired: false,
    expiredAdId: null,
  };
};

const applyDetail = (
  record: WillhabenRecord,
  detail: WillhabenDetail | null,
  checkedAt: string,
) => {
  if (!detail) return;
  record.detail = detail;
  if (detail.expired) {
    record.advertStatus = "expired";
    record.advertStatusDescription = detail.advertStatus?.description ?? "Expired";
  }
  if (detail.images?.length) {
    record.images = detail.images;
    record.thumbnailUrl = detail.images[0] ?? record.thumbnailUrl;
  }
  if (detail.sellerName) {
    record.sellerName = detail.sellerName;
  }
  if (detail.costs && Object.keys(detail.costs).length > 0) {
    record.costs = detail.costs;
  }
  if (detail.primaryCost) {
    record.primaryCost = detail.primaryCost;
    record.primaryCostLabel = detail.primaryCostLabel ?? record.primaryCostLabel;
  } else if (!record.primaryCost && detail.costs) {
    const primary = detail.costs["Gesamtmiete"] ?? detail.costs["Gesamtbelastung"] ?? null;
    if (primary) {
      record.primaryCost = primary;
      record.primaryCostLabel = detail.costs["Gesamtmiete"] ? "Gesamtmiete" : "Gesamtbelastung";
    }
  }
  if (detail.createdDate) {
    record.createdAt = detail.createdDate;
  }
  if (detail.changedDate) {
    record.changedAt = detail.changedDate;
  }
  if (detail.advertStatus) {
    record.advertStatus = detail.advertStatus.id ?? record.advertStatus ?? null;
    record.advertStatusDescription =
      detail.advertStatus.description ?? record.advertStatusDescription ?? null;
    record.advertStatusId = detail.advertStatus.statusId ?? record.advertStatusId ?? null;
  }
  record.lastDetailCheckAt = checkedAt;
  record.totalCostValue = getTotalCostValue({
    primaryCost: record.primaryCost,
    costs: record.costs,
  });
};

const buildRecords = async (
  summaries: WillhabenSummary[],
  state: FlatfinderState,
  now: string,
  keepExisting: boolean,
  config?: WillhabenSearchConfig | null,
) => {
  const existing = new Map(state.willhaben.map((item) => [item.id, item]));
  const recordsInOrder: WillhabenRecord[] = [];
  const newIds = new Set<string>();

  for (const summary of summaries) {
    const record = parseSummary(summary, existing, now);
    if (!record) continue;
    if (containsExcludedKeyword(record.title) || containsExcludedKeyword(record.location)) continue;
    if (!matchesDistrict(record, config)) continue;
    if (isOverMaxCost(record, config)) continue;
    if (isUnderMinCost(record, config)) continue;
    if (isOutsideArea(record, config)) continue;
    if (!existing.has(record.id)) {
      newIds.add(record.id);
    }

    recordsInOrder.push(record);
  }

  let merged = recordsInOrder;
  if (keepExisting) {
    const ids = new Set(recordsInOrder.map((item) => item.id));
    merged = [...recordsInOrder, ...state.willhaben.filter((item) => !ids.has(item.id))];
  }

  const detailTargets = merged.filter((item) => newIds.has(item.id) && item.url);
  if (detailTargets.length > 0) {
    const queue = [...detailTargets];
    const removed = new Set<string>();
    const workers = Array.from({ length: 3 }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        let detail: WillhabenDetail | null = null;
        try {
          detail = await fetchDetail(item);
        } catch (error) {
          console.warn(
            "[willhaben] detail fetch failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!detail) {
          continue;
        }
        applyDetail(item, detail, now);
        if (isOverMaxCost(item, config)) {
          removed.add(item.id);
          continue;
        }
        if (isUnderMinCost(item, config) || isOutsideArea(item, config)) {
          removed.add(item.id);
          continue;
        }
        if (!matchesDistrict(item, config)) {
          removed.add(item.id);
          continue;
        }
        applyAutoHide(item, now);
        applySuppression(item, now);
        if (!isAdvertActive(item.advertStatus ?? null)) {
          removed.add(item.id);
        }
      }
    });
    await Promise.all(workers);
    if (removed.size > 0) {
      merged = merged.filter((item) => !removed.has(item.id));
    }
  }

  merged.forEach((record) => {
    applyAutoHide(record, now);
    applySuppression(record, now);
  });

  return merged;
};

export const refreshWillhabenDetails = async (state: FlatfinderState) => {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const dueItems = state.willhaben.filter((item) => shouldRefreshDetail(item, nowMs));
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
      let detail: WillhabenDetail | null = null;
      try {
        detail = await fetchDetail(item);
      } catch (error) {
        console.warn(
          "[willhaben] detail refresh failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!detail) {
        continue;
      }
      applyDetail(item, detail, now);
      applyAutoHide(item, now);
      applySuppression(item, now);
      didUpdate = true;
      if (!isAdvertActive(item.advertStatus ?? null)) {
        removed.add(item.id);
      }
    }
  });
  await Promise.all(workers);

  if (removed.size > 0) {
    state.willhaben = state.willhaben.filter((item) => !removed.has(item.id));
    didUpdate = true;
  }
  if (didUpdate) {
    state.updatedAt = now;
  }
  return { checked: dueItems.length, removed: removed.size, updated: didUpdate };
};

export const scrapeWillhaben = async (
  state: FlatfinderState,
  options: { recentOnly: boolean; config?: WillhabenSearchConfig | null },
): Promise<WillhabenScrapeResult> => {
  const now = new Date().toISOString();
  let page = 1;
  let rowsFound = 0;
  const summaries: WillhabenSummary[] = [];

  try {
    while (true) {
      const result = await fetchSearchPage(page, options.recentOnly, options.config);
      summaries.push(...result.summaries);
      rowsFound = result.rowsFound;
      if (result.rowsReturned < willhabenRowsPerPage) break;
      if (page * willhabenRowsPerPage >= rowsFound) break;
      page += 1;
    }
  } catch (error) {
    console.warn(
      "[willhaben] search failed:",
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: false,
      updated: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const merged = await buildRecords(summaries, state, now, true, options.config);
  state.willhaben = merged;
  state.updatedAt = now;
  return { ok: true, updated: true, message: null };
};
