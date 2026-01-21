import { formatRefreshLeft, formatTimeLeft } from "./time.js";

const updateCountdowns = () => {
  document.querySelectorAll<HTMLElement>(".time[data-end]").forEach((node) => {
    const end = node.getAttribute("data-end");
    const formatted = formatTimeLeft(end);
    if (formatted) {
      node.textContent = formatted;
    }
  });
};

const updateRefreshCountdowns = () => {
  document.querySelectorAll<HTMLElement>(".title-meta.refresh[data-refresh-at]").forEach((node) => {
    const nextAt = node.getAttribute("data-refresh-at");
    const formatted = formatRefreshLeft(nextAt);
    if (formatted) {
      node.textContent = formatted;
    }
  });
};

const highlightNew = () => {
  document.querySelectorAll<HTMLElement>(".row[data-seen-at]").forEach((row) => {
    const seenAt = row.getAttribute("data-seen-at");
    row.classList.toggle("is-new", !seenAt);
  });
};

const updateNextRefreshLabel = () => {
  const willhabenLabel = document.getElementById("next-refresh-willhaben");
  const wohnberatungLabel = document.getElementById("next-refresh-wohnberatung");
  const willhabenAt = Number(document.body.getAttribute("data-next-refresh-willhaben"));
  const wohnberatungAt = Number(document.body.getAttribute("data-next-refresh-wohnberatung"));
  if (willhabenLabel && Number.isFinite(willhabenAt)) {
    willhabenLabel.textContent = formatRefreshLeft(new Date(willhabenAt).toISOString()) ?? "soon";
  }
  if (wohnberatungLabel && Number.isFinite(wohnberatungAt)) {
    const diffMs = wohnberatungAt - Date.now();
    if (Number.isNaN(diffMs)) {
      wohnberatungLabel.textContent = "soon";
      return;
    }
    if (diffMs <= 0) {
      wohnberatungLabel.textContent = "now";
      return;
    }
    const minutes = Math.max(1, Math.ceil(diffMs / 60000));
    wohnberatungLabel.textContent = `${minutes}m`;
  }
};

const refreshDerivedUi = () => {
  updateCountdowns();
  updateRefreshCountdowns();
  highlightNew();
  updateNextRefreshLabel();
};

const bindOnce = (element: HTMLElement, key: string, handler: (event: Event) => void) => {
  if (element.dataset[key] === "true") return;
  element.dataset[key] = "true";
  element.addEventListener("click", handler);
};

const bindOnceEvent = (
  element: HTMLElement,
  key: string,
  eventName: string,
  handler: (event: Event) => void,
) => {
  if (element.dataset[key] === "true") return;
  element.dataset[key] = "true";
  element.addEventListener(eventName, handler);
};

const initMapToggles = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-toggle-map").forEach((button) => {
    bindOnce(button, "boundMap", (event) => {
      event.preventDefault();
      const target = button.getAttribute("data-target");
      if (!target) return;
      const container = document.getElementById(target);
      if (!container) return;
      container.classList.toggle("is-hidden");
    });
  });
};

type ViewName = "root" | "hidden" | "interested" | "settings";
type SourceFilter = "all" | "wohnberatung" | "willhaben";
type WillhabenSortKey = "price" | "area" | null;
type WillhabenSortDir = "asc" | "desc" | null;
let reorderActive = false;

const syncReorderActive = () => {
  reorderActive = Array.from(document.querySelectorAll<HTMLElement>(".list[data-rank-mode]")).some(
    (list) => list.getAttribute("data-rank-mode") === "true",
  );
};

const resolveView = (pathname: string): { view: ViewName; path: string } => {
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  if (trimmed === "/hidden") return { view: "hidden", path: "/hidden" };
  if (trimmed === "/interested") return { view: "interested", path: "/interested" };
  if (trimmed === "/settings") return { view: "settings", path: "/settings" };
  return { view: "root", path: "/" };
};

const setView = (view: ViewName, options: { replace?: boolean } = {}) => {
  document.body.setAttribute("data-view", view);
  document.querySelectorAll<HTMLButtonElement>(".js-view-toggle").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  clearSwapHighlights();
  const targetPath = view === "root" ? "/" : `/${view}`;
  if (window.location.pathname === targetPath) return;
  const url = new URL(window.location.href);
  url.pathname = targetPath;
  if (options.replace) {
    window.history.replaceState({ view }, "", url.toString());
  } else {
    window.history.pushState({ view }, "", url.toString());
  }
};

const initViewToggles = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-view-toggle").forEach((button) => {
    bindOnce(button, "boundView", (event) => {
      event.preventDefault();
      const view = button.dataset.view as ViewName | undefined;
      if (!view) return;
      setView(view);
    });
  });
};

const syncViewWithLocation = (replace: boolean) => {
  const resolved = resolveView(window.location.pathname);
  setView(resolved.view, { replace });
};

const resolveSourceFilter = (search: string): SourceFilter => {
  const params = new URLSearchParams(search);
  const source = params.get("source");
  if (source === "wohnberatung" || source === "willhaben") return source;
  return "all";
};

const setSourceFilter = (source: SourceFilter, options: { replace?: boolean } = {}) => {
  document.body.setAttribute("data-source", source);
  document.querySelectorAll<HTMLButtonElement>(".js-source-toggle").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.source === source);
  });
  updateHiddenCount();
  const url = new URL(window.location.href);
  if (source === "all") {
    url.searchParams.delete("source");
  } else {
    url.searchParams.set("source", source);
  }
  if (options.replace) {
    window.history.replaceState({ source }, "", url.toString());
  } else {
    window.history.pushState({ source }, "", url.toString());
  }
};

const initSourceFilters = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-source-toggle").forEach((button) => {
    bindOnce(button, "boundSource", (event) => {
      event.preventDefault();
      const source = button.dataset.source as SourceFilter | undefined;
      if (!source) return;
      setSourceFilter(source);
    });
  });
};

const syncSourceWithLocation = (replace: boolean) => {
  const source = resolveSourceFilter(window.location.search);
  setSourceFilter(source, { replace });
};

