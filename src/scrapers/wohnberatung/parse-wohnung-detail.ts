import { load } from "cheerio";
import { BASE_URL } from "./constants.js";

export type WohnungDetail = {
  superfoerderung: string | null;
  mapUrl: string | null;
  mapImageUrl: string | null;
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
  return new URL(value.replace(/&amp;/g, "&"), BASE_URL).toString();
};

export const parseWohnungDetail = (html: string): WohnungDetail => {
  const $ = load(html);

  const mapAnchor = $("a[href*='google.com/maps']").first();
  const mapUrl = absoluteUrl(mapAnchor.attr("href") ?? null);
  const mapImageUrl = absoluteUrl($("img.googlemap_static").first().attr("src") ?? null);

  const imageUrls = $("img.img-150")
    .toArray()
    .map((img) => absoluteUrl($(img).attr("src") ?? null))
    .filter(Boolean) as string[];

  const superfoerderungRow = $("tr").filter((_, el) => {
    const text = normalize($(el).find("th").text());
    return text?.toLowerCase().startsWith("superförderung");
  });
  const superfoerderung = normalize(superfoerderungRow.first().find("td").text());

  return {
    superfoerderung,
    mapUrl,
    mapImageUrl,
    imageUrls,
  };
};
