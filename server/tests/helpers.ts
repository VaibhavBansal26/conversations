import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createContext, type ContextOverrides } from "../src/app-context.js";
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

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig(
    {
      NODE_ENV: "test", JWT_SECRET: "test-secret-test-secret-test-secret", DATABASE_PATH: ":memory:", DATA_DIR: mkdtempSync(join(tmpdir(), "conv-test-")),
      LOG_LEVEL: "silent", PUBLIC_URL: "http://localhost:3000", SEND_RETRY_BASE_SECONDS: "10", SEND_RETRY_CAP_SECONDS: "100", SEND_RETRY_MAX_ATTEMPTS: "4", ...env,
    },
    () => {},
  );
}

export function makeCtx(env: Record<string, string> = {}, over: ContextOverrides = {}): TestCtx {
  const clockCtl = new TestClock();
  const ctx = createContext(testConfig(env), {
    log: silentLogger, bus: new RecordingBus(), sms: new FakeSmsProvider(), email: new FakeEmailProvider(), ai: new HeuristicProvider(), ...over,
  }) as TestCtx;
  ctx.clock = clockCtl.now;
  ctx.clockCtl = clockCtl;
  return ctx;
}

let pwHash: string | undefined;

/** Insert a user+member directly (scrypt is slow; one shared hash keeps tests fast). */
export async function addMemberRaw(ctx: AppContext, workspaceId: string, o: { name?: string; role?: Role; email?: string; inbox_visibility?: "assigned" | "assigned_inbox"; live_seat?: boolean } = {}): Promise<Actor> {
  pwHash ??= await hashPassword("password123");
  const uid = newId("usr");
  const mid = newId("mem");
  const name = o.name ?? "Agent";
  ctx.db.run("INSERT INTO users(id, email, password_hash, name, created_at) VALUES (?,?,?,?,?)", uid, o.email ?? `${name.toLowerCase().replace(/\W+/g, "")}.${uid.slice(-6)}@example.test`, pwHash, name, ctx.clock().toISOString());
  ctx.db.run("INSERT INTO members(id, workspace_id, user_id, role, live_seat, inbox_visibility, created_at) VALUES (?,?,?,?,?,?,?)", mid, workspaceId, uid, o.role ?? "agent", o.live_seat ?? true, o.inbox_visibility ?? "assigned_inbox", ctx.clock().toISOString());
  return actorFromRow(getMember(ctx, workspaceId, mid));
}

export async function seedWorkspace(ctx: AppContext, name = "Acme") {
  const wsId = newId("ws");
  ctx.db.run("INSERT INTO workspaces(id, name, settings, created_at) VALUES (?,?,?,?)", wsId, name, "{}", ctx.clock().toISOString());
  const owner = await addMemberRaw(ctx, wsId, { name: "Olivia Owner", role: "owner", email: `owner.${wsId.slice(-6)}@example.test` });
  return { wsId, owner };
}

export const setSettings = (ctx: AppContext, wsId: string, patch: Record<string, unknown>) => {
  const cur = JSON.parse(ctx.db.get<{ settings: string }>("SELECT settings FROM workspaces WHERE id = ?", wsId)!.settings);
  ctx.db.run("UPDATE workspaces SET settings = ? WHERE id = ?", JSON.stringify({ ...cur, ...patch }), wsId);
};

export function addSmsNumberRaw(ctx: AppContext, wsId: string, e164: string, isDefault = false) {
  ctx.db.run("INSERT INTO sms_numbers(id, workspace_id, e164, label, is_default, created_at) VALUES (?,?,?,?,?,?)", newId("num"), wsId, e164, "", isDefault, ctx.clock().toISOString());
}
export function addSenderRaw(ctx: AppContext, wsId: string, address: string, verified = true, isDefault = false) {
  ctx.db.run("INSERT INTO email_senders(id, workspace_id, address, display_name, verified, is_default, created_at) VALUES (?,?,?,?,?,?,?)", newId("snd"), wsId, address, "Support", verified, isDefault, ctx.clock().toISOString());
}
export function addInboundAddressRaw(ctx: AppContext, wsId: string, address: string) {
  ctx.db.run("INSERT INTO inbound_addresses(address, workspace_id, created_at) VALUES (?,?,?)", address, wsId, ctx.clock().toISOString());
}

export const mkContact = (ctx: AppContext, wsId: string, input: ContactInput = {}) =>
  createContact(ctx, wsId, { name: "Casey Customer", ...(input.email === undefined && input.phone === undefined ? { email: `casey.${newId("x").slice(-8)}@example.test` } : {}), ...input });

export async function tokenFor(ctx: AppContext, a: Actor): Promise<string> {
  return signAccessToken(ctx, a);
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export function client(app: Hono) {
  async function call<T = any>(method: string, path: string, opts: { token?: string; json?: unknown; headers?: Record<string, string>; form?: FormData; raw?: string } = {}): Promise<Res<T>> {
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
  const ctx = makeCtx(env);
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
export function mkRoom(ctx: AppContext, wsId: string, o: { contact?: ContactInput; inboxId?: string | null; assignees?: Actor[] } = {}) {
  const contact = mkContact(ctx, wsId, o.contact);
  const { room } = findOrCreateRoom(ctx, wsId, { contactId: contact.id, inboxId: o.inboxId ?? null });
  if (o.assignees?.length) setAssignees(ctx, room, o.assignees.map((a) => a.memberId), "Test");
  return { contact, room: getRoomRow(ctx, wsId, room.id) };
}

export function contactSays(ctx: AppContext, room: RoomRow, text: string, source: "dm" | "sms" | "email" = "dm", extra: { clientMsgId?: string } = {}): MessageRow {
  return insertMessage(ctx, {
    workspaceId: room.workspace_id, roomId: room.id, senderType: "contact", senderId: room.contact_id, senderName: "Contact", kind: "text", source,
    content: text, contentText: text, clientMsgId: extra.clientMsgId ?? null,
  }).message;
}

export async function agentSays(ctx: AppContext, actor: Actor, roomId: string, text: string, extra: Partial<SendInput> = {}): Promise<MessageRow> {
  return (await sendAgentMessage(ctx, actor, roomId, { kind: "text", source: "dm", content: text, ...extra })).message;
}

export const mkInbox = (ctx: AppContext, owner: Actor, input: Partial<InboxInput> & { name?: string } = {}) =>
  createInbox(ctx, owner, { name: "Support", ...input });

export const roomRow = (ctx: AppContext, id: string) => ctx.db.get<RoomRow>("SELECT * FROM rooms WHERE id = ?", id)!;
export const messagesOf = (ctx: AppContext, roomId: string) => ctx.db.all<MessageRow>("SELECT * FROM messages WHERE room_id = ? ORDER BY seq", roomId);