let suppressReloadUntil = 0;

const rowListIds = {
  wohnungen: "wohnungen-list",
  planungsprojekte: "planungsprojekte-list",
  willhaben: "willhaben-list",
} as const;

const getRowList = (type: string) => {
  const listId = rowListIds[type as keyof typeof rowListIds];
  return listId ? document.getElementById(listId) : null;
};

const getMapSection = (row: HTMLElement) => {
  const mapToggle = row.querySelector<HTMLButtonElement>(".js-toggle-map");
  const mapId = mapToggle?.getAttribute("data-target");
  return mapId ? document.getElementById(mapId) : null;
};

const moveRowWithMap = (row: HTMLElement, list: HTMLElement, before: Element | null) => {
  const mapSection = getMapSection(row);
  if (before) {
    list.insertBefore(row, before);
    if (mapSection) list.insertBefore(mapSection, before);
  } else {
    list.appendChild(row);
    if (mapSection) list.appendChild(mapSection);
  }
};

const insertHiddenRow = (row: HTMLElement, hiddenList: HTMLElement) => {
  const hiddenAt = row.getAttribute("data-hidden-at") ?? "";
  const rows = Array.from(hiddenList.querySelectorAll<HTMLElement>(":scope > .row"));
  const insertBefore =
    rows.find((entry) => (entry.getAttribute("data-hidden-at") ?? "") < hiddenAt) ?? null;
  moveRowWithMap(row, hiddenList, insertBefore);
};

const placeSeenOrder = (row: HTMLElement, list: HTMLElement) => {
  const isSeen = row.classList.contains("is-seen");
  const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > .row")).filter(
    (entry) => entry !== row,
  );
  if (isSeen) {
    moveRowWithMap(row, list, null);
    return;
  }
  const firstSeen = rows.find((entry) => entry.classList.contains("is-seen")) ?? null;
  moveRowWithMap(row, list, firstSeen);
};

const matchesSourceFilter = (row: HTMLElement, filter: SourceFilter) => {
  if (filter === "all") return true;
  const type = row.getAttribute("data-type");
  const isWillhaben = type === "willhaben";
  return filter === "willhaben" ? isWillhaben : !isWillhaben;
};

const updateHiddenCount = () => {
  const filter = (document.body.getAttribute("data-source") ?? "all") as SourceFilter;
  const count = Array.from(document.querySelectorAll<HTMLElement>("#hidden-list > .row")).filter(
    (row) => matchesSourceFilter(row, filter),
  ).length;
  const label = document.getElementById("hidden-count");
  if (label) label.textContent = String(count);
};

type WillhabenUrlState = {
  sortKey: WillhabenSortKey;
  sortDir: WillhabenSortDir;
  districts: string[];
  rooms: string[];
};

const readWillhabenStateFromUrl = (): WillhabenUrlState => {
  const params = new URLSearchParams(window.location.search);
  const sortKey = params.get("wh_sort");
  const sortDir = params.get("wh_dir");
  const districts = params.get("wh_districts");
  const rooms = params.get("wh_rooms");
  return {
    sortKey: sortKey === "price" || sortKey === "area" ? sortKey : null,
    sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : null,
    districts: districts ? districts.split(",").filter(Boolean) : [],
    rooms: rooms ? rooms.split(",").filter(Boolean) : [],
  };
};

const writeWillhabenStateToUrl = (state: WillhabenUrlState) => {
  const url = new URL(window.location.href);
  if (state.sortKey && state.sortDir) {
    url.searchParams.set("wh_sort", state.sortKey);
    url.searchParams.set("wh_dir", state.sortDir);
  } else {
    url.searchParams.delete("wh_sort");
    url.searchParams.delete("wh_dir");
  }
  if (state.districts.length) {
    url.searchParams.set("wh_districts", state.districts.join(","));
  } else {
    url.searchParams.delete("wh_districts");
  }
  if (state.rooms.length) {
    url.searchParams.set("wh_rooms", state.rooms.join(","));
  } else {
    url.searchParams.delete("wh_rooms");
  }
  window.history.pushState({}, "", url.toString());
};

const initWillhabenFilters = () => {
  const controls = document.getElementById("willhaben-controls");
  if (!controls) return;
  controls.querySelectorAll<HTMLButtonElement>(".js-sort-chip").forEach((button) => {
    bindOnce(button, "boundSort", () => {
      const key = button.dataset.sort as WillhabenSortKey | undefined;
      if (!key) return;
      const state = readWillhabenStateFromUrl();
      if (state.sortKey !== key) {
        state.sortKey = key;
        state.sortDir = "asc";
      } else if (state.sortDir === "asc") {
        state.sortDir = "desc";
      } else {
        state.sortKey = null;
        state.sortDir = null;
      }
      writeWillhabenStateToUrl(state);
      void refreshFromServer();
    });
  });
  controls.querySelectorAll<HTMLButtonElement>(".js-filter-district").forEach((button) => {
    bindOnce(button, "boundDistrict", () => {
      const value = button.dataset.value ?? "";
      const state = readWillhabenStateFromUrl();
      if (value === "all") {
        state.districts = [];
      } else if (state.districts.includes(value)) {
        state.districts = state.districts.filter((entry) => entry !== value);
      } else {
        state.districts = [...state.districts, value];
      }
      writeWillhabenStateToUrl(state);
      void refreshFromServer();
    });
  });
  controls.querySelectorAll<HTMLButtonElement>(".js-filter-rooms").forEach((button) => {
    bindOnce(button, "boundRooms", () => {
      const value = button.dataset.value ?? "";
      const state = readWillhabenStateFromUrl();
      if (value === "all") {
        state.rooms = [];
      } else if (state.rooms.includes(value)) {
        state.rooms = state.rooms.filter((entry) => entry !== value);
      } else {
        state.rooms = [...state.rooms, value];
      }
      writeWillhabenStateToUrl(state);
      void refreshFromServer();
    });
  });
};

const signupLimit = 3;

const getRequestedAtValue = (value: string | null | undefined) => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
};

