import {
  willhabenAreaIds,
  willhabenDetailBaseUrl,
  willhabenExcludedKeywords,
  willhabenMinArea,
  willhabenRecentPeriod,
  willhabenRoomBuckets,
  willhabenRowsPerPage,
  willhabenSearchUrl,
} from "./config.js";
import type { FlatfinderState, WillhabenDetail, WillhabenRecord } from "../wohnberatung/state.js";

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
        };
      };
    };
  };
};

const getAttributeValue = (attrs: WillhabenAttribute[], name: string) => {
  const found = attrs.find((attr) => attr.name === name);
  return found?.values?.[0] ?? null;
};

const buildSearchUrl = (options: { page: number; recentOnly: boolean }) => {
  const params = new URLSearchParams();
  willhabenAreaIds.forEach((id) => params.append("areaId", id));
  willhabenRoomBuckets.forEach((bucket) => params.append("NO_OF_ROOMS_BUCKET", bucket));
  params.set("ESTATE_SIZE/LIVING_AREA_FROM", String(willhabenMinArea));
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
    if (!costs.has(label)) {
      costs.set(label, value);
    }
    if (!primaryCost && costPrimaryOrder.includes(attr.name)) {
      primaryCost = value;
      primaryLabel = costLabelOverrides[attr.name] ?? label;
    }
  }

  return {
    costs: Object.fromEntries(costs.entries()),
    primaryCost,
    primaryLabel,
  };
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

  const images =
    summary.advertImageList?.advertImage
      ?.map((img) => img.mainImageUrl ?? img.referenceImageUrl ?? null)
      .filter((img): img is string => Boolean(img)) ?? [];
  const thumbnailUrl =
    summary.advertImageList?.advertImage?.[0]?.thumbnailImageUrl ?? images[0] ?? null;

  const costsSummary = extractCosts(attrs);
  const primaryCostLabel =
    previous?.primaryCostLabel ??
    costsSummary.primaryLabel ??
    (costsSummary.primaryCost ? "Gesamtmiete" : null);

  return {
    id,
    title,
    location,
    address,
    postalCode,
    district,
    url,
    thumbnailUrl,
    images,
    size,
    rooms,
    publishedAt,
    costs: previous?.costs ?? costsSummary.costs,
    primaryCost: previous?.primaryCost ?? costsSummary.primaryCost,
    primaryCostLabel,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    seenAt: previous?.seenAt ?? null,
    hiddenAt: previous?.hiddenAt ?? null,
    detail: previous?.detail,
    telegramNotifiedAt: previous?.telegramNotifiedAt ?? null,
  } satisfies WillhabenRecord;
};

const fetchSearchPage = async (page: number, recentOnly: boolean) => {
  const url = buildSearchUrl({ page, recentOnly });
  const response = await fetch(url, { headers: { "user-agent": "flatfinder" } });
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
  const response = await fetch(record.url, { headers: { "user-agent": "flatfinder" } });
  const html = await response.text();
  const json = extractNextData(html);
  const details = json.props?.pageProps?.advertDetails;
  if (!details) return null;
  const attrs = details.attributes?.attribute ?? [];

  const description = normalizeDescription(
    getAttributeValue(attrs, "DESCRIPTION") ?? getAttributeValue(attrs, "BODY_DYN"),
  );
  const coordinates = normalizeText(getAttributeValue(attrs, "COORDINATES"));
  const images =
    details.advertImageList?.advertImage
      ?.map((img) => img.mainImageUrl ?? null)
      .filter((img): img is string => Boolean(img)) ?? [];
  const costs = extractCosts(attrs);

  return {
    description,
    coordinates,
    images,
    mapUrl: buildMapUrl(coordinates, record.location),
    costs: costs.costs,
    primaryCost: costs.primaryCost,
    primaryCostLabel: costs.primaryLabel,
  };
};

const applyDetail = (record: WillhabenRecord, detail: WillhabenDetail | null) => {
  if (!detail) return;
  record.detail = detail;
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
  } else if (!record.primaryCost && detail.costs) {
    const primary = detail.costs["Gesamtmiete"] ?? detail.costs["Gesamtbelastung"] ?? null;
    if (primary) {
      record.primaryCost = primary;
      record.primaryCostLabel = detail.costs["Gesamtmiete"] ? "Gesamtmiete" : "Gesamtbelastung";
    }
  }
};

const buildRecords = async (
  summaries: WillhabenSummary[],
  state: FlatfinderState,
  now: string,
  keepExisting: boolean,
) => {
  const existing = new Map(state.willhaben.map((item) => [item.id, item]));
  const recordsInOrder: WillhabenRecord[] = [];

  for (const summary of summaries) {
    const record = parseSummary(summary, existing, now);
    if (!record) continue;
    if (containsExcludedKeyword(record.title) || containsExcludedKeyword(record.location)) continue;

    recordsInOrder.push(record);
  }

  let merged = recordsInOrder;
  if (keepExisting) {
    const ids = new Set(recordsInOrder.map((item) => item.id));
    merged = [...recordsInOrder, ...state.willhaben.filter((item) => !ids.has(item.id))];
  }

  const missingDetails = merged.filter((item) => !item.detail && item.url);
  if (missingDetails.length > 0) {
    const queue = [...missingDetails];
    const workers = Array.from({ length: 3 }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        const detail = await fetchDetail(item);
        if (detail?.description && containsExcludedKeyword(detail.description)) {
          const index = merged.findIndex((entry) => entry.id === item.id);
          if (index >= 0) merged.splice(index, 1);
          continue;
        }
        applyDetail(item, detail);
      }
    });
    await Promise.all(workers);
  }

  return merged;
};

export const scrapeWillhaben = async (state: FlatfinderState, options: { recentOnly: boolean }) => {
  const now = new Date().toISOString();
  let page = 1;
  let rowsFound = 0;
  const summaries: WillhabenSummary[] = [];

  while (true) {
    const result = await fetchSearchPage(page, options.recentOnly);
    summaries.push(...result.summaries);
    rowsFound = result.rowsFound;
    if (result.rowsReturned < willhabenRowsPerPage) break;
    if (page * willhabenRowsPerPage >= rowsFound) break;
    page += 1;
  }

  const merged = await buildRecords(summaries, state, now, options.recentOnly);
  state.willhaben = merged;
  state.updatedAt = now;
  state.lastWillhabenFetchAt = now;
};
