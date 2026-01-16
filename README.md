# Flatfinder

Wohnberatung Wien scraper + local web UI.

## Setup

```bash
npm install
npx playwright install
```

No `.env` needed for runtime. Use the manual login script once to save cookies.

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
- `src/ui/app.ts` (TypeScript build to `public/app.js`)
- `src/ui/styles.css` (copied to `public/app.css`)
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

The server:
- uses the saved login cookies
- refreshes wohnungssuche + planungsprojekte on a schedule
- stores state in `data/wohnberatung/state.json`
- downloads images to `data/wohnberatung/assets/`

### Scheduling + rate limit

Defaults keep well below the **6000 searches/month** limit:

- Wohnungssuche every **20 min**
- Planungsprojekte every **60 min**

Wohnungssuche consumes:
- **preview cost** when submitting the saved suchprofil
- **result cost** per list page that has results (gefördert/gemeinde)

Edit the defaults in:

- `src/scrapers/wohnberatung/config.ts`

This file also contains browser settings (headless/manual login timeout) and rate-limit costs.

## Filters

- Planungsprojekte only **PLZ 1010–1090**.
- Exclude **SPF**, **SMART**, **Superförderung** in titles.
- Exclude Wohnungen with **Superförderung = Ja** in detail view.

Filters live in:
- `src/scrapers/wohnberatung/config.ts`
- `src/scrapers/wohnberatung/filter.ts`

## Linting/formatting (oxlint/oxfmt)

```bash
npm run lint
npm run format
npm run format:fix
```
