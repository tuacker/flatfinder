import { load } from "cheerio";
import { baseUrl } from "./config.js";
import type { PlanungsprojektDetail } from "./state.js";

const absoluteUrl = (value: string | null) => {
  if (!value) return null;
  return new URL(value.replace(/&amp;/g, "&"), baseUrl).toString();
};

export const parsePlanungsprojektDetail = (html: string): PlanungsprojektDetail => {
  const $ = load(html);

  const lageplanUrl = absoluteUrl(
    $("a")
      .filter((_, el) => $(el).text().trim() === "Lageplan")
      .first()
      .attr("href") ?? null,
  );

  const imageUrls = $(".gallery a.wsw_thumb")
    .toArray()
    .map((el) => absoluteUrl($(el).attr("href") ?? null))
    .filter(Boolean) as string[];

  return {
    lageplanUrl,
    imageUrls,
  };
};
