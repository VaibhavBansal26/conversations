// End-to-end proof against the BUILT server (dist/index.js) with real HTTP and real Socket.IO clients.
//   npm run build && node scripts/e2e.mjs
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const freePort = () => new Promise((res) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "conv-e2e-"));
const TWILIO_TOKEN = "e2e-twilio-token";
const env = {
  ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1", JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-1234", DATABASE_PATH: join(dataDir, "e2e.db"), DATA_DIR: dataDir,
  PUBLIC_URL: base, TWILIO_AUTH_TOKEN: TWILIO_TOKEN, WEBHOOK_SHARED_SECRET: "e2e-hook-secret", LOG_LEVEL: "warn",
};
const server = spawn(process.execPath, [join(root, "dist/index.js")], { env, stdio: ["ignore", "inherit", "inherit"] });
let failed = false;
const step = (name) => console.log(`\n• ${name}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  ok(msg);
}

async function http(method, path, { token, json, headers = {}, form } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (json !== undefined) h["content-type"] = "application/json";
  if (form) h["content-type"] = "application/x-www-form-urlencoded";
  const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, headers: res.headers };
}

const waitFor = (socket, event, pred = () => true, ms = 5000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); socket.off(event, h); resolve(p); } };
  socket.on(event, h);
});
const ack = (socket, event, payload) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 5000);
  socket.emit(event, payload, (r) => { clearTimeout(t); resolve(r); });
});
const connect = (ns, auth, extraHeaders = {}) => new Promise((resolve, reject) => {
  const s = io(`${base}/ws/${ns}`, { auth, transports: ["websocket"], reconnection: false, extraHeaders });
  s.once("connect", () => resolve(s));
  s.once("connect_error", (e) => reject(e));
});

async function main() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error("server did not become healthy");
  }
  step("server is up");
  assert((await http("GET", "/readyz")).body.status === "ready", "GET /readyz is ready");

  step("register an owner and set up the workspace");
  const reg = await http("POST", "/api/auth/register", { json: { email: "e2e@example.test", password: "e2e-password-1", name: "Eve Owner", workspace_name: "E2E Co" } });
  assert(reg.status === 201, "registered (201)");
  const token = reg.body.token;
  const wsId = reg.body.workspace.id;
  const inbox = await http("POST", "/api/inboxes", { token, json: { name: "Support", algorithm: "round_robin", member_ids: [reg.body.member.id], default_sms_inbound: true, live_routing_visibility: true } });
  assert(inbox.status === 201, "created a round-robin inbox");
  const contact = await http("POST", "/api/contacts", { token, json: { name: "Casey Customer", email: "casey@example.test" } });
  assert(contact.status === 201, "created a contact");
  const number = await http("POST", "/api/sms-numbers", { token, json: { e164: "+14155550100" } });
  assert(number.status === 201, "registered an SMS number");
  await http("PATCH", "/api/workspace", { token, json: { settings: { widget: { default_inbox_id: inbox.body.id } } } });
  const tok = await http("POST", "/api/tokens", { token, json: { domain: `127.0.0.1:${port}` } });
  assert(tok.status === 201 && tok.body.token.startsWith("cvt_"), "created an embed token for this origin");

  step("the widget script is served");
  const js = await fetch(`${base}/widget.js`);
  assert(js.status === 200 && (await js.text()).includes("ConversationsWidget"), "GET /widget.js");

  step("visitor session (origin-checked) and chat room");
  const origin = base;
  const device = "e2e-device-0001";
  const vh = { "x-api-key": tok.body.token, origin, "x-device-id": device };
  const bad = await http("POST", "/public/sessions", { json: {}, headers: { ...vh, origin: "https://evil.example.org" } });
  assert(bad.status === 403, "a foreign Origin is rejected for the embed token");
  const cfg = await http("GET", "/public/widget/config", { headers: vh });
  assert(cfg.status === 200 && cfg.body.workspace_id === wsId, "widget config loads");
  const sess = await http("POST", "/public/sessions", { json: { name: "Vera Visitor" }, headers: vh });
  assert(sess.status === 201 && sess.body.workspace_id === wsId, "visitor session created");

  step("realtime: agent and visitor sockets");
  const agent = await connect(wsId, { token });
  const visitor = await connect(wsId, { session: sess.body.session_token, deviceId: device }, { origin });
  assert(agent.connected && visitor.connected, "both sockets connected to /ws/<workspaceId>");
  const stranger = await http("POST", "/api/auth/register", { json: { email: "other@example.test", password: "e2e-password-1", name: "Other", workspace_name: "Other Co" } });
  let crossTenantRejected = false;
  try { await connect(stranger.body.workspace.id, { session: sess.body.session_token, deviceId: device }, { origin }); } catch { crossTenantRejected = true; }
  assert(crossTenantRejected, "visitor session is rejected on another workspace's namespace");

  const room = await ack(visitor, "room:create", {});
  assert(room.ok && room.created, "visitor opened a conversation");
  const roomId = room.room.id;
  await new Promise((r) => setTimeout(r, 150));

  step("visitor message -> agent receives via socket");
  const atAgent = waitFor(agent, "message:new", (p) => p.message.content === "Hello, I need help with my order");
  const sent = await ack(visitor, "message:send", { room_id: roomId, kind: "text", source: "dm", content: "Hello, I need help with my order", client_msg_id: "e2e-visitor-msg-1" });
  assert(sent.ok && sent.message.client_msg_id === "e2e-visitor-msg-1", "visitor message acked");
  const gotMsg = await atAgent;
  assert(gotMsg.message.sender.type === "contact", "agent received message:new from the contact");
  const dup = await ack(visitor, "message:send", { room_id: roomId, kind: "text", source: "dm", content: "Hello, I need help with my order", client_msg_id: "e2e-visitor-msg-1" });
  assert(dup.ok && dup.created === false && dup.message.id === sent.message.id, "duplicate client_msg_id returns the original (idempotent)");

  step("agent reply -> visitor receives via socket");
  const atVisitor = waitFor(visitor, "message:new", (p) => p.message.content === "Hi Vera, happy to help!");
  const reply = await ack(agent, "message:send", { room_id: roomId, kind: "text", source: "dm", content: "Hi Vera, happy to help!", client_msg_id: "e2e-agent-msg-1" });
  assert(reply.ok, "agent reply acked");
  const gotReply = await atVisitor;
  assert(gotReply.message.sender.type === "agent", "visitor received the agent's reply");

  step("read receipts");
  const receiptAtAgent = waitFor(agent, "message:receipt", (p) => p.reader.type === "contact");
  await ack(visitor, "message:read", { room_id: roomId, message_id: gotReply.message.id });
  assert((await receiptAtAgent).up_to_message_id === gotReply.message.id, "agent saw the visitor's read receipt");
  const receiptAtVisitor = waitFor(visitor, "message:receipt", (p) => p.reader.type === "agent");
  await ack(agent, "message:read", { room_id: roomId, message_id: gotMsg.message.id });
  assert((await receiptAtVisitor).up_to_message_id === gotMsg.message.id, "visitor saw the agent's read receipt");
  const listed = await http("GET", "/api/rooms?status=all", { token });
  assert(listed.body.data.find((r) => r.id === roomId)?.unread_count === 0, "unread count is computed from the cursor (0 after reading)");

  step("inbound SMS webhook with a valid Twilio signature creates a room");
  const params = { From: "+14155552671", To: "+14155550100", Body: "Texting you about my invoice", MessageSid: "SMe2e0001" };
  const sign = (url, p) => createHmac("sha1", TWILIO_TOKEN).update(Object.keys(p).sort().reduce((a, k) => a + k + p[k], url)).digest("base64");
  const unsigned = await http("POST", "/webhooks/twilio/sms", { form: params });
  assert(unsigned.status === 401, "unsigned webhook is rejected");
  const roomNew = waitFor(agent, "room:new", (p) => p.room.contact?.phone === "+14155552671");
  const hook = await http("POST", "/webhooks/twilio/sms", { form: params, headers: { "x-twilio-signature": sign(`${base}/webhooks/twilio/sms`, params) } });
  assert(hook.status === 200 && String(hook.body).includes("<Response>"), "signed webhook accepted with TwiML reply");
  await roomNew;
  ok("agent received room:new for the SMS conversation");
  const again = await http("POST", "/webhooks/twilio/sms", { form: params, headers: { "x-twilio-signature": sign(`${base}/webhooks/twilio/sms`, params) } });
  assert(again.status === 200, "replayed webhook is acknowledged without duplicating");
  const rooms = await http("GET", "/api/rooms?status=all", { token });
  const smsRoom = rooms.body.data.find((r) => r.contact?.phone === "+14155552671");
  assert(!!smsRoom && smsRoom.inbox_id === inbox.body.id, "SMS room exists in the default SMS inbox");
  const msgs = await http("GET", `/api/rooms/${smsRoom.id}/messages`, { token });
  assert(msgs.body.data.filter((m) => m.source === "sms").length === 1, "exactly one SMS message stored (idempotent on MessageSid)");

  agent.close();
  visitor.close();
  console.log("\nE2E PASSED");
}

try {
  await main();
} catch (e) {
  failed = true;
  console.error("\nE2E FAILED:", e instanceof Error ? e.message : e);
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
