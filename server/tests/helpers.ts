import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import pg from "pg";
import { afterEach } from "vitest";
import { closeContext, createContext, type ContextOverrides } from "../src/app-context.js";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { HeuristicProvider } from "../src/ai/heuristic.js";
import type { Actor, Role } from "../src/domain/types.js";
import { silentLogger } from "../src/logger.js";
import { FakeEmailProvider, FakeSmsProvider } from "../src/providers/fake.js";
import { RecordingBus } from "../src/realtime/bus.js";
import { signAccessToken } from "../src/services/auth.js";
import { createContact, type ContactInput } from "../src/services/contacts.js";
import { actorFromRow, getMember } from "../src/services/members.js";
import { hashPassword } from "../src/util/crypto.js";
import { newId } from "../src/util/ids.js";

export class TestClock {
  constructor(public t = Date.parse("2026-03-02T10:00:00.000Z")) {}
  now = (): Date => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
  set(iso: string) {
    this.t = Date.parse(iso);
  }
}

export interface TestCtx extends AppContext {
  bus: RecordingBus;
  sms: FakeSmsProvider;
  email: FakeEmailProvider;
  clockCtl: TestClock;
}

const tracked: { ctx: AppContext; schema?: string }[] = [];

/**
 * With TEST_DATABASE_URL every context gets its own schema in that PostgreSQL database, so tests stay independent
 * exactly as they are with a fresh `:memory:` SQLite database.
 */
export async function isolatedDbEnv(env: Record<string, string>): Promise<{ env: Record<string, string>; schema?: string }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || env.DATABASE_URL) return { env };
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return { env: { ...env, DATABASE_URL: u.toString(), DATABASE_POOL_MAX: "4" }, schema };
}

export function trackCtx(ctx: AppContext, schema?: string) {
  tracked.push({ ctx, schema });
}

/** Drop a schema created by isolatedDbEnv (used by helpers that own a long-lived context). */
export async function dropSchema(schema?: string) {
  if (!schema || !process.env.TEST_DATABASE_URL) return;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin.end();
}

afterEach(async () => {
  const admin = process.env.TEST_DATABASE_URL ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;
  await admin?.connect();
  for (const t of tracked.splice(0)) {
    await closeContext(t.ctx).catch(() => {});
    if (t.schema) await admin?.query(`DROP SCHEMA IF EXISTS ${t.schema} CASCADE`).catch(() => {});
  }
  await admin?.end();
});

export function testConfig(env: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "conv-test-"));
  return loadConfig(
    {
      // WEB_DIST points nowhere so tests never depend on whether the web app happens to be built
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-test-secret-test-secret",
      DATABASE_PATH: ":memory:",
      DATA_DIR: dir,
      WEB_DIST: join(dir, "no-web-build"),
      LOG_LEVEL: "silent",
      CACHE_TTL_MS: "0",
      // with TEST_REDIS the whole suite also runs on the Redis paths (limiter, presence, locks, cache invalidation); each context gets its own key prefix
      ...(process.env.TEST_REDIS_URL ? { REDIS_URL: process.env.TEST_REDIS_URL, REDIS_PREFIX: `t${randomBytes(4).toString("hex")}`, JOB_QUEUE: "db" } : {}),
      PUBLIC_URL: "http://localhost:3000",
      SEND_PACING: "false",
      SEND_RETRY_BASE_SECONDS: "10",
      SEND_RETRY_CAP_SECONDS: "100",
      SEND_RETRY_MAX_ATTEMPTS: "4",
      ...env,
    },
    () => {},
  );
}

export async function makeCtx(env: Record<string, string> = {}, over: ContextOverrides = {}): Promise<TestCtx> {
  const clockCtl = new TestClock();
  const iso = await isolatedDbEnv(env);
  const ctx = (await createContext(testConfig(iso.env), {
    log: silentLogger,
    bus: new RecordingBus(),
    sms: new FakeSmsProvider(),
    email: new FakeEmailProvider(),
    ai: new HeuristicProvider(),
    ...over,
  })) as TestCtx;
  trackCtx(ctx, iso.schema);
  ctx.clock = clockCtl.now;
  ctx.clockCtl = clockCtl;
  return ctx;
}

