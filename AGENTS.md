# Flatfinder agent notes

- Never trigger destructive actions on Wohnberatung pages (e.g. "Kein Interesse mehr") without explicit user confirmation.
- Planungsprojekte filter: PLZ 1010–1090.
- Exclude SPF/SMART/Superförderung for planungsprojekte **and wohnungen** (also exclude wohnungen with Superförderung=Ja in details).
- Respect the 6000 searches/month rate limit for list endpoints (planungsprojekte + wohnungssuche).
- Run `npm run format:fix` and `npm run lint` after code changes.
- Verify the project builds after changes (run the build when appropriate).
- Runtime config lives in `src/scrapers/wohnberatung/config.ts` (no env overrides).
- Do not preserve backwards compatibility unless explicitly requested.

# ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in .agent/PLANS.md) from design to implementation.
