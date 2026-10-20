# Contributing

## Setup

Node >= 22.13 (developed on 24) and npm. No Docker needed: the default stack is SQLite in-process.

```bash
npm run setup     # installs server/ and web/
npm run dev       # API :3000 and web app :5173 (demo data: npm run seed)
```

PostgreSQL and Redis are optional and used to test the scale-out paths: set `TEST_DATABASE_URL=postgres://...` (each test gets its own schema) and `TEST_REDIS_URL=redis://...` before `npm test --prefix server` and the whole server suite runs on them (CI does this with `postgres:17` and `redis:7`). Use a throwaway instance; never point tests at a database you care about.

## Tests

```bash
npm run typecheck && npm test      # server (vitest) and web (vitest + jsdom), includes docs:check
npm run build && npm run e2e       # boots the built server and drives it with real HTTP and sockets
npm run test --prefix server -- tests/rooms.test.ts
```

Write the test with the change. Services are tested directly against in-memory SQLite with a fake clock; HTTP through `app.request()`; realtime with real Socket.IO sockets (`tests/rt-helpers.ts`). See [docs/TESTING.md](docs/TESTING.md). Tests must not touch the network or real providers; billing tests use `FakeBilling`.

## Branches and commits

* Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.
* [Conventional Commits](https://www.conventionalcommits.org/): `feat(billing): ...`, `fix(eventbus): ...`, `docs: ...`, `test: ...`, `refactor: ...`, `chore: ...`. Small commits; each one leaves the tests green.
* The commit that changes behaviour also changes its docs.

## Documentation is part of the change

| If you change... | Update |
| --- | --- |
| a REST route | `server/src/apidoc/meta.ts`, `authz/routePerms.ts`, `ratelimit/routePolicies.ts`, then `npm run docs:api --prefix server` |
| an environment variable | `server/src/config.ts` and `server/src/configMeta.ts`, then `npm run docs:config --prefix server` |
| a socket event | `EVENT_ACCESS`, `EVENT_LIMITS`, `docs/REALTIME.md`, then `npm run docs:realtime --prefix server` |
| a rate-limit policy | `ratelimit/policies.ts`, then `npm run docs:ratelimit --prefix server` |
| a permission | `authz/permissions.ts`, `docs/RBAC.md` |
| the analytics API | `analytics/schemas.ts`, then `npm run docs:analytics-schemas --prefix server` |
| user-visible behaviour | `CHANGELOG.md` under *Unreleased* |
| a significant decision | a new `docs/adr/NNNN-title.md` and its line in `docs/adr/README.md` |
| a new doc file | its row in `docs/README.md` |

`npm run docs:check --prefix server` verifies links and anchors, the docs index, the generated files, Mermaid blocks, route/event/permission coverage and the changelog. It runs in `npm test` and in CI, and the pull-request template has the checklist.

## Database changes

Add a numbered file under `server/src/db/migrations/` (`NNN_name.sql`, or `.sqlite.sql` / `.pg.sql` when dialects differ). Never edit a migration that has been applied. Write portable SQL (see "Portable SQL" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)): positional `?`, 0/1 integers for booleans, no `OFFSET` on large tables, no `COUNT(*)` on hot paths.

## Security

Never commit keys, tokens, `.env` files or real customer data. Report vulnerabilities as described in [docs/SECURITY.md](docs/SECURITY.md).