let pwHash: string | undefined;

/** Insert a user+member directly (scrypt is slow; one shared hash keeps tests fast). */
export async function addMemberRaw(
  ctx: AppContext,
  workspaceId: string,
  o: { name?: string; role?: Role; email?: string; inbox_visibility?: "assigned" | "assigned_inbox"; live_seat?: boolean } = {},
): Promise<Actor> {
  pwHash ??= await hashPassword("password123");
  const uid = newId("usr");
  const mid = newId("mem");
  const name = o.name ?? "Agent";
  await ctx.db.run(
    "INSERT INTO users(id, email, password_hash, name, created_at) VALUES (?,?,?,?,?)",
    uid,
    o.email ?? `${name.toLowerCase().replace(/\W+/g, "")}.${uid.slice(-6)}@example.test`,
    pwHash,
    name,
    ctx.clock().toISOString(),
  );
  await ctx.db.run(
    "INSERT INTO members(id, workspace_id, user_id, role, live_seat, inbox_visibility, created_at) VALUES (?,?,?,?,?,?,?)",
    mid,
    workspaceId,
    uid,
    o.role ?? "agent",
    o.live_seat ?? true,
    o.inbox_visibility ?? "assigned_inbox",
    ctx.clock().toISOString(),
  );
  return actorFromRow(await getMember(ctx, workspaceId, mid));
}

export async function seedWorkspace(ctx: AppContext, name = "Acme") {
  const wsId = newId("ws");
  await ctx.db.run("INSERT INTO workspaces(id, name, settings, created_at) VALUES (?,?,?,?)", wsId, name, "{}", ctx.clock().toISOString());
  const owner = await addMemberRaw(ctx, wsId, { name: "Olivia Owner", role: "owner", email: `owner.${wsId.slice(-6)}@example.test` });
  return { wsId, owner };
}

export const setSettings = async (ctx: AppContext, wsId: string, patch: Record<string, unknown>) => {
  const cur = JSON.parse((await ctx.db.get<{ settings: string }>("SELECT settings FROM workspaces WHERE id = ?", wsId))!.settings);
  await ctx.db.run("UPDATE workspaces SET settings = ? WHERE id = ?", JSON.stringify({ ...cur, ...patch }), wsId);
};

export async function addSmsNumberRaw(ctx: AppContext, wsId: string, e164: string, isDefault = false) {
  await ctx.db.run(
    "INSERT INTO sms_numbers(id, workspace_id, e164, label, is_default, created_at) VALUES (?,?,?,?,?,?)",
    newId("num"),
    wsId,
    e164,
    "",
    isDefault,
    ctx.clock().toISOString(),
  );
}
export async function addSenderRaw(ctx: AppContext, wsId: string, address: string, verified = true, isDefault = false) {
  await ctx.db.run(
    "INSERT INTO email_senders(id, workspace_id, address, display_name, verified, is_default, created_at) VALUES (?,?,?,?,?,?,?)",
    newId("snd"),
    wsId,
    address,
    "Support",
    verified,
    isDefault,
    ctx.clock().toISOString(),
  );
}
export async function addInboundAddressRaw(ctx: AppContext, wsId: string, address: string) {
  await ctx.db.run("INSERT INTO inbound_addresses(address, workspace_id, created_at) VALUES (?,?,?)", address, wsId, ctx.clock().toISOString());
}

export const mkContact = (ctx: AppContext, wsId: string, input: ContactInput = {}) =>
  createContact(ctx, wsId, {
    name: "Casey Customer",
    ...(input.email === undefined && input.phone === undefined ? { email: `casey.${newId("x").slice(-8)}@example.test` } : {}),
    ...input,
  });

