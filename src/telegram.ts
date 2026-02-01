import type {
  PlanungsprojektRecord,
  TelegramConfig,
  WohnungRecord,
  WillhabenRecord,
} from "./scrapers/wohnberatung/state.js";
import { fetchWithTimeout } from "./shared/http.js";

type TelegramRequestResult = {
  ok: boolean;
  status: number;
  text?: string;
};

export type TelegramUpdate = {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
  };
};

const telegramRateState = {
  nextAllowedAt: 0,
};
const telegramMinIntervalMs = 1000;
const telegramRequestTimeoutMs = 15_000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const parseRetryAfterMs = (result: TelegramRequestResult) => {
  if (result.status !== 429 || !result.text) return null;
  try {
    const parsed = JSON.parse(result.text) as {
      parameters?: { retry_after?: number };
    };
    const seconds = parsed?.parameters?.retry_after;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return Math.max(0, seconds) * 1000;
    }
  } catch {
    // ignore
  }
  return null;
};

const waitForTelegramSlot = async () => {
  const waitMs = telegramRateState.nextAllowedAt - Date.now();
  if (waitMs > 0) {
    await delay(waitMs);
  }
};

const markTelegramCooldown = (retryAfterMs: number) => {
  telegramRateState.nextAllowedAt = Math.max(
    telegramRateState.nextAllowedAt,
    Date.now() + retryAfterMs,
  );
};

