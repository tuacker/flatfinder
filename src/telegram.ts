import type {
  PlanungsprojektRecord,
  TelegramConfig,
  WohnungRecord,
} from "./scrapers/wohnberatung/state.js";

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

const escapeTelegramHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const formatTelegramText = (options: {
  title: string;
  url?: string | null;
  lines: Array<string | null | undefined>;
  links?: Array<{ label: string; url: string | null | undefined }>;
}) => {
  const lines = options.lines.filter((line) => line && line.trim().length > 0) as string[];
  const header = `<b>${escapeTelegramHtml(options.title)}</b>`;
  const link = options.url ? `<a href="${escapeTelegramHtml(options.url)}">Open item</a>` : null;
  const extraLinks =
    options.links
      ?.filter((entry) => entry.url)
      .map(
        (entry) =>
          `<a href="${escapeTelegramHtml(entry.url ?? "")}">${escapeTelegramHtml(entry.label)}</a>`,
      ) ?? [];
  return [header, ...lines.map(escapeTelegramHtml), link, ...extraLinks].filter(Boolean).join("\n");
};

export const telegramRequest = async (
  config: TelegramConfig,
  method: string,
  payload: Record<string, unknown>,
): Promise<TelegramRequestResult> => {
  if (!config.botToken) return { ok: false, status: 0 };
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
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

  const result = await telegramRequest(config, "getUpdates", payload);
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
  const result = await telegramRequest(config, "sendMessage", payload);
  if (!result.ok) {
    console.warn("[telegram] sendMessage failed", result.status, result.text?.slice(0, 200));
  }
  return result.ok;
};

const sendTelegramMediaGroup = async (
  config: TelegramConfig,
  mediaUrls: string[],
  caption: string,
  options?: { keyboard?: unknown },
) => {
  if (!config.botToken || !config.chatId) return false;
  if (mediaUrls.length === 0) return false;
  const media = mediaUrls.slice(0, 4).map((url, index) => ({
    type: "photo",
    media: url,
    caption: index === 0 ? caption : undefined,
    parse_mode: index === 0 ? "HTML" : undefined,
  }));
  const result = await telegramRequest(config, "sendMediaGroup", {
    chat_id: config.chatId,
    media,
  });
  if (!result.ok) {
    console.warn("[telegram] sendMediaGroup failed", result.status, result.text?.slice(0, 200));
    return false;
  }
  if (options?.keyboard) {
    await sendTelegramMessage(config, caption, options);
  }
  return true;
};

const buildTelegramKeyboard = (
  config: TelegramConfig,
  options: { type: "wohnungen" | "planungsprojekte"; id: string | null | undefined },
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

const pickTelegramImages = (urls: Array<string | null | undefined>) =>
  urls.map((url) => url ?? "").filter((url) => url.length > 0);

const sendTelegramNotification = async (options: {
  config: TelegramConfig;
  text: string;
  images: string[];
  keyboard?: unknown;
}) => {
  const { config, images, text, keyboard } = options;
  if (config.includeImages && images.length > 0) {
    const ok = await sendTelegramMediaGroup(config, images, text, { keyboard });
    if (ok) return true;
  }
  return await sendTelegramMessage(config, text, { keyboard });
};

const notifyTelegramForWohnung = async (config: TelegramConfig, item: WohnungRecord) => {
  const images = pickTelegramImages([...(item.detail?.imageUrls ?? []), item.thumbnailUrl]);
  const text = formatTelegramText({
    title: `${item.postalCode ?? ""} ${item.address ?? ""}`.trim(),
    url: item.url ?? null,
    lines: [
      item.registrationEnd ? `Ends: ${item.registrationEnd}` : null,
      item.size ? `Size: ${item.size}` : null,
      item.rooms ? `Rooms: ${item.rooms}` : null,
      item.monthlyCost ? `Cost: ${item.monthlyCost}` : null,
      item.equity ? `Equity: ${item.equity}` : null,
      item.foerderungstyp ? `Type: ${item.foerderungstyp}` : null,
      item.interessenten ? `Signups: ${item.interessenten}` : null,
    ],
    links: item.detail?.mapUrl ? [{ label: "Map", url: item.detail.mapUrl }] : [],
  });
  return await sendTelegramNotification({
    config,
    text,
    images,
    keyboard: buildTelegramKeyboard(config, { type: "wohnungen", id: item.id }),
  });
};

const notifyTelegramForProjekt = async (config: TelegramConfig, item: PlanungsprojektRecord) => {
  const images = pickTelegramImages([...(item.detail?.imageUrls ?? []), item.imageUrl]);
  const text = formatTelegramText({
    title: `${item.postalCode ?? ""} ${item.address ?? ""}`.trim(),
    url: item.url ?? null,
    lines: [
      item.bezugsfertig ? `Bezugsfertig: ${item.bezugsfertig}` : null,
      item.foerderungstyp ? `Type: ${item.foerderungstyp}` : null,
      item.interessenten ? `Signups: ${item.interessenten}` : null,
    ],
    links: item.detail?.lageplanUrl ? [{ label: "Lageplan", url: item.detail.lageplanUrl }] : [],
  });
  return await sendTelegramNotification({
    config,
    text,
    images,
    keyboard: buildTelegramKeyboard(config, { type: "planungsprojekte", id: item.id }),
  });
};

export const notifyTelegramNewItems = async (
  config: TelegramConfig | undefined,
  options: {
    wohnungen: WohnungRecord[];
    planungsprojekte: PlanungsprojektRecord[];
  },
) => {
  if (!config?.enabled || !config.botToken || !config.chatId) return;
  const now = new Date().toISOString();
  const notifyList = async <T extends { telegramNotifiedAt?: string | null }>(
    items: T[],
    notifier: (item: T) => Promise<boolean>,
  ) => {
    for (const item of items) {
      if (item.telegramNotifiedAt) continue;
      const ok = await notifier(item);
      if (ok) item.telegramNotifiedAt = now;
    }
  };

  await notifyList(options.wohnungen, (item) => notifyTelegramForWohnung(config, item));
  await notifyList(options.planungsprojekte, (item) => notifyTelegramForProjekt(config, item));
};
