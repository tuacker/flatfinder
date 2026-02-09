import { getConfig, getMeta, getDb, loadItems, setConfig, setMeta } from "../db.js";
import type { Planungsprojekt } from "../scrapers/wohnberatung/parse-planungsprojekte.js";
import type { WohnungDetail } from "../scrapers/wohnberatung/parse-wohnung-detail.js";
import type { WohnungListItem } from "../scrapers/wohnberatung/parse-wohnungen-list.js";
import {
  willhabenDistrictCount,
  willhabenMaxTotalCost,
  willhabenMinArea,
} from "../scrapers/willhaben/config.js";
import {
  derstandardDistrictCount,
  derstandardMaxTotalCost,
  derstandardMinArea,
} from "../scrapers/derstandard/config.js";

export type PlanungsprojektDetail = {
  lageplanUrl: string | null;
  imageUrls: string[];
};

export type InterestInfo = {
  requestedAt?: string | null;
  rank?: number | null;
  locked?: boolean | null;
  watch?: {
    nextCheckAt?: string | null;
    lastCheckAt?: string | null;
  };
};

export type PlanungsprojektRecord = Planungsprojekt & {
  firstSeenAt: string;
  lastSeenAt: string;
  seenAt?: string | null;
  hiddenAt?: string | null;
  detail?: PlanungsprojektDetail;
  interest?: InterestInfo;
  telegramNotifiedAt?: string | null;
};

export type WohnungRecord = WohnungListItem & {
  source: "gefoerdert" | "gemeinde";
  firstSeenAt: string;
  lastSeenAt: string;
  seenAt?: string | null;
  hiddenAt?: string | null;
  detail?: WohnungDetail;
  assets?: {
    thumbnail?: string | null;
    images?: string[];
  };
  interest?: InterestInfo;
  telegramNotifiedAt?: string | null;
};

export type WillhabenDetail = {
  description?: string | null;
  descriptionHtml?: string | null;
  images?: string[];
  coordinates?: string | null;
  mapUrl?: string | null;
  costs?: Record<string, string>;
  primaryCost?: string | null;
  primaryCostLabel?: string | null;
  sellerName?: string | null;
  createdDate?: string | null;
  changedDate?: string | null;
  advertStatus?: {
    id?: string | null;
    description?: string | null;
    statusId?: number | null;
  } | null;
  expired?: boolean | null;
  expiredAdId?: string | null;
};

export type WillhabenRecord = {
  id: string;
  title: string | null;
  location: string | null;
  address: string | null;
  postalCode: string | null;
  district: string | null;
  sellerName?: string | null;
  url: string | null;
  thumbnailUrl?: string | null;
  images?: string[];
  size?: string | null;
  rooms?: string | null;
  publishedAt?: string | null;
  costs?: Record<string, string>;
  primaryCost?: string | null;
  primaryCostLabel?: string | null;
  totalCostValue?: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt?: string | null;
  changedAt?: string | null;
  advertStatusId?: number | null;
  advertStatus?: string | null;
  advertStatusDescription?: string | null;
  lastDetailCheckAt?: string | null;
  seenAt?: string | null;
  hiddenAt?: string | null;
  suppressed?: boolean | null;
  detail?: WillhabenDetail;
  interest?: InterestInfo;
  telegramNotifiedAt?: string | null;
};

export type DerstandardDetail = {
  description?: string | null;
  descriptionHtml?: string | null;
  images?: string[];
  costs?: Record<string, string>;
  primaryCost?: string | null;
  primaryCostLabel?: string | null;
  expired?: boolean | null;
};

export type DerstandardRecord = {
  id: string;
  title: string | null;
  location: string | null;
  address: string | null;
  postalCode: string | null;
  district: string | null;
  url: string | null;
  thumbnailUrl?: string | null;
  images?: string[];
  size?: string | null;
  rooms?: string | null;
  primaryCost?: string | null;
  primaryCostLabel?: string | null;
  costs?: Record<string, string>;
  totalCostValue?: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastDetailCheckAt?: string | null;
  expired?: boolean | null;
  seenAt?: string | null;
  hiddenAt?: string | null;
  detail?: DerstandardDetail;
  interest?: InterestInfo;
  telegramNotifiedAt?: string | null;
};

