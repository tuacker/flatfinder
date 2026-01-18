import {
  planungsprojekteIntervalMinutes,
  rateLimitMonthly,
  wohnungssucheIntervalMinutes,
} from "../src/scrapers/wohnberatung/config.js";
import { willhabenRefreshIntervalMs } from "../src/scrapers/willhaben/config.js";
import type {
  FlatfinderState,
  TelegramConfig,
  WohnungRecord,
  WillhabenRecord,
} from "../src/scrapers/wohnberatung/state.js";
import { comparePriority } from "../src/shared/interest-priority.js";
import { formatRefreshLeft, formatTimeLeft } from "./time.js";

export type RenderOptions = {
  nextRefreshAt: number;
  sourceFilter?: SourceFilter;
};

export type RenderFragments = {
  updatedAt: string | null;
  lastScrapeAt: string | null;
  nextRefreshAt: number;
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
  willhaben: {
    districts: string[];
    rooms: string[];
  };
};

type SourceFilter = "all" | "wohnberatung" | "willhaben";

const escapeHtml = (value: string | number | null | undefined) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeValue = (value: string | number | null | undefined, fallback = "-") =>
  escapeHtml(value ?? fallback);

const safeAttribute = (value: string | number | null | undefined) => escapeHtml(value ?? "");

const cleanValue = (value: string | null) => {
  if (!value) return "-";
  return value.replace(/^[^0-9€]+:?\s*/i, "").trim();
};

