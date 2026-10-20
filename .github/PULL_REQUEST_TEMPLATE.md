## What and why

<!-- One or two sentences. Link the issue or decision record if there is one. -->

## Checklist

- [ ] Tests added or updated; `npm run typecheck && npm test` pass (the server suite on SQLite; PostgreSQL + Redis in CI)
- [ ] **Docs updated in this PR** (see the table in CONTRIBUTING.md): README/docs for the feature, `CHANGELOG.md` under *Unreleased*
- [ ] New or changed route: entry in `server/src/apidoc/meta.ts`, rule in `authz/routePerms.ts`, decision in `ratelimit/routePolicies.ts`, then `npm run docs:api --prefix server`
- [ ] New or changed environment variable: entry in `server/src/configMeta.ts`, then `npm run docs:config --prefix server`
- [ ] New socket event: `EVENT_ACCESS`, `EVENT_LIMITS`, `docs/REALTIME.md`
- [ ] Schema change: a new numbered migration (never edit an applied one), works on SQLite and PostgreSQL
- [ ] `npm run docs:check --prefix server` passes
- [ ] No secrets, keys or customer data in the diff, logs or fixtures
- [ ] Significant decision? Added an ADR under `docs/adr/`
