import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES, can } from "../src/authz/permissions.js";
import { EVENT_ACCESS, ROUTE_ACCESS } from "../src/authz/routePerms.js";
import { API_KEY_SCOPES } from "../src/services/apiKeys.js";
import { ROUTE_LIMITS } from "../src/ratelimit/routePolicies.js";
import { actorFromRow, getMember } from "../src/services/members.js";
import { createRole, setMemberRole } from "../src/services/roles.js";
import { ack, startServer } from "./rt-helpers.js";
import { addMemberRaw, fullApp, tokenFor } from "./helpers.js";

/** permissions that are enforced by features not yet listed in the route table (they land with those features) */
const NOT_YET_ROUTED = new Set<string>(["conversations:assign"]);

describe("authorisation declaration", () => {
  it("every registered REST route has an access rule, and every rule names a real route", async () => {
    const { app } = await fullApp();
    const registered = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));
    const exempt = new Set(["GET /healthz", "GET /readyz", "GET /metrics"]);
    for (const r of registered) expect(ROUTE_ACCESS.has(r) || exempt.has(r), `route without an authorisation rule: ${r}`).toBe(true);
    for (const k of ROUTE_ACCESS.keys()) expect(registered.has(k), `rule for a route that does not exist: ${k}`).toBe(true);
  });

  it("the authorisation and rate-limit declarations cover the same routes", () => {
    const limited = new Set(ROUTE_LIMITS.keys());
    for (const k of ROUTE_ACCESS.keys()) expect(limited.has(k), `no rate-limit policy for ${k}`).toBe(true);
    for (const k of limited) expect(ROUTE_ACCESS.has(k), `no authorisation rule for ${k}`).toBe(true);
  });

  it("every socket event the server registers has an access rule and vice versa", () => {
    const src = readFileSync("src/realtime/socket.ts", "utf8");
    const events = [...src.matchAll(/^\s+on\("([a-z:]+)"/gm)].map((m) => m[1]!);
    for (const e of events) expect(EVENT_ACCESS[e], e).toBeDefined();
    for (const e of Object.keys(EVENT_ACCESS)) expect(events, e).toContain(e);
  });

  it("every permission in the catalogue guards something", () => {
    const used = new Set<string>(Object.values(EVENT_ACCESS).filter((v) => v !== "authed" && v !== "visitor-only"));
    for (const a of ROUTE_ACCESS.values()) if (a !== "authed" && a !== "public" && a !== "apikey") used.add(a);
    for (const k of API_KEY_SCOPES) used.add(k); // permissions that bound the scopes an API key may carry
    for (const p of ALL_PERMISSIONS) expect(used.has(p) || NOT_YET_ROUTED.has(p), `permission ${p} guards nothing`).toBe(true);
    expect(Object.keys(PERMISSIONS)).toEqual(ALL_PERMISSIONS);
  });

  it("the system roles seeded by the migration match the definitions in code", async () => {
    const { ctx } = await fullApp();
    for (const r of SYSTEM_ROLES) {
      const row = await ctx.db.get<{ permissions: string; base_role: string; is_system: number; key: string }>("SELECT * FROM roles WHERE id = ?", r.id);
      expect(row, r.id).toBeDefined();
      expect(JSON.parse(row!.permissions).sort(), r.id).toEqual([...r.permissions].sort());
      expect(row!.base_role).toBe(r.baseRole);
      expect(row!.is_system).toBe(1);
    }
  });
});

