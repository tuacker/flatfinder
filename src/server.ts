import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { assetsDir, storageStatePath } from "./scrapers/wohnberatung/config.js";
import { updateMeta, loadState } from "./state/flatfinder-state.js";
import { createStateService } from "./services/state-service.js";
import { createInterestService } from "./services/interest-service.js";
import { createTelegramService } from "./services/telegram-service.js";
import { registerRoutes } from "./api/routes.js";
import { startScraperJobs } from "./services/scheduler-service.js";

const port = 3000;

const nowIso = () => new Date().toISOString();

const ensureStorageState = async () => {
  try {
    await fs.access(storageStatePath);
    return true;
  } catch {
    console.warn(
      "Missing storage state. Run `npm run scrape:wohnberatung:login` or use Settings > Start login.",
    );
    return false;
  }
};

const main = async () => {
  const hasStorageState = await ensureStorageState();

  const app = express();
  app.use(express.json());
  app.use("/assets", express.static(path.resolve(assetsDir)));
  app.use(express.static(path.resolve("public")));

  const stateService = createStateService({ nowIso });
  const interestService = createInterestService({ nowIso, stateService });
  const telegramService = createTelegramService({ nowIso, stateService, interestService });

  registerRoutes(app, { stateService, interestService, telegramService, nowIso });

  if (!hasStorageState) {
    const currentState = await loadState();
    if (!currentState.wohnberatungAuthError) {
      updateMeta({
        wohnberatungAuthError: "Login required.",
        nextWohnungenRetryAt: null,
        nextPlanungsprojekteRetryAt: null,
        updatedAt: nowIso(),
      });
      await stateService.notifyClients();
    }
  }

  app.listen(port, () => {
    console.log(`Flatfinder server running on http://localhost:${port}`);
  });

  interestService.startInterestRefresh();
  telegramService.schedulePolling();

  startScraperJobs({
    nowIso,
    onSchedule: () => {
      void stateService.notifyClients();
    },
    onUpdate: () => {
      void stateService.notifyClients();
    },
  });
};

void main();
