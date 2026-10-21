import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as Ajv2020Mod from "ajv/dist/2020.js";
import * as addFormatsMod from "ajv-formats";
import { describe, expect, it } from "vitest";
import { originMatches } from "../src/services/visitors.js";

/* The bridge is a browser script (UMD). It is loaded the way a page loads it, in a vm context, so the test exercises the file that ships. */
function loadBridge(extra: Record<string, unknown> = {}) {
  const ctx: Record<string, any> = { URL, JSON, Promise, setTimeout, clearTimeout, console, crypto: globalThis.crypto, ...extra };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../public/chat/bridge.js", import.meta.url), "utf8"), ctx);
  return ctx.ConversationsBridge as any;
}
const B = loadBridge();

const schema = (n: string) => JSON.parse(readFileSync(new URL(`../../docs/bridge/${n}.schema.json`, import.meta.url), "utf8"));
const Ajv2020 = ((Ajv2020Mod as any).default?.default ?? (Ajv2020Mod as any).default ?? Ajv2020Mod) as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
((addFormatsMod as any).default?.default ?? (addFormatsMod as any).default)(ajv);
ajv.addSchema(schema("envelope"));
ajv.addSchema(schema("events"));
const validCommand = ajv.compile(schema("commands"));
const validEvent = ajv.getSchema("https://conversations.example/schemas/bridge/events.schema.json")!;

const env = (type: string, payload: unknown, extra: object = {}) => ({ v: 1, id: "id-1", type, payload, ...extra });
const HASH = "a".repeat(64);

const COMMANDS: [string, unknown, boolean][] = [
  ["identify", { external_id: "u1", email: "a@b.co", name: "Ana", phone: "+1415", identity_hash: HASH }, true],
  ["identify", { name: "Ana" }, true],
  ["identify", {}, true],
  ["identify", { identity_hash: HASH }, false],
  ["identify", { external_id: "u1", identity_hash: "xyz" }, false],
  ["identify", { external_id: "" }, false],
  ["identify", { email: "nope" }, false],
  ["identify", { name: "x".repeat(101) }, false],
  ["identify", { extra: 1 }, false],
  ["setLanguage", { locale: "pt-BR" }, true],
  ["setLanguage", { locale: "ja", strings: { send: "送信" } }, true],
  ["setLanguage", { locale: "english please" }, false],
  ["setLanguage", { locale: "en", strings: { send: 5 } }, false],
  ["setLanguage", { locale: "en", strings: { send: "x".repeat(301) } }, false],
  ["setLanguage", {}, false],
  ["setTheme", { theme: "dark", primary_color: "#112233", text_color: "#ffffff" }, true],
  ["setTheme", {}, true],
  ["setTheme", { theme: "purple" }, false],
  ["setTheme", { primary_color: "red" }, false],
  ["setTheme", { primary_color: "#12345" }, false],
  ["setCustomAttributes", { attributes: { plan: "pro", seats: 3, beta: true, gone: null } }, true],
  ["setCustomAttributes", { attributes: { "Bad-Key": 1 } }, false],
  ["setCustomAttributes", { attributes: { k: { n: 1 } } }, false],
  ["setCustomAttributes", { attributes: { k: "x".repeat(201) } }, false],
  ["setCustomAttributes", { attributes: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) }, false],
  ["setCustomAttributes", {}, false],
  ["open", {}, true],
  ["open", { a: 1 }, false],
  ["close", {}, true],
  ["back", {}, true],
  ["reset", {}, true],
  ["reset", { hard: true }, false],
  ["sendMessage", { text: "hi" }, true],
  ["sendMessage", { text: "hi", send: true }, true],
  ["sendMessage", { text: "" }, false],
  ["sendMessage", { text: "x".repeat(4001) }, false],
  ["sendMessage", { text: "hi", send: "yes" }, false],
  ["restoreSession", { device_id: "device-1234" }, true],
  ["restoreSession", { device_id: "short" }, false],
  ["restoreSession", { device_id: "has space here" }, false],
  ["ack", { ok: true, handled: true }, true],
  ["ack", { ok: false, error: { code: "X", message: "m" } }, true],
  ["ack", { ok: "yes" }, false],
  ["ack", { handled: true }, false],
];

