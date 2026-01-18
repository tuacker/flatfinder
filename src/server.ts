import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assetsDir,
  planungsprojekteIntervalMinutes,
  rateLimitMonthly,
  storageStatePath,
  wohnungssucheIntervalMinutes,
} from "./scrapers/wohnberatung/config.js";
import { createRateLimiter } from "./scrapers/wohnberatung/wohnberatung-service.js";
import {
  loadState,
  saveState,
  defaultTelegramConfig,
  loadTelegramConfig,
  saveTelegramConfig,
  type InterestInfo,
  type TelegramConfig,
} from "./scrapers/wohnberatung/state.js";
import {
  renderFragments,
  renderPage,
  type WillhabenFilters,
  type WillhabenSortDir,
  type WillhabenSortKey,
} from "../ui/render.js";
import { willhabenRefreshIntervalMs } from "./scrapers/willhaben/config.js";
import { fetchTelegramUpdates, sendTelegramMessage, telegramRequest } from "./telegram.js";
import { createSerialQueue } from "./runtime/scheduler.js";
import { registerScraperJobs } from "./runtime/scraper-jobs.js";
import { sortByPriority } from "./shared/interest-priority.js";
import { INTEREST_REFRESH_INTERVAL_MS, SIGNUP_LIMIT } from "./shared/constants.js";
import { getCollection, getPageForType } from "./shared/collections.js";
import {
  clearWatch,
  ensureInterest,
  getNextWatchAt,
  getSignedItems,
  getSwapCandidates,
  getWorstSignedItem,
  isLocked,
  markSigned,
  scheduleWatch,
  shouldWatchWhenFull,
} from "./shared/interest-utils.js";
import {
  detectInterestResult,
  detectSignedFromResponse,
  isSignupAvailable,
} from "./scrapers/wohnberatung/interest-response.js";
import {
  buildWohnberatungUrl,
  fetchWohnberatungHtml,
  loadAuthCookies,
} from "./scrapers/wohnberatung/wohnberatung-client.js";

const port = 3000;

const nextRefresh: Record<"wohnungen" | "planungsprojekte" | "willhaben", number> = {
  wohnungen: 0,
  planungsprojekte: 0,
  willhaben: 0,
};

