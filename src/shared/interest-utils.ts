import { comparePriority } from "./interest-priority.js";
import { INTEREST_REFRESH_INTERVAL_MS, INTEREST_WATCH_JITTER_MS } from "./constants.js";
import type { InterestInfo } from "../state/flatfinder-state.js";

type SignedItem = { flags: { angemeldet: boolean }; interest?: InterestInfo };

export const ensureInterest = <T extends { interest?: InterestInfo }>(item: T) => {
  if (!item.interest) item.interest = {};
  return item.interest;
};

export const clearWatch = (item: { interest?: { watch?: { nextCheckAt?: string | null } } }) => {
  if (!item.interest) return;
  item.interest.watch = undefined;
};

export const markSigned = (
  item: { flags: { angemeldet: boolean }; interest?: InterestInfo },
  nowIso: string,
) => {
  item.flags.angemeldet = true;
  const interest = ensureInterest(item);
  interest.requestedAt = interest.requestedAt ?? nowIso;
  clearWatch(item);
};

export const isLocked = (item: {
  flags?: { angemeldet?: boolean };
  interest?: { locked?: boolean | null };
}) => Boolean(item.flags?.angemeldet && item.interest?.locked);

export const getSignedItems = <T extends SignedItem>(items: T[]) =>
  items.filter((item) => item.flags.angemeldet);

export const getSwapCandidates = <T extends SignedItem>(items: T[]) =>
  getSignedItems(items).filter((item) => !isLocked(item));

export const getWorstSignedItem = <
  T extends { interest?: { rank?: number | null; requestedAt?: string } },
>(
  items: T[],
) => {
  if (items.length === 0) return null;
  return items.reduce((worst, current) => {
    if (comparePriority(current, worst) > 0) return current;
    return worst;
  }, items[0]);
};

export const shouldWatchWhenFull = (
  candidate: { interest?: { rank?: number | null; requestedAt?: string | null } },
  signedItems: Array<{
    flags?: { angemeldet?: boolean };
    interest?: { rank?: number | null; requestedAt?: string | null; locked?: boolean | null };
  }>,
) => {
  const worst = getWorstSignedItem(signedItems);
  if (!worst) return false;
  return comparePriority(candidate, worst) < 0;
};

const stableHash = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

export const getWatchDelayMs = (id?: string | null) => {
  if (!id) return INTEREST_REFRESH_INTERVAL_MS;
  const jitter = stableHash(id) % INTEREST_WATCH_JITTER_MS;
  return INTEREST_REFRESH_INTERVAL_MS + jitter;
};

export const scheduleWatch = (item: {
  id?: string | null;
  interest?: { watch?: { nextCheckAt?: string | null } };
}) => {
  const nextCheckAt = new Date(Date.now() + getWatchDelayMs(item.id)).toISOString();
  const interest = ensureInterest(item);
  interest.watch = {
    ...interest.watch,
    nextCheckAt,
  };
};

export const getNextWatchAt = (
  items: Array<{ interest?: { watch?: { nextCheckAt?: string | null } } }>,
) => {
  let nextAt: number | null = null;
  for (const item of items) {
    const nextCheckAt = item.interest?.watch?.nextCheckAt;
    if (!nextCheckAt) continue;
    const time = new Date(nextCheckAt).getTime();
    if (!Number.isFinite(time)) continue;
    if (nextAt === null || time < nextAt) nextAt = time;
  }
  return nextAt;
};
