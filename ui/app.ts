const formatTimeLeft = (iso: string | null) => {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return null;
  if (diffMs <= 0) return "abgelaufen";
  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
};

const formatRefreshLeft = (iso: string | null) => {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return null;
  if (diffMs <= 0) return "now";
  if (diffMs < 60000) return `${Math.ceil(diffMs / 1000)}s`;
  return formatTimeLeft(iso);
};

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
      node.textContent = `refresh ${formatted}`;
    }
  });
};

const highlightNew = () => {
  document.querySelectorAll<HTMLElement>(".row[data-seen-at]").forEach((row) => {
    const seenAt = row.getAttribute("data-seen-at");
    row.classList.toggle("is-new", !seenAt);
  });
};

const updateRefreshLabel = () => {
  const updatedAt = document.body.getAttribute("data-updated-at");
  const label = document.getElementById("last-refresh");
  if (!label || !updatedAt) return;
  const diffMs = Date.now() - new Date(updatedAt).getTime();
  if (Number.isNaN(diffMs)) return;
  if (diffMs < 0) {
    label.textContent = "just now";
    label.title = updatedAt;
    return;
  }
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const value = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  label.textContent = `${value} ago`;
  label.title = updatedAt;
};

const updateNextRefreshLabel = () => {
  const label = document.getElementById("next-refresh");
  if (!label) return;
  const nextAt = Number(document.body.getAttribute("data-next-refresh"));
  if (!Number.isFinite(nextAt)) return;
  const diffMs = nextAt - Date.now();
  if (diffMs <= 0) {
    label.textContent = "soon";
    return;
  }
  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  label.textContent = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const bindOnce = (element: HTMLElement, key: string, handler: (event: Event) => void) => {
  if (element.dataset[key] === "true") return;
  element.dataset[key] = "true";
  element.addEventListener("click", handler);
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

type ViewName = "root" | "hidden" | "interested";
let currentView: ViewName = "root";

const clearHoldOnLeaveRoot = async () => {
  try {
    const response = await fetch("/api/interest/hold/clear", { method: "POST" });
    if (!response.ok) return;
  } catch {
    return;
  }
  await refreshFromServer();
};

const resolveView = (pathname: string): { view: ViewName; path: string } => {
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  if (trimmed === "/hidden") return { view: "hidden", path: "/hidden" };
  if (trimmed === "/interested") return { view: "interested", path: "/interested" };
  return { view: "root", path: "/" };
};

const setView = (view: ViewName, options: { replace?: boolean } = {}) => {
  const previous = currentView;
  currentView = view;
  document.body.setAttribute("data-view", view);
  document.querySelectorAll<HTMLButtonElement>(".js-view-toggle").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  if (previous === "root" && view !== "root") {
    void clearHoldOnLeaveRoot();
  }
  const targetPath = view === "root" ? "/" : `/${view}`;
  if (window.location.pathname === targetPath) return;
  if (options.replace) {
    window.history.replaceState({ view }, "", targetPath);
  } else {
    window.history.pushState({ view }, "", targetPath);
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

let suppressReloadUntil = 0;

const getRowList = (type: string) => {
  if (type === "wohnungen") return document.getElementById("wohnungen-list");
  if (type === "planungsprojekte") return document.getElementById("planungsprojekte-list");
  return null;
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

const updateHiddenCount = () => {
  const count = document.querySelectorAll("#hidden-list > .row").length;
  const label = document.getElementById("hidden-count");
  if (label) label.textContent = String(count);
};

const getRankList = (listId: string) => document.getElementById(listId);

const setRankMode = (listId: string, enabled: boolean) => {
  const list = getRankList(listId);
  if (!list) return;
  list.setAttribute("data-rank-mode", enabled ? "true" : "false");
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
    });
  });
};

const initSwapActions = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-swap-action").forEach((button) => {
    bindOnce(button, "boundSwap", async (event) => {
      event.preventDefault();
      const action = button.getAttribute("data-action");
      const swapId = button.getAttribute("data-swap-id");
      if (!action || !swapId) return;
      button.disabled = true;
      try {
        const response = await fetch(`/api/swaps/${encodeURIComponent(swapId)}/${action}`, {
          method: "POST",
        });
        if (!response.ok) {
          console.warn("Swap action failed.", await response.text());
          return;
        }
        await refreshFromServer();
      } finally {
        button.disabled = false;
      }
    });
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

const updateInterestButton = (button: HTMLButtonElement, signed: boolean) => {
  button.setAttribute("data-action", signed ? "remove" : "add");
  button.textContent = signed ? "Remove" : "Signup";
  button.classList.toggle("btn-success", !signed);
  button.classList.toggle("btn-danger", signed);
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
        body: JSON.stringify({ action, confirm: action === "remove" }),
      },
    );
    if (!response.ok) {
      console.warn("Interest request failed.", await response.text());
      return { ok: false, signed: null };
    }
    const payload = (await response.json()) as { ok: boolean; signed?: boolean };
    if (!payload.ok) {
      console.warn("Interest request failed.");
      return { ok: false, signed: null };
    }
    return { ok: true, signed: typeof payload.signed === "boolean" ? payload.signed : null };
  } catch (error) {
    console.warn("Interest request failed.", error);
    return { ok: false, signed: null };
  } finally {
    button.disabled = false;
  }
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
          container.innerHTML = originalHtml;
          initInterestActions();
          initRankActions();
        });

        confirmButton.addEventListener("click", async (confirmEvent) => {
          confirmEvent.preventDefault();
          confirmButton.disabled = true;
          cancelButton.disabled = true;
          const result = await sendInterestRequest({ button: confirmButton, action, type, id });
          if (result.ok && result.signed !== null) {
            container.innerHTML = originalHtml;
            initInterestActions();
            initRankActions();
            const restored = container.querySelector<HTMLButtonElement>(".js-interest-action");
            if (restored) {
              updateInterestButton(restored, result.signed);
              const row = restored.closest<HTMLElement>(".row");
              row?.classList.toggle("is-signed", result.signed);
              highlightNew();
            }
            await refreshFromServer();
            return;
          }
          container.innerHTML = originalHtml;
          initInterestActions();
          initRankActions();
        });

        return;
      }

      const result = await sendInterestRequest({ button, action, type, id });
      if (result.ok && result.signed !== null) {
        const row = button.closest<HTMLElement>(".row");
        row?.classList.toggle("is-signed", result.signed);
        updateInterestButton(button, result.signed);
        highlightNew();
      }
      await refreshFromServer();
    });
  });
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
          updateRefreshLabel();
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
  nextRefreshAt: number;
  rateLimitCount: number;
  rateLimitMonthly: number;
  sections: {
    hidden: string;
    swaps: string;
    interested: string;
    wohnungen: string;
    planungsprojekte: string;
  };
};

