import type { FlatfinderState } from "../scrapers/wohnberatung/state.js";

export type ItemType = "wohnungen" | "planungsprojekte" | "willhaben";
export type WohnberatungType = "wohnungen" | "planungsprojekte";

export const getCollection = (state: FlatfinderState, type: ItemType) =>
  type === "wohnungen"
    ? state.wohnungen
    : type === "planungsprojekte"
      ? state.planungsprojekte
      : type === "willhaben"
        ? state.willhaben
        : null;

export const getPageForType = (type: WohnberatungType) =>
  type === "wohnungen" ? "wohnung" : "projekt";
