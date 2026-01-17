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

const updateCountdowns = () => {
  document.querySelectorAll<HTMLElement>(".time[data-end]").forEach((node) => {
    const end = node.getAttribute("data-end");
    const formatted = formatTimeLeft(end);
    if (formatted) {
      node.textContent = formatted;
    }
  });
};

const highlightNew = () => {
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;
  document.querySelectorAll<HTMLElement>(".row[data-first-seen]").forEach((row) => {
    if (row.classList.contains("is-signed")) {
      row.classList.remove("is-new");
      return;
    }
    const seenAt = row.getAttribute("data-seen-at");
    const hiddenAt = row.getAttribute("data-hidden-at");
    if (seenAt || hiddenAt) {
      row.classList.remove("is-new");
      return;
    }
    const firstSeen = row.getAttribute("data-first-seen");
    if (!firstSeen) return;
    const diff = now - new Date(firstSeen).getTime();
    if (diff <= windowMs) {
      row.classList.add("is-new");
    } else {
      row.classList.remove("is-new");
    }
  });
};

const updateRefreshLabel = () => {
  const updatedAt = document.body.getAttribute("data-updated-at");
  const label = document.getElementById("last-refresh");
  if (!label || !updatedAt) return;
  const diffMs = Date.now() - new Date(updatedAt).getTime();
  if (Number.isNaN(diffMs)) return;
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

const initMapToggles = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-toggle-map").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const target = button.getAttribute("data-target");
      if (!target) return;
      const container = document.getElementById(target);
      if (!container) return;
      container.classList.toggle("is-hidden");
    });
  });
};

const initHiddenToggle = () => {
  const button = document.querySelector<HTMLButtonElement>(".js-toggle-hidden");
  if (!button) return;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    const target = button.getAttribute("data-target");
    if (!target) return;
    const container = document.getElementById(target);
    if (!container) return;
    container.classList.toggle("is-hidden");
  });
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

const initEntryActions = () => {
  document.querySelectorAll<HTMLButtonElement>(".js-entry-action").forEach((button) => {
    button.addEventListener("click", async (event) => {
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

        row
          .querySelectorAll<HTMLButtonElement>(".js-entry-action[data-action='toggleSeen']")
          .forEach((btn) => {
            btn.textContent = seenAt ? "Unseen" : "Seen";
          });
        row
          .querySelectorAll<HTMLButtonElement>(".js-entry-action[data-action='toggleHidden']")
          .forEach((btn) => {
            btn.textContent = hiddenAt ? "Unhide" : "Hide";
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

const initCarousel = () => {
  const carousel = document.getElementById("carousel");
  const carouselImage = document.getElementById("carousel-image") as HTMLImageElement | null;
  const carouselLink = document.getElementById("carousel-link") as HTMLAnchorElement | null;
  let carouselImages: string[] = [];
  let carouselIndex = 0;

  const showCarouselImage = () => {
    if (!carouselImage || carouselImages.length === 0) return;
    const src = carouselImages[carouselIndex];
    carouselImage.src = src;
    if (carouselLink) carouselLink.href = src;
  };

  const openCarousel = (images: string[]) => {
    if (!carousel || !carouselImage || images.length === 0) return;
    carouselImages = images;
    carouselIndex = 0;
    showCarouselImage();
    carousel.classList.remove("hidden");
  };

  const closeCarousel = () => {
    if (!carousel) return;
    carousel.classList.add("hidden");
    carouselImages = [];
  };

  document.querySelectorAll<HTMLButtonElement>(".js-carousel").forEach((button) => {
    button.addEventListener("click", () => {
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
      if (payload.nextRefresh) {
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
      location.reload();
    }
  };

  window.addEventListener("beforeunload", () => {
    events.close();
  });
};

const init = () => {
  updateCountdowns();
  highlightNew();
  updateRefreshLabel();
  updateNextRefreshLabel();
  setInterval(() => {
    updateCountdowns();
    highlightNew();
    updateRefreshLabel();
    updateNextRefreshLabel();
  }, 60000);
  initMapToggles();
  initHiddenToggle();
  initEntryActions();
  initCarousel();
  initEvents();
};

document.addEventListener("DOMContentLoaded", init);