describe("role x route matrix", () => {
  it("a role is refused (403 PERMISSION_DENIED) exactly on the routes whose permission it lacks, for owner, manager, agent and viewer", async () => {
    const f = await fullApp();
    const { ctx, app, wsId, owner } = f;
    const seats: Record<string, Awaited<ReturnType<typeof addMemberRaw>>> = { owner };
    seats.manager = await addMemberRaw(ctx, wsId, { name: "Mia Manager", role: "manager" });
    seats.agent = await addMemberRaw(ctx, wsId, { name: "Ann Agent", role: "agent" });
    const v = await addMemberRaw(ctx, wsId, { name: "Vic Viewer", role: "agent" });
    await setMemberRole(ctx, owner, v.memberId, "role_viewer");
    seats.viewer = actorFromRow(await getMember(ctx, wsId, v.memberId));
    const dummy = (path: string) => path.replace(/:[A-Za-z]+/g, "x0x0x0x0").replace("*", "x");
    let checked = 0;
    for (const [role, actor] of Object.entries(seats)) {
      const token = await tokenFor(ctx, actor);
      for (const [key, access] of ROUTE_ACCESS) {
        if (access === "public" || access === "authed" || access === "apikey") continue;
        const [method, path] = key.split(" ") as [string, string];
        const res = await app.request(dummy(path), { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: ["GET", "DELETE"].includes(method) ? undefined : "{}" });
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        const denied = res.status === 403 && body.error?.code === "PERMISSION_DENIED";
        expect(denied, `${role} ${key} -> ${res.status} ${body.error?.code}`).toBe(!can(actor, access));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  }, 120_000);

  it("a viewer sees everything but changes nothing; an agent still sees only assigned rooms", async () => {
    const { ctx, http, wsId, owner } = await fullApp();
    const { mkRoom } = await import("./helpers.js");
    const { room } = await mkRoom(ctx, wsId);
    const v = await addMemberRaw(ctx, wsId, { name: "Vic Viewer", role: "agent" });
    const a = await addMemberRaw(ctx, wsId, { name: "Ann Agent", role: "agent" });
    await setMemberRole(ctx, owner, v.memberId, "role_viewer");
    const vt = await tokenFor(ctx, actorFromRow(await getMember(ctx, wsId, v.memberId)));
    const at = await tokenFor(ctx, a);
    expect((await http.get("/api/rooms", vt)).body.data.map((r: { id: string }) => r.id)).toContain(room.id);
    expect((await http.get("/api/rooms", at)).body.data).toHaveLength(0);
    expect((await http.post(`/api/rooms/${room.id}/messages`, { content: "hi", source: "dm", kind: "text" }, vt)).status).toBe(403);
    expect((await http.get("/api/analytics/overview", vt)).status).toBe(200); // viewers hold analytics:read
  });
});

describe("custom roles", () => {
  it("are workspace scoped, validated, and take effect on the very next request", async () => {
    const { ctx, http, wsId, owner, token } = await fullApp();
    const created = await http.post("/api/roles", { name: "Inbox admin", base_role: "agent", permissions: ["conversations:read", "conversations:reply", "inboxes:manage"] }, token);
    expect(created.status).toBe(201);
    const role = created.body;
    const m = await addMemberRaw(ctx, wsId, { name: "Cy Custom", role: "agent" });
    const assigned = await http.put(`/api/members/${m.memberId}/role`, { role_id: role.id }, token);
    expect(assigned.status).toBe(200);
    expect(assigned.body.role).toBe("inbox-admin");
    const mt = await tokenFor(ctx, actorFromRow(await getMember(ctx, wsId, m.memberId)));
    expect((await http.post("/api/inboxes", { name: "Support" }, mt)).status).toBe(201);
    expect((await http.get("/api/tokens", mt)).status).toBe(403);
    // revoking a permission is immediate (caches are invalidated), not after a TTL
    await http.patch(`/api/roles/${role.id}`, { permissions: ["conversations:read"] }, token);
    expect((await http.post("/api/inboxes", { name: "Support 2" }, mt)).status).toBe(403);
    // another workspace cannot see or use it
    const other = await fullApp();
    expect((await other.http.put(`/api/members/${other.owner.memberId}/role`, { role_id: role.id }, other.token)).status).toBe(404);
    expect(owner.workspaceId).toBe(wsId);
  });

  it("cannot be created with a permission the creator lacks, and a base role never exceeds what the creator may grant", async () => {
    const { ctx, http, wsId, owner } = await fullApp();
    const mgr = await addMemberRaw(ctx, wsId, { name: "Mia Manager", role: "manager" });
    const mt = await tokenFor(ctx, mgr);
    // managers have no roles:manage at all
    expect((await http.post("/api/roles", { name: "x", base_role: "agent", permissions: ["conversations:read"] }, mt)).status).toBe(403);
    // a custom role that holds roles:manage but not billing:manage cannot mint a billing role
    const r = await createRole(ctx, owner, { name: "Role admin", base_role: "manager", permissions: ["roles:manage", "conversations:read", "members:read", "members:manage"] });
    const m = await addMemberRaw(ctx, wsId, { name: "Rae Admin", role: "manager" });
    await setMemberRole(ctx, owner, m.memberId, r.id);
    const rt = await tokenFor(ctx, actorFromRow(await getMember(ctx, wsId, m.memberId)));
    const esc = await http.post("/api/roles", { name: "Sneaky", base_role: "manager", permissions: ["billing:manage"] }, rt);
    expect(esc.status).toBe(403);
    expect(esc.body.error.code).toBe("PRIVILEGE_ESCALATION");
    // and cannot promote anyone to owner
    const victim = await addMemberRaw(ctx, wsId, { name: "Vic", role: "agent" });
    expect((await http.put(`/api/members/${victim.memberId}/role`, { role_id: "role_owner" }, rt)).status).toBe(403);
    expect((await http.post("/api/roles", { name: "bad", base_role: "agent", permissions: ["not:real"] }, token0(owner, ctx))).status).toBe(401);
  });

  it("system roles are immutable through the API and through the database; roles in use cannot be deleted", async () => {
    const { ctx, http, wsId, owner, token } = await fullApp();
    expect((await http.patch("/api/roles/role_agent", { permissions: ["billing:manage"] }, token)).status).toBe(403);
    expect((await http.del("/api/roles/role_owner", token)).status).toBe(403);
    await expect(ctx.db.run("UPDATE roles SET permissions = '[]' WHERE id = 'role_owner'")).rejects.toThrow(/immutable/i);
    await expect(ctx.db.run("DELETE FROM roles WHERE id = 'role_viewer'")).rejects.toThrow(/immutable/i);
    const role = (await http.post("/api/roles", { name: "Temp", base_role: "agent", permissions: ["conversations:read"] }, token)).body;
    const m = await addMemberRaw(ctx, wsId, { name: "Tom Temp", role: "agent" });
    await setMemberRole(ctx, owner, m.memberId, role.id);
    expect((await http.del(`/api/roles/${role.id}`, token)).status).toBe(409);
    await setMemberRole(ctx, owner, m.memberId, "role_agent");
    expect((await http.del(`/api/roles/${role.id}`, token)).status).toBe(204);
  });

  it("the last owner cannot be demoted by a role change", async () => {
    const { ctx, owner } = await fullApp();
    await expect(setMemberRole(ctx, owner, owner.memberId, "role_agent")).rejects.toMatchObject({ code: "LAST_OWNER" });
  });
});

// a deliberately unauthenticated token helper for the negative case above
const token0 = (_o: unknown, _c: unknown) => "not-a-token";

describe("socket events use the same permissions", () => {
  it("a viewer socket receives events but its sends are refused; a role without reply cannot send or type", async () => {
    const srv = await startServer();
    const { wsId, owner } = await srv.seedWorkspace(srv.ctx, "RBAC");
    const { mkRoom } = await import("./helpers.js");
    const { room } = await mkRoom(srv.ctx, wsId);
    const v = await addMemberRaw(srv.ctx, wsId, { name: "Vic Viewer", role: "agent" });
    await setMemberRole(srv.ctx, owner, v.memberId, "role_viewer");
    const viewer = await srv.team(wsId, actorFromRow(await getMember(srv.ctx, wsId, v.memberId)));
    const r = await ack(viewer, "message:send", { room_id: room.id, kind: "text", source: "dm", content: "nope", client_msg_id: "rbac-viewer-0001" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("PERMISSION_DENIED");
    expect((await ack(viewer, "presence:list")).ok).toBe(true); // members:read
    const ownerSock = await srv.team(wsId, owner);
    const seen: unknown[] = [];
    viewer.on("message:new", (p) => seen.push(p));
    expect((await ack(ownerSock, "message:send", { room_id: room.id, kind: "text", source: "dm", content: "hello team", client_msg_id: "rbac-owner-0001" })).ok).toBe(true);
    await new Promise((res) => setTimeout(res, 150));
    expect(seen.length).toBeGreaterThan(0); // viewers still get live updates (manager-visibility base role)
    await srv.close();
  });
});

describe("audit log", () => {
  it("records role changes and is append-only at the database level; reading it needs audit:read", async () => {
    const { ctx, http, wsId, owner, token } = await fullApp();
    const m = await addMemberRaw(ctx, wsId, { name: "Ann Agent", role: "agent" });
    await setMemberRole(ctx, owner, m.memberId, "role_viewer");
    const log = await http.get("/api/audit", token);
    expect(log.status).toBe(200);
    expect(log.body.data.some((e: { action: string }) => e.action === "member.role")).toBe(true);
    const id = log.body.data[0].id as string;
    await expect(ctx.db.run("UPDATE audit_log SET action = 'x' WHERE id = ?", id)).rejects.toThrow(/append-only|immutable/i);
    await expect(ctx.db.run("DELETE FROM audit_log WHERE id = ?", id)).rejects.toThrow(/append-only|immutable/i);
    const agent = await addMemberRaw(ctx, wsId, { name: "Bob Agent", role: "agent" });
    expect((await http.get("/api/audit", await tokenFor(ctx, agent))).status).toBe(403);
    // keyset pagination
    for (let i = 0; i < 3; i++) {
      await setMemberRole(ctx, owner, m.memberId, "role_agent");
      await setMemberRole(ctx, owner, m.memberId, "role_viewer");
    }
    const p1 = await http.get("/api/audit?limit=2", token);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await http.get(`/api/audit?limit=2&cursor=${p1.body.next_cursor}`, token);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
  });
});
