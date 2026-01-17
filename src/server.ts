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
import { loadState, saveState } from "./scrapers/wohnberatung/state.js";
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

const detectInterestResult = (html: string) => {
  if (/maximale Anzahl an Interessent/i.test(html)) return "limit";
  if (/Sie haben sich unverbindlich angemeldet/i.test(html)) return "success";
  if (/kein Interesse mehr/i.test(html)) return "signed";
  if (/unverbindlich anmelden/i.test(html)) return "not_signed";
  if (/eingetragen|angemeldet|Interesse/i.test(html)) return "success";
  return "unknown";
};

const detectSignedFromResponse = (html: string) => {
  if (/kein Interesse mehr/i.test(html)) return true;
  if (/unverbindlich anmelden/i.test(html)) return false;
  if (/Sie haben sich unverbindlich angemeldet/i.test(html)) return true;
  return null;
};

const getNextRefreshAt = () => {
  const scheduled = [nextRefresh.wohnungen, nextRefresh.planungsprojekte].filter(
    (value) => value > 0,
  );
  return scheduled.length ? Math.min(...scheduled) : 0;
};

const getNextRefreshAtWithFallback = () => getNextRefreshAt() || getNextRefreshFallback();

let queue = Promise.resolve();

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

    const page = type === "wohnungen" ? "wohnung" : type === "planungsprojekte" ? "projekt" : null;

    if (!page) {
      res.status(400).json({ ok: false, message: "Unknown item type." });
      return;
    }

    const flag =
      action === "add" ? "anmelden_confirm" : action === "remove" ? "delete_confirm" : "";

    if (!flag) {
      res.status(400).json({ ok: false, message: "Unknown action." });
      return;
    }

    if (action === "remove" && !confirm) {
      res.status(400).json({ ok: false, message: "Removal requires confirmation." });
      return;
    }

    try {
      const cookieHeader = await loadAuthCookies();
      if (!cookieHeader) {
        res.status(400).json({ ok: false, message: "Missing login cookies." });
        return;
      }

      const url = new URL(baseUrl);
      url.searchParams.set("page", page);
      url.searchParams.set("id", id);
      url.searchParams.set(flag, "true");

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          cookie: cookieHeader,
          "user-agent": "flatfinder",
        },
      });

      const html = await response.text();
      const result = detectInterestResult(html);
      const signedStatus = detectSignedFromResponse(html);

      const collection =
        type === "wohnungen"
          ? state.wohnungen
          : type === "planungsprojekte"
            ? state.planungsprojekte
            : null;

      if (collection && typeof signedStatus === "boolean") {
        const item = collection.find((entry) => entry.id === id);
        if (item) {
          item.flags.angemeldet = signedStatus;
          state.updatedAt = new Date().toISOString();
          await saveState(state);
          notifyClients();
        }
      }

      res.json({
        ok: response.ok,
        status: response.status,
        result,
        signed: typeof signedStatus === "boolean" ? signedStatus : undefined,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : "Interest request failed.",
      });
    }
  });
  app.get("/api/fragment", (_, res) =>
    res.json(renderFragments(state, { nextRefreshAt: getNextRefreshAtWithFallback() })),
  );
  app.get("/api/state", (_, res) => res.json(state));
  app.get("/", (_, res) =>
    res.send(renderPage(state, { nextRefreshAt: getNextRefreshAtWithFallback() })),
  );

  app.listen(port, () => {
    console.log(`Flatfinder server running on http://localhost:${port}`);
  });

  const rateLimiter = createRateLimiter(state, rateLimitMonthly);

  scheduleJob(
    "wohnungssuche",
    wohnungssucheIntervalMinutes * 60 * 1000,
    async () => {
      await scrapeWohnungen(state, rateLimiter);
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
