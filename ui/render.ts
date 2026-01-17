import {
  planungsprojekteIntervalMinutes,
  rateLimitMonthly,
  wohnungssucheIntervalMinutes,
} from "../src/scrapers/wohnberatung/config.js";
import type { FlatfinderState, WohnungRecord } from "../src/scrapers/wohnberatung/state.js";

export type RenderOptions = {
  nextRefreshAt: number;
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
  };
};

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

const getRequestedAtValue = (value: string | null | undefined) => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
};

const getPriority = (item: {
  interest?: { rank?: number | null; requestedAt?: string | null };
}) => {
  if (typeof item.interest?.rank === "number") {
    return { bucket: 0, value: item.interest.rank };
  }
  return { bucket: 1, value: getRequestedAtValue(item.interest?.requestedAt) };
};

const comparePriority = (
  left: { interest?: { rank?: number | null; requestedAt?: string | null } },
  right: { interest?: { rank?: number | null; requestedAt?: string | null } },
) => {
  const leftPriority = getPriority(left);
  const rightPriority = getPriority(right);
  if (leftPriority.bucket !== rightPriority.bucket) {
    return leftPriority.bucket - rightPriority.bucket;
  }
  if (leftPriority.value < rightPriority.value) return -1;
  if (leftPriority.value > rightPriority.value) return 1;
  return 0;
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
  const isSigned = item.flags.angemeldet;
  const isHidden = Boolean(item.hiddenAt);
  const isSeen = Boolean(item.seenAt);
  const isInterested = Boolean(item.interest?.requestedAt);
  const isLocked = Boolean(item.flags.angemeldet && item.interest?.locked);
  const badges = renderBadges(
    [isSigned ? "Angemeldet" : "", !isSigned && isInterested ? "Waiting" : ""].filter(Boolean),
  );
  const interestButtonLabel = isSigned ? "Remove" : isInterested ? "Drop" : "Interested";
  const interestAction = isSigned ? "remove" : isInterested ? "drop" : "add";
  const interestButtonClass = isSigned ? "btn-danger" : isInterested ? "btn-muted" : "btn-success";
  const interestButton = item.id
    ? `<button class="btn ${interestButtonClass} js-interest-action" data-action="${interestAction}" data-type="planungsprojekte" data-id="${safeAttribute(item.id)}"${isLocked ? " disabled" : ""}>${interestButtonLabel}</button>`
    : "";
  const lockButton =
    item.id && isSigned
      ? `<button class="btn ${isLocked ? "btn-primary" : "btn-muted"} js-lock-action" data-action="${isLocked ? "unlock" : "lock"}" data-type="planungsprojekte" data-id="${safeAttribute(item.id)}">${isLocked ? "Locked" : "Lock"}</button>`
      : "";
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
  const refreshLeft = refreshAt ? formatRefreshLeft(refreshAt) : null;
  const refreshLabel = refreshLeft
    ? `<span class="title-meta refresh" data-refresh-at="${safeAttribute(refreshAt)}">refresh ${escapeHtml(refreshLeft)}</span>`
    : "";
  const titleMetaParts = [
    ...(refreshLabel ? [refreshLabel] : []),
    `<span class="title-meta">${interestCount} signups${maxLabel}</span>`,
    ...(rankLabel ? [rankLabel] : []),
  ];
  const titleMeta =
    titleMetaParts.length > 0
      ? `<span class="title-meta-group">· ${titleMetaParts.join(" · ")}</span>`
      : "";
  const badgesBlock = badges ? `<span class="title-badges">${badges}</span>` : "";
  const rankControls = showRankControls
    ? `
        <div class="rank-controls">
          <button class="btn btn-muted js-rank-move" data-direction="up" data-type="planungsprojekte" data-id="${safeAttribute(item.id ?? "")}" aria-label="Move up">&#x2191;</button>
          <button class="btn btn-muted js-rank-move" data-direction="down" data-type="planungsprojekte" data-id="${safeAttribute(item.id ?? "")}" aria-label="Move down">&#x2193;</button>
        </div>
      `
    : "";
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
  const isSigned = item.flags.angemeldet;
  const isHidden = Boolean(item.hiddenAt);
  const isSeen = Boolean(item.seenAt);
  const isInterested = Boolean(item.interest?.requestedAt);
  const isLocked = Boolean(item.flags.angemeldet && item.interest?.locked);
  const badges = renderBadges(
    [isSigned ? "Angemeldet" : "", !isSigned && isInterested ? "Waiting" : ""].filter(Boolean),
  );
  const visibilityLabel = renderVisibilityLabel(isHidden);
  const seenButton =
    !isSeen && item.id
      ? `<button class="seen-toggle js-entry-action" data-action="toggleSeen" data-type="wohnungen" data-id="${safeAttribute(item.id)}" aria-label="Mark seen">✓</button>`
      : "";
  const interestButtonLabel = isSigned ? "Remove" : isInterested ? "Drop" : "Interested";
  const interestAction = isSigned ? "remove" : isInterested ? "drop" : "add";
  const interestButtonClass = isSigned ? "btn-danger" : isInterested ? "btn-muted" : "btn-success";
  const interestButton = item.id
    ? `<button class="btn ${interestButtonClass} js-interest-action" data-action="${interestAction}" data-type="wohnungen" data-id="${safeAttribute(item.id)}"${isLocked ? " disabled" : ""}>${interestButtonLabel}</button>`
    : "";
  const lockButton =
    item.id && isSigned
      ? `<button class="btn ${isLocked ? "btn-primary" : "btn-muted"} js-lock-action" data-action="${isLocked ? "unlock" : "lock"}" data-type="wohnungen" data-id="${safeAttribute(item.id)}">${isLocked ? "Locked" : "Lock"}</button>`
      : "";
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
  const refreshLeft = refreshAt ? formatRefreshLeft(refreshAt) : null;
  const refreshLabel = refreshLeft
    ? `<span class="title-meta refresh" data-refresh-at="${safeAttribute(refreshAt)}">refresh ${escapeHtml(refreshLeft)}</span>`
    : "";
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
  const badgesBlock = badges ? `<span class="title-badges">${badges}</span>` : "";
  const rankControls = showRankControls
    ? `
        <div class="rank-controls">
          <button class="btn btn-muted js-rank-move" data-direction="up" data-type="wohnungen" data-id="${safeAttribute(item.id ?? "")}" aria-label="Move up">&#x2191;</button>
          <button class="btn btn-muted js-rank-move" data-direction="down" data-type="wohnungen" data-id="${safeAttribute(item.id ?? "")}" aria-label="Move down">&#x2193;</button>
        </div>
      `
    : "";
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

const renderSubsection = (title: string, type: string, listId: string, items: string[]) => {
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

const buildSections = (state: FlatfinderState) => {
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

  const wohnungen = sortSeenLast(visibleWohnungen).map((item) =>
    renderWohnungRow(item, { showCountdown: true }),
  );
  const planungsprojekte = sortSeenLast(visiblePlanungsprojekte).map((item) =>
    renderPlanungsprojektRow(item, { showCountdown: true }),
  );

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
  ].sort((a, b) => b.hiddenAt.localeCompare(a.hiddenAt));

  const hiddenRows = hiddenItems.map((item) => item.html);
  const hiddenCount = hiddenItems.length;
  const wohnungenCount = wohnungen.length;
  const planungsprojekteCount = planungsprojekte.length;
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

  return {
    hiddenSection: renderHiddenSection(hiddenRows, hiddenCount),
    interestedSection,
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
    hiddenCount,
    wohnungenCount,
    planungsprojekteCount,
  };
};

export const renderFragments = (
  state: FlatfinderState,
  options: RenderOptions,
): RenderFragments => {
  const sections = buildSections(state);
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
    },
  };
};

export const renderPage = (state: FlatfinderState, options: RenderOptions) => {
  const sections = buildSections(state);

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
      <body data-updated-at="${updatedAt}" data-last-scrape-at="${lastScrapeAt}" data-next-refresh="${options.nextRefreshAt}" data-view="root">
        <div class="header">
          <div class="header-row">
            <h1>Flatfinder</h1>
            <div class="status-line">
              Last refresh: <span id="last-refresh" title="${lastScrapeAt || "-"}"></span>, next refresh: <span id="next-refresh"></span>, rate <span id="rate-count">${state.rateLimit.count}</span>/<span id="rate-limit">${rateLimitMonthly}</span>
            </div>
          </div>
          <div class="header-divider"></div>
          <div class="status-actions">
            <button class="btn btn-muted js-view-toggle" data-view="root">New</button>
            <button class="btn btn-muted js-view-toggle" data-view="interested">Interested</button>
            <button class="btn btn-muted js-view-toggle" data-view="hidden">Hidden</button>
          </div>
        </div>

        ${sections.hiddenSection}
        ${sections.interestedSection}
        ${sections.wohnungenSection}
        ${sections.planungsprojekteSection}

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