let refreshPromise: Promise<void> | null = null;
let holdRefreshTimer: number | null = null;

const replaceSection = (id: string, html: string) => {
  const current = document.getElementById(id);
  if (!current) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html.trim();
  const next = wrapper.firstElementChild;
  if (!next) return;
  current.replaceWith(next);
};

const applyFragments = (payload: FragmentPayload) => {
  document.body.setAttribute("data-updated-at", payload.updatedAt ?? "");
  document.body.setAttribute("data-next-refresh", String(payload.nextRefreshAt));

  const rateCount = document.getElementById("rate-count");
  if (rateCount) rateCount.textContent = String(payload.rateLimitCount);
  const rateLimit = document.getElementById("rate-limit");
  if (rateLimit) rateLimit.textContent = String(payload.rateLimitMonthly);

  replaceSection("hidden-section", payload.sections.hidden);
  replaceSection("swap-section", payload.sections.swaps);
  replaceSection("interested-section", payload.sections.interested);
  replaceSection("wohnungen-section", payload.sections.wohnungen);
  replaceSection("planungsprojekte-section", payload.sections.planungsprojekte);

  initMapToggles();
  initViewToggles();
  initInterestActions();
  initEntryActions();
  initCarousel();
  initRankActions();
  initSwapActions();
  updateCountdowns();
  updateRefreshCountdowns();
  highlightNew();
  updateRefreshLabel();
  updateNextRefreshLabel();
  scheduleHoldRefresh();
  applyHoldFade();
};

const refreshFromServer = async () => {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const response = await fetch("/api/fragment");
      if (!response.ok) return;
      const payload = (await response.json()) as FragmentPayload;
      applyFragments(payload);
    } catch {
      return;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
};

const scheduleHoldRefresh = () => {
  if (holdRefreshTimer) {
    window.clearTimeout(holdRefreshTimer);
    holdRefreshTimer = null;
  }
  const now = Date.now();
  let earliest = Number.POSITIVE_INFINITY;
  document.querySelectorAll<HTMLElement>(".row[data-hold-until]").forEach((row) => {
    const holdUntil = row.getAttribute("data-hold-until");
    if (!holdUntil) return;
    const timestamp = new Date(holdUntil).getTime();
    if (!Number.isFinite(timestamp)) return;
    if (timestamp > now && timestamp < earliest) {
      earliest = timestamp;
    }
  });
  if (!Number.isFinite(earliest)) return;
  const delay = Math.max(earliest - now + 50, 0);
  holdRefreshTimer = window.setTimeout(() => {
    void refreshFromServer();
  }, delay);
};

const applyHoldFade = () => {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>(".row.is-hold[data-hold-until]").forEach((row) => {
    const holdUntil = row.getAttribute("data-hold-until");
    if (!holdUntil) return;
    const timestamp = new Date(holdUntil).getTime();
    if (!Number.isFinite(timestamp)) return;
    const remaining = Math.max(timestamp - now, 0);
    if (remaining <= 0) {
      row.classList.remove("is-hold");
      row.style.removeProperty("--hold-ms");
      return;
    }
    row.style.setProperty("--hold-ms", `${remaining}ms`);
  });
};

const initEvents = () => {
  const events = new EventSource("/events");
  events.onmessage = (event) => {
    const current = document.body.getAttribute("data-updated-at");
    let updatedAt: string | undefined;
    try {
      const payload = JSON.parse(event.data) as { updatedAt?: string; nextRefresh?: number };
      updatedAt = payload.updatedAt;
      if (updatedAt) {
        document.body.setAttribute("data-updated-at", updatedAt);
      }
      if (typeof payload.nextRefresh === "number") {
        document.body.setAttribute("data-next-refresh", String(payload.nextRefresh));
      }
      updateRefreshLabel();
      updateNextRefreshLabel();
    } catch {
      return;
    }
    if (updatedAt && updatedAt !== current) {
      if (Date.now() < suppressReloadUntil) {
        suppressReloadUntil = 0;
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
  updateCountdowns();
  updateRefreshCountdowns();
  highlightNew();
  updateRefreshLabel();
  updateNextRefreshLabel();
  setInterval(() => {
    updateCountdowns();
    updateRefreshCountdowns();
    highlightNew();
    updateRefreshLabel();
    updateNextRefreshLabel();
  }, 15000);
  initMapToggles();
  initViewToggles();
  initInterestActions();
  initEntryActions();
  initCarousel();
  initRankActions();
  initSwapActions();
  initEvents();
  syncViewWithLocation(true);
  window.addEventListener("popstate", () => syncViewWithLocation(true));
  scheduleHoldRefresh();
  applyHoldFade();
};

document.addEventListener("DOMContentLoaded", init);
