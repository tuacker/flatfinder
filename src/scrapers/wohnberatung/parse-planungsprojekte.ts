import { load } from "cheerio";
import { baseUrl } from "./config.js";

export type Planungsprojekt = {
  id: string | null;
  url: string | null;
  imageUrl: string | null;
  postalCode: string | null;
  address: string | null;
  bezugsfertig: string | null;
  foerderungstyp: string | null;
  interessenten: number | null;
  flags: {
    angemeldet: boolean;
    maxlimit: boolean;
  };
};

const normalize = (value: string | undefined | null) =>
  value
    ? value
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim()
    : null;

const absoluteUrl = (value: string | null) => {
  if (!value) return null;
  const cleaned = value.replace(/&amp;/g, "&");
  return new URL(cleaned, baseUrl).toString();
};

const parseNumber = (value: string | null) => {
  if (!value) return null;
  const match = value.replace(/\./g, "").match(/\d+/g);
  if (!match) return null;
  return Number(match.join(""));
};

export const parsePlanungsprojekte = (html: string): Planungsprojekt[] => {
  const $ = load(html);

  const items: Planungsprojekt[] = [];

  $("#wsw_planungsprojekte .media.media-wohnung").each((_, el) => {
    const entry = $(el);
    const link = entry.find("a[href*='?page=projekt']").first();
    const href = link.attr("href") ?? null;
    const url = absoluteUrl(href);

    const imageSrc = entry.find("img.media-object").first().attr("src") ?? null;
    const spans = entry.find("h4.media-heading span");
    const postalCode = normalize(spans.eq(0).text());
    const address = normalize(spans.eq(1).text());

    const bezugsfertigText = normalize(entry.find("li[title^='Bezugsfertig']").first().text());
    const foerderungText = normalize(entry.find("li[title^='Förderungstyp']").first().text());
    const interessentenText = normalize(entry.find("li.meta-interessenten").text());
    const classList = (entry.attr("class") ?? "").split(/\s+/);

    items.push({
      id: url ? new URL(url).searchParams.get("id") : null,
      url,
      imageUrl: absoluteUrl(imageSrc),
      postalCode,
      address,
      bezugsfertig: bezugsfertigText?.replace(/^Bezugsfertig:\s*/i, "") ?? null,
      foerderungstyp: foerderungText,
      interessenten: parseNumber(interessentenText),
      flags: {
        angemeldet: classList.includes("angemeldet-1"),
        maxlimit: classList.includes("maxlimit-1"),
      },
    });
  });

  return items;
};
