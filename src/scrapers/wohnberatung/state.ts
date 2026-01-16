import fs from "node:fs/promises";
import path from "node:path";
import { STATE_PATH } from "./constants.js";
import type { Planungsprojekt } from "./parse-planungsprojekte.js";
import type { WohnungDetail } from "./parse-wohnung-detail.js";
import type { WohnungListItem } from "./parse-wohnungen-list.js";

export type PlanungsprojektDetail = {
  lageplanUrl: string | null;
  imageUrls: string[];
};

export type PlanungsprojektRecord = Planungsprojekt & {
  firstSeenAt: string;
  lastSeenAt: string;
  detail?: PlanungsprojektDetail;
};

export type WohnungRecord = WohnungListItem & {
  source: "gefoerdert" | "gemeinde";
  firstSeenAt: string;
  lastSeenAt: string;
  detail?: WohnungDetail;
  assets?: {
    thumbnail?: string | null;
    mapImage?: string | null;
    images?: string[];
  };
};

export type RateLimitState = {
  month: string;
  count: number;
};

export type FlatfinderState = {
  updatedAt: string | null;
  planungsprojekte: PlanungsprojektRecord[];
  wohnungen: WohnungRecord[];
  rateLimit: RateLimitState;
};

const defaultState = (): FlatfinderState => ({
  updatedAt: null,
  planungsprojekte: [],
  wohnungen: [],
  rateLimit: {
    month: new Date().toISOString().slice(0, 7),
    count: 0,
  },
});

const normalizePlanungsprojekt = (item: PlanungsprojektRecord) => {
  const { detail, ...rest } = item;
  return {
    ...rest,
    detail: detail
      ? {
          lageplanUrl: detail.lageplanUrl ?? null,
          imageUrls: Array.isArray(detail.imageUrls) ? detail.imageUrls : [],
        }
      : undefined,
  } as PlanungsprojektRecord;
};

const normalizeWohnung = (item: WohnungRecord) => {
  const { detail, assets, ...rest } = item;
  return {
    ...rest,
    detail: detail
      ? {
          superfoerderung: detail.superfoerderung ?? null,
          mapUrl: detail.mapUrl ?? null,
          mapImageUrl: detail.mapImageUrl ?? null,
          imageUrls: Array.isArray(detail.imageUrls) ? detail.imageUrls : [],
        }
      : undefined,
    assets: assets
      ? {
          thumbnail: assets.thumbnail ?? null,
          mapImage: assets.mapImage ?? null,
          images: Array.isArray(assets.images) ? assets.images : [],
        }
      : undefined,
  } as WohnungRecord;
};

const normalizeState = (raw: FlatfinderState | null | undefined): FlatfinderState => {
  if (!raw) return defaultState();
  return {
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    planungsprojekte: Array.isArray(raw.planungsprojekte)
      ? raw.planungsprojekte.map(normalizePlanungsprojekt)
      : [],
    wohnungen: Array.isArray(raw.wohnungen) ? raw.wohnungen.map(normalizeWohnung) : [],
    rateLimit: {
      month: raw.rateLimit?.month ?? new Date().toISOString().slice(0, 7),
      count: typeof raw.rateLimit?.count === "number" ? raw.rateLimit.count : 0,
    },
  };
};

export const loadState = async (): Promise<FlatfinderState> => {
  try {
    const data = await fs.readFile(STATE_PATH, "utf8");
    return normalizeState(JSON.parse(data) as FlatfinderState);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultState();
    }
    throw error;
  }
};

export const saveState = async (state: FlatfinderState) => {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(normalizeState(state), null, 2), "utf8");
};
