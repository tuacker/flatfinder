import { load } from "cheerio";
import { baseUrl } from "./config.js";

export type WohnungDetail = {
  superfoerderung: string | null;
  mapUrl: string | null;
  imageUrls: string[];
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
  return new URL(value.replace(/&amp;/g, "&"), baseUrl).toString();
};

export const parseWohnungDetail = (html: string): WohnungDetail => {
  const $ = load(html);

  const mapAnchor = $("a[href*='google.com/maps']").first();
  const mapUrl = absoluteUrl(mapAnchor.attr("href") ?? null);

  const imageUrls = $("img.img-150")
    .toArray()
    .map((img) => absoluteUrl($(img).attr("src") ?? null))
    .filter(Boolean) as string[];

  const superfoerderungRow = $("tr").filter((_, el) => {
    const text = normalize($(el).find("th").text());
    if (!text) return false;
    const lower = text.toLowerCase();
    return lower.startsWith("superförderung") || lower.startsWith("superfoerderung");
  });
  const superfoerderung = normalize(superfoerderungRow.first().find("td").text());

  return {
    superfoerderung,
    mapUrl,
    imageUrls,
  };
};