const nowIso = () => new Date().toISOString();
type SourceFilter = "all" | "wohnberatung" | "willhaben";
const parseListParam = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry).split(","))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const parseWillhabenFilters = (query: Record<string, unknown>): WillhabenFilters => {
  const sortKeyRaw = query.wh_sort;
  const sortDirRaw = query.wh_dir;
  const sortKey: WillhabenSortKey =
    sortKeyRaw === "price" || sortKeyRaw === "area" ? sortKeyRaw : null;
  const sortDir: WillhabenSortDir =
    sortDirRaw === "asc" || sortDirRaw === "desc" ? sortDirRaw : null;
  return {
    sortKey: sortKey && sortDir ? sortKey : null,
    sortDir: sortKey && sortDir ? sortDir : null,
    districts: parseListParam(query.wh_districts),
    rooms: parseListParam(query.wh_rooms),
  };
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
  const page = getPageForType(type);
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

  const { html: confirmHtml } = await fetchWohnberatungHtml(
    buildWohnberatungUrl(page, target.id, "anmelden_confirm"),
    cookieHeader,
  );
  const targetSigned = detectSignedFromResponse(confirmHtml);
  const result = detectInterestResult(confirmHtml);
  if (targetSigned === true) {
    markSigned(target, nowIso);
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
  if (signedCount >= SIGNUP_LIMIT) return false;

  const candidates = sortByPriority(
    collection.filter((item) =>
      Boolean(item.id && item.interest?.requestedAt && !item.flags.angemeldet),
    ),
  );

  let didUpdate = false;
  for (const item of candidates) {
    if (signedCount >= SIGNUP_LIMIT) break;
    if (!item.id) continue;
    const page = getPageForType(type);
    const { html } = await fetchWohnberatungHtml(buildWohnberatungUrl(page, item.id), cookieHeader);
    const signedFromDetail = detectSignedFromResponse(html);
    if (signedFromDetail === true) {
      markSigned(item, nowIso);
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
      markSigned(item, nowIso);
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

const getNextRefreshAtFor = (keys: Array<keyof typeof nextRefresh>) => {
  const scheduled = keys.map((key) => nextRefresh[key]).filter((value) => value > 0);
  return scheduled.length ? Math.min(...scheduled) : 0;
};

const getNextWohnberatungRefreshAt = () => getNextRefreshAtFor(["wohnungen", "planungsprojekte"]);

const getNextWillhabenRefreshAt = () => getNextRefreshAtFor(["willhaben"]);

const getNextWillhabenRefreshAtWithFallback = () =>
  getNextWillhabenRefreshAt() || Date.now() + willhabenRefreshIntervalMs;

const getNextWohnberatungRefreshAtWithFallback = () =>
  getNextWohnberatungRefreshAt() ||
  Date.now() + Math.min(wohnungssucheIntervalMinutes, planungsprojekteIntervalMinutes) * 60 * 1000;

const getSourceFilter = (value: unknown): SourceFilter => {
  if (value === "wohnberatung" || value === "willhaben") return value;
  return "all";
};

const buildRenderOptions = (query: Record<string, unknown>) => ({
  sourceFilter: getSourceFilter(query.source),
  willhabenFilters: parseWillhabenFilters(query),
  wohnberatungNextRefreshAt: getNextWohnberatungRefreshAtWithFallback(),
  willhabenNextRefreshAt: getNextWillhabenRefreshAtWithFallback(),
});

const buildFragmentOptions = (query: Record<string, unknown>) => ({
  willhabenFilters: parseWillhabenFilters(query),
  wohnberatungNextRefreshAt: getNextWohnberatungRefreshAtWithFallback(),
  willhabenNextRefreshAt: getNextWillhabenRefreshAtWithFallback(),
});

let scheduleInterestRefresh: () => void = () => {};

const runExclusive = createSerialQueue();
const runInterestExclusive = createSerialQueue();

const ensureStorageState = async () => {
  try {
    await fs.access(storageStatePath);
  } catch {
    throw new Error(
      "Missing storage state. Run `npm run scrape:wohnberatung:login` first to save cookies.",
    );
  }
};

let state: Awaited<ReturnType<typeof loadState>>;

const main = async () => {
  await ensureStorageState();
  state = await loadState();
  let telegramConfig = await loadTelegramConfig();

  const app = express();
  app.use(express.json());
  app.use("/assets", express.static(path.resolve(assetsDir)));
  app.use(express.static(path.resolve("public")));

  const clients = new Set<express.Response>();

  const notifyClients = () => {
    const payload = JSON.stringify({
      updatedAt: state.updatedAt,
      nextRefreshWohnberatung: getNextWohnberatungRefreshAtWithFallback(),
      nextRefreshWillhaben: getNextWillhabenRefreshAtWithFallback(),
    });
    for (const client of clients) {
      client.write(`data: ${payload}\n\n`);
    }
  };

  const persistState = async (updatedAt: string = nowIso()) => {
    state.updatedAt = updatedAt;
    await saveState(state);
    notifyClients();
    return updatedAt;
  };

  let interestRefreshRunning = false;
  let interestRefreshTimer: NodeJS.Timeout | null = null;

  scheduleInterestRefresh = () => {
    if (interestRefreshTimer) clearTimeout(interestRefreshTimer);
    const now = Date.now();
    const nextAt = getNextWatchAt([...state.wohnungen, ...state.planungsprojekte]);
    const delay = nextAt === null ? INTEREST_REFRESH_INTERVAL_MS : Math.max(0, nextAt - now);
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
        const nowStamp = new Date(now).toISOString();
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
              signedCount < SIGNUP_LIMIT || shouldWatchWhenFull(item, swapCandidates);
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

            const page = getPageForType(type);
            const { html } = await fetchWohnberatungHtml(
              buildWohnberatungUrl(page, item.id),
              cookieHeader,
            );
            const signedFromDetail = detectSignedFromResponse(html);
            if (signedFromDetail === true) {
              markSigned(item, nowStamp);
              signedCount += 1;
              signedItems = getSignedItems(collection);
              swapCandidates = getSwapCandidates(collection);
              didUpdate = true;
              continue;
            }
            const interest = ensureInterest(item);
            interest.watch = {
              ...interest.watch,
              lastCheckAt: nowStamp,
            };
            scheduleWatch(item);
            didUpdate = true;

            const available = isSignupAvailable(html);
            if (!available) continue;

            if (signedCount < SIGNUP_LIMIT) {
              const { html: confirmHtml } = await fetchWohnberatungHtml(
                buildWohnberatungUrl(page, item.id, "anmelden_confirm"),
                cookieHeader,
              );
              const signedStatus = detectSignedFromResponse(confirmHtml);
              if (signedStatus === true) {
                markSigned(item, nowStamp);
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
                  nowIso: nowStamp,
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
          await persistState(nowStamp);
        }
      } catch (error) {
        console.error("[interest-refresh]", error);
      } finally {
        interestRefreshRunning = false;
        scheduleInterestRefresh();
      }
    });
  };

  const ensureTelegramConfig = () => {
    if (!telegramConfig) {
      telegramConfig = defaultTelegramConfig();
    }
    return telegramConfig;
  };

  const persistTelegramConfig = async (config?: TelegramConfig) => {
    if (config) {
      telegramConfig = config;
    }
    await saveTelegramConfig(ensureTelegramConfig());
  };

  const handleTelegramCallback = async (
    config: TelegramConfig,
    callback: { id: string; data?: string } | undefined,
  ) => {
    if (!callback?.data) return;
    if (callback.data === "test:complete") {
      await telegramRequest(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Test complete.",
        show_alert: false,
      });
      if (config.botToken && config.chatId) {
        await sendTelegramMessage(config, "Test complete.");
      }
      return;
    }
    if (!callback.data.startsWith("interest:")) return;
    const [, rawType, id] = callback.data.split(":");
    const type = rawType === "wohnungen" ? "wohnungen" : "planungsprojekte";
    const collection = getCollection(state, type);
    const item = collection?.find((entry) => entry.id === id);
    if (!collection || !item) return;
    const now = nowIso();
    try {
      const result = await handleAddInterest(type, item, collection, now);
      if (result.ok) {
        await persistState(now);
        scheduleInterestRefresh();
      }
      await telegramRequest(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: result.ok ? "Marked as interested." : "Failed to mark interested.",
        show_alert: false,
      });
    } catch {
      await telegramRequest(config, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Interest action failed.",
        show_alert: false,
      });
    }
  };

  const handleAddInterest = async (
    type: "wohnungen" | "planungsprojekte",
    item: { id?: string | null; flags: { angemeldet: boolean }; interest?: InterestInfo },
    collection: Array<{
      id?: string | null;
      flags: { angemeldet: boolean };
      interest?: InterestInfo;
    }>,
    nowIso: string,
  ) => {
    const interest = ensureInterest(item);
    if (!interest.requestedAt) interest.requestedAt = nowIso;

    const signedItems = getSignedItems(collection);
    const signedCount = signedItems.length;
    const swapCandidates = getSwapCandidates(collection);
    const page = getPageForType(type);

    const cookieHeader = await loadAuthCookies();
    if (!cookieHeader) {
      return { ok: false, message: "Missing login cookies." } as const;
    }

    if (item.flags.angemeldet) {
      return { ok: true, signed: true } as const;
    }

    if (signedCount < SIGNUP_LIMIT) {
      const { response, html } = await fetchWohnberatungHtml(
        buildWohnberatungUrl(page, item.id ?? "", "anmelden_confirm"),
        cookieHeader,
      );
      const result = detectInterestResult(html);
      const signedStatus = detectSignedFromResponse(html);

      if (signedStatus === true) {
        markSigned(item, nowIso);
      } else if (result === "full" || result === "available" || result === "unknown") {
        scheduleWatch(item);
      }

      return {
        ok: response.ok,
        status: response.status,
        signed: item.flags.angemeldet,
        result,
      } as const;
    }

    const shouldSwap = shouldWatchWhenFull(item, swapCandidates);
    if (!shouldSwap) {
      clearWatch(item);
      return { ok: true, signed: false, skipped: "rank" } as const;
    }

    const { html } = await fetchWohnberatungHtml(
      buildWohnberatungUrl(page, item.id ?? ""),
      cookieHeader,
    );
    if (!isSignupAvailable(html)) {
      scheduleWatch(item);
      return { ok: true, signed: false, waiting: true } as const;
    }

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
        return { ok: true, signed: item.flags.angemeldet, swapped: true } as const;
      }
    }

    return { ok: true, signed: item.flags.angemeldet, swapped: false } as const;
  };

  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const initialPayload = JSON.stringify({
      updatedAt: state.updatedAt,
      nextRefreshWohnberatung: getNextWohnberatungRefreshAtWithFallback(),
      nextRefreshWillhaben: getNextWillhabenRefreshAtWithFallback(),
    });
    res.write(`data: ${initialPayload}\n\n`);
    clients.add(res);
    req.on("close", () => {
      clients.delete(res);
    });
  });

  let telegramPollingTimer: NodeJS.Timeout | null = null;
  let telegramPollingRunning = false;

  const scheduleTelegramPolling = (delayMs = 0) => {
    if (telegramPollingTimer) clearTimeout(telegramPollingTimer);
    telegramPollingTimer = setTimeout(() => {
      void runTelegramPolling();
    }, delayMs);
  };

  const runTelegramPolling = async () => {
    if (telegramPollingRunning) return;
    telegramPollingRunning = true;
    try {
      const config = ensureTelegramConfig();
      if (
        !config.enabled ||
        !config.enableActions ||
        !config.pollingEnabled ||
        !config.botToken ||
        !config.chatId
      ) {
        return;
      }

      const result = await fetchTelegramUpdates(config, {
        offset: config.pollingOffset ?? 0,
        timeoutSeconds: 30,
        limit: 100,
        allowedUpdates: ["callback_query"],
      });

      if (!result.ok) return;

      let nextOffset = config.pollingOffset ?? 0;
      for (const update of result.updates) {
        nextOffset = Math.max(nextOffset, update.update_id + 1);
        await handleTelegramCallback(config, update.callback_query);
      }

      if (nextOffset !== (config.pollingOffset ?? 0)) {
        config.pollingOffset = nextOffset;
        await persistTelegramConfig();
      }
    } finally {
      telegramPollingRunning = false;
      scheduleTelegramPolling(1000);
    }
  };

  app.post("/api/telegram/config", async (req, res) => {
    const body = req.body as Partial<TelegramConfig> | undefined;
    const config = ensureTelegramConfig();
    const wasEnabled = config.enabled;
    const wasPollingEnabled = config.pollingEnabled;

    config.enabled = Boolean(body?.enabled);
    config.botToken = body?.botToken ? String(body.botToken).trim() : null;
    config.chatId = body?.chatId ? String(body.chatId).trim() : null;
    config.includeImages = body?.includeImages !== false;
    config.enableActions = Boolean(body?.enableActions);
    config.pollingEnabled = Boolean(body?.pollingEnabled);
    config.webhookToken = body?.webhookToken ? String(body.webhookToken).trim() : null;

    if (config.enabled && (!config.botToken || !config.chatId)) {
      res.status(400).json({ ok: false, message: "Bot token and chat ID are required." });
      return;
    }
    if (config.enableActions && !config.pollingEnabled && !config.webhookToken) {
      res.status(400).json({ ok: false, message: "Webhook token required for actions." });
      return;
    }

    if (config.enabled && !wasEnabled) {
      const now = nowIso();
      state.wohnungen.forEach((item) => {
        item.telegramNotifiedAt = now;
      });
      state.planungsprojekte.forEach((item) => {
        item.telegramNotifiedAt = now;
      });
      await persistState(now);
    }

    if (config.pollingEnabled && !wasPollingEnabled && config.botToken) {
      let offset = config.pollingOffset ?? 0;
      while (true) {
        const result = await fetchTelegramUpdates(config, {
          offset,
          timeoutSeconds: 0,
          limit: 100,
          allowedUpdates: ["callback_query"],
        });
        if (!result.ok || result.updates.length === 0) break;
        offset = result.updates[result.updates.length - 1].update_id + 1;
        if (result.updates.length < 100) break;
      }
      config.pollingOffset = offset;
    }

    await persistTelegramConfig();
    scheduleTelegramPolling();

    res.json({ ok: true, config });
  });

  app.post("/api/telegram/test", async (_req, res) => {
    const config = ensureTelegramConfig();
    if (!config.botToken || !config.chatId) {
      res.status(400).json({ ok: false, message: "Bot token and chat ID are required." });
      return;
    }
    const canUseActions = config.enableActions && (config.pollingEnabled || config.webhookToken);
    const ok = await sendTelegramMessage(
      config,
      `Flatfinder test message (${nowIso()})`,
      canUseActions
        ? {
            keyboard: {
              inline_keyboard: [
                [
                  {
                    text: "Test complete",
                    callback_data: "test:complete",
                  },
                ],
              ],
            },
          }
        : undefined,
    );
    if (!ok) {
      res.status(500).json({ ok: false, message: "Test message failed." });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/telegram/webhook/:token", async (req, res) => {
    const token = req.params.token;
    const config = ensureTelegramConfig();
    if (!config.enableActions || !config.webhookToken || token !== config.webhookToken) {
      res.status(401).json({ ok: false });
      return;
    }

    const update = req.body as {
      callback_query?: {
        id: string;
        data?: string;
      };
    };

    const callback = update?.callback_query;
    await handleTelegramCallback(config, callback);

    res.json({ ok: true });
  });

  app.post("/api/items/:type/:id", async (req, res) => {
    const { type, id } = req.params;
    const action = (req.body as { action?: string } | undefined)?.action;

    const collection =
      type === "wohnungen"
        ? state.wohnungen
        : type === "planungsprojekte"
          ? state.planungsprojekte
          : type === "willhaben"
            ? state.willhaben
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

    const now = nowIso();

    if (action === "toggleSeen") {
      item.seenAt = item.seenAt ? null : now;
    } else if (action === "toggleHidden") {
      const nextHiddenAt = item.hiddenAt ? null : now;
      item.hiddenAt = nextHiddenAt;
      if (nextHiddenAt && !item.seenAt) {
        item.seenAt = now;
      }
    } else {
      res.status(400).json({ error: "Unknown action." });
      return;
    }

    await persistState(now);

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

    if (type === "willhaben") {
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
      const interest = ensureInterest(item);
      const now = nowIso();
      if (action === "add") {
        if (!interest.requestedAt) interest.requestedAt = now;
        if (!item.seenAt) {
          item.seenAt = now;
        }
      } else if (action === "drop") {
        interest.requestedAt = null;
      } else {
        res.status(400).json({ ok: false, message: "Unknown action." });
        return;
      }
      await persistState(now);
      res.json({ ok: true, signed: false });
      return;
    }

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

    const page = getPageForType(type);
    const now = nowIso();

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
      await persistState(now);
      res.json({ ok: true, signed: item.flags.angemeldet });
      return;
    }

    if (action === "lock" || action === "unlock") {
      if (!item.flags.angemeldet) {
        res.status(400).json({ ok: false, message: "Only signed items can be locked." });
        return;
      }
      const interest = ensureInterest(item);
      interest.locked = action === "lock";
      await persistState(now);
      res.json({ ok: true, signed: item.flags.angemeldet, locked: interest.locked });
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
        const interest = ensureInterest(item);
        interest.watch = undefined;
        if (keepInterested) {
          if (!interest.requestedAt) interest.requestedAt = now;
        } else {
          interest.requestedAt = null;
          interest.rank = null;
        }
        if (!item.flags.angemeldet) {
          interest.locked = false;
        }

        let didFill = false;
        try {
          didFill = await fillOpenSlots({
            type: type as "wohnungen" | "planungsprojekte",
            cookieHeader,
            nowIso: nowIso(),
          });
        } catch (fillError) {
          console.error(
            "[interest-fill]",
            fillError instanceof Error ? fillError.message : fillError,
          );
        }

        await persistState();
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

    try {
      const result = await handleAddInterest(
        type as "wohnungen" | "planungsprojekte",
        item,
        collection,
        nowIso,
      );
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      if (!item.seenAt) {
        item.seenAt = nowIso;
      }
      await persistState(nowIso);
      scheduleInterestRefresh();
      res.json(result);
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

    const now = nowIso();
    const orderSet = new Set(order);

    order.forEach((id, index) => {
      const item = collection.find((entry) => entry.id === id);
      if (!item) return;
      const interest = ensureInterest(item);
      interest.rank = index + 1;
      if (!interest.requestedAt) {
        interest.requestedAt = now;
      }
    });

    collection.forEach((item) => {
      if (!item.id) return;
      if (!orderSet.has(item.id) && item.interest?.rank) {
        item.interest.rank = null;
      }
    });

    await persistState(now);
    void runInterestRefresh();

    res.json({ ok: true });
  });

  app.get("/api/fragment", (req, res) => {
    res.json(renderFragments(state, buildFragmentOptions(req.query), telegramConfig));
  });
  app.get("/api/state", (_, res) => res.json(state));
  app.get(["/hidden", "/interested", "/settings"], (req, res) => {
    res.send(renderPage(state, buildRenderOptions(req.query), telegramConfig));
  });
  app.get("/", (req, res) => {
    res.send(renderPage(state, buildRenderOptions(req.query), telegramConfig));
  });

  app.listen(port, () => {
    console.log(`Flatfinder server running on http://localhost:${port}`);
  });

  const rateLimiter = createRateLimiter(state, rateLimitMonthly);
  void runInterestRefresh();
  scheduleInterestRefresh();
  scheduleTelegramPolling();

  registerScraperJobs({
    state,
    rateLimiter,
    runExclusive,
    nowIso,
    persistState,
    getTelegramConfig: ensureTelegramConfig,
    onSchedule: (key, nextAt) => {
      nextRefresh[key] = nextAt;
      notifyClients();
    },
  });
};

void main();
