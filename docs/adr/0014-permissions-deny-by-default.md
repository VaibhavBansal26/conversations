# 0014. Permission-based access control, declared in one table, deny by default

Status: accepted

## Context

The first version had three roles checked by ad-hoc `requireManager` calls. Custom roles, API keys, operators and a read-only support token all need finer, consistent rules, and the legacy product's scattered scope strings were a source of gaps (socket handlers that did not re-check scope).

## Decision

Permissions are strings (`resource:action`); a role is a set of them; one function `can()` decides. Every REST route and socket event is listed in one table (`authz/routePerms.ts`) with the permission it needs, or one of `authed`, `public`, `apikey`, `platform`. A route missing from the table is refused (`NO_POLICY`) and a test fails the build. Built-in roles are immutable (API and database triggers). Nobody can grant a permission they lack. The seat and role are re-read on every request and socket event.

## Alternatives

* Role names checked inline: cannot express custom roles and drifts.
* An external policy engine: heavier than needed; the table plus a role-by-route matrix test gives the same assurance.

## Consequences

Adding a route means three declarations (access, rate limit, API doc) and tests enforce all three. Permission changes take effect immediately because nothing is cached beyond `CACHE_TTL_MS` and the cache is invalidated across nodes.
