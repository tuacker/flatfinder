import {
  planungsprojekteIntervalMinutes,
  rateLimitMonthly,
  wohnungssucheIntervalMinutes,
} from "../src/scrapers/wohnberatung/config.js";
import type { FlatfinderState, WohnungRecord } from "../src/scrapers/wohnberatung/state.js";

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
  const isSigned = item.flags.angemeldet;
  const isHidden = Boolean(item.hiddenAt);
  const isSeen = Boolean(item.seenAt);
  const badges = renderBadges([isSigned ? "Angemeldet" : ""].filter(Boolean));
  const lageplan = item.detail?.lageplanUrl
    ? `<a class="btn" href="${safeAttribute(item.detail.lageplanUrl)}" target="_blank">Lageplan</a>`
    : "";
  const interestCount = safeValue(String(item.interessenten ?? "-"));
  const interestLabel = ` · <span class="count">${interestCount} Interessent*innen</span>`;
  const maxLabel = item.flags.maxlimit ? ' <span class="max">(max erreicht)</span>' : "";
  const title = `${safeValue(item.postalCode ?? "")}\u00a0, ${safeValue(item.address ?? "")}`;
  const seenLabel = isSeen ? "Unseen" : "Seen";
  const hiddenLabel = isHidden ? "Unhide" : "Hide";
  const entryActions = item.id
    ? `
        <button class="btn btn-muted js-entry-action" data-action="toggleSeen" data-type="planungsprojekte" data-id="${safeAttribute(item.id)}">${seenLabel}</button>
        <button class="btn btn-muted js-entry-action" data-action="toggleHidden" data-type="planungsprojekte" data-id="${safeAttribute(item.id)}">${hiddenLabel}</button>
      `
    : "";
  const rowClasses = ["row"];
  if (isSigned) rowClasses.push("is-signed");
  if (isSeen) rowClasses.push("is-seen");
  return `
    <div class="${rowClasses.join(" ")}" data-type="planungsprojekte" data-id="${safeAttribute(item.id ?? "")}" data-first-seen="${item.firstSeenAt}" data-seen-at="${safeAttribute(item.seenAt ?? "")}" data-hidden-at="${safeAttribute(item.hiddenAt ?? "")}">
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
          ${entryActions}
          ${item.url ? `<a class="btn btn-primary" href="${safeAttribute(item.url)}" target="_blank">Open</a>` : ""}
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
  const isSigned = item.flags.angemeldet;
  const isHidden = Boolean(item.hiddenAt);
  const isSeen = Boolean(item.seenAt);
  const badges = renderBadges([isSigned ? "Angemeldet" : ""].filter(Boolean));
  const seenLabel = isSeen ? "Unseen" : "Seen";
  const hiddenLabel = isHidden ? "Unhide" : "Hide";
  const entryActions = item.id
    ? `
        <button class="btn btn-muted js-entry-action" data-action="toggleSeen" data-type="wohnungen" data-id="${safeAttribute(item.id)}">${seenLabel}</button>
        <button class="btn btn-muted js-entry-action" data-action="toggleHidden" data-type="wohnungen" data-id="${safeAttribute(item.id)}">${hiddenLabel}</button>
      `
    : "";

  const mapToggle = mapEmbed
    ? `<button class="btn js-toggle-map" data-target="${mapId}">Maps</button>`
    : "";
  const mapSection = mapEmbed
    ? `<div id="${mapId}" class="map-container is-hidden">
         <iframe src="${safeAttribute(mapEmbed)}" loading="lazy" allowfullscreen></iframe>
         ${mapUrl ? `<a class="btn btn-primary" href="${safeAttribute(mapUrl)}" target="_blank">Google Maps ↗</a>` : ""}
       </div>`
    : "";

  const rowClasses = ["row"];
  if (isSigned) rowClasses.push("is-signed");
  if (isSeen) rowClasses.push("is-seen");
  return `
    <div class="${rowClasses.join(" ")}" data-type="wohnungen" data-id="${safeAttribute(item.id ?? "")}" data-first-seen="${item.firstSeenAt}" data-seen-at="${safeAttribute(item.seenAt ?? "")}" data-hidden-at="${safeAttribute(item.hiddenAt ?? "")}">
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
        ${timeLeft ? `<div class="time" data-end="${item.registrationEnd}">${timeLeft}</div>` : ""}
        ${badges}
        <div class="actions">
          ${mapToggle}
          ${entryActions}
          ${item.url ? `<a class="btn btn-primary" href="${safeAttribute(item.url)}" target="_blank">Open</a>` : ""}
        </div>
      </div>
    </div>
    ${mapSection}
  `;
};

const renderSection = (title: string, items: string[], listId: string) => {
  const content = items.length ? items.join("\n") : '<div class="empty">No results</div>';
  return `
    <div class="section">
      <h2>${escapeHtml(title)}</h2>
      <div class="list" id="${listId}">${content}</div>
    </div>
  `;
};

const renderHiddenSection = (items: string[], count: number) => {
  const content = items.length ? items.join("\n") : '<div class="empty">No hidden entries</div>';
  return `
    <div id="hidden-section" class="section is-hidden">
      <h2>Hidden (<span id="hidden-count">${count}</span>)</h2>
      <div class="list" id="hidden-list">${content}</div>
    </div>
  `;
};

const sortSeenLast = <T extends { seenAt?: string | null }>(items: T[]) => {
  const unseen = items.filter((item) => !item.seenAt);
  const seen = items.filter((item) => item.seenAt);
  return [...unseen, ...seen];
};

export const renderPage = (state: FlatfinderState, options: RenderOptions) => {
  const visibleWohnungen = state.wohnungen.filter((item) => !item.hiddenAt);
  const visiblePlanungsprojekte = state.planungsprojekte.filter((item) => !item.hiddenAt);
  const hiddenWohnungen = state.wohnungen.filter((item) => item.hiddenAt);
  const hiddenPlanungsprojekte = state.planungsprojekte.filter((item) => item.hiddenAt);

  const wohnungen = sortSeenLast(visibleWohnungen).map(renderWohnungRow);
  const planungsprojekte = sortSeenLast(visiblePlanungsprojekte).map(renderPlanungsprojektRow);

  const hiddenItems = [
    ...hiddenWohnungen.map((item) => ({
      hiddenAt: item.hiddenAt ?? "",
      html: renderWohnungRow(item),
    })),
    ...hiddenPlanungsprojekte.map((item) => ({
      hiddenAt: item.hiddenAt ?? "",
      html: renderPlanungsprojektRow(item),
    })),
  ].sort((a, b) => b.hiddenAt.localeCompare(a.hiddenAt));

  const hiddenRows = hiddenItems.map((item) => item.html);

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
          <div class="header-row">
            <h1>Flatfinder</h1>
            <div class="status-line">
              Last refresh: <span id="last-refresh" title="${updatedAt || "-"}"></span>, next refresh: <span id="next-refresh"></span>, rate ${state.rateLimit.count}/${rateLimitMonthly}
            </div>
          </div>
          <div class="header-divider"></div>
          <div class="status-actions">
            <button class="btn btn-muted js-toggle-hidden" data-target="hidden-section">Hidden</button>
          </div>
        </div>

        ${renderHiddenSection(hiddenRows, hiddenItems.length)}
        ${renderSection(`Wohnungen (${wohnungen.length})`, wohnungen, "wohnungen-list")}
        ${renderSection(`Planungsprojekte (${planungsprojekte.length})`, planungsprojekte, "planungsprojekte-list")}

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
