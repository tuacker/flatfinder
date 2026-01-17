import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "./config.js";
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
};

export type RateLimitState = {
  month: string;
  count: number;
};

export type FlatfinderState = {
  updatedAt: string | null;
  lastScrapeAt?: string | null;
  planungsprojekte: PlanungsprojektRecord[];
  wohnungen: WohnungRecord[];
  rateLimit: RateLimitState;
};

const currentMonth = () => new Date().toISOString().slice(0, 7);

const defaultState = (): FlatfinderState => ({
  updatedAt: null,
  lastScrapeAt: null,
  planungsprojekte: [],
  wohnungen: [],
  rateLimit: {
    month: currentMonth(),
    count: 0,
  },
});

const normalizeState = (raw: FlatfinderState | null | undefined): FlatfinderState => {
  if (!raw) return defaultState();
  return {
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    lastScrapeAt: typeof raw.lastScrapeAt === "string" ? raw.lastScrapeAt : null,
    planungsprojekte: Array.isArray(raw.planungsprojekte) ? raw.planungsprojekte : [],
    wohnungen: Array.isArray(raw.wohnungen) ? raw.wohnungen : [],
    rateLimit: {
      month: typeof raw.rateLimit?.month === "string" ? raw.rateLimit.month : currentMonth(),
      count: typeof raw.rateLimit?.count === "number" ? raw.rateLimit.count : 0,
    },
  };
};

export const loadState = async (): Promise<FlatfinderState> => {
  try {
    const data = await fs.readFile(statePath, "utf8");
    return normalizeState(JSON.parse(data) as FlatfinderState);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultState();
    }
    throw error;
  }
};

export const saveState = async (state: FlatfinderState) => {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
};
