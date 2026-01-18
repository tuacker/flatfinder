import { getConfig, getMeta, getDb, loadItems, saveItems, setConfig, setMeta } from "../../db.js";
import type { Planungsprojekt } from "./parse-planungsprojekte.js";
import type { WohnungDetail } from "./parse-wohnung-detail.js";
import type { WohnungListItem } from "./parse-wohnungen-list.js";

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
};

export type WillhabenRecord = {
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
  publishedAt?: string | null;
  costs?: Record<string, string>;
  primaryCost?: string | null;
  primaryCostLabel?: string | null;
  totalCostValue?: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenAt?: string | null;
  hiddenAt?: string | null;
  detail?: WillhabenDetail;
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
  includeImages: boolean;
  enableActions: boolean;
  webhookToken: string | null;
  pollingEnabled: boolean;
  pollingOffset: number | null;
};

export type FlatfinderState = {
  updatedAt: string | null;
  lastScrapeAt?: string | null;
  lastWohnungenFetchAt?: string | null;
  lastPlanungsprojekteFetchAt?: string | null;
  lastWillhabenFetchAt?: string | null;
  planungsprojekte: PlanungsprojektRecord[];
  wohnungen: WohnungRecord[];
  willhaben: WillhabenRecord[];
  rateLimit: RateLimitState;
};

const currentMonth = () => new Date().toISOString().slice(0, 7);

const telegramConfigKey = "telegram.config";
const metaKeys = {
  updatedAt: "state.updatedAt",
  lastScrapeAt: "state.lastScrapeAt",
  lastWohnungenFetchAt: "state.lastWohnungenFetchAt",
  lastPlanungsprojekteFetchAt: "state.lastPlanungsprojekteFetchAt",
  lastWillhabenFetchAt: "state.lastWillhabenFetchAt",
  rateLimit: "state.rateLimit",
} as const;

export const defaultTelegramConfig = (): TelegramConfig => ({
  enabled: false,
  botToken: null,
  chatId: null,
  includeImages: true,
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
  includeImages: raw?.includeImages !== false,
  enableActions: Boolean(raw?.enableActions),
  webhookToken: typeof raw?.webhookToken === "string" ? raw.webhookToken : null,
  pollingEnabled: Boolean(raw?.pollingEnabled),
  pollingOffset: typeof raw?.pollingOffset === "number" ? raw.pollingOffset : null,
});

const defaultState = (): FlatfinderState => ({
  updatedAt: null,
  lastScrapeAt: null,
  lastWohnungenFetchAt: null,
  lastPlanungsprojekteFetchAt: null,
  lastWillhabenFetchAt: null,
  planungsprojekte: [],
  wohnungen: [],
  willhaben: [],
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
    planungsprojekte: loadItems<PlanungsprojektRecord>("wohnberatung", "planungsprojekte"),
    wohnungen: loadItems<WohnungRecord>("wohnberatung", "wohnungen"),
    willhaben: loadItems<WillhabenRecord>("willhaben", "wohnungen"),
    rateLimit,
  };
};

export const saveState = async (state: FlatfinderState) => {
  ensureDb();
  const updatedAt = state.updatedAt ?? new Date().toISOString();
  saveItems("wohnberatung", "wohnungen", state.wohnungen, updatedAt);
  saveItems("wohnberatung", "planungsprojekte", state.planungsprojekte, updatedAt);
  saveItems("willhaben", "wohnungen", state.willhaben, updatedAt);

  setMeta(metaKeys.updatedAt, state.updatedAt ?? "");
  setMeta(metaKeys.lastScrapeAt, state.lastScrapeAt ?? "");
  setMeta(metaKeys.lastWohnungenFetchAt, state.lastWohnungenFetchAt ?? "");
  setMeta(metaKeys.lastPlanungsprojekteFetchAt, state.lastPlanungsprojekteFetchAt ?? "");
  setMeta(metaKeys.lastWillhabenFetchAt, state.lastWillhabenFetchAt ?? "");
  setMeta(metaKeys.rateLimit, JSON.stringify(state.rateLimit ?? defaultState().rateLimit));
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

export { defaultState };