const getRowPriority = (row: HTMLElement) => {
  const rankValue = row.getAttribute("data-rank");
  const parsedRank = rankValue ? Number(rankValue) : Number.NaN;
  if (Number.isFinite(parsedRank)) {
    return { bucket: 0, value: parsedRank };
  }
  return { bucket: 1, value: getRequestedAtValue(row.getAttribute("data-requested-at")) };
};

const compareRowPriority = (left: HTMLElement, right: HTMLElement) => {
  const leftPriority = getRowPriority(left);
  const rightPriority = getRowPriority(right);
  if (leftPriority.bucket !== rightPriority.bucket) {
    return leftPriority.bucket - rightPriority.bucket;
  }
  if (leftPriority.value < rightPriority.value) return -1;
  if (leftPriority.value > rightPriority.value) return 1;
  return 0;
};

function clearSwapHighlights() {
  document.querySelectorAll<HTMLElement>(".row.is-swap-target").forEach((row) => {
    row.classList.remove("is-swap-target");
  });
}

const updateSwapIndicatorsForList = (list: HTMLElement) => {
  const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > .row"));
  rows.forEach((row) => {
    const indicator = row.querySelector<HTMLElement>(".swap-indicator");
    if (!indicator) return;
    indicator.textContent = "";
    indicator.classList.remove("is-active", "is-waiting");
  });

  if (list.getAttribute("data-rank-mode") !== "true") return;

  rows.forEach((row, index) => {
    const rankBadge = row.querySelector<HTMLElement>(".title-meta.rank");
    if (!rankBadge) return;
    rankBadge.textContent = `#${index + 1}`;
  });

  const signed = rows.filter((row) => row.classList.contains("is-signed"));
  const droppableSigned = signed.filter((row) => row.getAttribute("data-locked") !== "true");
  const desired = rows.slice(0, signupLimit);
  const desiredUnsigned = desired.filter((row) => !row.classList.contains("is-signed"));

  const setIndicator = (row: HTMLElement, text: string, waiting: boolean) => {
    const indicator = row.querySelector<HTMLElement>(".swap-indicator");
    if (!indicator) return;
    indicator.textContent = text;
    indicator.classList.add("is-active");
    indicator.classList.toggle("is-waiting", waiting);
  };

  const titleForRow = (row: HTMLElement) =>
    row.querySelector(".title")?.textContent?.trim() ?? "item";

  if (signed.length < signupLimit) {
    desiredUnsigned.forEach((row) => {
      const waiting = row.getAttribute("data-maxlimit") === "true";
      setIndicator(row, waiting ? "Will signup (waiting)" : "Will signup", waiting);
    });
    return;
  }

  if (!desiredUnsigned.length || droppableSigned.length === 0) return;

  const compareByOrder = (left: HTMLElement, right: HTMLElement) => {
    const leftIndex = rows.indexOf(left);
    const rightIndex = rows.indexOf(right);
    return leftIndex - rightIndex;
  };

  const signedByWorst = [...droppableSigned].sort(compareByOrder).reverse();
  const targetsByBest = [...desiredUnsigned].sort(compareByOrder);

  targetsByBest.forEach((targetRow) => {
    const eligibleIndex = signedByWorst.findIndex(
      (signedRow) => compareByOrder(targetRow, signedRow) < 0,
    );
    if (eligibleIndex === -1) return;
    const dropRow = signedByWorst.splice(eligibleIndex, 1)[0];
    if (!dropRow) return;
    const waiting = targetRow.getAttribute("data-maxlimit") === "true";
    const dropTitle = titleForRow(dropRow);
    const targetTitle = titleForRow(targetRow);
    setIndicator(targetRow, `Swap with ${dropTitle}${waiting ? " (waiting)" : ""}`, waiting);
    setIndicator(dropRow, `Will drop for ${targetTitle}`, false);
  });
};

const updateSwapIndicators = () => {
  document
    .querySelectorAll<HTMLElement>(".list[data-rank-mode]")
    .forEach((list) => updateSwapIndicatorsForList(list));
};

const findSwapCandidate = (type: string) => {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(`.row[data-type='${type}']`));
  const signed = rows.filter((row) => row.classList.contains("is-signed"));
  if (signed.length < signupLimit) return null;
  const candidates = rows.filter((row) => {
    if (row.classList.contains("is-signed")) return false;
    if (row.getAttribute("data-hidden-at")) return false;
    return Boolean(row.getAttribute("data-requested-at"));
  });
  if (!candidates.length) return null;
  return candidates.reduce((best, row) => (compareRowPriority(row, best) < 0 ? row : best));
};

const initRemoveHover = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-interest-action").forEach((button) => {
    if (button.getAttribute("data-action") !== "remove") return;
    if (button.disabled) return;
    const type = button.getAttribute("data-type");
    if (!type) return;
    bindOnceEvent(button, "boundRemoveHoverIn", "mouseenter", () => {
      clearSwapHighlights();
      const candidate = findSwapCandidate(type);
      if (candidate) candidate.classList.add("is-swap-target");
    });
    bindOnceEvent(button, "boundRemoveHoverOut", "mouseleave", () => {
      clearSwapHighlights();
    });
    bindOnceEvent(button, "boundRemoveHoverClick", "click", () => {
      clearSwapHighlights();
    });
  });
};

const getRankList = (listId: string) => document.getElementById(listId);

let dragRow: HTMLElement | null = null;

const ensureDragHandlers = (list: HTMLElement) => {
  if (list.dataset.dragInit === "true") return;
  list.dataset.dragInit = "true";

  list.addEventListener("dragover", (event) => {
    if (!dragRow) return;
    if (list.getAttribute("data-rank-mode") !== "true") return;
    event.preventDefault();
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".row");
    if (!target || target === dragRow) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > .row"));
    const targetIndex = rows.indexOf(target);
    const dragIndex = rows.indexOf(dragRow);
    if (targetIndex === -1 || dragIndex === -1) return;
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    const insertIndex = before ? targetIndex : targetIndex + 1;
    const insertBefore = rows[insertIndex] ?? null;
    if (insertBefore === dragRow) return;
    moveRowWithMap(dragRow, list, insertBefore);
    updateSwapIndicatorsForList(list);
  });

  list.addEventListener("drop", (event) => {
    if (!dragRow) return;
    event.preventDefault();
    dragRow.classList.remove("is-dragging");
    dragRow = null;
    updateSwapIndicatorsForList(list);
  });
};