export type RateLimitState = {
  month: string;
  count: number;
};

export type TelegramConfig = {
  enabled: boolean;
  botToken: string | null;
  chatId: string | null;
  enableActions: boolean;
  webhookToken: string | null;
  pollingEnabled: boolean;
  pollingOffset: number | null;
};

export type WillhabenSearchConfig = {
  minArea: number | null;
  maxArea: number | null;
  minTotalCost: number | null;
  maxTotalCost: number | null;
  districts: string[];
};

export type DerstandardSearchConfig = {
  minArea: number | null;
  maxArea: number | null;
  minTotalCost: number | null;
  maxTotalCost: number | null;
  districts: string[];
};

export type FlatfinderState = {
  updatedAt: string | null;
  lastScrapeAt?: string | null;
  lastWohnungenFetchAt?: string | null;
  lastPlanungsprojekteFetchAt?: string | null;
  lastWillhabenFetchAt?: string | null;
  lastDerstandardFetchAt?: string | null;
  nextWohnungenRetryAt?: string | null;
  nextPlanungsprojekteRetryAt?: string | null;
  wohnberatungAuthError?: string | null;
  wohnberatungAuthNotifiedAt?: string | null;
  planungsprojekte: PlanungsprojektRecord[];
  wohnungen: WohnungRecord[];
  willhaben: WillhabenRecord[];
  derstandard: DerstandardRecord[];
  rateLimit: RateLimitState;
};

const formatMonth = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const currentMonth = () => formatMonth(new Date());

const telegramConfigKey = "telegram.config";
const willhabenConfigKey = "willhaben.config";
const derstandardConfigKey = "derstandard.config";
const metaKeys = {
  updatedAt: "state.updatedAt",
  lastScrapeAt: "state.lastScrapeAt",
  lastWohnungenFetchAt: "state.lastWohnungenFetchAt",
  lastPlanungsprojekteFetchAt: "state.lastPlanungsprojekteFetchAt",
  lastWillhabenFetchAt: "state.lastWillhabenFetchAt",
  lastDerstandardFetchAt: "state.lastDerstandardFetchAt",
  nextWohnungenRetryAt: "state.nextWohnungenRetryAt",
  nextPlanungsprojekteRetryAt: "state.nextPlanungsprojekteRetryAt",
  wohnberatungAuthError: "state.wohnberatungAuthError",
  wohnberatungAuthNotifiedAt: "state.wohnberatungAuthNotifiedAt",
  rateLimit: "state.rateLimit",
} as const;

export const defaultTelegramConfig = (): TelegramConfig => ({
  enabled: false,
  botToken: null,
  chatId: null,
  enableActions: false,
  webhookToken: null,
  pollingEnabled: false,
  pollingOffset: null,
});

export const normalizeTelegramConfig = (
  raw: Partial<TelegramConfig> | null | undefined,
): TelegramConfig => ({
  enabled: Boolean(raw?.enabled),
  botToken: typeof raw?.botToken === "string" ? raw.botToken : null,
  chatId: typeof raw?.chatId === "string" ? raw.chatId : null,
  enableActions: Boolean(raw?.enableActions),
  webhookToken: typeof raw?.webhookToken === "string" ? raw.webhookToken : null,
  pollingEnabled: Boolean(raw?.pollingEnabled),
  pollingOffset: typeof raw?.pollingOffset === "number" ? raw.pollingOffset : null,
});

const defaultWillhabenConfig = (): WillhabenSearchConfig => ({
  minArea: willhabenMinArea,
  maxArea: null,
  minTotalCost: null,
  maxTotalCost: willhabenMaxTotalCost,
  districts: Array.from({ length: willhabenDistrictCount }, (_, index) => String(index + 1)),
});

const normalizeDistricts = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return defaultWillhabenConfig().districts;
  const normalized = raw
    .map((value) => String(value).trim())
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= willhabenDistrictCount)
    .map((value) => String(value));
  return normalized.length ? Array.from(new Set(normalized)) : defaultWillhabenConfig().districts;
};

const normalizeNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(",", ".").trim());
  return Number.isFinite(parsed) ? parsed : null;
};

