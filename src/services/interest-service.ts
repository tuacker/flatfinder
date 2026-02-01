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
} from "../shared/interest-utils.js";
import { sortByPriority } from "../shared/interest-priority.js";
import { INTEREST_REFRESH_INTERVAL_MS, SIGNUP_LIMIT } from "../shared/constants.js";
import { getErrorCode, getErrorMessage, isTransientError } from "../shared/errors.js";
import { getCollection, getDbLocation, getPageForType } from "../shared/collections.js";
import {
  detectInterestResult,
  detectSignedFromResponse,
  isSignupAvailable,
} from "../scrapers/wohnberatung/interest-response.js";
import {
  buildWohnberatungUrl,
  fetchWohnberatungHtml,
  isLoginPage,
  loadAuthCookies,
} from "../scrapers/wohnberatung/wohnberatung-client.js";
import type { FlatfinderState, InterestInfo } from "../scrapers/wohnberatung/state.js";
import { loadItem, updateItemColumns, updateItemsColumns, type ItemColumnValues } from "../db.js";
import { createSerialQueue } from "../runtime/scheduler.js";
import type { StateService } from "./state-service.js";

const toDbBool = (value: boolean | null | undefined) =>
  value === null || value === undefined ? null : value ? 1 : 0;

const wohnberatungInterestColumns = [
  "interest_requested_at",
  "interest_rank",
  "interest_locked",
  "interest_watch_next_at",
  "interest_watch_last_at",
  "flags_angemeldet",
] as const;

const wohnberatungWatchColumns = [
  "interest_watch_next_at",
  "interest_watch_last_at",
  "flags_angemeldet",
] as const;

type WohnberatungInterestRow = {
  id?: string | null;
  interest?: InterestInfo;
  flags: { angemeldet: boolean };
};

const buildInterestColumns = (
  item: {
    interest?: InterestInfo;
    flags?: { angemeldet?: boolean } | null;
  },
  includeFlags: boolean,
): ItemColumnValues => {
  const columns: ItemColumnValues = {
    interest_requested_at: item.interest?.requestedAt ?? null,
    interest_rank: item.interest?.rank ?? null,
    interest_locked: toDbBool(item.interest?.locked ?? null),
    interest_watch_next_at: item.interest?.watch?.nextCheckAt ?? null,
    interest_watch_last_at: item.interest?.watch?.lastCheckAt ?? null,
  };
  if (includeFlags) {
    columns.flags_angemeldet = toDbBool(item.flags?.angemeldet ?? null);
  }
  return columns;
};

const persistWohnberatungInterest = (
  type: "wohnungen" | "planungsprojekte",
  items: WohnberatungInterestRow[],
  now: string,
  columns: readonly (typeof wohnberatungInterestColumns)[number][] = wohnberatungInterestColumns,
) => {
  const updates = items
    .filter((item) => item.id)
    .map((item) => {
      const values = buildInterestColumns(item, true);
      return {
        id: item.id as string,
        values: columns.map((key) => values[key] ?? null),
      };
    });
  if (updates.length === 0) return;
  updateItemsColumns("wohnberatung", type, [...columns], updates, now);
};

const markInterested = (
  item: { interest?: InterestInfo; seenAt?: string | null },
  nowIso: string,
) => {
  const interest = ensureInterest(item);
  if (!interest.requestedAt) interest.requestedAt = nowIso;
  if (!item.seenAt) item.seenAt = nowIso;
};

const scheduleImmediateWatch = (item: { interest?: InterestInfo }, nowIso: string) => {
  const interest = ensureInterest(item);
  interest.watch = {
    ...interest.watch,
    nextCheckAt: nowIso,
  };
};