const configureDrag = (listId: string, enabled: boolean) => {
  const list = getRankList(listId);
  if (!list) return;
  ensureDragHandlers(list);
  list.querySelectorAll<HTMLElement>(":scope > .row").forEach((row) => {
    row.draggable = enabled;
    row.classList.toggle("is-draggable", enabled);
    bindOnceEvent(row, "boundDragStart", "dragstart", (event) => {
      if (list.getAttribute("data-rank-mode") !== "true") {
        event.preventDefault();
        return;
      }
      dragRow = row;
      row.classList.add("is-dragging");
      const dataTransfer = (event as DragEvent).dataTransfer;
      if (dataTransfer) {
        dataTransfer.effectAllowed = "move";
        dataTransfer.setData("text/plain", row.getAttribute("data-id") ?? "");
      }
    });
    bindOnceEvent(row, "boundDragEnd", "dragend", () => {
      if (dragRow === row) dragRow = null;
      row.classList.remove("is-dragging");
    });
  });
};

const setRankMode = (listId: string, enabled: boolean) => {
  const list = getRankList(listId);
  if (!list) return;
  list.setAttribute("data-rank-mode", enabled ? "true" : "false");
  configureDrag(listId, enabled);
  const toggle = document.querySelector<HTMLButtonElement>(
    `.js-rank-toggle[data-target='${listId}']`,
  );
  const save = document.querySelector<HTMLButtonElement>(`.js-rank-save[data-target='${listId}']`);
  const cancel = document.querySelector<HTMLButtonElement>(
    `.js-rank-cancel[data-target='${listId}']`,
  );
  if (toggle) toggle.classList.toggle("is-hidden", enabled);
  if (save) save.classList.toggle("is-hidden", !enabled);
  if (cancel) cancel.classList.toggle("is-hidden", !enabled);
  updateSwapIndicatorsForList(list);
  syncReorderActive();
};

const collectRankOrder = (listId: string) => {
  const list = getRankList(listId);
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > .row"))
    .map((row) => row.getAttribute("data-id") ?? "")
    .filter(Boolean);
};

