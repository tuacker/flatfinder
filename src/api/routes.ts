import type { Express } from "express";
import {
  renderFragments,
  renderPage,
  type WillhabenFilters,
  type WillhabenSortDir,
  type WillhabenSortKey,
} from "../../ui/render.js";
import {
  loadDerstandardConfig,
  loadTelegramConfig,
  loadWillhabenConfig,
  normalizeDerstandardConfig,
  normalizeWillhabenConfig,
  saveDerstandardConfig,
  saveWillhabenConfig,
  type FlatfinderState,
} from "../state/flatfinder-state.js";
import { loginAndSaveState } from "../scrapers/wohnberatung/session.js";
import { getDbLocation } from "../shared/collections.js";
import { updateItemColumns, loadItem } from "../db.js";
import type { StateService } from "../services/state-service.js";
import type { InterestService } from "../services/interest-service.js";
import type { TelegramService } from "../services/telegram-service.js";
import { getWohnberatungIntervalsMs } from "../services/scheduler-service.js";

type Services = {
  stateService: StateService;
  interestService: InterestService;
  telegramService: TelegramService;
  nowIso: () => string;
};

type SourceFilter = "all" | "wohnberatung" | "willhaben" | "derstandard";

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

const getSourceFilter = (value: unknown): SourceFilter => {
  if (value === "wohnberatung" || value === "willhaben" || value === "derstandard") {
    return value;
  }
  return "all";
};

const buildRenderOptions = (
  state: FlatfinderState,
  query: Record<string, unknown>,
  willhabenConfig: Awaited<ReturnType<typeof loadWillhabenConfig>>,
  derstandardConfig: Awaited<ReturnType<typeof loadDerstandardConfig>>,
  stateService: StateService,
) => {
  const intervals = getWohnberatungIntervalsMs(state);
  return {
    sourceFilter: getSourceFilter(query.source),
    willhabenFilters: parseWillhabenFilters(query),
    wohnberatungNextRefreshAt: stateService.nextRefreshWohnberatung(state),
    willhabenNextRefreshAt: stateService.nextRefreshWillhaben(state),
    derstandardNextRefreshAt: stateService.nextRefreshDerstandard(state),
    wohnberatungWohnungenIntervalMs: intervals.wohnungenIntervalMs,
    wohnberatungPlanungsprojekteIntervalMs: intervals.planungsprojekteIntervalMs,
    wohnberatungAuthError: state.wohnberatungAuthError ?? null,
    willhabenConfig,
    derstandardConfig,
  };
};

const buildFragmentOptions = (
  state: FlatfinderState,
  query: Record<string, unknown>,
  willhabenConfig: Awaited<ReturnType<typeof loadWillhabenConfig>>,
  derstandardConfig: Awaited<ReturnType<typeof loadDerstandardConfig>>,
  stateService: StateService,
) => {
  const intervals = getWohnberatungIntervalsMs(state);
  return {
    willhabenFilters: parseWillhabenFilters(query),
    wohnberatungNextRefreshAt: stateService.nextRefreshWohnberatung(state),
    willhabenNextRefreshAt: stateService.nextRefreshWillhaben(state),
    derstandardNextRefreshAt: stateService.nextRefreshDerstandard(state),
    wohnberatungWohnungenIntervalMs: intervals.wohnungenIntervalMs,
    wohnberatungPlanungsprojekteIntervalMs: intervals.planungsprojekteIntervalMs,
    wohnberatungAuthError: state.wohnberatungAuthError ?? null,
    willhabenConfig,
    derstandardConfig,
  };
};

