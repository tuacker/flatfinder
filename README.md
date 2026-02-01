# Flatfinder

Local scraper + web UI for Wiener Wohnen (Wohnberatung) and Willhaben rentals, with optional Telegram notifications. 100% vibe coded just so you know.

## Setup

```bash
npm install
npx playwright install
```

## Login (save cookies)

Run manual login once:

```bash
npm run scrape:wohnberatung:login
```

This opens a browser window so you can log in. Cookies are stored in
`data/wohnberatung/storageState.json` for reuse.

## Dev (hot reload)

```bash
npm run dev
```

This watches:
- `ui/app.ts` (TypeScript build to `public/app.js`)
- `ui/styles.css` (copied to `public/app.css`)
- `src/server.ts` (auto-restart)

Build failures do not stop the watch process; it resumes once fixed.

## Build UI assets

```bash
npm run build:ui
```

## Run server

```bash
npm run start
```

Open `http://localhost:3000`.

## What it does

- Scrapes Wohnberatung (Wohnungssuche + Planungsprojekte) with saved login cookies.
- Scrapes Willhaben (districts 1–23 by default) without login.
- Stores all state/config in `data/flatfinder.sqlite`.
- Downloads Wohnberatung images to `data/wohnberatung/assets/`.
- Sends Telegram notifications for new items (optional).

## Scheduling + rate limit

Wohnberatung refresh intervals are calculated from the remaining **6000 searches/month** budget and the time left in the current month. Wohnungssuche is scheduled ~3x as often as Planungsprojekte, and the rate is recalculated on every run and on server restart.

Willhaben search runs every **60s**. The **first** run is a full fetch. After that it uses Willhaben’s “last 48 hours” filter **as long as the previous fetch was within 48 hours**. If the server was down longer than 48 hours, the next run falls back to a full fetch. Detail refreshes run **hourly** for active items and every **12h** for hidden/suppressed items.

Wohnungssuche consumes:
- **preview cost** when submitting the saved suchprofil
- **result cost** per list page that has results (gefördert/gemeinde)

Edit defaults in:
- `src/scrapers/wohnberatung/config.ts`
- `src/scrapers/willhaben/config.ts`

## Filters

- Planungsprojekte only **PLZ 1010–1090**.
- Exclude **SPF**, **SMART**, **Superförderung** in titles.
- Exclude Wohnungen with **Superförderung = Ja** in detail view.
- Willhaben auto‑hides entries mentioning **Wohnticket**, **Sozialwohnung**, **Wiener Wohnen**, or **Vormerkschein**.
- Willhaben suppresses listings from **Blueground** (kept in DB but hidden).

Filters live in:
- `src/scrapers/wohnberatung/config.ts`
- `src/scrapers/wohnberatung/filter.ts`
- `src/scrapers/willhaben/willhaben-service.ts`

## Telegram notifications (optional)

Configure in the **Settings** view:
- Bot token + chat ID
- Include images
- Enable actions (requires polling or webhook token)

Telegram config is persisted in the SQLite DB.

## Linting/formatting (oxlint/oxfmt)

```bash
npm run lint
npm run format
npm run format:fix
```

## Data storage

- All state/config lives in `data/flatfinder.sqlite`.
- Wohnberatung login cookies live in `data/wohnberatung/storageState.json`.
- Wohnberatung images are cached in `data/wohnberatung/assets/`.