const initRankActions = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-rank-toggle").forEach((button) => {
    bindOnce(button, "boundRankToggle", (event) => {
      event.preventDefault();
      const listId = button.getAttribute("data-target");
      if (!listId) return;
      setRankMode(listId, true);
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".js-rank-cancel").forEach((button) => {
    bindOnce(button, "boundRankCancel", async (event) => {
      event.preventDefault();
      const listId = button.getAttribute("data-target");
      if (!listId) return;
      setRankMode(listId, false);
      await refreshFromServer();
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".js-rank-save").forEach((button) => {
    bindOnce(button, "boundRankSave", async (event) => {
      event.preventDefault();
      const listId = button.getAttribute("data-target");
      const type = button.getAttribute("data-type");
      if (!listId || !type) return;
      const order = collectRankOrder(listId);
      button.disabled = true;
      try {
        const response = await fetch(`/api/rank/${encodeURIComponent(type)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ order }),
        });
        if (!response.ok) {
          console.warn("Rank save failed.", await response.text());
          return;
        }
        setRankMode(listId, false);
        await refreshFromServer();
      } finally {
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".js-rank-move").forEach((button) => {
    bindOnce(button, "boundRankMove", (event) => {
      event.preventDefault();
      const direction = button.getAttribute("data-direction");
      const row = button.closest<HTMLElement>(".row");
      const list = row?.parentElement;
      if (!direction || !row || !list) return;
      if (list.getAttribute("data-rank-mode") !== "true") return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > .row"));
      const index = rows.indexOf(row);
      if (index < 0) return;
      if (direction === "up" && index > 0) {
        moveRowWithMap(row, list, rows[index - 1]);
      } else if (direction === "down" && index < rows.length - 1) {
        moveRowWithMap(rows[index + 1], list, row);
      }
      updateSwapIndicatorsForList(list);
    });
  });

  document.querySelectorAll<HTMLElement>(".list[data-rank-mode]").forEach((list) => {
    const listId = list.getAttribute("id");
    if (!listId) return;
    configureDrag(listId, list.getAttribute("data-rank-mode") === "true");
  });
};

const renderVisibilityLabel = (isHidden: boolean) => {
  const eyeIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  const eyeOffIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M1 12s4-7 11-7c2.2 0 4.1.5 5.7 1.4"></path>
      <path d="M4.3 14.6A12.3 12.3 0 0 0 12 19c7 0 11-7 11-7a21.8 21.8 0 0 0-3.3-4.2"></path>
      <path d="M9.9 9.9a3 3 0 0 1 4.2 4.2"></path>
      <path d="M1 1l22 22"></path>
    </svg>
  `;
  return `
    <span class="icon" aria-hidden="true">${isHidden ? eyeOffIcon : eyeIcon}</span>
    <span class="sr-only">${isHidden ? "Hidden" : "Visible"}</span>
  `;
};

const updateInterestButton = (
  button: HTMLButtonElement,
  options: { signed: boolean; interested: boolean; locked?: boolean },
) => {
  const action = options.signed ? "remove" : options.interested ? "drop" : "add";
  const label = options.signed ? "Remove" : options.interested ? "Drop" : "Interested";
  button.setAttribute("data-action", action);
  button.textContent = label;
  button.classList.toggle("btn-success", action === "add");
  button.classList.toggle("btn-danger", action === "remove");
  button.classList.toggle("btn-muted", action === "drop");
  if (action === "remove") {
    button.disabled = Boolean(options.locked);
  } else {
    button.disabled = false;
  }
};

const updateLockButton = (button: HTMLButtonElement, locked: boolean) => {
  button.setAttribute("data-action", locked ? "unlock" : "lock");
  button.textContent = locked ? "Locked" : "Lock";
  button.classList.toggle("btn-primary", locked);
  button.classList.toggle("btn-muted", !locked);
};

const sendInterestRequest = async (options: {
  button: HTMLButtonElement;
  action: string;
  type: string;
  id: string;
}) => {
  const { button, action, type, id } = options;
  button.disabled = true;
  try {
    const response = await fetch(
      `/api/interest/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          confirm: action === "remove",
          keepInterested: false,
        }),
      },
    );
    if (!response.ok) {
      console.warn("Interest request failed.", await response.text());
      return { ok: false, signed: null };
    }
    const payload = (await response.json()) as { ok: boolean; signed?: boolean; locked?: boolean };
    if (!payload.ok) {
      console.warn("Interest request failed.");
      return { ok: false, signed: null, locked: null };
    }
    return {
      ok: true,
      signed: typeof payload.signed === "boolean" ? payload.signed : null,
      locked: typeof payload.locked === "boolean" ? payload.locked : null,
    };
  } catch (error) {
    console.warn("Interest request failed.", error);
    return { ok: false, signed: null, locked: null };
  } finally {
    button.disabled = false;
  }
};

const pendingRemoveConfirm = new Set<string>();

const getConfirmKey = (type: string, id: string) => `${type}:${id}`;

const mountRemoveConfirm = (
  container: HTMLElement,
  button: HTMLButtonElement,
  type: string,
  id: string,
) => {
  if (container.querySelector(".js-interest-confirm")) return;
  const originalHtml = container.innerHTML;
  const originalWidth = Math.max(0, Math.round(button.getBoundingClientRect().width));

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "btn btn-danger js-interest-confirm";
  confirmButton.textContent = "Confirm remove";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "btn btn-muted js-interest-cancel";
  cancelButton.textContent = "Cancel";
  if (originalWidth > 0) {
    cancelButton.style.width = `${originalWidth}px`;
  }

  const confirmWrap = document.createElement("div");
  confirmWrap.className = "interest-confirm";
  confirmWrap.append(confirmButton, cancelButton);
  container.replaceChildren(confirmWrap);

  requestAnimationFrame(() => {
    confirmWrap.classList.add("is-visible");
  });

  cancelButton.addEventListener("click", (cancelEvent) => {
    cancelEvent.preventDefault();
    pendingRemoveConfirm.delete(getConfirmKey(type, id));
    container.innerHTML = originalHtml;
    initInterestActions();
    initLockActions();
    initRemoveHover();
    initRankActions();
  });

  confirmButton.addEventListener("click", async (confirmEvent) => {
    confirmEvent.preventDefault();
    confirmButton.textContent = "Removing…";
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    pendingRemoveConfirm.delete(getConfirmKey(type, id));
    const result = await sendInterestRequest({ button: confirmButton, action: "remove", type, id });
    if (result.ok && result.signed !== null) {
      container.innerHTML = originalHtml;
      initInterestActions();
      initLockActions();
      initRemoveHover();
      initRankActions();
      await refreshFromServer();
      return;
    }
    container.innerHTML = originalHtml;
    initInterestActions();
    initLockActions();
    initRemoveHover();
    initRankActions();
  });
};

const syncPendingRemoveConfirms = () => {
  pendingRemoveConfirm.forEach((key) => {
    const [type, id] = key.split(":");
    if (!type || !id) {
      pendingRemoveConfirm.delete(key);
      return;
    }
    const row = document.querySelector<HTMLElement>(
      `.row[data-type='${type}'][data-id='${CSS.escape(id)}']`,
    );
    if (!row) {
      pendingRemoveConfirm.delete(key);
      return;
    }
    const container = row.querySelector<HTMLElement>(".row-header-interest");
    if (!container) {
      pendingRemoveConfirm.delete(key);
      return;
    }
    const removeButton = container.querySelector<HTMLButtonElement>(
      ".js-interest-action[data-action='remove']",
    );
    if (!removeButton) {
      pendingRemoveConfirm.delete(key);
      return;
    }
    mountRemoveConfirm(container, removeButton, type, id);
  });
};

const initInterestActions = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-interest-action").forEach((button) => {
    bindOnce(button, "boundInterest", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const type = button.getAttribute("data-type");
      const id = button.getAttribute("data-id");
      if (!action || !type || !id) return;

      const container = button.closest<HTMLElement>(".row-header-interest") ?? button.parentElement;
      if (!container) return;

      if (action === "remove") {
        pendingRemoveConfirm.add(getConfirmKey(type, id));
        mountRemoveConfirm(container, button, type, id);
        return;
      }

      if (action === "add") {
        button.dataset.labelOriginal = button.textContent ?? "";
        button.textContent = "Interested…";
        button.disabled = true;
      }

      const result = await sendInterestRequest({ button, action, type, id });
      if (result.ok && result.signed !== null) {
        const row = button.closest<HTMLElement>(".row");
        const section = row?.closest<HTMLElement>(".section");
        const viewGroup = section?.getAttribute("data-view-group");
        const shouldUpdateInline = action === "remove" && viewGroup === "interested";
        if (shouldUpdateInline) {
          row?.classList.toggle("is-signed", result.signed);
        }
        if (action === "add") {
          button.disabled = true;
        }
        highlightNew();
      }
      if (!result.ok && action === "add") {
        button.textContent = button.dataset.labelOriginal || "Interested";
        button.disabled = false;
      }
      await refreshFromServer();
    });
  });
};

const initLockActions = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-lock-action").forEach((button) => {
    bindOnce(button, "boundLock", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const type = button.getAttribute("data-type");
      const id = button.getAttribute("data-id");
      if (!action || !type || !id) return;

      const result = await sendInterestRequest({ button, action, type, id });
      if (!result.ok || typeof result.locked !== "boolean") {
        await refreshFromServer();
        return;
      }

      updateLockButton(button, result.locked);
      const row = button.closest<HTMLElement>(".row");
      if (row) {
        row.classList.toggle("is-locked", result.locked);
        row.setAttribute("data-locked", result.locked ? "true" : "");
      }
      const removeButton = row?.querySelector<HTMLButtonElement>(
        ".js-interest-action[data-action='remove']",
      );
      if (removeButton) {
        updateInterestButton(removeButton, {
          signed: true,
          interested: true,
          locked: result.locked,
        });
      }
      await refreshFromServer();
    });
  });
};

const initTelegramSettings = () => {
  const saveButton = document.getElementById("telegram-save") as HTMLButtonElement | null;
  if (!saveButton) return;
  const enabled = document.getElementById("telegram-enabled") as HTMLInputElement | null;
  const botToken = document.getElementById("telegram-bot-token") as HTMLInputElement | null;
  const chatId = document.getElementById("telegram-chat-id") as HTMLInputElement | null;
  const includeImages = document.getElementById(
    "telegram-include-images",
  ) as HTMLInputElement | null;
  const enableActions = document.getElementById(
    "telegram-enable-actions",
  ) as HTMLInputElement | null;
  const pollingEnabled = document.getElementById(
    "telegram-polling-enabled",
  ) as HTMLInputElement | null;
  const webhookToken = document.getElementById("telegram-webhook-token") as HTMLInputElement | null;
  const testButton = document.getElementById("telegram-test") as HTMLButtonElement | null;
  const webhookUrl = document.getElementById("telegram-webhook-url");
  const status = document.getElementById("telegram-status");

  const updateWebhookUrl = () => {
    if (!webhookUrl) return;
    const token = webhookToken?.value.trim();
    webhookUrl.textContent = token
      ? `${window.location.origin}/api/telegram/webhook/${token}`
      : "/api/telegram/webhook/{token}";
  };

  updateWebhookUrl();
  if (webhookToken) {
    bindOnceEvent(webhookToken, "boundTelegramWebhook", "input", updateWebhookUrl);
  }

  const markDirty = () => {
    settingsDirty = true;
  };

  [enabled, botToken, chatId, includeImages, enableActions, pollingEnabled, webhookToken]
    .filter((input): input is HTMLInputElement => Boolean(input))
    .forEach((input) => {
      bindOnceEvent(input, "boundTelegramDirtyInput", "input", markDirty);
      bindOnceEvent(input, "boundTelegramDirtyChange", "change", markDirty);
    });

  if (testButton) {
    bindOnce(testButton, "boundTelegramTest", async (event) => {
      event.preventDefault();
      testButton.disabled = true;
      if (status) status.textContent = "Sending test…";
      try {
        const response = await fetch("/api/telegram/test", { method: "POST" });
        if (!response.ok) {
          if (status) status.textContent = "Test failed.";
          return;
        }
        if (status) status.textContent = "Test sent.";
      } catch {
        if (status) status.textContent = "Test failed.";
      } finally {
        testButton.disabled = false;
      }
    });
  }

  bindOnce(saveButton, "boundTelegramSave", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    if (status) status.textContent = "Saving…";
    try {
      const response = await fetch("/api/telegram/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: Boolean(enabled?.checked),
          botToken: botToken?.value.trim(),
          chatId: chatId?.value.trim(),
          includeImages: Boolean(includeImages?.checked),
          enableActions: Boolean(enableActions?.checked),
          pollingEnabled: Boolean(pollingEnabled?.checked),
          webhookToken: webhookToken?.value.trim(),
        }),
      });
      if (!response.ok) {
        if (status) status.textContent = "Save failed.";
        return;
      }
      if (status) status.textContent = "Saved.";
      settingsDirty = false;
    } catch {
      if (status) status.textContent = "Save failed.";
    } finally {
      saveButton.disabled = false;
    }
  });
};

const initWillhabenSettings = () => {
  const saveButton = document.getElementById("willhaben-save") as HTMLButtonElement | null;
  if (!saveButton) return;
  const minArea = document.getElementById("willhaben-min-area") as HTMLInputElement | null;
  const maxArea = document.getElementById("willhaben-max-area") as HTMLInputElement | null;
  const minPrice = document.getElementById("willhaben-min-price") as HTMLInputElement | null;
  const maxPrice = document.getElementById("willhaben-max-price") as HTMLInputElement | null;
  const status = document.getElementById("willhaben-status");
  const districtButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#willhaben-districts .js-willhaben-district"),
  );

  const markDirty = () => {
    settingsDirty = true;
  };

  const parseNumber = (value: string | null) => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const syncAllChip = () => {
    const allChip = districtButtons.find((button) => button.dataset.value === "all");
    if (!allChip) return;
    const activeSpecific = districtButtons.filter(
      (button) => button.dataset.value !== "all" && button.classList.contains("is-active"),
    );
    const allActive =
      activeSpecific.length ===
      districtButtons.filter((button) => button.dataset.value !== "all").length;
    allChip.classList.toggle("is-active", allActive || activeSpecific.length === 0);
  };

  [minArea, maxArea, minPrice, maxPrice]
    .filter((input): input is HTMLInputElement => Boolean(input))
    .forEach((input) => {
      bindOnceEvent(input, "boundWillhabenDirtyInput", "input", markDirty);
      bindOnceEvent(input, "boundWillhabenDirtyChange", "change", markDirty);
    });

  districtButtons.forEach((button) => {
    bindOnce(button, "boundWillhabenDistrict", async (event) => {
      event.preventDefault();
      const value = button.dataset.value;
      if (!value) return;
      if (value === "all") {
        const allButtons = districtButtons.filter((btn) => btn.dataset.value !== "all");
        const shouldActivate = allButtons.some((btn) => !btn.classList.contains("is-active"));
        allButtons.forEach((btn) => btn.classList.toggle("is-active", shouldActivate));
      } else {
        button.classList.toggle("is-active");
      }
      syncAllChip();
      markDirty();
    });
  });

  bindOnce(saveButton, "boundWillhabenSave", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    if (status) status.textContent = "Saving…";
    try {
      const districts = districtButtons
        .filter(
          (button) => button.dataset.value !== "all" && button.classList.contains("is-active"),
        )
        .map((button) => button.dataset.value ?? "")
        .filter(Boolean);
      const response = await fetch("/api/willhaben/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          minArea: parseNumber(minArea?.value ?? null),
          maxArea: parseNumber(maxArea?.value ?? null),
          minTotalCost: parseNumber(minPrice?.value ?? null),
          maxTotalCost: parseNumber(maxPrice?.value ?? null),
          districts,
        }),
      });
      if (!response.ok) {
        if (status) status.textContent = "Save failed.";
        return;
      }
      if (status) status.textContent = "Saved.";
      settingsDirty = false;
    } catch {
      if (status) status.textContent = "Save failed.";
    } finally {
      saveButton.disabled = false;
    }
  });
};

const initInteractiveElements = () => {
  initMapToggles();
  initViewToggles();
  initSourceFilters();
  initTelegramSettings();
  initWillhabenSettings();
  initInterestActions();
  initLockActions();
  initRemoveHover();
  initEntryActions();
  initCarousel();
  initRankActions();
  initWillhabenFilters();
};

const initEntryActions = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-entry-action").forEach((button) => {
    bindOnce(button, "boundEntry", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const type = button.getAttribute("data-type");
      const id = button.getAttribute("data-id");
      if (!action || !type || !id) return;

      const row = button.closest<HTMLElement>(".row");
      if (!row) return;

      suppressReloadUntil = Date.now() + 4000;

      button.disabled = true;
      try {
        const response = await fetch(
          `/api/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action }),
          },
        );
        if (!response.ok) return;

        const payload = (await response.json()) as {
          ok: boolean;
          updatedAt?: string;
          item?: { seenAt?: string | null; hiddenAt?: string | null };
        };

        if (!payload.ok) return;

        if (payload.updatedAt) {
          document.body.setAttribute("data-updated-at", payload.updatedAt);
        }

        const seenAt = payload.item?.seenAt ?? null;
        const hiddenAt = payload.item?.hiddenAt ?? null;

        row.setAttribute("data-seen-at", seenAt ?? "");
        row.setAttribute("data-hidden-at", hiddenAt ?? "");
        row.classList.toggle("is-seen", Boolean(seenAt));
        row.classList.toggle("is-new", !seenAt);

        row.querySelectorAll<HTMLButtonElement>(".seen-toggle").forEach((btn) => {
          btn.classList.toggle("is-hidden", Boolean(seenAt));
        });
        row
          .querySelectorAll<HTMLButtonElement>(".js-entry-action[data-action='toggleHidden']")
          .forEach((btn) => {
            btn.innerHTML = renderVisibilityLabel(Boolean(hiddenAt));
            btn.setAttribute("aria-label", hiddenAt ? "Unhide" : "Hide");
          });

        const hiddenList = document.getElementById("hidden-list");
        const targetList = getRowList(type);

        if (hiddenAt && hiddenList) {
          insertHiddenRow(row, hiddenList);
        } else if (!hiddenAt && targetList) {
          placeSeenOrder(row, targetList);
        }

        updateHiddenCount();
        highlightNew();
      } finally {
        button.disabled = false;
      }
    });
  });
};

let carouselInitialized = false;
let carouselImages: string[] = [];
let carouselIndex = 0;
let carousel: HTMLElement | null = null;
let carouselImage: HTMLImageElement | null = null;
let carouselLink: HTMLAnchorElement | null = null;

const ensureCarouselElements = () => {
  if (carousel) return;
  carousel = document.getElementById("carousel");
  carouselImage = document.getElementById("carousel-image") as HTMLImageElement | null;
  carouselLink = document.getElementById("carousel-link") as HTMLAnchorElement | null;
};

const showCarouselImage = () => {
  ensureCarouselElements();
  if (!carouselImage || carouselImages.length === 0) return;
  const src = carouselImages[carouselIndex];
  carouselImage.src = src;
  if (carouselLink) carouselLink.href = src;
};

const openCarousel = (images: string[]) => {
  ensureCarouselElements();
  if (!carousel || !carouselImage || images.length === 0) return;
  carouselImages = images;
  carouselIndex = 0;
  showCarouselImage();
  carousel.classList.remove("hidden");
};

const closeCarousel = () => {
  ensureCarouselElements();
  if (!carousel) return;
  carousel.classList.add("hidden");
  carouselImages = [];
};

const bindCarouselButtons = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-carousel").forEach((button) => {
    bindOnce(button, "boundCarousel", () => {
      const raw = button.getAttribute("data-images");
      if (!raw) return;
      try {
        const images = JSON.parse(decodeURIComponent(raw)) as string[];
        openCarousel(images);
      } catch {
        return;
      }
    });
  });
};