const assertOkResponse = (response: Response, url: string) => {
  if (response.ok) return;
  throw new Error(`Request failed (${response.status}) ${url}`);
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

  const dropUrl = buildWohnberatungUrl(page, drop.id, "delete_confirm");
  const { response: dropResponse, html: dropHtml } = await fetchWohnberatungHtml(
    dropUrl,
    cookieHeader,
  );
  if (isLoginPage(dropHtml)) {
    return { swapped: false, requiresLogin: true };
  }
  assertOkResponse(dropResponse, dropUrl);
  const dropSigned = detectSignedFromResponse(dropHtml);
  if (typeof dropSigned === "boolean") {
    drop.flags.angemeldet = dropSigned;
  }
  drop.interest = {
    ...drop.interest,
    watch: undefined,
  };

  const confirmUrl = buildWohnberatungUrl(page, target.id, "anmelden_confirm");
  const { response: confirmResponse, html: confirmHtml } = await fetchWohnberatungHtml(
    confirmUrl,
    cookieHeader,
  );
  if (isLoginPage(confirmHtml)) {
    return { swapped: false, requiresLogin: true };
  }
  assertOkResponse(confirmResponse, confirmUrl);
  const targetSigned = detectSignedFromResponse(confirmHtml);
  const result = detectInterestResult(confirmHtml);
  if (targetSigned === true) {
    markSigned(target, nowIso);
    return { swapped: true, result };
  }

  scheduleWatch(target);

  if (drop.id) {
    const restoreUrl = buildWohnberatungUrl(page, drop.id, "anmelden_confirm");
    const { response: restoreResponse, html: restoreHtml } = await fetchWohnberatungHtml(
      restoreUrl,
      cookieHeader,
    );
    if (isLoginPage(restoreHtml)) {
      return { swapped: false, result, requiresLogin: true };
    }
    assertOkResponse(restoreResponse, restoreUrl);
    const restoreSigned = detectSignedFromResponse(restoreHtml);
    if (restoreSigned === true) {
      drop.flags.angemeldet = true;
      drop.interest = dropSnapshot ?? { requestedAt: nowIso, rank: null };
    }
  }

  return { swapped: false, result };
};

const fillOpenSlots = async (
  state: FlatfinderState,
  options: {
    type: "wohnungen" | "planungsprojekte";
    cookieHeader: string;
    nowIso: string;
  },
) => {
  const { type, cookieHeader, nowIso } = options;
  const collection = getCollection(state, type);
  if (!collection) return { updated: false, changedItems: [] as WohnberatungInterestRow[] };
  let signedItems = getSignedItems(collection);
  let signedCount = signedItems.length;
  if (signedCount >= SIGNUP_LIMIT) {
    return { updated: false, changedItems: [] as WohnberatungInterestRow[] };
  }

  const candidates = sortByPriority(
    collection.filter((item) =>
      Boolean(item.id && item.interest?.requestedAt && !item.flags.angemeldet),
    ),
  );

  let didUpdate = false;
  const changed = new Map<string, WohnberatungInterestRow>();
  const markChanged = (item: WohnberatungInterestRow) => {
    if (!item.id) return;
    changed.set(item.id, item);
    didUpdate = true;
  };

  for (const item of candidates) {
    if (signedCount >= SIGNUP_LIMIT) break;
    if (!item.id) continue;
    const page = getPageForType(type);
    const detailUrl = buildWohnberatungUrl(page, item.id);
    const { response: detailResponse, html } = await fetchWohnberatungHtml(detailUrl, cookieHeader);
    if (isLoginPage(html)) {
      return { updated: didUpdate, requiresLogin: true, changedItems: [...changed.values()] };
    }
    assertOkResponse(detailResponse, detailUrl);
    const signedFromDetail = detectSignedFromResponse(html);
    if (signedFromDetail === true) {
      markSigned(item, nowIso);
      signedCount += 1;
      signedItems = getSignedItems(collection);
      markChanged(item);
      continue;
    }

    if (!isSignupAvailable(html)) {
      scheduleWatch(item);
      markChanged(item);
      continue;
    }

    const confirmUrl = buildWohnberatungUrl(page, item.id, "anmelden_confirm");
    const { response: confirmResponse, html: confirmHtml } = await fetchWohnberatungHtml(
      confirmUrl,
      cookieHeader,
    );
    if (isLoginPage(confirmHtml)) {
      return { updated: didUpdate, requiresLogin: true, changedItems: [...changed.values()] };
    }
    assertOkResponse(confirmResponse, confirmUrl);
    const signedStatus = detectSignedFromResponse(confirmHtml);
    if (signedStatus === true) {
      markSigned(item, nowIso);
      signedCount += 1;
      signedItems = getSignedItems(collection);
      markChanged(item);
    } else {
      scheduleWatch(item);
      markChanged(item);
    }
  }

  return { updated: didUpdate, changedItems: [...changed.values()] };
};