const telegramRequestWithRetry = async (
  config: TelegramConfig,
  method: string,
  payload: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => {
  await waitForTelegramSlot();
  const result = await telegramRequest(config, method, payload, options);
  telegramRateState.nextAllowedAt = Math.max(
    telegramRateState.nextAllowedAt,
    Date.now() + telegramMinIntervalMs,
  );
  const retryAfterMs = parseRetryAfterMs(result);
  if (retryAfterMs !== null) {
    markTelegramCooldown(retryAfterMs);
    await delay(retryAfterMs);
    const retryResult = await telegramRequest(config, method, payload, options);
    telegramRateState.nextAllowedAt = Math.max(
      telegramRateState.nextAllowedAt,
      Date.now() + telegramMinIntervalMs,
    );
    return retryResult;
  }
  return result;
};

const escapeTelegramHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const formatTelegramText = (options: {
  title: string;
  url?: string | null;
  lines: Array<string | null | undefined>;
  links?: Array<{ label: string; url: string | null | undefined }>;
}) => {
  const lines = options.lines.filter((line) => line && line.trim().length > 0) as string[];
  const header = options.url
    ? `<b><a href="${escapeTelegramHtml(options.url)}">${escapeTelegramHtml(options.title)}</a></b>`
    : `<b>${escapeTelegramHtml(options.title)}</b>`;
  const extraLinks =
    options.links
      ?.filter((entry) => entry.url)
      .map(
        (entry) =>
          `<a href="${escapeTelegramHtml(entry.url ?? "")}">${escapeTelegramHtml(entry.label)}</a>`,
      ) ?? [];
  return [header, ...lines.map(escapeTelegramHtml), ...extraLinks].filter(Boolean).join("\n");
};

export const telegramRequest = async (
  config: TelegramConfig,
  method: string,
  payload: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<TelegramRequestResult> => {
  if (!config.botToken) return { ok: false, status: 0 };
  const timeoutMs = options?.timeoutMs ?? telegramRequestTimeoutMs;
  const response = await fetchWithTimeout(
    `https://api.telegram.org/bot${config.botToken}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs,
    },
  );
  return { ok: response.ok, status: response.status, text: await response.text() };
};

export const fetchTelegramUpdates = async (
  config: TelegramConfig,
  options: {
    offset?: number | null;
    timeoutSeconds?: number;
    limit?: number;
    allowedUpdates?: string[];
  } = {},
) => {
  if (!config.botToken) {
    return { ok: false, updates: [] as TelegramUpdate[] };
  }
  const payload: Record<string, unknown> = {};
  if (typeof options.offset === "number") payload.offset = options.offset;
  if (typeof options.timeoutSeconds === "number") payload.timeout = options.timeoutSeconds;
  if (typeof options.limit === "number") payload.limit = options.limit;
  if (options.allowedUpdates?.length) payload.allowed_updates = options.allowedUpdates;

  const timeoutMs =
    typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
      ? options.timeoutSeconds * 1000 + 5000
      : telegramRequestTimeoutMs;
  const result = await telegramRequest(config, "getUpdates", payload, { timeoutMs });
  if (!result.ok) {
    return { ok: false, updates: [] as TelegramUpdate[] };
  }
  try {
    const parsed = JSON.parse(result.text ?? "") as { ok?: boolean; result?: TelegramUpdate[] };
    if (!parsed?.ok || !Array.isArray(parsed.result)) {
      return { ok: false, updates: [] as TelegramUpdate[] };
    }
    return { ok: true, updates: parsed.result };
  } catch {
    return { ok: false, updates: [] as TelegramUpdate[] };
  }
};

export const sendTelegramMessage = async (
  config: TelegramConfig,
  text: string,
  options?: { keyboard?: unknown },
) => {
  if (!config.botToken || !config.chatId) return false;
  const payload: Record<string, unknown> = {
    chat_id: config.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };
  if (options?.keyboard) {
    payload.reply_markup = options.keyboard;
  }
  const result = await telegramRequestWithRetry(config, "sendMessage", payload);
  if (!result.ok) {
    console.warn("[telegram] sendMessage failed", result.status, result.text?.slice(0, 200));
  }
  return result.ok;
};

type TelegramPayload = {
  text: string;
  keyboard?: unknown;
};

const buildTelegramPayload = (options: {
  title: string;
  url?: string | null;
  keyboard?: unknown;
}): TelegramPayload => ({
  text: formatTelegramText({
    title: options.title,
    url: options.url,
    lines: [],
  }),
  keyboard: options.keyboard,
});

const buildTelegramKeyboard = (
  config: TelegramConfig,
  options: { type: "wohnungen" | "planungsprojekte" | "willhaben"; id: string | null | undefined },
) => {
  if (!config.enableActions || (!config.pollingEnabled && !config.webhookToken) || !options.id) {
    return undefined;
  }
  return {
    inline_keyboard: [
      [
        {
          text: "Interested",
          callback_data: `interest:${options.type}:${options.id}`,
        },
      ],
    ],
  };
};

const sendTelegramNotification = async (options: {
  config: TelegramConfig;
  text: string;
  keyboard?: unknown;
}) => {
  const { config, text, keyboard } = options;
  return await sendTelegramMessage(config, text, { keyboard });
};

const notifyTelegramForWohnung = async (config: TelegramConfig, item: WohnungRecord) => {
  const payload = buildTelegramPayload({
    title: `${item.postalCode ?? ""} ${item.address ?? ""}`.trim(),
    url: item.url ?? null,
    keyboard: buildTelegramKeyboard(config, { type: "wohnungen", id: item.id }),
  });
  return await sendTelegramNotification({ config, ...payload });
};

const notifyTelegramForProjekt = async (config: TelegramConfig, item: PlanungsprojektRecord) => {
  const payload = buildTelegramPayload({
    title: `${item.postalCode ?? ""} ${item.address ?? ""}`.trim(),
    url: item.url ?? null,
    keyboard: buildTelegramKeyboard(config, { type: "planungsprojekte", id: item.id }),
  });
  return await sendTelegramNotification({ config, ...payload });
};

const notifyTelegramForWillhaben = async (config: TelegramConfig, item: WillhabenRecord) => {
  const payload = buildTelegramPayload({
    title: item.title ?? item.location ?? "Willhaben listing",
    url: item.url ?? null,
    keyboard: buildTelegramKeyboard(config, { type: "willhaben", id: item.id }),
  });
  return await sendTelegramNotification({ config, ...payload });
};

export const notifyTelegramNewItems = async (
  config: TelegramConfig | undefined,
  options: {
    wohnungen: WohnungRecord[];
    planungsprojekte: PlanungsprojektRecord[];
    willhaben: WillhabenRecord[];
    now?: string;
  },
) => {
  if (!config?.enabled || !config.botToken || !config.chatId) return null;
  const now = options.now ?? new Date().toISOString();
  const notified = {
    wohnungen: [] as string[],
    planungsprojekte: [] as string[],
    willhaben: [] as string[],
  };

  const notifyList = async <T extends { id?: string | null; telegramNotifiedAt?: string | null }>(
    items: T[],
    notifier: (item: T) => Promise<boolean>,
    target: string[],
  ) => {
    for (const item of items) {
      if (!item.id || item.telegramNotifiedAt) continue;
      const ok = await notifier(item);
      if (ok) {
        item.telegramNotifiedAt = now;
        target.push(item.id);
      }
    }
  };

  await notifyList(
    options.wohnungen,
    (item) => notifyTelegramForWohnung(config, item),
    notified.wohnungen,
  );
  await notifyList(
    options.planungsprojekte,
    (item) => notifyTelegramForProjekt(config, item),
    notified.planungsprojekte,
  );
  await notifyList(
    options.willhaben.filter((item) => !item.suppressed && !item.hiddenAt),
    (item) => notifyTelegramForWillhaben(config, item),
    notified.willhaben,
  );

  return notified;
};