const initCarousel = () => {
  ensureCarouselElements();
  bindCarouselButtons();
  if (carouselInitialized) return;
  carouselInitialized = true;

  const showPrev = () => {
    if (carouselImages.length === 0) return;
    carouselIndex = (carouselIndex - 1 + carouselImages.length) % carouselImages.length;
    showCarouselImage();
  };

  const showNext = () => {
    if (carouselImages.length === 0) return;
    carouselIndex = (carouselIndex + 1) % carouselImages.length;
    showCarouselImage();
  };

  carousel?.querySelector(".close")?.addEventListener("click", closeCarousel);
  carousel?.querySelector(".prev")?.addEventListener("click", showPrev);
  carousel?.querySelector(".next")?.addEventListener("click", showNext);
  carousel?.addEventListener("click", (event) => {
    if (event.target === carousel) closeCarousel();
  });

  document.addEventListener("keydown", (event) => {
    if (!carousel || carousel.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      closeCarousel();
    } else if (event.key === "ArrowLeft") {
      showPrev();
    } else if (event.key === "ArrowRight") {
      showNext();
    }
  });
};

type FragmentPayload = {
  updatedAt: string | null;
  wohnberatungNextRefreshAt: number;
  willhabenNextRefreshAt: number;
  rateLimitCount: number;
  rateLimitMonthly: number;
  sections: {
    hidden: string;
    interested: string;
    wohnungen: string;
    planungsprojekte: string;
    willhaben: string;
    settings: string;
  };
};

