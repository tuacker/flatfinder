import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assetsDir,
  baseUrl,
  planungsprojekteIntervalMinutes,
  rateLimitMonthly,
  storageStatePath,
  wohnungssucheIntervalMinutes,
} from "./scrapers/wohnberatung/config.js";
import {
  createRateLimiter,
  scrapePlanungsprojekte,
  scrapeWohnungen,
} from "./scrapers/wohnberatung/wohnberatung-service.js";
import { loadState, saveState, type InterestInfo } from "./scrapers/wohnberatung/state.js";
import { getNextRefreshFallback, renderFragments, renderPage } from "../ui/render.js";

const port = 3000;

const nextRefresh = { wohnungen: 0, planungsprojekte: 0 };

type StorageStateCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
};

const loadAuthCookies = async (): Promise<string> => {
  const raw = await fs.readFile(storageStatePath, "utf8");
  const parsed = JSON.parse(raw) as { cookies?: StorageStateCookie[] } | null;
  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const serialized = cookies
    .filter((cookie) => cookie.domain?.includes("wohnberatung-wien.at"))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  return serialized;
};

const buildWohnberatungUrl = (page: "wohnung" | "projekt", id: string, flag?: string) => {
  const url = new URL(baseUrl);
  url.searchParams.set("page", page);
  url.searchParams.set("id", id);
  if (flag) {
    url.searchParams.set(flag, "true");
  }
  return url.toString();
};

const fetchWohnberatungHtml = async (url: string, cookieHeader: string) => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      cookie: cookieHeader,
      "user-agent": "flatfinder",
    },
  });
  const html = await response.text();
  return { response, html };
};

const signupLimit = 3;
const interestRefreshIntervalMs = 15_000;

const detectInterestResult = (html: string) => {
  if (/Sie haben sich unverbindlich angemeldet/i.test(html)) return "signed";
  if (/kein Interesse mehr/i.test(html)) return "signed";
  if (/maximale Anzahl an Interessent/i.test(html)) return "full";
  if (/maximale Anzahl.*Anmeld/i.test(html)) return "limit";
  if (/nur\s*3\s*Wohnung/i.test(html)) return "limit";
  if (/bereits\s*3\s*Wohnung/i.test(html)) return "limit";
  if (/unverbindlich anmelden/i.test(html)) return "available";
  return "unknown";
};

const detectSignedFromResponse = (html: string) => {
  const result = detectInterestResult(html);
  if (result === "signed") return true;
  if (result === "available" || result === "full" || result === "limit") return false;
  return null;
};

const isSignupAvailable = (html: string) =>
  /unverbindlich anmelden/i.test(html) && !/maximale Anzahl an Interessent/i.test(html);

const getCollection = (state: Awaited<ReturnType<typeof loadState>>, type: string) =>
  type === "wohnungen"
    ? state.wohnungen
    : type === "planungsprojekte"
      ? state.planungsprojekte
      : null;

const getRequestedAtValue = (value: string | null | undefined) => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
};

const getPriority = (item: {
  interest?: { rank?: number | null; requestedAt?: string | null };
}) => {
  const rank = item.interest?.rank;
  if (typeof rank === "number") {
    return { bucket: 0, value: rank };
  }
  return { bucket: 1, value: getRequestedAtValue(item.interest?.requestedAt) };
};

const comparePriority = (
  left: { interest?: { rank?: number | null; requestedAt?: string | null } },
  right: { interest?: { rank?: number | null; requestedAt?: string | null } },
) => {
  const leftPriority = getPriority(left);
  const rightPriority = getPriority(right);
  if (leftPriority.bucket !== rightPriority.bucket) {
    return leftPriority.bucket - rightPriority.bucket;
  }
  if (leftPriority.value < rightPriority.value) return -1;
  if (leftPriority.value > rightPriority.value) return 1;
  return 0;
};

const sortByPriority = <T extends { interest?: { rank?: number | null; requestedAt?: string } }>(
  items: T[],
) => [...items].sort(comparePriority);

