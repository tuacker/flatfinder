import { fetchTelegramUpdates, sendTelegramMessage, telegramRequest } from "../telegram.js";
import {
  loadTelegramConfig,
  saveTelegramConfig,
  type TelegramConfig,
  type FlatfinderState,
} from "../scrapers/wohnberatung/state.js";
import { updateItemsColumns } from "../db.js";
import type { StateService } from "./state-service.js";
import type { InterestService } from "./interest-service.js";

type TelegramCallback = { id: string; data?: string } | undefined;

type TelegramUpdate = {
  update_id: number;
  callback_query?: TelegramCallback;
};

type PollingResult = { ok: boolean; updates: TelegramUpdate[] };

const markTelegramNotified = (
  source: "wohnberatung" | "willhaben",
  type: "wohnungen" | "planungsprojekte",
  items: Array<{ id?: string | null }>,
  now: string,
) => {
  const updates = items
    .filter((item) => item.id)
    .map((item) => ({ id: item.id as string, values: [now] }));
  if (updates.length === 0) return;
  updateItemsColumns(source, type, ["telegram_notified_at"], updates, now);
};

export const createTelegramService = (options: {
  nowIso: () => string;
  stateService: StateService;
  interestService: InterestService;
}) => {
  let telegramPollingTimer: NodeJS.Timeout | null = null;
  let telegramPollingRunning = false;

  const schedulePolling = (delayMs = 0) => {
    if (telegramPollingTimer) clearTimeout(telegramPollingTimer);
    telegramPollingTimer = setTimeout(() => {
      void runPolling();
    }, delayMs);
  };

  const handleCallback = async (config: TelegramConfig, callback: TelegramCallback) => {
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
    if (!id) return;

    const result = await options.interestService.handleInterestAction({
      type: rawType,
      id,
      action: "add",
      confirm: false,
    });
    const ok = result.body?.ok === true;
    const responseText = ok
      ? "Marked as interested."
      : (result.body?.message ?? "Interest action failed.");
    await telegramRequest(config, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: responseText,
      show_alert: false,
    });
  };

  const fetchUpdates = async (
    config: TelegramConfig,
    optionsInput: {
      offset?: number | null;
      timeoutSeconds?: number;
      limit?: number;
      allowedUpdates?: string[];
    },
  ): Promise<PollingResult> => {
    try {
      return await fetchTelegramUpdates(config, optionsInput);
    } catch (error) {
      const details =
        error &&
        typeof error === "object" &&
        "cause" in error &&
        (error as { cause?: unknown }).cause
          ? ` (${String((error as { cause?: unknown }).cause)})`
          : "";
      console.warn(
        "[telegram] polling failed:",
        error instanceof Error ? `${error.message}${details}` : String(error),
      );
      return { ok: false, updates: [] };
    }
  };

  const runPolling = async () => {
    if (telegramPollingRunning) return;
    telegramPollingRunning = true;
    let hadError = false;
    try {
      const config = await loadTelegramConfig();
      if (
        !config.enabled ||
        !config.enableActions ||
        !config.pollingEnabled ||
        !config.botToken ||
        !config.chatId
      ) {
        return;
      }

      const result = await fetchUpdates(config, {
        offset: config.pollingOffset ?? 0,
        timeoutSeconds: 30,
        limit: 100,
        allowedUpdates: ["callback_query"],
      });

      if (!result.ok) return;

      let nextOffset = config.pollingOffset ?? 0;
      for (const update of result.updates) {
        nextOffset = Math.max(nextOffset, update.update_id + 1);
        await handleCallback(config, update.callback_query);
      }

      if (nextOffset !== (config.pollingOffset ?? 0)) {
        config.pollingOffset = nextOffset;
        await saveTelegramConfig(config);
      }
    } catch {
      hadError = true;
    } finally {
      telegramPollingRunning = false;
      schedulePolling(hadError ? 5000 : 1000);
    }
  };

  const updateConfig = async (body: Partial<TelegramConfig> | undefined) => {
    const config = await loadTelegramConfig();
    const wasEnabled = config.enabled;
    const wasPollingEnabled = config.pollingEnabled;

    config.enabled = Boolean(body?.enabled);
    config.botToken = body?.botToken ? String(body.botToken).trim() : null;
    config.chatId = body?.chatId ? String(body.chatId).trim() : null;
    config.enableActions = Boolean(body?.enableActions);
    config.pollingEnabled = Boolean(body?.pollingEnabled);
    config.webhookToken = body?.webhookToken ? String(body.webhookToken).trim() : null;

    if (config.enabled && (!config.botToken || !config.chatId)) {
      return { status: 400, body: { ok: false, message: "Bot token and chat ID are required." } };
    }
    if (config.enableActions && !config.pollingEnabled && !config.webhookToken) {
      return { status: 400, body: { ok: false, message: "Webhook token required for actions." } };
    }

    let currentState: FlatfinderState | null = null;
    if (config.enabled && !wasEnabled) {
      const now = options.nowIso();
      currentState = await options.stateService.loadState();
      markTelegramNotified("wohnberatung", "wohnungen", currentState.wohnungen, now);
      markTelegramNotified("wohnberatung", "planungsprojekte", currentState.planungsprojekte, now);
      markTelegramNotified("willhaben", "wohnungen", currentState.willhaben, now);
    }

    if (config.pollingEnabled && !wasPollingEnabled && config.botToken) {
      let offset = config.pollingOffset ?? 0;
      while (true) {
        const result = await fetchUpdates(config, {
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

    await saveTelegramConfig(config);
    schedulePolling();
    await options.stateService.notifyClients();

    return { status: 200, body: { ok: true, config } };
  };

  const sendTest = async () => {
    const config = await loadTelegramConfig();
    if (!config.botToken || !config.chatId) {
      return { status: 400, body: { ok: false, message: "Bot token and chat ID are required." } };
    }
    const canUseActions = config.enableActions && (config.pollingEnabled || config.webhookToken);
    const ok = await sendTelegramMessage(
      config,
      `Flatfinder test message (${options.nowIso()})`,
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
      return { status: 500, body: { ok: false, message: "Test message failed." } };
    }
    return { status: 200, body: { ok: true } };
  };

  const handleWebhook = async (token: string, update: { callback_query?: TelegramCallback }) => {
    const config = await loadTelegramConfig();
    if (!config.enableActions || !config.webhookToken || token !== config.webhookToken) {
      return { status: 401, body: { ok: false } };
    }

    await handleCallback(config, update?.callback_query);
    return { status: 200, body: { ok: true } };
  };

  return {
    schedulePolling,
    updateConfig,
    sendTest,
    handleWebhook,
    handleCallback,
  };
};

export type TelegramService = ReturnType<typeof createTelegramService>;