export const createInterestService = (options: {
  nowIso: () => string;
  stateService: StateService;
}) => {
  const runInterestExclusive = createSerialQueue();
  let interestRefreshRunning = false;
  let interestRefreshTimer: NodeJS.Timeout | null = null;
  let interestRefreshRetryAt = 0;

  const scheduleInterestRefresh = () => {
    if (interestRefreshTimer) clearTimeout(interestRefreshTimer);
    void (async () => {
      const currentState = await options.stateService.loadState();
      const now = Date.now();
      const nextAt = getNextWatchAt([...currentState.wohnungen, ...currentState.planungsprojekte]);
      const scheduledAt = nextAt === null ? now + INTEREST_REFRESH_INTERVAL_MS : nextAt;
      const retryAt = interestRefreshRetryAt > now ? interestRefreshRetryAt : 0;
      const effectiveAt = retryAt ? Math.min(scheduledAt, retryAt) : scheduledAt;
      const delay = Math.max(0, effectiveAt - now);
      interestRefreshTimer = setTimeout(() => {
        interestRefreshTimer = null;
        void runInterestRefresh();
      }, delay);
    })();
  };

  const runInterestRefresh = async () => {
    if (interestRefreshRunning) return;
    interestRefreshRunning = true;
    await runInterestExclusive("interest-refresh", async () => {
      try {
        const currentState = await options.stateService.loadState();
        if (currentState.wohnberatungAuthError) {
          return;
        }
        const cookieHeader = await loadAuthCookies();
        if (!cookieHeader) {
          await options.stateService.updateMetaAndNotify({
            wohnberatungAuthError: "Login required.",
            nextWohnungenRetryAt: null,
            nextPlanungsprojekteRetryAt: null,
            updatedAt: options.nowIso(),
          });
          return;
        }

        const now = Date.now();
        const nowStamp = new Date(now).toISOString();
        let didUpdate = false;
        let authFailed = false;
        const changedWohnungen = new Map<string, WohnberatungInterestRow>();
        const changedPlanungen = new Map<string, WohnberatungInterestRow>();

        const handleAuthFailure = async () => {
          if (authFailed) return;
          authFailed = true;
          await options.stateService.updateMetaAndNotify({
            wohnberatungAuthError: "Login required.",
            nextWohnungenRetryAt: null,
            nextPlanungsprojekteRetryAt: null,
            updatedAt: nowStamp,
          });
        };

        const processType = async (
          type: "wohnungen" | "planungsprojekte",
          changed: Map<string, WohnberatungInterestRow>,
        ) => {
          const collection = getCollection(currentState, type);
          if (!collection) return;
          let signedItems = getSignedItems(collection);
          let signedCount = signedItems.length;
          let swapCandidates = getSwapCandidates(collection);

          const markChanged = (item: WohnberatungInterestRow) => {
            if (!item.id) return;
            changed.set(item.id, item);
            didUpdate = true;
          };

          for (const item of collection) {
            if (!item.id) continue;
            if (item.flags.angemeldet) {
              if (item.interest?.watch) {
                clearWatch(item);
                markChanged(item);
              }
              continue;
            }
            if (!item.interest?.requestedAt) {
              if (item.interest?.watch) {
                clearWatch(item);
                markChanged(item);
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

            const fresh = await loadItem<WohnberatungInterestRow & { interest?: InterestInfo }>(
              "wohnberatung",
              type,
              item.id,
            );
            if (!fresh?.interest?.requestedAt) {
              if (item.interest?.watch) {
                clearWatch(item);
                markChanged(item);
              }
              continue;
            }

            const shouldWatch =
              signedCount < SIGNUP_LIMIT || shouldWatchWhenFull(item, swapCandidates);
            if (!shouldWatch) {
              if (item.interest?.watch) {
                clearWatch(item);
                markChanged(item);
              }
              continue;
            }

            const nextCheckAt = item.interest?.watch?.nextCheckAt;
            if (nextCheckAt && new Date(nextCheckAt).getTime() > now) {
              continue;
            }

            const page = getPageForType(type);
            const detailUrl = buildWohnberatungUrl(page, item.id);
            const { response: detailResponse, html } = await fetchWohnberatungHtml(
              detailUrl,
              cookieHeader,
            );
            if (isLoginPage(html)) {
              await handleAuthFailure();
              return;
            }
            assertOkResponse(detailResponse, detailUrl);
            const signedFromDetail = detectSignedFromResponse(html);
            if (signedFromDetail === true) {
              markSigned(item, nowStamp);
              signedCount += 1;
              signedItems = getSignedItems(collection);
              swapCandidates = getSwapCandidates(collection);
              markChanged(item);
              continue;
            }
            const interest = ensureInterest(item);
            interest.watch = {
              ...interest.watch,
              lastCheckAt: nowStamp,
            };
            scheduleWatch(item);
            markChanged(item);

            const available = isSignupAvailable(html);
            if (!available) continue;

            if (signedCount < SIGNUP_LIMIT) {
              const confirmUrl = buildWohnberatungUrl(page, item.id, "anmelden_confirm");
              const { response: confirmResponse, html: confirmHtml } = await fetchWohnberatungHtml(
                confirmUrl,
                cookieHeader,
              );
              if (isLoginPage(confirmHtml)) {
                await handleAuthFailure();
                return;
              }
              assertOkResponse(confirmResponse, confirmUrl);
              const signedStatus = detectSignedFromResponse(confirmHtml);
              if (signedStatus === true) {
                markSigned(item, nowStamp);
                signedCount += 1;
                signedItems = getSignedItems(collection);
                swapCandidates = getSwapCandidates(collection);
                markChanged(item);
              } else {
                scheduleWatch(item);
                markChanged(item);
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
                markChanged(item);
                markChanged(worst);
                if (swapResult.requiresLogin) {
                  await handleAuthFailure();
                  return;
                }
                if (swapResult.swapped) {
                  signedItems = getSignedItems(collection);
                  signedCount = signedItems.length;
                  swapCandidates = getSwapCandidates(collection);
                }
              }
            }
          }
        };

        await processType("wohnungen", changedWohnungen);
        if (authFailed) return;
        await processType("planungsprojekte", changedPlanungen);

        if (changedWohnungen.size > 0) {
          persistWohnberatungInterest(
            "wohnungen",
            [...changedWohnungen.values()],
            nowStamp,
            wohnberatungWatchColumns,
          );
        }
        if (changedPlanungen.size > 0) {
          persistWohnberatungInterest(
            "planungsprojekte",
            [...changedPlanungen.values()],
            nowStamp,
            wohnberatungWatchColumns,
          );
        }
        if (didUpdate) {
          await options.stateService.touchUpdatedAt(nowStamp);
        }
      } catch (error) {
        const code = getErrorCode(error);
        if (isTransientError(error)) {
          interestRefreshRetryAt = Date.now() + 60_000;
        }
        console.error("[interest-refresh]", getErrorMessage(error), code ? `(${code})` : "");
      } finally {
        interestRefreshRunning = false;
        scheduleInterestRefresh();
      }
    });
  };

  type InterestItem = {
    id?: string | null;
    seenAt?: string | null;
    interest?: InterestInfo;
    flags?: { angemeldet?: boolean } | null;
  };

  const ensureWohnberatungFlags = (item: InterestItem) => {
    if (!item.flags) item.flags = { angemeldet: false };
    if (typeof item.flags.angemeldet !== "boolean") item.flags.angemeldet = false;
    return item.flags;
  };

  const updateInterestColumns = (optionsInput: {
    source: "wohnberatung" | "willhaben";
    type: "wohnungen" | "planungsprojekte";
    id: string;
    item: InterestItem;
    now: string;
    includeFlags: boolean;
    includeSeen: boolean;
  }) => {
    const columns = buildInterestColumns(optionsInput.item, optionsInput.includeFlags);
    if (optionsInput.includeSeen) {
      columns.seen_at = optionsInput.item.seenAt ?? null;
    }
    updateItemColumns(
      optionsInput.source,
      optionsInput.type,
      optionsInput.id,
      columns,
      optionsInput.now,
    );
  };

  const handleWohnberatungRemove = async (optionsInput: {
    type: "wohnungen" | "planungsprojekte";
    id: string;
    confirm: boolean;
    keepInterested?: boolean;
  }) => {
    const { type, id, confirm, keepInterested } = optionsInput;
    const currentState = await options.stateService.loadState();
    const collection = getCollection(currentState, type);
    if (!collection) {
      return { status: 400, body: { ok: false, message: "Unknown item type." } };
    }

    const item = collection.find((entry) => entry.id === id);
    if (!item) {
      return { status: 404, body: { ok: false, message: "Item not found." } };
    }

    const now = options.nowIso();
    const page = getPageForType(type);

    if (!confirm) {
      return { status: 400, body: { ok: false, message: "Removal requires confirmation." } };
    }
    if (item.interest?.locked) {
      return { status: 400, body: { ok: false, message: "Item is locked." } };
    }

    try {
      const cookieHeader = await loadAuthCookies();
      if (!cookieHeader) {
        return { status: 400, body: { ok: false, message: "Missing login cookies." } };
      }

      const dropUrl = buildWohnberatungUrl(page, id, "delete_confirm");
      const { response, html } = await fetchWohnberatungHtml(dropUrl, cookieHeader);
      if (isLoginPage(html)) {
        await options.stateService.updateMetaAndNotify({
          wohnberatungAuthError: "Login required.",
          nextWohnungenRetryAt: null,
          nextPlanungsprojekteRetryAt: null,
          updatedAt: options.nowIso(),
        });
        return { status: 401, body: { ok: false, message: "Login required." } };
      }
      if (!response.ok) {
        return {
          status: 502,
          body: {
            ok: false,
            status: response.status,
            message: `Wohnberatung request failed (${response.status}).`,
          },
        };
      }
      const signedStatus = detectSignedFromResponse(html);
      const changed = new Map<string, WohnberatungInterestRow>();
      const markChanged = (entry: WohnberatungInterestRow) => {
        if (!entry.id) return;
        changed.set(entry.id, entry);
      };

      if (typeof signedStatus === "boolean") {
        item.flags.angemeldet = signedStatus;
      }
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
      markChanged(item);

      let didFill = false;
      try {
        const fillResult = await fillOpenSlots(currentState, {
          type,
          cookieHeader,
          nowIso: now,
        });
        didFill = fillResult.updated;
        fillResult.changedItems.forEach(markChanged);
        if (fillResult.requiresLogin) {
          currentState.wohnberatungAuthError = "Login required.";
          currentState.nextWohnungenRetryAt = null;
          currentState.nextPlanungsprojekteRetryAt = null;
        }
      } catch (fillError) {
        console.error(
          "[interest-fill]",
          fillError instanceof Error ? fillError.message : fillError,
        );
      }

      if (changed.size > 0) {
        persistWohnberatungInterest(type, [...changed.values()], now);
      }
      await options.stateService.updateMetaAndNotify({
        updatedAt: now,
        wohnberatungAuthError: currentState.wohnberatungAuthError ?? null,
        nextWohnungenRetryAt: currentState.nextWohnungenRetryAt ?? null,
        nextPlanungsprojekteRetryAt: currentState.nextPlanungsprojekteRetryAt ?? null,
      });
      scheduleInterestRefresh();

      return {
        status: 200,
        body: {
          ok: response.ok,
          status: response.status,
          signed: item.flags.angemeldet,
          filled: didFill,
        },
      };
    } catch (error) {
      return {
        status: 500,
        body: {
          ok: false,
          message: error instanceof Error ? error.message : "Interest request failed.",
        },
      };
    }
  };

  const handleInterestActionInternal = async (input: {
    type: string;
    id: string;
    action: string;
    confirm: boolean;
    keepInterested?: boolean;
  }) => {
    if (input.action === "remove") {
      if (input.type === "wohnungen" || input.type === "planungsprojekte") {
        return handleWohnberatungRemove({
          type: input.type,
          id: input.id,
          confirm: input.confirm,
          keepInterested: input.keepInterested,
        });
      }
      return { status: 400, body: { ok: false, message: "Unknown action." } };
    }

    if (
      input.type !== "wohnungen" &&
      input.type !== "planungsprojekte" &&
      input.type !== "willhaben"
    ) {
      return { status: 400, body: { ok: false, message: "Unknown item type." } };
    }

    const location = getDbLocation(input.type);
    const item = await loadItem<InterestItem>(location.source, location.type, input.id);
    if (!item) {
      return { status: 404, body: { ok: false, message: "Item not found." } };
    }

    const now = options.nowIso();

    if (input.type === "willhaben") {
      const interest = ensureInterest(item);
      if (input.action === "add") {
        markInterested(item, now);
      } else if (input.action === "drop") {
        interest.requestedAt = null;
      } else {
        return { status: 400, body: { ok: false, message: "Unknown action." } };
      }

      updateInterestColumns({
        source: "willhaben",
        type: "wohnungen",
        id: input.id,
        item,
        now,
        includeFlags: false,
        includeSeen: input.action === "add",
      });

      await options.stateService.touchUpdatedAt(now);
      return { status: 200, body: { ok: true, signed: false } };
    }

    const flags = ensureWohnberatungFlags(item);

    if (input.action === "drop") {
      if (flags.angemeldet) {
        return { status: 400, body: { ok: false, message: "Cannot drop a signed item." } };
      }
      item.interest = {
        ...item.interest,
        requestedAt: null,
        rank: null,
        locked: false,
        watch: undefined,
      };
      updateInterestColumns({
        source: "wohnberatung",
        type: input.type,
        id: input.id,
        item,
        now,
        includeFlags: true,
        includeSeen: false,
      });
      await options.stateService.touchUpdatedAt(now);
      scheduleInterestRefresh();
      return { status: 200, body: { ok: true, signed: flags.angemeldet } };
    }

    if (input.action === "lock" || input.action === "unlock") {
      if (!flags.angemeldet) {
        return {
          status: 400,
          body: { ok: false, message: "Only signed items can be locked." },
        };
      }
      const interest = ensureInterest(item);
      interest.locked = input.action === "lock";
      updateInterestColumns({
        source: "wohnberatung",
        type: input.type,
        id: input.id,
        item,
        now,
        includeFlags: true,
        includeSeen: false,
      });
      await options.stateService.touchUpdatedAt(now);
      scheduleInterestRefresh();
      return {
        status: 200,
        body: { ok: true, signed: flags.angemeldet, locked: interest.locked },
      };
    }

    if (input.action === "add") {
      markInterested(item, now);
      scheduleImmediateWatch(item, now);
      updateInterestColumns({
        source: "wohnberatung",
        type: input.type,
        id: input.id,
        item,
        now,
        includeFlags: true,
        includeSeen: true,
      });
      await options.stateService.touchUpdatedAt(now);
      scheduleInterestRefresh();
      return { status: 200, body: { ok: true, signed: flags.angemeldet } };
    }

    return { status: 400, body: { ok: false, message: "Unknown action." } };
  };

  const handleRankUpdate = async (type: string, order: string[]) => {
    if (type !== "wohnungen" && type !== "planungsprojekte") {
      return { status: 400, body: { ok: false, message: "Unknown item type." } };
    }
    const currentState = await options.stateService.loadState();
    const collection = getCollection(currentState, type);
    if (!collection) {
      return { status: 400, body: { ok: false, message: "Unknown item type." } };
    }

    const now = options.nowIso();
    const orderSet = new Set(order);
    const changed = new Map<string, WohnberatungInterestRow>();
    const markChanged = (entry: WohnberatungInterestRow) => {
      if (!entry.id) return;
      changed.set(entry.id, entry);
    };

    order.forEach((id, index) => {
      const item = collection.find((entry) => entry.id === id);
      if (!item) return;
      const interest = ensureInterest(item);
      const nextRank = index + 1;
      const nextRequestedAt = interest.requestedAt ?? now;
      const rankChanged = interest.rank !== nextRank;
      const requestedChanged = interest.requestedAt !== nextRequestedAt;
      interest.rank = nextRank;
      interest.requestedAt = nextRequestedAt;
      if (rankChanged || requestedChanged) {
        markChanged(item);
      }
    });

    collection.forEach((item) => {
      if (!item.id) return;
      if (
        !orderSet.has(item.id) &&
        item.interest?.rank !== null &&
        item.interest?.rank !== undefined
      ) {
        item.interest.rank = null;
        markChanged(item);
      }
    });

    if (changed.size > 0) {
      persistWohnberatungInterest(type, [...changed.values()], now);
      await options.stateService.touchUpdatedAt(now);
      void runInterestRefresh();
    }

    return { status: 200, body: { ok: true } };
  };

  const startInterestRefresh = () => {
    void runInterestRefresh();
    scheduleInterestRefresh();
  };

  const fallback = (message: string) => ({
    status: 500,
    body: { ok: false, message },
  });

  return {
    startInterestRefresh,
    scheduleInterestRefresh,
    handleInterestAction: async (input: {
      type: string;
      id: string;
      action: string;
      confirm: boolean;
      keepInterested?: boolean;
    }) => {
      const needsExclusive = input.type !== "willhaben" && input.action === "remove";
      if (!needsExclusive) {
        return handleInterestActionInternal(input);
      }
      const result = await runInterestExclusive("api-interest", () =>
        handleInterestActionInternal(input),
      );
      return result ?? fallback("Interest action failed.");
    },
    handleRankUpdate: async (type: string, order: string[]) => {
      return handleRankUpdate(type, order);
    },
  };
};

export type InterestService = ReturnType<typeof createInterestService>;
