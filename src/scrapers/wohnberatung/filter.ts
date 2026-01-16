import type { Planungsprojekt } from "./parse-planungsprojekte.js";
import { excludedKeywords, planungsprojektePlzRange } from "./config.js";

export type PlanungsprojektExclusion = {
  item: Planungsprojekt;
  reason: string;
};

export type PlanungsprojektFilterResult = {
  included: Planungsprojekt[];
  excluded: PlanungsprojektExclusion[];
};

const parsePostalCode = (postalCode: string | null) => {
  if (!postalCode) return null;
  const parsed = Number.parseInt(postalCode.trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const isAllowedPostalCode = (postalCode: string | null) => {
  const parsed = parsePostalCode(postalCode);
  if (parsed === null) return false;
  return parsed >= planungsprojektePlzRange.min && parsed <= planungsprojektePlzRange.max;
};

export const hasExcludedKeyword = (text: string | null) => {
  if (!text) return false;
  return excludedKeywords.some((keyword) =>
    text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()),
  );
};

const getTitle = (item: Planungsprojekt) => {
  return [item.address, item.postalCode].filter(Boolean).join(" ");
};

export const filterPlanungsprojekte = (items: Planungsprojekt[]): PlanungsprojektFilterResult => {
  const included: Planungsprojekt[] = [];
  const excluded: PlanungsprojektExclusion[] = [];

  for (const item of items) {
    if (!isAllowedPostalCode(item.postalCode)) {
      excluded.push({
        item,
        reason: `PLZ not in range ${planungsprojektePlzRange.min}-${planungsprojektePlzRange.max}`,
      });
      continue;
    }

    const title = getTitle(item);
    if (hasExcludedKeyword(title)) {
      excluded.push({ item, reason: "Excluded keyword in title" });
      continue;
    }

    included.push(item);
  }

  return { included, excluded };
};
