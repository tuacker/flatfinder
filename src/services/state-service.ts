import type { Response } from "express";
import {
  loadState,
  loadTelegramConfig,
  updateMeta,
  type FlatfinderState,
} from "../scrapers/wohnberatung/state.js";
import { sendTelegramMessage } from "../telegram.js";
import {
  getNextWillhabenRefreshAt,
  getNextWohnberatungRefreshAt,
  getWohnberatungIntervalsMs,
} from "./scheduler-service.js";

export type StatePayload = {
  updatedAt: string | null;
  nextRefreshWohnberatung: number;
  nextRefreshWillhaben: number;
  wohnberatungWohnungenIntervalMs: number;
  wohnberatungPlanungsprojekteIntervalMs: number;
};

export const createStateService = (options: { nowIso: () => string }) => {
  const clients = new Set<Response>();

  const syncAuthNotification = async (state: FlatfinderState) => {
    if (state.wohnberatungAuthError) {
      if (!state.wohnberatungAuthNotifiedAt) {
        const config = await loadTelegramConfig();
        if (config.enabled && config.botToken && config.chatId) {
          const ok = await sendTelegramMessage(
            config,
            "Wohnberatung login required. Open Settings and click “Start login”.",
          );
          if (!ok) {
            console.warn("[telegram] Failed to send Wohnberatung login notification.");
          } else {
            updateMeta({ wohnberatungAuthNotifiedAt: options.nowIso() });
          }
        }
      }
    } else if (state.wohnberatungAuthNotifiedAt) {
      updateMeta({ wohnberatungAuthNotifiedAt: null });
    }
  };

  const buildPayload = async (): Promise<StatePayload> => {
    const currentState = await loadState();
    await syncAuthNotification(currentState);
    const intervals = getWohnberatungIntervalsMs(currentState);
    return {
      updatedAt: currentState.updatedAt ?? null,
      nextRefreshWohnberatung: getNextWohnberatungRefreshAt(currentState),
      nextRefreshWillhaben: getNextWillhabenRefreshAt(currentState),
      wohnberatungWohnungenIntervalMs: intervals.wohnungenIntervalMs,
      wohnberatungPlanungsprojekteIntervalMs: intervals.planungsprojekteIntervalMs,
    };
  };

  const notifyClients = async () => {
    const payload = JSON.stringify(await buildPayload());
    for (const client of clients) {
      client.write(`data: ${payload}\n\n`);
    }
  };

  const registerClient = async (res: Response) => {
    res.write(`data: ${JSON.stringify(await buildPayload())}\n\n`);
    clients.add(res);
    res.on("close", () => {
      clients.delete(res);
    });
  };

  const touchUpdatedAt = async (updatedAt: string = options.nowIso()) => {
    updateMeta({ updatedAt });
    await notifyClients();
    return updatedAt;
  };

  const updateMetaAndNotify = async (patch: Partial<FlatfinderState>) => {
    updateMeta(patch);
    await notifyClients();
  };

  return {
    loadState,
    notifyClients,
    registerClient,
    touchUpdatedAt,
    updateMetaAndNotify,
    syncAuthNotification,
    nextRefreshWohnberatung: getNextWohnberatungRefreshAt,
    nextRefreshWillhaben: getNextWillhabenRefreshAt,
  };
};

export type StateService = ReturnType<typeof createStateService>;