export const normalizeWillhabenConfig = (
  raw: Partial<WillhabenSearchConfig> | null | undefined,
): WillhabenSearchConfig => {
  const defaults = defaultWillhabenConfig();
  const minArea = normalizeNumber(raw?.minArea);
  const maxArea = normalizeNumber(raw?.maxArea);
  const minTotalCost = normalizeNumber(raw?.minTotalCost);
  const maxTotalCost = normalizeNumber(raw?.maxTotalCost);
  return {
    minArea: minArea ?? defaults.minArea,
    maxArea,
    minTotalCost,
    maxTotalCost: maxTotalCost ?? defaults.maxTotalCost,
    districts: normalizeDistricts(raw?.districts),
  };
};

const defaultDerstandardConfig = (): DerstandardSearchConfig => ({
  minArea: derstandardMinArea,
  maxArea: null,
  minTotalCost: null,
  maxTotalCost: derstandardMaxTotalCost,
  districts: Array.from({ length: derstandardDistrictCount }, (_, index) => String(index + 1)),
});

const normalizeDerstandardDistricts = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return defaultDerstandardConfig().districts;
  const normalized = raw
    .map((value) => String(value).trim())
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= derstandardDistrictCount)
    .map((value) => String(value));
  return normalized.length ? Array.from(new Set(normalized)) : defaultDerstandardConfig().districts;
};

export const normalizeDerstandardConfig = (
  raw: Partial<DerstandardSearchConfig> | null | undefined,
): DerstandardSearchConfig => {
  const defaults = defaultDerstandardConfig();
  const minArea = normalizeNumber(raw?.minArea);
  const maxArea = normalizeNumber(raw?.maxArea);
  const minTotalCost = normalizeNumber(raw?.minTotalCost);
  const maxTotalCost = normalizeNumber(raw?.maxTotalCost);
  return {
    minArea: minArea ?? defaults.minArea,
    maxArea,
    minTotalCost,
    maxTotalCost: maxTotalCost ?? defaults.maxTotalCost,
    districts: normalizeDerstandardDistricts(raw?.districts),
  };
};

const defaultState = (): FlatfinderState => ({
  updatedAt: null,
  lastScrapeAt: null,
  lastWohnungenFetchAt: null,
  lastPlanungsprojekteFetchAt: null,
  lastWillhabenFetchAt: null,
  lastDerstandardFetchAt: null,
  nextWohnungenRetryAt: null,
  nextPlanungsprojekteRetryAt: null,
  wohnberatungAuthError: null,
  wohnberatungAuthNotifiedAt: null,
  planungsprojekte: [],
  wohnungen: [],
  willhaben: [],
  derstandard: [],
  rateLimit: {
    month: currentMonth(),
    count: 0,
  },
});

const ensureDb = () => {
  getDb();
};

export const loadState = async (): Promise<FlatfinderState> => {
  ensureDb();
  const valueOrNull = (key: string) => {
    const value = getMeta(key);
    return value && value.length > 0 ? value : null;
  };

  return {
    updatedAt: valueOrNull(metaKeys.updatedAt),
    lastScrapeAt: valueOrNull(metaKeys.lastScrapeAt),
    lastWohnungenFetchAt: valueOrNull(metaKeys.lastWohnungenFetchAt),
    lastPlanungsprojekteFetchAt: valueOrNull(metaKeys.lastPlanungsprojekteFetchAt),
    lastWillhabenFetchAt: valueOrNull(metaKeys.lastWillhabenFetchAt),
    lastDerstandardFetchAt: valueOrNull(metaKeys.lastDerstandardFetchAt),
    nextWohnungenRetryAt: valueOrNull(metaKeys.nextWohnungenRetryAt),
    nextPlanungsprojekteRetryAt: valueOrNull(metaKeys.nextPlanungsprojekteRetryAt),
    wohnberatungAuthError: valueOrNull(metaKeys.wohnberatungAuthError),
    wohnberatungAuthNotifiedAt: valueOrNull(metaKeys.wohnberatungAuthNotifiedAt),
    planungsprojekte: loadItems<PlanungsprojektRecord>("wohnberatung", "planungsprojekte"),
    wohnungen: loadItems<WohnungRecord>("wohnberatung", "wohnungen"),
    willhaben: loadItems<WillhabenRecord>("willhaben", "wohnungen"),
    derstandard: loadItems<DerstandardRecord>("derstandard", "wohnungen"),
    rateLimit: loadRateLimitSync(),
  };
};

