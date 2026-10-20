import type { Context } from "hono";
import type { Actor } from "../domain/types.js";
import { AppError } from "../errors.js";
import { specFor } from "../ratelimit/http.js";
import { can, type Permission } from "./permissions.js";
import { ROUTE_ACCESS } from "./routePerms.js";

export class PermissionDenied extends AppError {
  constructor(readonly permission: string) {
    super(403, "PERMISSION_DENIED", `Your role does not allow this action (${permission})`, { permission });
    this.name = "PermissionDenied";
  }
}

/** Throws unless the actor holds `p`. For service-level checks that depend on the target (the route-level check is automatic). */
export function requirePermission(actor: Actor, p: Permission): void {
  if (!can(actor, p)) throw new PermissionDenied(p);
}

/**
 * Route-level authorisation from the central declaration (routePerms.ts). Called by the auth middleware once the seat is known.
 * Deny by default: a route with no declaration is refused.
 */
export function authorizeRoute(c: Context, actor: Actor): void {
  // no handler matched: the router answers 404 next, there is nothing to authorise
  if (!c.req.matchedRoutes.some((r) => r.method !== "ALL" && r.path !== "/*" && r.path !== "*")) return;
  const { key } = specFor(c);
  const access = ROUTE_ACCESS.get(key);
  if (access === undefined) throw new AppError(403, "NO_POLICY", "This route has no authorisation policy");
  if (access === "authed" || access === "public" || access === "apikey") return;
  if (!can(actor, access)) throw new PermissionDenied(access);
}
