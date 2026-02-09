import type { FlatfinderState } from "../state/flatfinder-state.js";

export type ItemType = "wohnungen" | "planungsprojekte" | "willhaben" | "derstandard";
export type WohnberatungType = "wohnungen" | "planungsprojekte";

export function getCollection(
  state: FlatfinderState,
  type: "wohnungen",
): FlatfinderState["wohnungen"];
export function getCollection(
  state: FlatfinderState,
  type: "planungsprojekte",
): FlatfinderState["planungsprojekte"];
export function getCollection(
  state: FlatfinderState,
  type: "willhaben",
): FlatfinderState["willhaben"];
export function getCollection(
  state: FlatfinderState,
  type: "derstandard",
): FlatfinderState["derstandard"];
export function getCollection(state: FlatfinderState, type: ItemType) {
  if (type === "wohnungen") return state.wohnungen;
  if (type === "planungsprojekte") return state.planungsprojekte;
  if (type === "willhaben") return state.willhaben;
  return state.derstandard;
}

export const getPageForType = (type: WohnberatungType) =>
  type === "wohnungen" ? "wohnung" : "projekt";

export const getDbLocation = (type: ItemType) =>
  type === "willhaben"
    ? { source: "willhaben" as const, type: "wohnungen" as const }
    : type === "derstandard"
      ? { source: "derstandard" as const, type: "wohnungen" as const }
      : { source: "wohnberatung" as const, type: type };