let refreshPromise: Promise<void> | null = null;
let refreshQueued = false;
let settingsDirty = false;

const normalizeMapState = (element: Element) => {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".map-container").forEach((node) => {
    node.classList.add("is-hidden");
  });
  clone.querySelectorAll<HTMLElement>("[data-end]").forEach((node) => {
    node.textContent = node.getAttribute("data-end") ?? "";
  });
  clone.querySelectorAll<HTMLElement>("[data-refresh-at]").forEach((node) => {
    node.textContent = node.getAttribute("data-refresh-at") ?? "";
  });
  return clone;
};

const replaceSection = (id: string, html: string, openMapNodes: Map<string, HTMLElement>) => {
  const current = document.getElementById(id);
  if (!current) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html.trim();
  const next = wrapper.firstElementChild;
  if (!next) return;
  const normalizedCurrent = normalizeMapState(current);
  const normalizedNext = normalizeMapState(next);
  if (normalizedCurrent.outerHTML === normalizedNext.outerHTML) return;
  if (openMapNodes.size) {
    openMapNodes.forEach((node, mapId) => {
      const replacement = next.querySelector<HTMLElement>(`#${mapId}`);
      if (replacement) {
        replacement.replaceWith(node);
      }
    });
  }
  current.replaceWith(next);
};