const parseCurrency = (value: string | null | undefined) => {
  if (!value) return null;
  const cleaned = value
    .replace(/[^\d.,]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseNumeric = (value: string | null | undefined) => {
  if (!value) return null;
  const cleaned = value.replace(/[^\d.,]/g, "").replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const extractDistrictCode = (value: string | null | undefined) => {
  if (!value) return null;
  const match = value.match(/\b(0?[1-9]|1[0-9])\.?\s*Bezirk/i);
  if (match) return match[1].padStart(2, "0");
  return null;
};

const formatCurrency = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number" ? value : parseCurrency(value);
  if (numeric === null) return null;
  return new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(numeric);
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

type RenderRowOptions = {
  showRankControls?: boolean;
  showCountdown?: boolean;
  showRankLabel?: boolean;
};

type InterestRenderState = {
  isSigned: boolean;
  isInterested: boolean;
  isLocked: boolean;
  badges: string;
  interestButtonLabel: string;
  interestAction: string;
  interestButtonClass: string;
};

const getInterestState = (item: {
  flags: { angemeldet: boolean };
  interest?: { requestedAt?: string | null; locked?: boolean | null };
}): InterestRenderState => {
  const isSigned = item.flags.angemeldet;
  const isInterested = Boolean(item.interest?.requestedAt);
  const isLocked = Boolean(item.flags.angemeldet && item.interest?.locked);
  const badges = renderBadges(
    [isSigned ? "Angemeldet" : "", !isSigned && isInterested ? "Waiting" : ""].filter(Boolean),
  );
  const interestButtonLabel = isSigned ? "Remove" : isInterested ? "Drop" : "Interested";
  const interestAction = isSigned ? "remove" : isInterested ? "drop" : "add";
  const interestButtonClass = isSigned ? "btn-danger" : isInterested ? "btn-muted" : "btn-success";
  return {
    isSigned,
    isInterested,
    isLocked,
    badges,
    interestButtonLabel,
    interestAction,
    interestButtonClass,
  };
};

const renderInterestButton = (
  type: "wohnungen" | "planungsprojekte",
  id: string | null | undefined,
  state: InterestRenderState,
) => {
  if (!id) return "";
  return `<button class="btn ${state.interestButtonClass} js-interest-action" data-action="${state.interestAction}" data-type="${type}" data-id="${safeAttribute(id)}"${state.isLocked ? " disabled" : ""}>${state.interestButtonLabel}</button>`;
};

const renderLockButton = (
  type: "wohnungen" | "planungsprojekte",
  id: string | null | undefined,
  state: InterestRenderState,
) => {
  if (!id || !state.isSigned) return "";
  return `<button class="btn ${state.isLocked ? "btn-primary" : "btn-muted"} js-lock-action" data-action="${state.isLocked ? "unlock" : "lock"}" data-type="${type}" data-id="${safeAttribute(id)}">${state.isLocked ? "Locked" : "Lock"}</button>`;
};

const renderRankControls = (
  type: "wohnungen" | "planungsprojekte",
  id: string | null | undefined,
  showRankControls: boolean,
) => {
  if (!showRankControls) return "";
  return `
        <div class="rank-controls">
          <button class="btn btn-muted js-rank-move" data-direction="up" data-type="${type}" data-id="${safeAttribute(id ?? "")}" aria-label="Move up">&#x2191;</button>
          <button class="btn btn-muted js-rank-move" data-direction="down" data-type="${type}" data-id="${safeAttribute(id ?? "")}" aria-label="Move down">&#x2193;</button>
        </div>
      `;
};

const renderRefreshLabel = (refreshAt: string | null) => {
  if (!refreshAt) return "";
  const refreshLeft = formatRefreshLeft(refreshAt);
  if (!refreshLeft) return "";
  return `<span class="title-meta refresh" data-refresh-at="${safeAttribute(refreshAt)}">refresh ${escapeHtml(refreshLeft)}</span>`;
};

const renderPlanungsprojektRow = (
  item: FlatfinderState["planungsprojekte"][number],
  options: RenderRowOptions = {},
) => {
  const { showRankControls = false, showCountdown = true, showRankLabel = false } = options;
  const imageList = item.detail?.imageUrls?.length ? item.detail.imageUrls : [item.imageUrl ?? ""];
  const imageData = encodeImages(imageList);
  const image = item.imageUrl
    ? `<button class="image-button js-carousel" data-images="${imageData}">
         <img class="thumb" src="${safeAttribute(item.imageUrl)}" alt="" />
       </button>`
    : "";
  const interestState = getInterestState(item);
  const isSigned = interestState.isSigned;
  const isHidden = Boolean(item.hiddenAt);
  const isSeen = Boolean(item.seenAt);
  const isLocked = interestState.isLocked;
  const interestButton = renderInterestButton("planungsprojekte", item.id, interestState);
  const lockButton = renderLockButton("planungsprojekte", item.id, interestState);
  const lageplan = item.detail?.lageplanUrl
    ? `<a class="btn" href="${safeAttribute(item.detail.lageplanUrl)}" target="_blank">Lageplan</a>`
    : "";
  const interestCount = safeValue(String(item.interessenten ?? "-"));
  const maxLabel = item.flags.maxlimit ? ' <span class="max">(max erreicht)</span>' : "";
  const title = `${safeValue(item.postalCode ?? "")}\u00a0, ${safeValue(item.address ?? "")}`;
  const rankLabel =
    showRankLabel && typeof item.interest?.rank === "number"
      ? `<span class="title-meta rank">#${item.interest.rank}</span>`
      : "";
  const refreshAt = showCountdown && !isSigned ? (item.interest?.watch?.nextCheckAt ?? null) : null;
  const refreshLabel = renderRefreshLabel(refreshAt);
  const titleMetaParts = [
    ...(refreshLabel ? [refreshLabel] : []),
    `<span class="title-meta">${interestCount} signups${maxLabel}</span>`,
    ...(rankLabel ? [rankLabel] : []),
  ];
  const titleMeta =
    titleMetaParts.length > 0
      ? `<span class="title-meta-group">· ${titleMetaParts.join(" · ")}</span>`
      : "";
  const badgesBlock = interestState.badges
    ? `<span class="title-badges">${interestState.badges}</span>`
    : "";
  const rankControls = renderRankControls("planungsprojekte", item.id, showRankControls);
  const interestActionBlock =
    interestButton || lockButton || rankControls
      ? `<div class="row-header-interest">${interestButton}${lockButton}${rankControls}</div>`
      : "";
  const visibilityLabel = renderVisibilityLabel(isHidden);
  const seenButton =
    !isSeen && item.id
      ? `<button class="seen-toggle js-entry-action" data-action="toggleSeen" data-type="planungsprojekte" data-id="${safeAttribute(item.id)}" aria-label="Mark seen">✓</button>`
      : "";
  const entryActions = item.id
    ? `
        <button class="btn btn-muted js-entry-action" data-action="toggleHidden" data-type="planungsprojekte" data-id="${safeAttribute(item.id)}" aria-label="${isHidden ? "Unhide" : "Hide"}">${visibilityLabel}</button>
      `
    : "";
  const rowClasses = ["row"];
  if (isSigned) rowClasses.push("is-signed");
  if (isSeen) rowClasses.push("is-seen");
  if (!isSeen) rowClasses.push("is-new");
  if (isLocked) rowClasses.push("is-locked");
  return `
    <div class="${rowClasses.join(" ")}" data-type="planungsprojekte" data-id="${safeAttribute(item.id ?? "")}" data-first-seen="${item.firstSeenAt}" data-seen-at="${safeAttribute(item.seenAt ?? "")}" data-hidden-at="${safeAttribute(item.hiddenAt ?? "")}" data-requested-at="${safeAttribute(item.interest?.requestedAt ?? "")}" data-rank="${safeAttribute(item.interest?.rank ?? "")}" data-maxlimit="${item.flags.maxlimit ? "true" : "false"}" data-locked="${isLocked ? "true" : ""}">
      ${seenButton}
      ${image}
      <div class="content">
        <div class="row-header">
          <div class="title-line">
            <div class="title">${title}</div>
            ${titleMeta}
            ${badgesBlock}
            <span class="swap-indicator"></span>
          </div>
          <div class="row-header-actions">
            ${interestActionBlock}
            <div class="actions">
              ${lageplan}
              ${entryActions}
              ${item.url ? `<a class="btn btn-primary" href="${safeAttribute(item.url)}" target="_blank">Open</a>` : ""}
            </div>
          </div>
        </div>
        <div class="meta">
          Bezugsfertig ${safeValue(item.bezugsfertig)} · ${safeValue(item.foerderungstyp)}
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

const renderWohnungRow = (item: WohnungRecord, options: RenderRowOptions = {}) => {
  const { showRankControls = false, showCountdown = true, showRankLabel = false } = options;
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
  const timeLabel = timeLeft ? `<span class="title-meta time">${timeLeft}</span>` : "";
  const interestState = getInterestState(item);
  const isSigned = interestState.isSigned;
  const isHidden = Boolean(item.hiddenAt);
  const isSeen = Boolean(item.seenAt);
  const isLocked = interestState.isLocked;
  const visibilityLabel = renderVisibilityLabel(isHidden);
  const seenButton =
    !isSeen && item.id
      ? `<button class="seen-toggle js-entry-action" data-action="toggleSeen" data-type="wohnungen" data-id="${safeAttribute(item.id)}" aria-label="Mark seen">✓</button>`
      : "";
  const interestButton = renderInterestButton("wohnungen", item.id, interestState);
  const lockButton = renderLockButton("wohnungen", item.id, interestState);
  const entryActions = item.id
    ? `
        <button class="btn btn-muted js-entry-action" data-action="toggleHidden" data-type="wohnungen" data-id="${safeAttribute(item.id)}" aria-label="${isHidden ? "Unhide" : "Hide"}">${visibilityLabel}</button>
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

  const interestCount = safeValue(String(item.interessenten ?? "-"));
  const rankLabel =
    showRankLabel && typeof item.interest?.rank === "number"
      ? `<span class="title-meta rank">#${item.interest.rank}</span>`
      : "";
  const refreshAt = showCountdown && !isSigned ? (item.interest?.watch?.nextCheckAt ?? null) : null;
  const refreshLabel = renderRefreshLabel(refreshAt);
  const titleMetaParts = [
    ...(timeLabel ? [timeLabel] : []),
    ...(refreshLabel ? [refreshLabel] : []),
    `<span class="title-meta">${interestCount} signups</span>`,
    ...(rankLabel ? [rankLabel] : []),
  ];
  const titleMeta =
    titleMetaParts.length > 0
      ? `<span class="title-meta-group">· ${titleMetaParts.join(" · ")}</span>`
      : "";
  const badgesBlock = interestState.badges
    ? `<span class="title-badges">${interestState.badges}</span>`
    : "";
  const rankControls = renderRankControls("wohnungen", item.id, showRankControls);
  const interestActionBlock =
    interestButton || lockButton || rankControls
      ? `<div class="row-header-interest">${interestButton}${lockButton}${rankControls}</div>`
      : "";

  const rowClasses = ["row"];
  if (isSigned) rowClasses.push("is-signed");
  if (isSeen) rowClasses.push("is-seen");
  if (!isSeen) rowClasses.push("is-new");
  if (isLocked) rowClasses.push("is-locked");
  return `
    <div class="${rowClasses.join(" ")}" data-type="wohnungen" data-id="${safeAttribute(item.id ?? "")}" data-first-seen="${item.firstSeenAt}" data-seen-at="${safeAttribute(item.seenAt ?? "")}" data-hidden-at="${safeAttribute(item.hiddenAt ?? "")}" data-requested-at="${safeAttribute(item.interest?.requestedAt ?? "")}" data-rank="${safeAttribute(item.interest?.rank ?? "")}" data-maxlimit="${item.flags.maxlimit ? "true" : "false"}" data-locked="${isLocked ? "true" : ""}">
      ${seenButton}
      ${thumb}
      <div class="content">
        <div class="row-header">
          <div class="title-line">
            <div class="title">${safeValue(item.postalCode ?? "")} ${safeValue(item.address ?? "")}</div>
            ${titleMeta}
            ${badgesBlock}
            <span class="swap-indicator"></span>
          </div>
          <div class="row-header-actions">
            ${interestActionBlock}
            <div class="actions">
              ${mapToggle}
              ${entryActions}
              ${item.url ? `<a class="btn btn-primary" href="${safeAttribute(item.url)}" target="_blank">Open</a>` : ""}
            </div>
          </div>
        </div>
        <div class="facts">
          <div class="fact"><span class="label">Fläche:</span><span class="value">${safeValue(item.size)}</span></div>
          <div class="fact"><span class="label">Zimmer:</span><span class="value">${safeValue(cleanValue(item.rooms))}</span></div>
          <div class="fact"><span class="label">Kosten:</span><span class="value">${safeValue(cleanValue(item.monthlyCost))}</span></div>
          <div class="fact"><span class="label">Eigenmittel:</span><span class="value">${safeValue(cleanValue(item.equity))}</span></div>
          <div class="fact"><span class="label">Typ:</span><span class="value">${safeValue(item.foerderungstyp)}</span></div>
        </div>
      </div>
    </div>
    ${mapSection}
  `;
};

const renderWillhabenRow = (item: WillhabenRecord) => {
  const mapId = `details-${item.id}`;
  const mapUrl = item.detail?.mapUrl ?? null;
  const mapEmbed = mapUrl ? buildMapEmbedUrl(mapUrl) : null;

  const images = item.images?.length ? item.images : item.thumbnailUrl ? [item.thumbnailUrl] : [];
  const imageData = encodeImages(images);
  const thumbSrc = images[0] ?? null;
  const thumb = thumbSrc
    ? `<button class="image-button js-carousel" data-images="${imageData}">
         <img class="thumb" src="${safeAttribute(thumbSrc)}" alt="" />
       </button>`
    : "";

  const titleText = item.title ?? item.location ?? null;
  const subtitleText =
    item.title && item.location && item.title !== item.location ? item.location : null;
  const secondary = subtitleText ? `<div class="meta">${escapeHtml(subtitleText)}</div>` : "";

  const isHidden = Boolean(item.hiddenAt);
  const isSeen = Boolean(item.seenAt);
  const districtCode =
    extractDistrictCode(item.district ?? null) ?? extractDistrictCode(item.location ?? null) ?? "";
  const roomsValue = parseNumeric(item.rooms)?.toString() ?? "";
  const areaValue = parseNumeric(item.size)?.toString() ?? "";
  const priceValue = item.totalCostValue ?? parseCurrency(item.primaryCost);
  const visibilityLabel = renderVisibilityLabel(isHidden);
  const seenButton = !isSeen
    ? `<button class="seen-toggle js-entry-action" data-action="toggleSeen" data-type="willhaben" data-id="${safeAttribute(item.id)}" aria-label="Mark seen">✓</button>`
    : "";
  const entryActions = `
        <button class="btn btn-muted js-entry-action" data-action="toggleHidden" data-type="willhaben" data-id="${safeAttribute(item.id)}" aria-label="${isHidden ? "Unhide" : "Hide"}">${visibilityLabel}</button>
      `;

  const primaryLabel = item.primaryCostLabel ?? (item.primaryCost ? "Gesamtmiete" : null);
  const totalCost =
    formatCurrency(item.totalCostValue ?? item.primaryCost) ??
    (item.primaryCost ? `€ ${safeValue(item.primaryCost)}` : null);
  const totalLabel = "Gesamtbelastung";
  const additionalCostLabels = [
    "Betriebskosten",
    "Betriebskosten (brutto)",
    "Betriebskosten (netto)",
    "BK",
    "Additional Cost Fee",
  ];
  const additionalCostEntry =
    additionalCostLabels
      .map((label) => ({ label, value: item.costs?.[label] }))
      .find((entry) => entry.value)?.value ?? null;
  const additionalCost =
    formatCurrency(additionalCostEntry) ??
    (additionalCostEntry ? `€ ${safeValue(additionalCostEntry)}` : null);
  const summaryFacts = [
    item.size
      ? `<div class="fact"><span class="label">Fläche:</span><span class="value">${safeValue(item.size)} m²</span></div>`
      : "",
    item.rooms
      ? `<div class="fact"><span class="label">Zimmer:</span><span class="value">${safeValue(item.rooms)}</span></div>`
      : "",
    totalCost
      ? `<div class="fact"><span class="label">${escapeHtml(totalLabel)}:</span><span class="value">${escapeHtml(totalCost)}</span></div>`
      : "",
    additionalCost
      ? `<div class="fact"><span class="label">BK:</span><span class="value">${escapeHtml(additionalCost)}</span></div>`
      : "",
  ].filter(Boolean);

  const costEntries = Object.entries(item.costs ?? {}).filter(
    ([label]) => (!primaryLabel || label !== primaryLabel) && label !== totalLabel,
  );
  const otherFacts = costEntries.map(
    ([label, value]) =>
      `<div class="fact"><span class="label">${escapeHtml(label)}:</span><span class="value">${safeValue(value)}</span></div>`,
  );

  const detailsToggle =
    mapEmbed || item.detail?.description
      ? `<button class="btn js-toggle-map" data-target="${mapId}">Details</button>`
      : "";
  const description = item.detail?.description
    ? `<div class="details-text">${escapeHtml(item.detail.description).replace(/\n/g, "<br />")}</div>`
    : "";
  const mapSection =
    detailsToggle && (mapEmbed || description)
      ? `<div id="${mapId}" class="map-container is-hidden">
         ${mapEmbed ? `<iframe src="${safeAttribute(mapEmbed)}" loading="lazy" allowfullscreen></iframe>` : ""}
         ${mapUrl ? `<a class="btn btn-primary" href="${safeAttribute(mapUrl)}" target="_blank">Google Maps ↗</a>` : ""}
         ${description}
       </div>`
      : "";

  const rowClasses = ["row"];
  if (isSeen) rowClasses.push("is-seen");
  if (!isSeen) rowClasses.push("is-new");

  return `
    <div class="${rowClasses.join(" ")}" data-type="willhaben" data-id="${safeAttribute(item.id)}" data-first-seen="${item.firstSeenAt}" data-seen-at="${safeAttribute(item.seenAt ?? "")}" data-hidden-at="${safeAttribute(item.hiddenAt ?? "")}" data-district="${safeAttribute(districtCode)}" data-rooms="${safeAttribute(roomsValue)}" data-area="${safeAttribute(areaValue)}" data-price="${safeAttribute(priceValue ?? "")}">
      ${seenButton}
      ${thumb}
      <div class="content">
        <div class="row-header">
          <div class="title-line">
            <div class="title">${safeValue(titleText)}</div>
          </div>
          <div class="row-header-actions">
            <div class="actions">
              ${detailsToggle}
              ${entryActions}
              ${item.url ? `<a class="btn btn-primary" href="${safeAttribute(item.url)}" target="_blank">Open</a>` : ""}
            </div>
          </div>
        </div>
        ${secondary}
        <div class="facts">
          ${summaryFacts.join("")}
        </div>
        ${otherFacts.length ? `<div class="facts secondary-facts">${otherFacts.join("")}</div>` : ""}
      </div>
    </div>
    ${mapSection}
  `;
};

const renderSection = (
  title: string,
  items: string[],
  listId: string,
  sectionId: string,
  viewGroup = "root",
) => {
  const content = items.length ? items.join("\n") : '<div class="empty">No results</div>';
  return `
    <div class="section" id="${sectionId}" data-view-group="${viewGroup}">
      <h2>${escapeHtml(title)}</h2>
      <div class="list" id="${listId}">${content}</div>
    </div>
  `;
};

const renderHiddenSection = (items: string[], count: number) => {
  const content = items.length ? items.join("\n") : '<div class="empty">No hidden entries</div>';
  return `
    <div id="hidden-section" class="section" data-view-group="hidden">
      <h2>Hidden (<span id="hidden-count">${count}</span>)</h2>
      <div class="list" id="hidden-list">${content}</div>
    </div>
  `;
};

const renderTelegramSettings = (config: TelegramConfig | null | undefined) => {
  const enabled = config?.enabled ? "checked" : "";
  const includeImages = config?.includeImages !== false ? "checked" : "";
  const enableActions = config?.enableActions ? "checked" : "";
  const pollingEnabled = config?.pollingEnabled ? "checked" : "";
  const botToken = escapeHtml(config?.botToken ?? "");
  const chatId = escapeHtml(config?.chatId ?? "");
  const webhookToken = escapeHtml(config?.webhookToken ?? "");
  return `
    <div class="settings-card" id="telegram-settings">
      <div class="settings-header">
        <h2>Telegram notifications</h2>
        <div class="settings-actions">
          <button class="btn btn-muted" id="telegram-test">Send test</button>
          <button class="btn btn-primary" id="telegram-save">Save</button>
        </div>
      </div>
      <div class="settings-grid">
        <label class="settings-field">
          <span>Enabled</span>
          <input type="checkbox" id="telegram-enabled" ${enabled} />
        </label>
        <label class="settings-field">
          <span>Bot token</span>
          <input type="password" id="telegram-bot-token" value="${botToken}" placeholder="123456:ABC-DEF..." />
        </label>
        <label class="settings-field">
          <span>Chat ID</span>
          <input type="text" id="telegram-chat-id" value="${chatId}" placeholder="e.g. 123456789" />
        </label>
        <label class="settings-field">
          <span>Include images</span>
          <input type="checkbox" id="telegram-include-images" ${includeImages} />
        </label>
        <label class="settings-field">
          <span>Enable actions</span>
          <input type="checkbox" id="telegram-enable-actions" ${enableActions} />
        </label>
        <label class="settings-field">
          <span>Use polling (no webhook)</span>
          <input type="checkbox" id="telegram-polling-enabled" ${pollingEnabled} />
        </label>
        <label class="settings-field">
          <span>Webhook token</span>
          <input type="text" id="telegram-webhook-token" value="${webhookToken}" placeholder="secret token" />
        </label>
      </div>
      <div class="settings-hint">
        Webhook URL: <code id="telegram-webhook-url">/api/telegram/webhook/{token}</code>
      </div>
      <div class="settings-status" id="telegram-status"></div>
    </div>
  `;
};

const renderWillhabenControls = (options: { districts: string[] }) => `
  <div class="willhaben-controls" id="willhaben-controls">
    <div class="filter-group">
      <span class="filter-label">Sort</span>
      <button class="filter-chip js-sort-chip" data-sort="price" data-sort-state="none">Price</button>
      <button class="filter-chip js-sort-chip" data-sort="area" data-sort-state="none">Fläche</button>
    </div>
    <div class="filter-group">
      <span class="filter-label">District</span>
      <button class="filter-chip js-filter-district" data-value="all">All</button>
      ${options.districts
        .map(
          (district) =>
            `<button class="filter-chip js-filter-district" data-value="${escapeHtml(
              district,
            )}">${escapeHtml(district)}.</button>`,
        )
        .join("")}
    </div>
    <div class="filter-group">
      <span class="filter-label">Rooms</span>
      <button class="filter-chip js-filter-rooms" data-value="all">All</button>
      <button class="filter-chip js-filter-rooms" data-value="1">1</button>
      <button class="filter-chip js-filter-rooms" data-value="2">2</button>
      <button class="filter-chip js-filter-rooms" data-value="3">3</button>
      <button class="filter-chip js-filter-rooms" data-value="4+">4+</button>
    </div>
  </div>