const EVENTS: [string, unknown, boolean][] = [
  ["ready", { protocol: 1, page_version: "1.0.0", device_id: "device-1234", locale: "en", theme: "light", features: ["emoji"], unread_count: 0 }, true],
  ["ready", { protocol: 2, page_version: "1.0.0", device_id: "device-1234", locale: "en", theme: "light", features: [], unread_count: 0 }, false],
  ["ready", { protocol: 1, page_version: "1.0.0", device_id: "device-1234", locale: "en", theme: "blue", features: [], unread_count: 0 }, false],
  ["ready", { protocol: 1, page_version: "1.0.0", device_id: "x", locale: "en", theme: "dark", features: [], unread_count: 0 }, false],
  ["unread_count_changed", { count: 3 }, true],
  ["unread_count_changed", { count: -1 }, false],
  ["unread_count_changed", { count: 1.5 }, false],
  ["message_received", { message_id: "m1", sender_type: "agent", preview: "hi", has_attachments: false, in_foreground: true }, true],
  ["message_received", { message_id: "m1", sender_type: "contact", preview: "hi", has_attachments: false, in_foreground: true }, false],
  ["message_received", { message_id: "m1", sender_type: "bot", preview: "x".repeat(141), has_attachments: false, in_foreground: true }, false],
  ["conversation_started", { room_id: "room_1" }, true],
  ["conversation_started", {}, false],
  ["conversation_closed", { room_id: "room_1" }, true],
  ["form_requested", { room_id: "room_1", message_id: "msg_1", moment: "handoff", fields: ["email", "phone"] }, true],
  ["form_requested", { room_id: "room_1", message_id: "msg_1", moment: "later", fields: [] }, false],
  ["form_requested", { room_id: "room_1", message_id: "msg_1", moment: "agent" }, false],
  ["contact_info_submitted", { room_id: "room_1", fields: ["email"] }, true],
  ["contact_info_submitted", { fields: ["email"] }, false],
  ["handoff_started", { room_id: "room_1", status: "waiting_for_human" }, true],
  ["handoff_started", { room_id: "room_1", status: "resolved" }, false],
  ["agent_joined", { room_id: "room_1" }, true],
  ["agent_joined", {}, false],
  ["link_clicked", { url: "https://example.com/x", source: "message" }, true],
  ["link_clicked", { url: "mailto:a@b.co", source: "message" }, true],
  ["link_clicked", { url: "tel:+14155550123", source: "payment" }, true],
  ["link_clicked", { url: "javascript:alert(1)", source: "message" }, false],
  ["link_clicked", { url: "http://example.com", source: "message" }, false],
  ["link_clicked", { url: "https://example.com", source: "other" }, false],
  ["attachment_requested", { kinds: ["image", "pdf"] }, true],
  ["attachment_requested", { kinds: [] }, false],
  ["auth_required", { reason: "identity_invalid" }, true],
  ["auth_required", { reason: "nope" }, false],
  ["error", { code: "UNAVAILABLE", message: "m", fatal: true }, true],
  ["error", { code: "UNAVAILABLE", message: "m" }, false],
  ["close_requested", {}, true],
  ["close_requested", { x: 1 }, false],
  ["ack", { ok: true, result: { sent: true } }, true],
  ["ack", { ok: true, result: "text" }, false],
];