const applyFragments = (payload: FragmentPayload) => {
  const openMapNodes = new Map(
    Array.from(document.querySelectorAll<HTMLElement>(".map-container:not(.is-hidden)"))
      .map((node) => [node.id, node] as const)
      .filter(([id]) => id.length > 0),
  );
  const openMapSections = new Set(
    Array.from(openMapNodes.values())
      .map((node) => node.closest<HTMLElement>(".section")?.id)
      .filter((id): id is string => Boolean(id)),
  );
  document.body.setAttribute("data-updated-at", payload.updatedAt ?? "");
  document.body.setAttribute(
    "data-next-refresh-wohnberatung",
    String(payload.wohnberatungNextRefreshAt),
  );
  document.body.setAttribute("data-next-refresh-willhaben", String(payload.willhabenNextRefreshAt));

  const rateCount = document.getElementById("rate-count");
  if (rateCount) rateCount.textContent = String(payload.rateLimitCount);
  const rateLimit = document.getElementById("rate-limit");
  if (rateLimit) rateLimit.textContent = String(payload.rateLimitMonthly);

  if (!openMapSections.has("hidden-section")) {
    replaceSection("hidden-section", payload.sections.hidden, openMapNodes);
  }
  if (!openMapSections.has("interested-section")) {
    replaceSection("interested-section", payload.sections.interested, openMapNodes);
  }
  if (!openMapSections.has("wohnungen-section")) {
    replaceSection("wohnungen-section", payload.sections.wohnungen, openMapNodes);
  }
  if (!openMapSections.has("planungsprojekte-section")) {
    replaceSection("planungsprojekte-section", payload.sections.planungsprojekte, openMapNodes);
  }
  if (!openMapSections.has("willhaben-section")) {
    replaceSection("willhaben-section", payload.sections.willhaben, openMapNodes);
  }
  if (document.body.getAttribute("data-view") !== "settings" && !settingsDirty) {
    replaceSection("settings-section", payload.sections.settings, openMapNodes);
  }

  initInteractiveElements();
  syncPendingRemoveConfirms();
  updateHiddenCount();
  initWillhabenFilters();
  refreshDerivedUi();
  updateSwapIndicators();
  syncReorderActive();
};

const refreshFromServer = async () => {
  if (reorderActive) return;
  if (refreshPromise) {
    refreshQueued = true;
    return refreshPromise;
  }
  refreshPromise = (async () => {
    try {
      const response = await fetch(`/api/fragment${window.location.search}`);
      if (!response.ok) return;
      const payload = (await response.json()) as FragmentPayload;
      applyFragments(payload);
    } catch {
      return;
    } finally {
      refreshPromise = null;
      if (refreshQueued) {
        refreshQueued = false;
        void refreshFromServer();
      }
    }
  })();
  return refreshPromise;
};

const initEvents = () => {
  const events = new EventSource("/events");
  events.onmessage = (event) => {
    const current = document.body.getAttribute("data-updated-at");
    let updatedAt: string | undefined;
    try {
      const payload = JSON.parse(event.data) as {
        updatedAt?: string;
        nextRefreshWohnberatung?: number;
        nextRefreshWillhaben?: number;
      };
      updatedAt = payload.updatedAt;
      if (updatedAt) {
        document.body.setAttribute("data-updated-at", updatedAt);
      }
      if (typeof payload.nextRefreshWohnberatung === "number") {
        document.body.setAttribute(
          "data-next-refresh-wohnberatung",
          String(payload.nextRefreshWohnberatung),
        );
      }
      if (typeof payload.nextRefreshWillhaben === "number") {
        document.body.setAttribute(
          "data-next-refresh-willhaben",
          String(payload.nextRefreshWillhaben),
        );
      }
      updateNextRefreshLabel();
    } catch {
      return;
    }
    if (updatedAt && updatedAt !== current) {
      if (Date.now() < suppressReloadUntil) {
        suppressReloadUntil = 0;
        return;
      }
      if (reorderActive) {
        return;
      }
      void refreshFromServer();
    }
  };

  window.addEventListener("beforeunload", () => {
    events.close();
  });
};

const init = () => {
  refreshDerivedUi();
  setInterval(() => {
    refreshDerivedUi();
  }, 1000);
  initInteractiveElements();
  initEvents();
  syncViewWithLocation(true);
  syncSourceWithLocation(true);
  window.addEventListener("popstate", () => {
    syncViewWithLocation(true);
    syncSourceWithLocation(true);
  });
  updateSwapIndicators();
};

document.addEventListener("DOMContentLoaded", init);