`;

const renderSettingsSection = (config: TelegramConfig | null | undefined) => `
  <div id="settings-section" class="section" data-view-group="settings">
    <h2>Settings</h2>
    ${renderTelegramSettings(config)}
  </div>
`;

const renderSubsection = (
  title: string,
  type: string,
  listId: string,
  items: string[],
  options?: { controls?: string },
) => {
  const content = items.length ? items.join("\n") : '<div class="empty">No entries</div>';
  return `
    <div class="subsection">
      <div class="subsection-header">
        <h3>${escapeHtml(title)}</h3>
        <div class="subsection-actions">
          <button class="btn btn-muted js-rank-toggle" data-type="${type}" data-target="${listId}">Reorder</button>
          <button class="btn btn-primary js-rank-save is-hidden" data-type="${type}" data-target="${listId}">Save</button>
          <button class="btn btn-muted js-rank-cancel is-hidden" data-type="${type}" data-target="${listId}">Cancel</button>
        </div>
      </div>
      ${options?.controls ?? ""}
      <div class="list" id="${listId}" data-rank-mode="false">${content}</div>
    </div>
  `;
};

const sortSeenLast = <T extends { seenAt?: string | null }>(items: T[]) => {
  const unseen = items.filter((item) => !item.seenAt);
  const seen = items.filter((item) => item.seenAt);
  return [...unseen, ...seen];
};

const sortByRank = <
  T extends {
    lastSeenAt: string;
    interest?: { rank?: number | null; requestedAt?: string | null };
  },
>(
  items: T[],
) =>
  [...items].sort((a, b) => {
    const priority = comparePriority(a, b);
    if (priority !== 0) return priority;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });

const buildSections = (state: FlatfinderState, telegramConfig?: TelegramConfig | null) => {
  const isInterested = (item: {
    flags: { angemeldet: boolean };
    interest?: { requestedAt?: string | null };
  }) => Boolean(item.flags.angemeldet || item.interest?.requestedAt);

  const visibleWohnungen = state.wohnungen.filter((item) => !item.hiddenAt && !isInterested(item));
  const visiblePlanungsprojekte = state.planungsprojekte.filter(
    (item) => !item.hiddenAt && !isInterested(item),
  );
  const interestedWohnungen = state.wohnungen.filter(
    (item) => !item.hiddenAt && isInterested(item),
  );
  const interestedPlanungsprojekte = state.planungsprojekte.filter(
    (item) => !item.hiddenAt && isInterested(item),
  );
  const hiddenWohnungen = state.wohnungen.filter((item) => item.hiddenAt);
  const hiddenPlanungsprojekte = state.planungsprojekte.filter((item) => item.hiddenAt);
  const visibleWillhaben = state.willhaben.filter((item) => !item.hiddenAt);
  const hiddenWillhaben = state.willhaben.filter((item) => item.hiddenAt);

  const wohnungen = sortSeenLast(visibleWohnungen).map((item) =>
    renderWohnungRow(item, { showCountdown: true }),
  );
  const planungsprojekte = sortSeenLast(visiblePlanungsprojekte).map((item) =>
    renderPlanungsprojektRow(item, { showCountdown: true }),
  );
  const willhaben = sortSeenLast(visibleWillhaben).map((item) => renderWillhabenRow(item));
  const willhabenDistricts = Array.from(
    new Set(
      state.willhaben
        .map(
          (item) =>
            extractDistrictCode(item.district ?? null) ??
            extractDistrictCode(item.location ?? null) ??
            null,
        )
        .filter((value): value is string => Boolean(value && value.trim())),
    ),
  ).sort((a, b) => Number(a) - Number(b));

  const interestedWohnungenRows = sortByRank(interestedWohnungen).map((item) =>
    renderWohnungRow(item, { showRankControls: true, showRankLabel: true, showCountdown: true }),
  );
  const interestedPlanungsprojekteRows = sortByRank(interestedPlanungsprojekte).map((item) =>
    renderPlanungsprojektRow(item, {
      showRankControls: true,
      showRankLabel: true,
      showCountdown: true,
    }),
  );

  const hiddenItems = [
    ...hiddenWohnungen.map((item) => ({
      hiddenAt: item.hiddenAt ?? "",
      html: renderWohnungRow(item, { showCountdown: true }),
    })),
    ...hiddenPlanungsprojekte.map((item) => ({
      hiddenAt: item.hiddenAt ?? "",
      html: renderPlanungsprojektRow(item, { showCountdown: true }),
    })),
    ...hiddenWillhaben.map((item) => ({
      hiddenAt: item.hiddenAt ?? "",
      html: renderWillhabenRow(item),
    })),
  ].sort((a, b) => b.hiddenAt.localeCompare(a.hiddenAt));

  const hiddenRows = hiddenItems.map((item) => item.html);
  const hiddenCount = hiddenItems.length;
  const wohnungenCount = wohnungen.length;
  const planungsprojekteCount = planungsprojekte.length;
  const willhabenCount = willhaben.length;
  const interestedSection = `
    <div class="section" id="interested-section" data-view-group="interested">
      <h2>Interested</h2>
      ${renderSubsection(
        `Wohnungen (${interestedWohnungenRows.length})`,
        "wohnungen",
        "interested-wohnungen-list",
        interestedWohnungenRows,
      )}
      ${renderSubsection(
        `Planungsprojekte (${interestedPlanungsprojekteRows.length})`,
        "planungsprojekte",
        "interested-planungsprojekte-list",
        interestedPlanungsprojekteRows,
      )}
    </div>
  `;

  const willhabenControls = renderWillhabenControls({
    districts: willhabenDistricts,
  });

  return {
    hiddenSection: renderHiddenSection(hiddenRows, hiddenCount),
    interestedSection,
    settingsSection: renderSettingsSection(telegramConfig),
    wohnungenSection: renderSection(
      `Wohnungen (${wohnungenCount})`,
      wohnungen,
      "wohnungen-list",
      "wohnungen-section",
      "root",
    ),
    planungsprojekteSection: renderSection(
      `Planungsprojekte (${planungsprojekteCount})`,
      planungsprojekte,
      "planungsprojekte-list",
      "planungsprojekte-section",
      "root",
    ),
    willhabenSection: renderSection(
      `Willhaben (${willhabenCount})`,
      [willhabenControls, ...willhaben],
      "willhaben-list",
      "willhaben-section",
      "root",
    ),
    hiddenCount,
    wohnungenCount,
    planungsprojekteCount,
    willhabenCount,
  };
};

export const renderFragments = (
  state: FlatfinderState,
  options: RenderOptions,
  telegramConfig?: TelegramConfig | null,
): RenderFragments => {
  const sections = buildSections(state, telegramConfig);
  return {
    updatedAt: state.updatedAt ?? null,
    lastScrapeAt: state.lastScrapeAt ?? null,
    nextRefreshAt: options.nextRefreshAt,
    rateLimitCount: state.rateLimit.count,
    rateLimitMonthly,
    sections: {
      hidden: sections.hiddenSection,
      interested: sections.interestedSection,
      wohnungen: sections.wohnungenSection,
      planungsprojekte: sections.planungsprojekteSection,
      willhaben: sections.willhabenSection,
      settings: sections.settingsSection,
    },
    willhaben: {
      districts: Array.from(
        new Set(
          state.willhaben
            .map(
              (item) =>
                extractDistrictCode(item.district ?? null) ??
                extractDistrictCode(item.location ?? null) ??
                null,
            )
            .filter((value): value is string => Boolean(value && value.trim())),
        ),
      ).sort((a, b) => Number(a) - Number(b)),
      rooms: [],
    },
  };
};

export const renderPage = (
  state: FlatfinderState,
  options: RenderOptions,
  telegramConfig?: TelegramConfig | null,
) => {
  const sourceFilter: SourceFilter = options.sourceFilter ?? "all";
  const sections = buildSections(state, telegramConfig);

  const updatedAt = state.updatedAt ?? "";
  const lastScrapeAt = state.lastScrapeAt ?? "";

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
      <body data-updated-at="${updatedAt}" data-last-scrape-at="${lastScrapeAt}" data-next-refresh="${options.nextRefreshAt}" data-view="root" data-source="${sourceFilter}">
        <div class="header">
        <div class="header-row">
            <div class="header-title">
              <h1>Flatfinder</h1>
              <div class="header-sources">
                <button class="btn btn-muted js-source-toggle${sourceFilter === "all" ? " is-active" : ""}" data-source="all">All</button>
                <button class="btn btn-muted js-source-toggle${sourceFilter === "wohnberatung" ? " is-active" : ""}" data-source="wohnberatung">Wiener Wohnen</button>
                <button class="btn btn-muted js-source-toggle${sourceFilter === "willhaben" ? " is-active" : ""}" data-source="willhaben">Willhaben</button>
              </div>
            </div>
            <div class="header-status">
              <button class="btn btn-muted btn-icon btn-icon-sm js-view-toggle" data-view="settings" aria-label="Settings" title="Settings">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7z"></path>
                  <path d="M19.4 12.9a7.9 7.9 0 0 0 .1-.9a7.9 7.9 0 0 0-.1-.9l2-1.5a.7.7 0 0 0 .2-.9l-1.9-3.3a.7.7 0 0 0-.9-.3l-2.3.9a7.7 7.7 0 0 0-1.6-.9l-.3-2.4a.7.7 0 0 0-.7-.6h-3.8a.7.7 0 0 0-.7.6l-.3 2.4a7.7 7.7 0 0 0-1.6.9l-2.3-.9a.7.7 0 0 0-.9.3L2.5 8.7a.7.7 0 0 0 .2.9l2 1.5a7.9 7.9 0 0 0-.1.9a7.9 7.9 0 0 0 .1.9l-2 1.5a.7.7 0 0 0-.2.9l1.9 3.3a.7.7 0 0 0 .9.3l2.3-.9a7.7 7.7 0 0 0 1.6.9l.3 2.4a.7.7 0 0 0 .7.6h3.8a.7.7 0 0 0 .7-.6l.3-2.4a7.7 7.7 0 0 0 1.6-.9l2.3.9a.7.7 0 0 0 .9-.3l1.9-3.3a.7.7 0 0 0-.2-.9l-2-1.5z"></path>
                </svg>
              </button>
              <div class="status-line">
                Last refresh: <span id="last-refresh" title="${lastScrapeAt || "-"}"></span>, next refresh: <span id="next-refresh"></span>, rate <span id="rate-count">${state.rateLimit.count}</span>/<span id="rate-limit">${rateLimitMonthly}</span>
              </div>
            </div>
          </div>
          <div class="header-divider"></div>
          <div class="status-actions">
            <button class="btn btn-muted js-view-toggle" data-view="root">New</button>
            <button class="btn btn-muted js-view-toggle" data-view="interested">Interested</button>
            <button class="btn btn-muted js-view-toggle" data-view="hidden">Hidden</button>
          </div>
        </div>

        ${sections.settingsSection}

        ${sections.hiddenSection}
        ${sections.interestedSection}
        ${sections.wohnungenSection}
        ${sections.planungsprojekteSection}
        ${sections.willhabenSection}

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
  Date.now() +
  Math.min(
    wohnungssucheIntervalMinutes * 60 * 1000,
    planungsprojekteIntervalMinutes * 60 * 1000,
    willhabenRefreshIntervalMs,
  );
