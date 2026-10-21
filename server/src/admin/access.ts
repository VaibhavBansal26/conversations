/**
 * Who may call each platform-admin route. Same discipline as authz/routePerms.ts: deny by default, and a test requires every route
 * registered under /admin/api to be listed here (and the rate-limit table).
 *   public      sign-in steps (no session yet; strict per-IP limits and lockouts)
 *   any         any active admin: superadmin and support (read-only views)
 *   superadmin  anything that changes state
 */
export type AdminAccess = "public" | "any" | "superadmin";

const GROUPS: [AdminAccess, string[]][] = [
  ["public", ["POST /admin/api/login", "POST /admin/api/mfa/setup", "POST /admin/api/mfa/enable", "POST /admin/api/mfa/verify"]],
  [
    "any",
    [
      "GET /admin/api/me", "GET /admin/api/stats", "GET /admin/api/workspaces", "GET /admin/api/workspaces/:id", "GET /admin/api/audit", "GET /admin/api/ratelimit", "GET /admin/api/admins",
      "POST /admin/api/workspaces/:id/impersonate",
    ],
  ],
  [
    "superadmin",
    [
      "POST /admin/api/workspaces/:id/suspend", "POST /admin/api/workspaces/:id/unsuspend", "POST /admin/api/workspaces/:id/credits", "PUT /admin/api/workspaces/:id/tier", "PUT /admin/api/workspaces/:id/region",
      "POST /admin/api/monitoring/test", "POST /admin/api/ratelimit/:kind", "DELETE /admin/api/ratelimit/:kind/:entity", "POST /admin/api/admins/:id/disable", "POST /admin/api/admins/:id/enable",
    ],
  ],
];

export const ADMIN_ACCESS: ReadonlyMap<string, AdminAccess> = (() => {
  const m = new Map<string, AdminAccess>();
  for (const [a, routes] of GROUPS) for (const r of routes) {
    if (m.has(r)) throw new Error(`admin route ${r} declared twice`);
    m.set(r, a);
  }
  return m;
})();