export const registerRoutes = (app: Express, services: Services) => {
  let loginRunning = false;

  app.get("/events", async (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    await services.stateService.registerClient(res);
  });

  app.post("/api/telegram/config", async (req, res) => {
    const result = await services.telegramService.updateConfig(req.body);
    res.status(result.status).json(result.body);
  });

  app.post("/api/telegram/test", async (_req, res) => {
    const result = await services.telegramService.sendTest();
    res.status(result.status).json(result.body);
  });

  app.post("/api/telegram/webhook/:token", async (req, res) => {
    const result = await services.telegramService.handleWebhook(req.params.token, req.body);
    res.status(result.status).json(result.body);
  });

  app.post("/api/wohnberatung/login", async (_req, res) => {
    if (loginRunning) {
      res.status(409).json({ ok: false, message: "Login already running." });
      return;
    }
    loginRunning = true;
    res.json({ ok: true, message: "Login started. Complete it in the opened browser window." });
    void (async () => {
      try {
        await loginAndSaveState();
        await services.stateService.updateMetaAndNotify({
          wohnberatungAuthError: null,
          wohnberatungAuthNotifiedAt: null,
          updatedAt: services.nowIso(),
        });
      } catch (error) {
        console.error(
          "[wohnberatung] login failed:",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        loginRunning = false;
      }
    })();
  });

  app.post("/api/willhaben/config", async (req, res) => {
    const normalized = normalizeWillhabenConfig(
      (req.body ?? null) as Record<string, unknown> | null,
    );
    await saveWillhabenConfig(normalized);
    res.json({ ok: true, config: normalized });
  });

  app.post("/api/derstandard/config", async (req, res) => {
    const normalized = normalizeDerstandardConfig(
      (req.body ?? null) as Record<string, unknown> | null,
    );
    await saveDerstandardConfig(normalized);
    res.json({ ok: true, config: normalized });
  });

  app.post("/api/items/:type/:id", async (req, res) => {
    try {
      const { type, id } = req.params;
      const action = (req.body as { action?: string } | undefined)?.action;
      if (!id) {
        res.status(400).json({ error: "Missing item id." });
        return;
      }
      if (
        type !== "wohnungen" &&
        type !== "planungsprojekte" &&
        type !== "willhaben" &&
        type !== "derstandard"
      ) {
        res.status(400).json({ error: "Unknown item type." });
        return;
      }
      if (!action) {
        res.status(400).json({ error: "Unknown action." });
        return;
      }

      const { source, type: dbType } = getDbLocation(type);
      const item = await loadItem<{ seenAt?: string | null; hiddenAt?: string | null }>(
        source,
        dbType,
        id,
      );
      if (!item) {
        res.status(404).json({ error: "Item not found." });
        return;
      }

      const now = services.nowIso();
      let seenAt = item.seenAt ?? null;
      let hiddenAt = item.hiddenAt ?? null;

      if (action === "toggleSeen") {
        seenAt = seenAt ? null : now;
      } else if (action === "toggleHidden") {
        hiddenAt = hiddenAt ? null : now;
        if (hiddenAt && !seenAt) {
          seenAt = now;
        }
      } else {
        res.status(400).json({ error: "Unknown action." });
        return;
      }

      updateItemColumns(source, dbType, id, { seen_at: seenAt, hidden_at: hiddenAt }, now);
      await services.stateService.touchUpdatedAt(now);

      res.json({ ok: true, updatedAt: now, item: { seenAt, hiddenAt } });
    } catch (error) {
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : "Item update failed." });
    }
  });

  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  app.post("/api/interest/:type/:id", async (req, res) => {
    const { type, id } = req.params;
    const action = (req.body as { action?: string; confirm?: boolean } | undefined)?.action;
    const confirm = (req.body as { confirm?: boolean } | undefined)?.confirm ?? false;
    const keepInterested = (req.body as { keepInterested?: boolean } | undefined)?.keepInterested;
    if (!id || !action) {
      res.status(400).json({ ok: false, message: "Missing action or id." });
      return;
    }
    const result = await services.interestService.handleInterestAction({
      type,
      id,
      action,
      confirm,
      keepInterested,
    });
    res.status(result.status).json(result.body);
  });

  app.post("/api/rank/:type", async (req, res) => {
    const order = (req.body as { order?: string[] } | undefined)?.order ?? [];
    const result = await services.interestService.handleRankUpdate(req.params.type, order);
    res.status(result.status).json(result.body);
  });

  app.get("/api/fragment", async (req, res) => {
    const currentState = await services.stateService.loadState();
    const telegramConfig = await loadTelegramConfig();
    const willhabenConfig = await loadWillhabenConfig();
    const derstandardConfig = await loadDerstandardConfig();
    const options = buildFragmentOptions(
      currentState,
      req.query,
      willhabenConfig,
      derstandardConfig,
      services.stateService,
    );
    res.json(renderFragments(currentState, options, telegramConfig));
  });

  app.get("/api/state", async (_req, res) => {
    const currentState = await services.stateService.loadState();
    res.json(currentState);
  });

  const loadPageState = async (query: Record<string, unknown>) => {
    const currentState = await services.stateService.loadState();
    const willhabenConfig = await loadWillhabenConfig();
    const derstandardConfig = await loadDerstandardConfig();
    const telegramConfig = await loadTelegramConfig();
    const options = buildRenderOptions(
      currentState,
      query,
      willhabenConfig,
      derstandardConfig,
      services.stateService,
    );
    return { currentState, telegramConfig, options };
  };

  app.get(["/hidden", "/interested", "/settings"], async (req, res) => {
    const { currentState, telegramConfig, options } = await loadPageState(req.query);
    res.send(renderPage(currentState, options, telegramConfig));
  });

  app.get("/", async (req, res) => {
    const { currentState, telegramConfig, options } = await loadPageState(req.query);
    res.send(renderPage(currentState, options, telegramConfig));
  });
};