export async function tokenFor(ctx: AppContext, a: Actor): Promise<string> {
  return await signAccessToken(ctx, a);
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export function client(app: Hono) {
  async function call<T = any>(
    method: string,
    path: string,
    opts: { token?: string; json?: unknown; headers?: Record<string, string>; form?: FormData; raw?: string } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) body = opts.form;
    else if (opts.raw !== undefined) body = opts.raw;
    const res = await app.request(path, { method, headers, body });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-json */
    }
    return { status: res.status, body: parsed };
  }
  return {
    call,
    get: <T = any>(p: string, token?: string, headers?: Record<string, string>) => call<T>("GET", p, { token, headers }),
    post: <T = any>(p: string, json: unknown, token?: string, headers?: Record<string, string>) => call<T>("POST", p, { token, json, headers }),
    patch: <T = any>(p: string, json: unknown, token?: string) => call<T>("PATCH", p, { token, json }),
    put: <T = any>(p: string, json: unknown, token?: string) => call<T>("PUT", p, { token, json }),
    del: <T = any>(p: string, token?: string) => call<T>("DELETE", p, { token }),
  };
}

export async function fullApp(env: Record<string, string> = {}) {
  const ctx = await makeCtx(env);
  const app = createApp(ctx);
  const ws = await seedWorkspace(ctx);
  const token = await tokenFor(ctx, ws.owner);
  return { ctx, app, http: client(app), ...ws, token };
}

/** Create a room for a contact, optionally inside an inbox, returning rows. */
export { newId };

import { insertMessage, type MessageRow } from "../src/services/messageStore.js";
import { createInbox, type InboxInput } from "../src/services/inboxes.js";
import { findOrCreateRoom, setAssignees } from "../src/services/rooms.js";
import { getRoomRow, type RoomRow } from "../src/services/roomStore.js";
import { sendAgentMessage, type SendInput } from "../src/services/messages.js";

/** A contact plus their (single) room. */
export async function mkRoom(ctx: AppContext, wsId: string, o: { contact?: ContactInput; inboxId?: string | null; assignees?: Actor[] } = {}) {
  const contact = await mkContact(ctx, wsId, o.contact);
  const { room } = await findOrCreateRoom(ctx, wsId, { contactId: contact.id, inboxId: o.inboxId ?? null });
  if (o.assignees?.length)
    await setAssignees(
      ctx,
      room,
      o.assignees.map((a) => a.memberId),
      "Test",
    );
  return { contact, room: await getRoomRow(ctx, wsId, room.id) };
}

export async function contactSays(
  ctx: AppContext,
  room: RoomRow,
  text: string,
  source: "dm" | "sms" | "email" = "dm",
  extra: { clientMsgId?: string } = {},
): Promise<MessageRow> {
  return (
    await insertMessage(ctx, {
      workspaceId: room.workspace_id,
      roomId: room.id,
      senderType: "contact",
      senderId: room.contact_id,
      senderName: "Contact",
      kind: "text",
      source,
      content: text,
      contentText: text,
      clientMsgId: extra.clientMsgId ?? null,
    })
  ).message;
}

export async function agentSays(ctx: AppContext, actor: Actor, roomId: string, text: string, extra: Partial<SendInput> = {}): Promise<MessageRow> {
  return (await sendAgentMessage(ctx, actor, roomId, { kind: "text", source: "dm", content: text, ...extra })).message;
}

export const mkInbox = (ctx: AppContext, owner: Actor, input: Partial<InboxInput> & { name?: string } = {}) => createInbox(ctx, owner, { name: "Support", ...input });

export const roomRow = async (ctx: AppContext, id: string) => (await ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ?", id))!;
export const messagesOf = (ctx: AppContext, roomId: string) => ctx.db.all<MessageRow>("SELECT * FROM messages WHERE room_id = ? ORDER BY seq", roomId);
