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
        <link rel="stylesheet" href="/app.css" />
        <script src="/app.js" type="module" defer></script>
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
      </body>
    </html>
  `;
};

export const getNextRefreshFallback = () =>
  Date.now() + Math.min(wohnungssucheIntervalMinutes, planungsprojekteIntervalMinutes) * 60 * 1000;
