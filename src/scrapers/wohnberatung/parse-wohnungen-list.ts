import { load } from "cheerio";
import { BASE_URL } from "./constants.js";

export type WohnungListItem = {
  id: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  postalCode: string | null;
  address: string | null;
  size: string | null;
  rooms: string | null;
  monthlyCost: string | null;
  equity: string | null;
  foerderungstyp: string | null;
  interessenten: number | null;
  registrationEnd: string | null;
  flags: {
    angemeldet: boolean;
    zugesagt: boolean;
    maxlimit: boolean;
    interesse: boolean;
    erstreihung: boolean;
    bautraeger: boolean;
  };
};

export type WohnungListResult = {
  total: number | null;
  items: WohnungListItem[];
};

const normalize = (value: string | undefined | null) =>
  value
    ? value
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim()
    : null;

const parseNumber = (value: string | null) => {
  if (!value) return null;
  const match = value.replace(/\./g, "").match(/\d+/g);
  if (!match) return null;
  return Number(match.join(""));
};

const absoluteUrl = (value: string | null) => {
  if (!value) return null;
  return new URL(value.replace(/&amp;/g, "&"), BASE_URL).toString();
};

const parseFlags = (className: string | undefined | null) => {
  const classList = (className ?? "").split(/\s+/);
  const has = (flag: string) => classList.includes(flag);
  return {
    angemeldet: has("angemeldet-1"),
    zugesagt: has("zugesagt-1"),
    maxlimit: has("maxlimit-1"),
    interesse: has("interesse-1"),
    erstreihung: has("erstreihung-1"),
    bautraeger: has("bautraeger-1"),
  };
};

export const parseWohnungenList = (html: string): WohnungListResult => {
  const $ = load(html);

  const totalText =
    $("h2.wbw-blue")
      .filter((_, el) => $(el).text().includes("Wohnungen gefunden"))
      .first()
      .text() || "";
  const total = parseNumber(totalText);

  const items: WohnungListItem[] = [];

  $(".media.media-wohnung").each((_, el) => {
    const entry = $(el);
    const link = entry.find("a[href*='?page=wohnung']").first();
    const href = link.attr("href") ?? null;

    const imageSrc = entry.find("img.media-object").first().attr("src") ?? null;

    const spans = entry.find("h4.media-heading a span");
    const postalCode = normalize(spans.eq(0).text());
    const addressParts = spans
      .slice(1)
      .toArray()
      .map((node) => normalize($(node).text()))
      .filter(Boolean) as string[];
    const address = addressParts.length ? addressParts.join(" / ") : null;

    const size = normalize(entry.find("li[title^='Größe']").text());
    const rooms = normalize(entry.find("li:has(b:contains('Zimmer'))").text());
    const monthlyCost = normalize(entry.find("li[title^='Monatliche Kosten']").text());
    const equity = normalize(entry.find("li:contains('Eigenmittel')").text());
    const foerderungstyp = normalize(entry.find("li[title^='Förderungstyp']").text());
    const interessentenText = normalize(entry.find(".text-success").text());

    const countdown = entry.find(".registration_countdown span[data-enddate]").attr("data-enddate");
    const registrationEnd = countdown ? new Date(Number(countdown)).toISOString() : null;

    items.push({
      id: href ? new URL(absoluteUrl(href)!).searchParams.get("id") : null,
      url: absoluteUrl(href),
      thumbnailUrl: absoluteUrl(imageSrc),
      postalCode,
      address,
      size,
      rooms,
      monthlyCost,
      equity,
      foerderungstyp,
      interessenten: parseNumber(interessentenText),
      registrationEnd,
      flags: parseFlags(entry.attr("class")),
    });
  });

  return { total, items };
};
