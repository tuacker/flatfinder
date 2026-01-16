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
      node.textContent = "Anmeldung noch " + formatted;
    }
  });
};

const highlightNew = () => {
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;
  document.querySelectorAll<HTMLElement>(".row[data-first-seen]").forEach((row) => {
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
  initCarousel();
  initEvents();
};

document.addEventListener("DOMContentLoaded", init);