describe("bridge: the shipped validators and the published JSON Schemas agree", () => {
  it.each(COMMANDS)("command %s %j -> %s", (type, payload, ok) => {
    expect(validCommand(env(type, payload)), JSON.stringify(validCommand.errors)).toBe(ok);
    expect(B.parseEnvelope(env(type, payload), "commands").ok).toBe(ok);
    expect(B.parseEnvelope(JSON.stringify(env(type, payload)), "commands").ok).toBe(ok);
  });
  it.each(EVENTS)("event %s %j -> %s", (type, payload, ok) => {
    expect(validEvent(env(type, payload)), JSON.stringify(validEvent.errors)).toBe(ok);
    expect(B.parseEnvelope(env(type, payload), "events").ok).toBe(ok);
  });

  it("envelope rules: version, id, payload type, unknown type, reply_to", () => {
    const parse = (m: unknown) => B.parseEnvelope(m, "commands");
    expect(parse(env("open", {}, { v: 2 }))).toMatchObject({ ok: false, reason: "version", id: "id-1" });
    expect(parse({ ...env("open", {}), v: undefined })).toMatchObject({ ok: false, reason: "version" });
    expect(parse(env("explode", {}))).toMatchObject({ ok: false, reason: "unknown_type" });
    expect(parse(env("open", [] as unknown as object))).toMatchObject({ ok: false, reason: "invalid_payload" });
    expect(parse({ v: 1, id: "", type: "open", payload: {} })).toMatchObject({ ok: false, reason: "not_envelope" });
    expect(parse({ v: 1, id: "x".repeat(65), type: "open", payload: {} })).toMatchObject({ ok: false, reason: "not_envelope" });
    expect(parse("{not json")).toMatchObject({ ok: false, reason: "not_json" });
    expect(parse("null")).toMatchObject({ ok: false, reason: "not_envelope" });
    expect(parse(42)).toMatchObject({ ok: false, reason: "not_envelope" });
    expect(parse(env("ack", { ok: true }, { reply_to: "abc" })).ok).toBe(true);
    expect(validCommand(env("open", {}, { reply_to: "" }))).toBe(false);
    expect(parse(env("open", {}, { reply_to: "" })).ok).toBe(false);
    expect(validCommand({ ...env("open", {}), extra: 1 })).toBe(false);
  });

  it("size limit: 16 KiB for text and for objects", () => {
    const big = env("identify", { name: "x".repeat(20000) });
    expect(B.parseEnvelope(JSON.stringify(big), "commands")).toMatchObject({ ok: false, reason: "too_large" });
    expect(B.parseEnvelope(big, "commands")).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("a hostile payload cannot pollute prototypes or smuggle fields", () => {
    const r = B.parseEnvelope('{"v":1,"id":"a","type":"setCustomAttributes","payload":{"attributes":{"__proto__":{"x":1}}}}', "commands");
    expect(r.ok).toBe(false);
    expect(({} as any).x).toBeUndefined();
  });
});

describe("bridge: link and origin rules", () => {
  it("only https, mailto and tel leave the page (own http origin only where allowed)", () => {
    const ok = ["https://example.com", "mailto:a@b.co", "tel:+1415"];
    const bad = ["http://example.com", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x", "intent://x", "not a url", "//example.com", "https://" + "a".repeat(2100)];
    for (const u of ok) expect(B.validateLink(u, {}).ok, u).toBe(true);
    for (const u of bad) expect(B.validateLink(u, {}).ok, u).toBe(false);
    expect(B.validateLink("http://localhost:3000/files/x", { own: "http://localhost:3000" }).ok).toBe(true);
    expect(B.validateLink("http://localhost:3001/files/x", { own: "http://localhost:3000" }).ok).toBe(false);
  });

  const cases: [string, string | null | undefined][] = [
    ["example.com", "https://example.com"], ["example.com", "https://EXAMPLE.COM"], ["example.com", "https://example.com:8443"], ["example.com", "https://www.example.com"],
    ["example.com", "https://example.com.evil.test"], ["example.com", "https://evilexample.com"], ["localhost:3000", "http://localhost:3000"], ["localhost:3000", "http://localhost"],
    ["*.example.com", "https://app.example.com"], ["*.example.com", "https://a.b.example.com"], ["*.example.com", "https://example.com"], ["*.example.com", "https://evilexample.com"],
    ["*.example.com:8443", "https://x.example.com:8443"], ["example.com", undefined], ["example.com", null], ["example.com", "null"], ["example.com", "file:///x"], ["example.com", "chrome-extension://abc"], ["example.com", "https://user@example.com"],
  ];
  it.each(cases)("page-side originMatches(%s, %s) equals the server's", (pattern, origin) => {
    expect(B.originMatches(origin, pattern)).toBe(originMatches(origin, pattern));
  });
});

describe("bridge endpoint", () => {
  function setup(handlers: Record<string, (p: any) => unknown> = {}, now = () => 0) {
    const sent: any[] = [];
    const bridge = B.createBridge({ transport: { name: "test", send: (e: unknown) => sent.push(e) }, handlers, now });
    const acks = () => sent.filter((e) => e.type === "ack");
    return { bridge, sent, acks };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("acknowledges a handled command, putting extra data under result and `handled` at the top", async () => {
    const { bridge, acks } = setup({ open: () => ({ handled: true, extra: 1 }), close: () => undefined });
    bridge.receive(JSON.stringify(env("open", {}, { id: "c1" })));
    bridge.receive(JSON.stringify(env("close", {}, { id: "c2" })));
    await tick();
    expect(acks().map((a) => [a.reply_to, a.payload])).toEqual([["c1", { ok: true, handled: true, result: { extra: 1 } }], ["c2", { ok: true }]]);
    for (const a of acks()) expect(validEvent({ ...a })).toBe(true);
  });

  it("nacks: unknown command, invalid payload, handler error; stays silent on an unknown version and on garbage", async () => {
    const { bridge, acks } = setup({ open: () => { throw { code: "NOT_READY", message: "later" }; } });
    bridge.receive(env("explode", {}, { id: "u1" }));
    bridge.receive(env("setTheme", { theme: "x" }, { id: "u2" }));
    bridge.receive(env("open", {}, { id: "u3" }));
    bridge.receive(env("open", {}, { id: "u4", v: 9 }));
    bridge.receive("garbage");
    bridge.receive(env("close", {}, { id: "u5" })); // no handler registered
    await tick();
    expect(acks().map((a) => [a.reply_to, a.payload.error?.code]).sort()).toEqual([["u1", "UNKNOWN_COMMAND"], ["u2", "INVALID_PAYLOAD"], ["u3", "NOT_READY"], ["u5", "UNKNOWN_COMMAND"]]);
  });

  it("rate limits commands (30 per 10 s window), then recovers; acks are never limited", async () => {
    let t = 0;
    const { bridge, acks } = setup({ open: () => undefined }, () => t);
    for (let i = 0; i < 35; i++) bridge.receive(env("open", {}, { id: `r${i}` }));
    await tick();
    expect(acks().filter((a) => a.payload.ok).length).toBe(30);
    expect(acks().filter((a) => a.payload.error?.code === "RATE_LIMITED").length).toBe(5);
    t = 10_001;
    bridge.receive(env("open", {}, { id: "after" }));
    await tick();
    expect(acks().at(-1).payload.ok).toBe(true);
  });

  it("emitAwait resolves with the host's ack, or null after the timeout; messages from a refused origin are dropped", async () => {
    const { bridge, sent } = setup({ open: () => undefined });
    const p = bridge.emitAwait("link_clicked", { url: "https://example.com", source: "message" }, 200);
    const id = sent[0].id;
    bridge.receive(env("ack", { ok: true, handled: true }, { id: "h1", reply_to: id }));
    expect(await p).toEqual({ ok: true, handled: true });
    expect(await bridge.emitAwait("link_clicked", { url: "https://example.com", source: "message" }, 20)).toBeNull();
    const n = sent.length;
    bridge.receive(env("open", {}, { id: "x1" }), { allowed: false });
    await tick();
    expect(sent.length).toBe(n);
  });

  it("an ack with a reply_to nobody waits for is ignored", async () => {
    const { bridge, sent } = setup();
    bridge.receive(env("ack", { ok: true }, { reply_to: "ghost" }));
    await tick();
    expect(sent).toEqual([]);
  });
});

describe("bridge transports", () => {
  const msg = { v: 1, id: "t1", type: "ready", payload: {} };
  it("ios, android, rn and flutter send JSON text through their native channel", () => {
    const got: Record<string, string[]> = { ios: [], android: [], rn: [], flutter: [] };
    const win: any = {
      webkit: { messageHandlers: { conversations: { postMessage: (s: string) => got.ios!.push(s) } } },
      ConversationsAndroid: { postMessage: (s: string) => got.android!.push(s) },
      ReactNativeWebView: { postMessage: (s: string) => got.rn!.push(s) },
      ConversationsFlutter: { postMessage: (s: string) => got.flutter!.push(s) },
    };
    for (const name of ["ios", "android", "rn", "flutter"]) B.detectTransport(win, name, "x.com").send(msg);
    for (const k of Object.keys(got)) expect(JSON.parse(got[k]![0]!), k).toEqual(msg);
  });

  it("auto-detection prefers the native channel that exists, then an iframe parent, else none", () => {
    expect(B.detectTransport({ webkit: { messageHandlers: { conversations: {} } } }, undefined, "").name).toBe("ios");
    expect(B.detectTransport({ ConversationsAndroid: {} }, "auto", "").name).toBe("android");
    expect(B.detectTransport({ ReactNativeWebView: {} }, undefined, "").name).toBe("rn");
    expect(B.detectTransport({ ConversationsFlutter: {} }, undefined, "").name).toBe("flutter");
    const w: any = { parent: {} };
    expect(B.detectTransport(w, undefined, "").name).toBe("iframe");
    const top: any = {};
    top.parent = top;
    expect(B.detectTransport(top, undefined, "").name).toBe("none");
    expect(B.detectTransport({}, "bogus", "").name).toBe("none");
  });

  it("the iframe transport posts only to origins the token allows (or the page's own), never to an unknown parent", () => {
    const posted: [unknown, string][] = [];
    const mk = (referrer: string, ancestor: string | undefined) => ({
      parent: { postMessage: (m: unknown, o: string) => posted.push([m, o]) },
      document: { referrer },
      location: { origin: "https://app.example", ancestorOrigins: ancestor ? [ancestor] : [] },
    });
    posted.length = 0;
    B.detectTransport(mk("https://shop.example.com/page", "https://shop.example.com"), "iframe", "shop.example.com").send(msg);
    expect(posted.map((p) => p[1])).toEqual(["https://shop.example.com"]);
    posted.length = 0;
    B.detectTransport(mk("https://evil.example/x", "https://evil.example"), "iframe", "shop.example.com").send(msg);
    expect(posted).toEqual([]);
    posted.length = 0;
    B.detectTransport(mk("https://app.example/bridge-test", undefined), "iframe", "shop.example.com").send(msg);
    expect(posted.map((p) => p[1])).toEqual(["https://app.example"]);
    posted.length = 0;
    B.detectTransport(mk("https://x.shop.example.com/", undefined), "iframe", "*.example.com").send(msg);
    expect(posted.map((p) => p[1])).toEqual(["https://x.shop.example.com"]);
  });
});

describe("i18n", () => {
  function loadI18n() {
    const ctx: Record<string, any> = {};
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(new URL("../public/chat/i18n.js", import.meta.url), "utf8"), ctx);
    return ctx.ConversationsI18n as any;
  }
  const I = loadI18n();
  it("ships en, es, fr, de and ja with exactly the English keys", () => {
    expect(I.SUPPORTED.sort()).toEqual(["de", "en", "es", "fr", "ja"]);
    for (const l of I.SUPPORTED) expect(Object.keys(I.DICTS[l]).sort(), l).toEqual(Object.keys(I.en).sort());
    // placeholders survive translation
    for (const l of I.SUPPORTED) for (const k of Object.keys(I.en)) expect([...(I.DICTS[l][k].match(/\{\w+\}/g) ?? [])].sort(), `${l}.${k}`).toEqual([...(I.en[k].match(/\{\w+\}/g) ?? [])].sort());
  });
  it("falls back from region to language to English, applies overrides and placeholders", () => {
    expect(I.pickLanguage("pt-BR")).toBe("en");
    expect(I.pickLanguage("es-MX")).toBe("es");
    expect(I.pickLanguage("JA")).toBe("ja");
    const t = I.translator("fr", { send: "Go" });
    expect(t("send")).toBe("Go");
    expect(t("typing", { name: "Léa" })).toContain("Léa");
    expect(t("no_such_key")).toBe("no_such_key");
    expect(I.isRtl("ar-EG")).toBe(true);
    expect(I.isRtl("en")).toBe(false);
  });
});
