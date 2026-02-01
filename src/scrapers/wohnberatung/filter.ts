import type { Planungsprojekt } from "./parse-planungsprojekte.js";
import { excludedKeywords, planungsprojektePlzRange } from "./config.js";

const excludedKeywordsLower = excludedKeywords.map((keyword) => keyword.toLowerCase());

const parsePostalCode = (postalCode: string | null) => {
  const parsed = Number.parseInt(postalCode ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const isAllowedPostalCode = (postalCode: string | null) => {
  const parsed = parsePostalCode(postalCode);
  return (
    parsed !== null &&
    parsed >= planungsprojektePlzRange.min &&
    parsed <= planungsprojektePlzRange.max
  );
};

export const hasExcludedKeyword = (text: string | null) => {
  if (!text) return false;
  const lower = text.toLowerCase();
  return excludedKeywordsLower.some((keyword) => lower.includes(keyword));
};

export const filterPlanungsprojekte = (items: Planungsprojekt[]) => {
  return items.filter((item) => {
    if (!isAllowedPostalCode(item.postalCode)) return false;
    const title = [item.address, item.postalCode, item.foerderungstyp].filter(Boolean).join(" ");
    return !hasExcludedKeyword(title);
  });
};