export const updateMeta = (values: Partial<FlatfinderState>) => {
  ensureDb();
  const write = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    setMeta(key, value ?? "");
  };

  write(metaKeys.updatedAt, values.updatedAt ?? null);
  write(metaKeys.lastScrapeAt, values.lastScrapeAt ?? null);
  write(metaKeys.lastWohnungenFetchAt, values.lastWohnungenFetchAt ?? null);
  write(metaKeys.lastPlanungsprojekteFetchAt, values.lastPlanungsprojekteFetchAt ?? null);
  write(metaKeys.lastWillhabenFetchAt, values.lastWillhabenFetchAt ?? null);
  write(metaKeys.lastDerstandardFetchAt, values.lastDerstandardFetchAt ?? null);
  write(metaKeys.nextWohnungenRetryAt, values.nextWohnungenRetryAt ?? null);
  write(metaKeys.nextPlanungsprojekteRetryAt, values.nextPlanungsprojekteRetryAt ?? null);
  write(metaKeys.wohnberatungAuthError, values.wohnberatungAuthError ?? null);
  write(metaKeys.wohnberatungAuthNotifiedAt, values.wohnberatungAuthNotifiedAt ?? null);

  if (values.rateLimit) {
    saveRateLimitSync(values.rateLimit);
  }
};

const loadRateLimitSync = (): RateLimitState => {
  ensureDb();
  const rateLimitRaw = getMeta(metaKeys.rateLimit);
  let rateLimit = defaultState().rateLimit;
  if (rateLimitRaw) {
    try {
      const parsed = JSON.parse(rateLimitRaw) as RateLimitState;
      if (typeof parsed?.month === "string" && typeof parsed?.count === "number") {
        rateLimit = parsed;
      }
    } catch {
      // ignore
    }
  }
  const current = currentMonth();
  if (rateLimit.month < current) {
    rateLimit = { month: current, count: 0 };
    saveRateLimitSync(rateLimit);
  }
  return rateLimit;
};

const saveRateLimitSync = (rateLimit: RateLimitState) => {
  ensureDb();
  setMeta(metaKeys.rateLimit, JSON.stringify(rateLimit));
};

export const loadRateLimit = () => loadRateLimitSync();

export const saveRateLimit = (rateLimit: RateLimitState) => {
  saveRateLimitSync(rateLimit);
};

export const loadTelegramConfig = async (): Promise<TelegramConfig> => {
  ensureDb();
  const raw = getConfig(telegramConfigKey);
  if (!raw) return defaultTelegramConfig();
  try {
    return normalizeTelegramConfig(JSON.parse(raw) as TelegramConfig);
  } catch {
    return defaultTelegramConfig();
  }
};

export const saveTelegramConfig = async (config: TelegramConfig) => {
  ensureDb();
  setConfig(telegramConfigKey, JSON.stringify(config));
};

export const loadWillhabenConfig = async (): Promise<WillhabenSearchConfig> => {
  ensureDb();
  const raw = getConfig(willhabenConfigKey);
  if (!raw) return defaultWillhabenConfig();
  try {
    return normalizeWillhabenConfig(JSON.parse(raw) as WillhabenSearchConfig);
  } catch {
    return defaultWillhabenConfig();
  }
};

export const saveWillhabenConfig = async (config: WillhabenSearchConfig) => {
  ensureDb();
  setConfig(willhabenConfigKey, JSON.stringify(config));
};

export const loadDerstandardConfig = async (): Promise<DerstandardSearchConfig> => {
  ensureDb();
  const raw = getConfig(derstandardConfigKey);
  if (!raw) return defaultDerstandardConfig();
  try {
    return normalizeDerstandardConfig(JSON.parse(raw) as DerstandardSearchConfig);
  } catch {
    return defaultDerstandardConfig();
  }
};

export const saveDerstandardConfig = async (config: DerstandardSearchConfig) => {
  ensureDb();
  setConfig(derstandardConfigKey, JSON.stringify(config));
};

export { defaultState };
