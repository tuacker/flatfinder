import {
  planungsprojekteIntervalMinutes,
  rateLimitMonthly,
  wohnungssucheIntervalMinutes,
} from "../scrapers/wohnberatung/config.js";
import type { FlatfinderState, WohnungRecord } from "../scrapers/wohnberatung/state.js";

export type RenderOptions = {
  nextRefreshAt: number;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeValue = (value: string | null | undefined, fallback = "-") =>
  escapeHtml(value ?? fallback);

const safeAttribute = (value: string | null | undefined) => escapeHtml(value ?? "");

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

const cleanValue = (value: string | null) => {
  if (!value) return "-";
  return value.replace(/^[^0-9€]+:?\s*/i, "").trim();
};

const buildMapEmbedUrl = (mapUrl: string | null) => {
  if (!mapUrl) return null;
  const match = mapUrl.match(/place\/([0-9.-]+),([0-9.-]+)/);
  if (match) {
    return `https://www.google.com/maps?q=${match[1]},${match[2]}&z=17&output=embed`;
  }
  if (mapUrl.includes("output=embed")) return mapUrl;
  return `${mapUrl}${mapUrl.includes("?") ? "&" : "?"}output=embed`;
};

const encodeImages = (images: string[]) =>
  encodeURIComponent(JSON.stringify(images.filter(Boolean)));

const mapAsset = (pathValue: string | null | undefined) =>
  pathValue ? `/assets/${pathValue}` : null;

const renderBadges = (badges: string[]) => {
  if (badges.length === 0) return "";
  return badges.map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`).join("");
};

const renderPlanungsprojektRow = (item: FlatfinderState["planungsprojekte"][number]) => {
  const imageList = item.detail?.imageUrls?.length ? item.detail.imageUrls : [item.imageUrl ?? ""];
  const imageData = encodeImages(imageList);
  const image = item.imageUrl
    ? `<button class="image-button js-carousel" data-images="${imageData}">
         <img class="thumb" src="${safeAttribute(item.imageUrl)}" alt="" />
       </button>`
    : "";
  const badges = renderBadges([item.flags.angemeldet ? "Angemeldet" : ""].filter(Boolean));
  const lageplan = item.detail?.lageplanUrl
    ? `<a class="btn" href="${safeAttribute(item.detail.lageplanUrl)}" target="_blank">Lageplan</a>`
    : "";
  const interestCount = safeValue(String(item.interessenten ?? "-"));
  const interestLabel = ` · <span class="count">${interestCount} Interessent*innen</span>`;
  const maxLabel = item.flags.maxlimit ? ' <span class="max">(max erreicht)</span>' : "";
  const title = `${safeValue(item.postalCode ?? "")}\u00a0, ${safeValue(item.address ?? "")}`;
  return `
    <div class="row" data-first-seen="${item.firstSeenAt}">
      ${image}
      <div class="content">
        <div class="title">${title}${interestLabel}${maxLabel}</div>
        <div class="meta">
          Bezugsfertig ${safeValue(item.bezugsfertig)} · ${safeValue(item.foerderungstyp)}
        </div>
      </div>
      <div class="aside">
        ${badges}
        <div class="actions">
          ${lageplan}
          ${item.url ? `<a class="btn btn-primary" href="${safeAttribute(item.url)}" target="_blank">Öffnen ↗</a>` : ""}
        </div>
      </div>
    </div>
  `;
};

const buildImageList = (item: WohnungRecord) => {
  const imageList = new Set<string>();
  if (item.assets?.images?.length) {
    item.assets.images.forEach((img) => imageList.add(mapAsset(img) ?? img));
  } else if (item.detail?.imageUrls?.length) {
    item.detail.imageUrls.forEach((img) => imageList.add(img));
  }
  if (item.thumbnailUrl) imageList.add(item.thumbnailUrl);
  return Array.from(imageList);
};

const renderWohnungRow = (item: WohnungRecord) => {
  const mapUrl = item.detail?.mapUrl ?? null;
  const mapEmbed = buildMapEmbedUrl(mapUrl);
  const mapId = `map-${item.id}`;

  const images = buildImageList(item);
  const imageData = encodeImages(images);

  const thumbSrc = mapAsset(item.assets?.thumbnail) ?? item.thumbnailUrl;
  const thumb = thumbSrc
    ? `<button class="image-button js-carousel" data-images="${imageData}">
         <img class="thumb" src="${safeAttribute(thumbSrc)}" alt="" />
       </button>`
    : "";

  const timeLeft = formatTimeLeft(item.registrationEnd);
  const badges = renderBadges([item.flags.angemeldet ? "Angemeldet" : ""].filter(Boolean));

  const mapToggle = mapEmbed
    ? `<button class="btn js-toggle-map" data-target="${mapId}">Maps</button>`
    : "";
  const mapSection = mapEmbed
    ? `<div id="${mapId}" class="map-container is-hidden">
         <iframe src="${safeAttribute(mapEmbed)}" loading="lazy" allowfullscreen></iframe>
         ${mapUrl ? `<a class="btn btn-primary" href="${safeAttribute(mapUrl)}" target="_blank">Google Maps ↗</a>` : ""}
       </div>`
    : "";

  return `
    <div class="row" data-first-seen="${item.firstSeenAt}">
      ${thumb}
      <div class="content">
        <div class="title">${safeValue(item.postalCode ?? "")} ${safeValue(item.address ?? "")}</div>
        <div class="facts">
          <div class="fact"><span class="label">Fläche:</span><span class="value">${safeValue(item.size)}</span></div>
          <div class="fact"><span class="label">Zimmer:</span><span class="value">${safeValue(cleanValue(item.rooms))}</span></div>
          <div class="fact"><span class="label">Kosten:</span><span class="value">${safeValue(cleanValue(item.monthlyCost))}</span></div>
          <div class="fact"><span class="label">Eigenmittel:</span><span class="value">${safeValue(cleanValue(item.equity))}</span></div>
          <div class="fact"><span class="label">Typ:</span><span class="value">${safeValue(item.foerderungstyp)}</span></div>
          <div class="fact"><span class="label">Anmeldungen:</span><span class="value">${safeValue(String(item.interessenten ?? "-"))}</span></div>
        </div>
      </div>
      <div class="aside">
        ${timeLeft ? `<div class="time" data-end="${item.registrationEnd}">Anmeldung noch ${timeLeft}</div>` : ""}
        ${badges}
        <div class="actions">
          ${mapToggle}
          ${item.url ? `<a class="btn btn-primary" href="${safeAttribute(item.url)}" target="_blank">Öffnen ↗</a>` : ""}
        </div>
      </div>
    </div>
    ${mapSection}
  `;
};

const renderSection = (title: string, items: string[]) => {
  const content = items.length ? items.join("\n") : '<div class="empty">No results</div>';
  return `
    <div class="section">
      <h2>${escapeHtml(title)}</h2>
      <div class="list">${content}</div>
    </div>
  `;
};

const renderStyles = () => `
  <style>
    body { font-family: system-ui, sans-serif; margin: 20px 24px; background: #f8fafc; color: #0f172a; }
    h1 { margin: 0; font-size: 18px; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid #e2e8f0;
    }
    .status-line { color: #475569; font-size: 13px; }
    .section { margin-top: 32px; }
    .list { display: flex; flex-direction: column; gap: 12px; }
    .row {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
    }
    .image-button { border: none; padding: 0; background: transparent; cursor: pointer; }
    .thumb {
      width: 120px;
      height: 80px;
      object-fit: cover;
      border-radius: 10px;
      flex-shrink: 0;
    }
    .content { flex: 1; min-width: 0; }
    .title { font-size: 20px; font-weight: 600; color: #0f172a; }
    .meta { color: #475569; font-size: 14px; }
    .facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 6px 16px;
      margin-top: 6px;
      color: #0f172a;
      font-size: 14px;
    }
    .fact { display: flex; gap: 6px; align-items: baseline; white-space: nowrap; }
    .fact .label { font-weight: 500; color: #64748b; }
    .fact .value { font-weight: 700; }
    .title .count { color: #64748b; font-weight: 500; }
    .title .max { color: #9a7b7b; font-weight: 600; }
    .row.is-new { border: 1px solid #bfdbfe; background: #eff6ff; }
    .status { color: #dc2626; font-size: 14px; margin-top: 4px; }
    .aside { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .time { color: #dc2626; font-weight: 600; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      background: #e2e8f0;
      color: #1e293b;
      font-size: 12px;
      font-weight: 600;
    }
    .badge + .badge { margin-left: 6px; }
    .actions { display: flex; gap: 10px; font-size: 14px; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #cbd5f5;
      background: #f8fafc;
      color: #2563eb;
      border-radius: 8px;
      padding: 4px 10px;
      font-size: 13px;
      text-decoration: none;
      cursor: pointer;
      outline: none;
    }
    .btn:focus { outline: none; box-shadow: none; }
    .btn-primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    .map-container {
      margin: 8px 0 16px 136px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: flex-start;
    }
    .map-container iframe {
      width: 520px;
      max-width: 100%;
      height: 240px;
      border: 0;
      border-radius: 10px;
    }
    .map-container.is-hidden { display: none; }
    .empty { color: #64748b; font-size: 14px; padding: 8px 0; }
    a { color: #2563eb; text-decoration: none; }
    .carousel {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 50;
    }
    .carousel.hidden { display: none; }
    .carousel img {
      max-width: min(80vw, 960px);
      max-height: 80vh;
      border-radius: 12px;
    }
    .carousel button {
      background: transparent;
      border: none;
      color: #fff;
      font-size: 32px;
      cursor: pointer;
      padding: 12px;
    }
    .carousel .close { position: absolute; top: 24px; right: 24px; }
    .carousel .prev { position: absolute; left: 24px; }
    .carousel .next { position: absolute; right: 24px; }
  </style>
`;

const renderScripts = () => `
  <script>
    const formatTimeLeft = (iso) => {
      if (!iso) return null;
      const diffMs = new Date(iso).getTime() - Date.now();
      if (Number.isNaN(diffMs)) return null;
      if (diffMs <= 0) return "abgelaufen";
      const totalMinutes = Math.floor(diffMs / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return hours + "h " + minutes + "m";
    };

    const updateCountdowns = () => {
      document.querySelectorAll(".time[data-end]").forEach((node) => {
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
      document.querySelectorAll(".row[data-first-seen]").forEach((row) => {
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
      const value = hours > 0 ? hours + "h" + " " + (minutes % 60) + "m" : minutes + "m";
      label.textContent = value + " ago";
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
      label.textContent = hours > 0 ? hours + "h " + minutes + "m" : minutes + "m";
    };

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

    document.querySelectorAll(".js-toggle-map").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const target = button.getAttribute("data-target");
        if (!target) return;
        const container = document.getElementById(target);
        if (!container) return;
        container.classList.toggle("is-hidden");
      });
    });

    const carousel = document.getElementById("carousel");
    const carouselImage = document.getElementById("carousel-image");
    const carouselLink = document.getElementById("carousel-link");
    let carouselImages = [];
    let carouselIndex = 0;

    const showCarouselImage = () => {
      if (!carouselImage || carouselImages.length === 0) return;
      const src = carouselImages[carouselIndex];
      carouselImage.src = src;
      if (carouselLink) carouselLink.href = src;
    };

    const openCarousel = (images) => {
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

    document.querySelectorAll(".js-carousel").forEach((button) => {
      button.addEventListener("click", () => {
        const raw = button.getAttribute("data-images");
        if (!raw) return;
        try {
          const images = JSON.parse(decodeURIComponent(raw));
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

    const events = new EventSource("/events");
    events.onmessage = (event) => {
      const current = document.body.getAttribute("data-updated-at");
      let updatedAt;
      try {
        const payload = JSON.parse(event.data);
        updatedAt = payload.updatedAt;
        if (updatedAt) {
          document.body.setAttribute("data-updated-at", updatedAt);
        }
        if (payload.nextRefresh) {
          document.body.setAttribute("data-next-refresh", payload.nextRefresh);
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
  </script>
`;

export const renderPage = (state: FlatfinderState, options: RenderOptions) => {
  const wohnungen = state.wohnungen.map(renderWohnungRow);
  const planungsprojekte = state.planungsprojekte.map(renderPlanungsprojektRow);
  const updatedAt = state.updatedAt ?? "";

  return `
    <!doctype html>
    <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Flatfinder</title>
        ${renderStyles()}
      </head>
      <body data-updated-at="${updatedAt}" data-next-refresh="${options.nextRefreshAt}">
        <div class="header">
          <h1>Flatfinder</h1>
          <div class="status-line">
            Last refresh: <span id="last-refresh" title="${updatedAt || "-"}"></span>, next refresh: <span id="next-refresh"></span>, rate ${state.rateLimit.count}/${rateLimitMonthly}
          </div>
        </div>

        ${renderSection(`Wohnungen (${wohnungen.length})`, wohnungen)}
        ${renderSection(`Planungsprojekte (${planungsprojekte.length})`, planungsprojekte)}

        <div id="carousel" class="carousel hidden">
          <button class="close" aria-label="Close">×</button>
          <button class="prev" aria-label="Previous">‹</button>
          <a id="carousel-link" href="#" target="_blank" rel="noreferrer">
            <img id="carousel-image" alt="" />
          </a>
          <button class="next" aria-label="Next">›</button>
        </div>

        ${renderScripts()}
      </body>
    </html>
  `;
};

export const getNextRefreshFallback = () =>
  Date.now() + Math.min(wohnungssucheIntervalMinutes, planungsprojekteIntervalMinutes) * 60 * 1000;