const isLocked = (item: {
  flags?: { angemeldet?: boolean };
  interest?: { locked?: boolean | null };
}) => Boolean(item.flags?.angemeldet && item.interest?.locked);

const getSignedItems = (
  items: Array<{
    flags: { angemeldet: boolean };
    interest?: { rank?: number | null; requestedAt?: string | null; locked?: boolean | null };
  }>,
) => items.filter((item) => item.flags.angemeldet);

const getSwapCandidates = (
  items: Array<{
    flags: { angemeldet: boolean };
    interest?: { rank?: number | null; requestedAt?: string | null; locked?: boolean | null };
  }>,
) => getSignedItems(items).filter((item) => !isLocked(item));

const getWorstSignedItem = (
  items: Array<{ id?: string | null; interest?: { rank?: number | null; requestedAt?: string } }>,
) => {
  if (items.length === 0) return null;
  return items.reduce((worst, current) => {
    if (comparePriority(current, worst) > 0) return current;
    return worst;
  }, items[0]);
};

const shouldWatchWhenFull = (
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

const getWatchDelayMs = (id?: string | null) => {
  if (!id) return interestRefreshIntervalMs;
  const jitter = stableHash(id) % 4000;
  return interestRefreshIntervalMs + jitter;
};

const scheduleWatch = (item: {
  id?: string | null;
  interest?: { watch?: { nextCheckAt?: string | null } };
}) => {
  const nextCheckAt = new Date(Date.now() + getWatchDelayMs(item.id)).toISOString();
  if (!item.interest) item.interest = {};
  item.interest.watch = {
    ...item.interest.watch,
    nextCheckAt,
  };
};

const clearWatch = (item: { interest?: { watch?: { nextCheckAt?: string | null } } }) => {
  if (!item.interest) return;
  item.interest.watch = undefined;
};

const executeSwap = async (options: {
  type: "wohnungen" | "planungsprojekte";
  target: { id?: string | null; flags: { angemeldet: boolean }; interest?: InterestInfo };
  drop: { id?: string | null; flags: { angemeldet: boolean }; interest?: InterestInfo };
  cookieHeader: string;
  nowIso: string;
}) => {
  const { type, target, drop, cookieHeader, nowIso } = options;
  if (!target.id || !drop.id) return { swapped: false };
  if (isLocked(drop)) return { swapped: false, result: "locked" };
  const page = type === "wohnungen" ? "wohnung" : "projekt";
  const dropSnapshot = drop.interest ? { ...drop.interest } : undefined;

  const { html: dropHtml } = await fetchWohnberatungHtml(
    buildWohnberatungUrl(page, drop.id, "delete_confirm"),
    cookieHeader,
  );
  const dropSigned = detectSignedFromResponse(dropHtml);
  if (typeof dropSigned === "boolean") {
    drop.flags.angemeldet = dropSigned;
  }
  drop.interest = {
    ...drop.interest,
    watch: undefined,
  };

  if (!target.interest) target.interest = {};
  const { html: confirmHtml } = await fetchWohnberatungHtml(
    buildWohnberatungUrl(page, target.id, "anmelden_confirm"),
    cookieHeader,
  );
  const targetSigned = detectSignedFromResponse(confirmHtml);
  const result = detectInterestResult(confirmHtml);
  if (targetSigned === true) {
    target.flags.angemeldet = true;
    clearWatch(target);
    return { swapped: true, result };
  }

  scheduleWatch(target);

  if (drop.id) {
    const { html: restoreHtml } = await fetchWohnberatungHtml(
      buildWohnberatungUrl(page, drop.id, "anmelden_confirm"),
      cookieHeader,
    );
    const restoreSigned = detectSignedFromResponse(restoreHtml);
    if (restoreSigned === true) {
      drop.flags.angemeldet = true;
      drop.interest = dropSnapshot ?? { requestedAt: nowIso, rank: null };
    }
  }

  return { swapped: false, result };
};

const fillOpenSlots = async (options: {
  type: "wohnungen" | "planungsprojekte";
  cookieHeader: string;
  nowIso: string;
}) => {
  const { type, cookieHeader, nowIso } = options;
  const collection = getCollection(state, type);
  if (!collection) return false;
  let signedItems = getSignedItems(collection);
  let signedCount = signedItems.length;
  if (signedCount >= signupLimit) return false;

  const candidates = sortByPriority(
    collection.filter((item) =>
      Boolean(item.id && item.interest?.requestedAt && !item.flags.angemeldet),
    ),
  );

  let didUpdate = false;
  for (const item of candidates) {
    if (signedCount >= signupLimit) break;
    if (!item.id) continue;
    const page = type === "wohnungen" ? "wohnung" : "projekt";
    const { html } = await fetchWohnberatungHtml(buildWohnberatungUrl(page, item.id), cookieHeader);
    const signedFromDetail = detectSignedFromResponse(html);
    if (signedFromDetail === true) {
      item.flags.angemeldet = true;
      item.interest = {
        ...item.interest,
        requestedAt: item.interest?.requestedAt ?? nowIso,
      };
      clearWatch(item);
      signedCount += 1;
      signedItems = getSignedItems(collection);
      didUpdate = true;
      continue;
    }

    if (!isSignupAvailable(html)) {
      scheduleWatch(item);
      didUpdate = true;
      continue;
    }

    const { html: confirmHtml } = await fetchWohnberatungHtml(
      buildWohnberatungUrl(page, item.id, "anmelden_confirm"),
      cookieHeader,
    );
    const signedStatus = detectSignedFromResponse(confirmHtml);
    if (signedStatus === true) {
      item.flags.angemeldet = true;
      item.interest = {
        ...item.interest,
        requestedAt: item.interest?.requestedAt ?? nowIso,
      };
      clearWatch(item);
      signedCount += 1;
      signedItems = getSignedItems(collection);
      didUpdate = true;
    } else {
      scheduleWatch(item);
      didUpdate = true;
    }
  }

  return didUpdate;
};

const getNextRefreshAt = () => {
  const scheduled = [nextRefresh.wohnungen, nextRefresh.planungsprojekte].filter(
    (value) => value > 0,
  );
  return scheduled.length ? Math.min(...scheduled) : 0;
};

const getNextRefreshAtWithFallback = () => getNextRefreshAt() || getNextRefreshFallback();

let queue = Promise.resolve();
let interestQueue = Promise.resolve();
let scheduleInterestRefresh: () => void = () => {};

const runExclusive = (name: string, job: () => Promise<void>) => {
  queue = queue
    .catch(() => undefined)
    .then(async () => {
      try {
        await job();
      } catch (error) {
        console.error(`[${name}]`, error instanceof Error ? error.message : error);
      }
    });
  return queue;
};

const runInterestExclusive = (name: string, job: () => Promise<void>) => {
  interestQueue = interestQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        await job();
      } catch (error) {
        console.error(`[${name}]`, error instanceof Error ? error.message : error);
      }
    });
  return interestQueue;
};

const scheduleJob = (
  name: "wohnungssuche" | "planungsprojekte",
  intervalMs: number,
  job: () => Promise<void>,
  onSchedule: (nextAt: number) => void,
) => {
  let pending = false;

  const run = () => {
    if (pending) return;
    pending = true;
    const nextAt = Date.now() + intervalMs;
    onSchedule(nextAt);
    void runExclusive(name, async () => {
      try {
        await job();
      } finally {
        pending = false;
      }
    });
  };

  void run();
  setInterval(run, intervalMs);
};

const ensureStorageState = async () => {
  try {
    await fs.access(storageStatePath);
  } catch {
    throw new Error(
      "Missing storage state. Run `npm run scrape:wohnberatung:login` first to save cookies.",
    );
  }
};

const main = async () => {
  await ensureStorageState();
  const state = await loadState();

  const app = express();
  app.use(express.json());
  app.use("/assets", express.static(path.resolve(assetsDir)));
  app.use(express.static(path.resolve("public")));

  const clients = new Set<express.Response>();

  const notifyClients = () => {
    const payload = JSON.stringify({
      updatedAt: state.updatedAt,
      nextRefresh: getNextRefreshAtWithFallback(),
    });
    for (const client of clients) {
      client.write(`data: ${payload}\n\n`);
    }
  };

  let interestRefreshRunning = false;
  let interestRefreshTimer: NodeJS.Timeout | null = null;

  const getNextInterestCheckAt = () => {
    let nextAt: number | null = null;
    const all = [...state.wohnungen, ...state.planungsprojekte];
    for (const item of all) {
      const nextCheckAt = item.interest?.watch?.nextCheckAt;
      if (!nextCheckAt) continue;
      const time = new Date(nextCheckAt).getTime();
      if (!Number.isFinite(time)) continue;
      if (nextAt === null || time < nextAt) nextAt = time;
    }
    return nextAt;
  };

  scheduleInterestRefresh = () => {
    if (interestRefreshTimer) clearTimeout(interestRefreshTimer);
    const now = Date.now();
    const nextAt = getNextInterestCheckAt();
    const delay = nextAt === null ? interestRefreshIntervalMs : Math.max(0, nextAt - now);
    interestRefreshTimer = setTimeout(() => {
      interestRefreshTimer = null;
      void runInterestRefresh();
    }, delay);
  };

  const runInterestRefresh = async () => {
    if (interestRefreshRunning) return;
    interestRefreshRunning = true;
    await runInterestExclusive("interest-refresh", async () => {
      try {
        const cookieHeader = await loadAuthCookies();
        if (!cookieHeader) return;

        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        let didUpdate = false;

        const processType = async (type: "wohnungen" | "planungsprojekte") => {
          const collection = getCollection(state, type);
          if (!collection) return;
          let signedItems = getSignedItems(collection);
          let signedCount = signedItems.length;
          let swapCandidates = getSwapCandidates(collection);

          for (const item of collection) {
            if (!item.id) continue;
            if (item.flags.angemeldet) {
              if (item.interest?.watch) {
                clearWatch(item);
                didUpdate = true;
              }
              continue;
            }
            if (!item.interest?.requestedAt) {
              if (item.interest?.watch) {
                clearWatch(item);
                didUpdate = true;
              }
              continue;
            }
          }

          const candidates = sortByPriority(
            collection.filter((item) =>
              Boolean(item.id && item.interest?.requestedAt && !item.flags.angemeldet),
            ),
          );

          for (const item of candidates) {
            if (!item.id) continue;

            const shouldWatch =
              signedCount < signupLimit || shouldWatchWhenFull(item, swapCandidates);
            if (!shouldWatch) {
              if (item.interest?.watch) {
                clearWatch(item);
                didUpdate = true;
              }
              continue;
            }

            const nextCheckAt = item.interest?.watch?.nextCheckAt;
            if (nextCheckAt && new Date(nextCheckAt).getTime() > now) {
              continue;
            }

            const page = type === "wohnungen" ? "wohnung" : "projekt";
            const { html } = await fetchWohnberatungHtml(
              buildWohnberatungUrl(page, item.id),
              cookieHeader,
            );
            const signedFromDetail = detectSignedFromResponse(html);
            if (signedFromDetail === true) {
              item.flags.angemeldet = true;
              clearWatch(item);
              signedCount += 1;
              signedItems = getSignedItems(collection);
              swapCandidates = getSwapCandidates(collection);
              didUpdate = true;
              continue;
            }
            item.interest.watch = {
              lastCheckAt: nowIso,
              nextCheckAt: new Date(now + getWatchDelayMs(item.id)).toISOString(),
            };
            didUpdate = true;

            const available = isSignupAvailable(html);
            if (!available) continue;

            if (signedCount < signupLimit) {
              const { html: confirmHtml } = await fetchWohnberatungHtml(
                buildWohnberatungUrl(page, item.id, "anmelden_confirm"),
                cookieHeader,
              );
              const signedStatus = detectSignedFromResponse(confirmHtml);
              if (signedStatus === true) {
                item.flags.angemeldet = true;
                clearWatch(item);
                signedCount += 1;
                signedItems = getSignedItems(collection);
                swapCandidates = getSwapCandidates(collection);
                didUpdate = true;
              } else {
                scheduleWatch(item);
                didUpdate = true;
              }
              continue;
            }

            if (shouldWatchWhenFull(item, swapCandidates)) {
              const worst = getWorstSignedItem(swapCandidates);
              if (worst) {
                const swapResult = await executeSwap({
                  type,
                  target: item,
                  drop: worst,
                  cookieHeader,
                  nowIso,
                });
                if (swapResult.swapped) {
                  signedItems = getSignedItems(collection);
                  signedCount = signedItems.length;
                  swapCandidates = getSwapCandidates(collection);
                }
                didUpdate = true;
              }
            }
          }
        };

        await processType("wohnungen");
        await processType("planungsprojekte");

        if (didUpdate) {
          state.updatedAt = nowIso;
          await saveState(state);
          notifyClients();
        }
      } catch (error) {
        console.error("[interest-refresh]", error instanceof Error ? error.message : error);
      } finally {
        interestRefreshRunning = false;
        scheduleInterestRefresh();
      }
    });
  };

  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const initialPayload = JSON.stringify({
      updatedAt: state.updatedAt,
      nextRefresh: getNextRefreshAtWithFallback(),
    });
    res.write(`data: ${initialPayload}\n\n`);
    clients.add(res);
    req.on("close", () => {
      clients.delete(res);
    });
  });

  app.post("/api/items/:type/:id", async (req, res) => {
    const { type, id } = req.params;
    const action = (req.body as { action?: string } | undefined)?.action;

    const collection =
      type === "wohnungen"
        ? state.wohnungen
        : type === "planungsprojekte"
          ? state.planungsprojekte
          : null;

    if (!collection) {
      res.status(400).json({ error: "Unknown item type." });
      return;
    }

    const item = collection.find((entry) => entry.id === id);
    if (!item) {
      res.status(404).json({ error: "Item not found." });
      return;
    }

    const now = new Date().toISOString();

    if (action === "toggleSeen") {
      item.seenAt = item.seenAt ? null : now;
    } else if (action === "toggleHidden") {
      item.hiddenAt = item.hiddenAt ? null : now;
    } else {
      res.status(400).json({ error: "Unknown action." });
      return;
    }

    state.updatedAt = now;
    await saveState(state);
    notifyClients();

    res.json({
      ok: true,
      updatedAt: now,
      item: { seenAt: item.seenAt ?? null, hiddenAt: item.hiddenAt ?? null },
    });
  });

  app.get("/favicon.ico", (_, res) => res.status(204).end());
  app.post("/api/interest/:type/:id", async (req, res) => {
    const { type, id } = req.params;
    const action = (req.body as { action?: string; confirm?: boolean } | undefined)?.action;
    const confirm =
      (req.body as { action?: string; confirm?: boolean } | undefined)?.confirm ?? false;

    if (!id || !action) {
      res.status(400).json({ ok: false, message: "Missing action or id." });
      return;
    }

    const collection = getCollection(state, type);
    if (!collection) {
      res.status(400).json({ ok: false, message: "Unknown item type." });
      return;
    }

    const item = collection.find((entry) => entry.id === id);
    if (!item) {
      res.status(404).json({ ok: false, message: "Item not found." });
      return;
    }

    const page = type === "wohnungen" ? "wohnung" : "projekt";
    const nowIso = new Date().toISOString();

    if (action === "drop") {
      if (item.flags.angemeldet) {
        res.status(400).json({ ok: false, message: "Cannot drop a signed item." });
        return;
      }
      item.interest = {
        ...item.interest,
        requestedAt: null,
        rank: null,
        locked: false,
        watch: undefined,
      };
      state.updatedAt = nowIso;
      await saveState(state);
      notifyClients();
      res.json({ ok: true, signed: item.flags.angemeldet });
      return;
    }

    if (action === "lock" || action === "unlock") {
      if (!item.flags.angemeldet) {
        res.status(400).json({ ok: false, message: "Only signed items can be locked." });
        return;
      }
      if (!item.interest) item.interest = {};
      item.interest.locked = action === "lock";
      state.updatedAt = nowIso;
      await saveState(state);
      notifyClients();
      res.json({ ok: true, signed: item.flags.angemeldet, locked: item.interest.locked });
      return;
    }

    if (action === "remove") {
      if (!confirm) {
        res.status(400).json({ ok: false, message: "Removal requires confirmation." });
        return;
      }
      if (item.interest?.locked) {
        res.status(400).json({ ok: false, message: "Item is locked." });
        return;
      }

      try {
        const cookieHeader = await loadAuthCookies();
        if (!cookieHeader) {
          res.status(400).json({ ok: false, message: "Missing login cookies." });
          return;
        }

        const { response, html } = await fetchWohnberatungHtml(
          buildWohnberatungUrl(page, id, "delete_confirm"),
          cookieHeader,
        );
        const signedStatus = detectSignedFromResponse(html);

        if (typeof signedStatus === "boolean") {
          item.flags.angemeldet = signedStatus;
        }
        const keepInterested = Boolean(
          (req.body as { keepInterested?: boolean } | undefined)?.keepInterested,
        );
        if (!item.interest) item.interest = {};
        item.interest.watch = undefined;
        if (keepInterested) {
          if (!item.interest.requestedAt) item.interest.requestedAt = nowIso;
        } else {
          item.interest.requestedAt = null;
          item.interest.rank = null;
        }
        if (!item.flags.angemeldet) {
          item.interest.locked = false;
        }

        let didFill = false;
        try {
          didFill = await fillOpenSlots({
            type: type as "wohnungen" | "planungsprojekte",
            cookieHeader,
            nowIso: new Date().toISOString(),
          });
        } catch (fillError) {
          console.error(
            "[interest-fill]",
            fillError instanceof Error ? fillError.message : fillError,
          );
        }

        state.updatedAt = new Date().toISOString();
        await saveState(state);
        notifyClients();
        scheduleInterestRefresh();

        res.json({
          ok: response.ok,
          status: response.status,
          signed: item.flags.angemeldet,
          filled: didFill,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          message: error instanceof Error ? error.message : "Interest request failed.",
        });
      }
      return;
    }

    if (!item.interest) item.interest = {};
    if (!item.interest.requestedAt) item.interest.requestedAt = nowIso;

    const signedItems = getSignedItems(collection);
    const signedCount = signedItems.length;
    const swapCandidates = getSwapCandidates(collection);

    try {
      const cookieHeader = await loadAuthCookies();
      if (!cookieHeader) {
        res.status(400).json({ ok: false, message: "Missing login cookies." });
        return;
      }

      if (item.flags.angemeldet) {
        state.updatedAt = nowIso;
        await saveState(state);
        notifyClients();
        scheduleInterestRefresh();
        res.json({ ok: true, signed: true });
        return;
      }

      if (signedCount < signupLimit) {
        const { response, html } = await fetchWohnberatungHtml(
          buildWohnberatungUrl(page, id, "anmelden_confirm"),
          cookieHeader,
        );
        const result = detectInterestResult(html);
        const signedStatus = detectSignedFromResponse(html);

        if (signedStatus === true) {
          item.flags.angemeldet = true;
          clearWatch(item);
        } else if (result === "full" || result === "available" || result === "unknown") {
          scheduleWatch(item);
        }

        state.updatedAt = nowIso;
        await saveState(state);
        notifyClients();
        scheduleInterestRefresh();

        res.json({
          ok: response.ok,
          status: response.status,
          signed: item.flags.angemeldet,
          result,
        });
        return;
      }

      const shouldSwap = shouldWatchWhenFull(item, swapCandidates);
      if (!shouldSwap) {
        clearWatch(item);
        state.updatedAt = nowIso;
        await saveState(state);
        notifyClients();
        scheduleInterestRefresh();
        res.json({ ok: true, signed: false, skipped: "rank" });
        return;
      }

      const { html } = await fetchWohnberatungHtml(buildWohnberatungUrl(page, id), cookieHeader);
      if (!isSignupAvailable(html)) {
        scheduleWatch(item);
        state.updatedAt = nowIso;
        await saveState(state);
        notifyClients();
        scheduleInterestRefresh();
        res.json({ ok: true, signed: false, waiting: true });
        return;
      }

      const worst = getWorstSignedItem(swapCandidates);
      if (worst) {
        const swapResult = await executeSwap({
          type: type as "wohnungen" | "planungsprojekte",
          target: item,
          drop: worst,
          cookieHeader,
          nowIso,
        });
        if (swapResult.swapped) {
          state.updatedAt = nowIso;
          await saveState(state);
          notifyClients();
          scheduleInterestRefresh();
          res.json({ ok: true, signed: item.flags.angemeldet, swapped: true });
          return;
        }
      }
      state.updatedAt = nowIso;
      await saveState(state);
      notifyClients();
      scheduleInterestRefresh();
      res.json({ ok: true, signed: item.flags.angemeldet, swapped: false });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : "Interest request failed.",
      });
    }
  });
  app.post("/api/rank/:type", async (req, res) => {
    const { type } = req.params;
    const order = (req.body as { order?: string[] } | undefined)?.order ?? [];
    const collection = getCollection(state, type);
    if (!collection) {
      res.status(400).json({ ok: false, message: "Unknown item type." });
      return;
    }

    const nowIso = new Date().toISOString();
    const orderSet = new Set(order);

    order.forEach((id, index) => {
      const item = collection.find((entry) => entry.id === id);
      if (!item) return;
      if (!item.interest) item.interest = {};
      item.interest.rank = index + 1;
      if (!item.interest.requestedAt) {
        item.interest.requestedAt = nowIso;
      }
    });

    collection.forEach((item) => {
      if (!item.id) return;
      if (!orderSet.has(item.id) && item.interest?.rank) {
        item.interest.rank = null;
      }
    });

    state.updatedAt = nowIso;
    await saveState(state);
    notifyClients();
    void runInterestRefresh();

    res.json({ ok: true });
  });

  app.get("/api/fragment", (_, res) =>
    res.json(renderFragments(state, { nextRefreshAt: getNextRefreshAtWithFallback() })),
  );
  app.get("/api/state", (_, res) => res.json(state));
  app.get(["/hidden", "/interested"], (_, res) =>
    res.send(renderPage(state, { nextRefreshAt: getNextRefreshAtWithFallback() })),
  );
  app.get("/", (_, res) =>
    res.send(renderPage(state, { nextRefreshAt: getNextRefreshAtWithFallback() })),
  );

  app.listen(port, () => {
    console.log(`Flatfinder server running on http://localhost:${port}`);
  });

  const rateLimiter = createRateLimiter(state, rateLimitMonthly);
  void runInterestRefresh();
  scheduleInterestRefresh();

  scheduleJob(
    "wohnungssuche",
    wohnungssucheIntervalMinutes * 60 * 1000,
    async () => {
      await scrapeWohnungen(state, rateLimiter);
      state.lastScrapeAt = new Date().toISOString();
      await saveState(state);
      notifyClients();
    },
    (nextAt) => {
      nextRefresh.wohnungen = nextAt;
      notifyClients();
    },
  );

  scheduleJob(
    "planungsprojekte",
    planungsprojekteIntervalMinutes * 60 * 1000,
    async () => {
      await scrapePlanungsprojekte(state, rateLimiter);
      state.lastScrapeAt = new Date().toISOString();
      await saveState(state);
      notifyClients();
    },
    (nextAt) => {
      nextRefresh.planungsprojekte = nextAt;
      notifyClients();
    },
  );
};

void main();
