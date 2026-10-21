// Tests the embeddable widget (server/public/widget.js) in jsdom with a fake fetch and a fake Socket.IO client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import source from "../../server/public/widget.js?raw";

type Handler = (...a: any[]) => void;
class FakeSocket {
  handlers: Record<string, Handler[]> = {};
  emitted: { event: string; payload: any; ack?: Handler }[] = [];
  connected = false;
  constructor(public url: string, public opts: any) {}
  on(e: string, h: Handler) { (this.handlers[e] ||= []).push(h); return this; }
  off() { return this; }
  emit(event: string, payload: any, ack?: Handler) { this.emitted.push({ event, payload, ack }); }
  disconnect() { this.connected = false; }
  fire(e: string, ...a: any[]) { (this.handlers[e] || []).forEach((h) => h(...a)); }
  connect() { this.connected = true; this.fire("connect"); }
}

const config = {
  workspace_id: "ws_" + "a".repeat(24), workspace_name: "Acme", office_open: true, live_routing_inboxes: [], agents_available: 1, agents: [],
  widget: { title: "Chat with Acme", intro: "Hi", primary_color: "#112233", text_color: "#ffffff", logo_url: null, launcher_position: "left", launcher_spacing: 30, sound: false, welcome_message: "Welcome", away_message: "", required_info: [] as string[], chat_type: "live_chat", office_hours: {} },
};
const mkMsg = (o: any) => ({ id: "msg_" + Math.random().toString(16).slice(2), seq: 1, kind: "text", source: "dm", sender: { type: "agent", name: "Olivia" }, content_text: "hi", delivery: "sent", read: false, meta: {}, ...o });

let calls: { method: string; path: string; body: any; headers: any }[];
let sockets: FakeSocket[];
let replies: Record<string, (body: any) => { status?: number; json: any }>;
let widget: any;

const fakeFetch = async (url: string, init: any) => {
  const path = url.replace("http://api.test", "");
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path, body, headers: init.headers });
  const key = `${init.method} ${path.split("?")[0]}`;
  const r = replies[key]?.(body) ?? { status: 404, json: { error: { code: "NOT_FOUND", message: "nope" } } };
  const status = r.status ?? 200;
  return { ok: status < 400, status, text: async () => JSON.stringify(r.json) } as any;
};

async function boot(extraConfig: any = {}, opts: any = {}) {
  replies["GET /public/widget/config"] = () => ({ json: { ...config, widget: { ...config.widget, ...extraConfig } } });
  const w = (window as any).ConversationsWidget.init({ token: "cvt_testtoken1234", apiBase: "http://api.test", fetch: fakeFetch, io: (url: string, o: any) => { const s = new FakeSocket(url, o); sockets.push(s); return s; }, pollMs: 50, ...opts });
  await w.ready;
  return w;
}
const shadow = () => document.getElementById("conversations-widget-host")!.shadowRoot!;
const flush = () => new Promise((r) => setTimeout(r, 0));
const session = { session_id: "ses_1", session_token: "ses_secret", workspace_id: config.workspace_id, verified: true, requires_verification: false, contact: { id: "con_1", name: "V" } };

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  calls = []; sockets = []; replies = {};
  replies["POST /public/sessions"] = () => ({ status: 201, json: session });
  replies["GET /public/rooms"] = () => ({ json: { data: [{ id: "room_1" }] } });
  replies["GET /public/rooms/room_1/messages"] = () => ({ json: { data: [mkMsg({ id: "msg_w", seq: 1, sender: { type: "bot", name: "Chatbot" }, content_text: "Welcome" })] } });
  // eslint-disable-next-line no-eval
  (0, eval)(source);
});
afterEach(() => { widget?.destroy(); widget = null; });

describe("widget rendering", () => {
  it("renders a themed launcher and a closed panel in a shadow root, with accessible names", async () => {
    widget = await boot();
    const root = shadow();
    const launcher = root.querySelector("button.launcher")!;
    expect(launcher.getAttribute("aria-label")).toBe("Open chat");
    expect(launcher.className).toContain("left");
    expect((document.getElementById("conversations-widget-host") as HTMLElement).style.getPropertyValue("--c")).toBe("#112233");
    expect((root.querySelector(".panel") as HTMLElement).hidden).toBe(true);
    expect(root.querySelector(".ttl")!.textContent).toBe("Chat with Acme");
    expect(document.body.textContent).not.toContain("Welcome"); // nothing leaks outside the shadow root
  });

  it("applies the launcher style, label and radius from the config", async () => {
    widget = await boot({ launcher_style: "pill", launcher_label: "Ask us", radius: 6 });
    const launcher = shadow().querySelector("button.launcher")!;
    expect(launcher.className).toContain("pill");
    expect(launcher.querySelector(".lbl")!.textContent).toBe("Ask us");
    expect(launcher.querySelector("svg")).not.toBeNull();
    expect((document.getElementById("conversations-widget-host") as HTMLElement).style.getPropertyValue("--r")).toBe("6px");
  });

  it("falls back to the bubble launcher and 16px radius for configs without the new fields", async () => {
    widget = await boot();
    expect(shadow().querySelector("button.launcher")!.className).toContain("bubble");
    expect((document.getElementById("conversations-widget-host") as HTMLElement).style.getPropertyValue("--r")).toBe("16px");
  });

  it("closes on Escape, returns focus to the launcher and honours the theme option", async () => {
    widget = await boot({}, { theme: "dark" });
    expect(shadow().querySelector(".root")!.getAttribute("data-theme")).toBe("dark");
    widget.open();
    await flush(); await flush(); await flush();
    const panel = shadow().querySelector(".panel") as HTMLElement;
    expect(panel.hidden).toBe(false);
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(shadow().querySelector("button.launcher")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("gives the icon-only controls accessible names", async () => {
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    expect(shadow().querySelector(".head button")!.getAttribute("aria-label")).toBe("Close chat");
    expect(shadow().querySelector(".compose .send")!.getAttribute("aria-label")).toBe("Send message");
  });

  it("opens, creates an anonymous session and room, loads the welcome message and sends the API key/device headers", async () => {
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    const sess = calls.find((c) => c.path === "/public/sessions")!;
    expect(sess.headers["x-api-key"]).toBe("cvt_testtoken1234");
    expect(sess.headers["x-device-id"]).toBe(widget.deviceId());
    expect(shadow().querySelector(".msgs")!.textContent).toContain("Welcome");
    expect(shadow().querySelector(".msgs")!.getAttribute("aria-live")).toBe("polite");
    expect(shadow().querySelector(".tag")).toBeNull();
    expect(sockets[0]!.url).toBe(`http://api.test/ws/${config.workspace_id}`);
    expect(sockets[0]!.opts.auth).toEqual({ session: "ses_secret", deviceId: widget.deviceId() });
  });

  it("shows a pre-chat form for required info and posts it", async () => {
    widget = await boot({ required_info: ["name", "email"] });
    widget.open();
    await flush();
    const form = shadow().querySelector("form")!;
    expect(form.querySelectorAll("input[required]").length).toBe(2);
    (form.querySelector('[name="name"]') as HTMLInputElement).value = "Vic";
    (form.querySelector('[name="email"]') as HTMLInputElement).value = "vic@example.test";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush(); await flush(); await flush();
    expect(calls.find((c) => c.path === "/public/sessions")!.body).toEqual({ name: "Vic", email: "vic@example.test" });
    expect(shadow().querySelector(".msgs")).not.toBeNull();
  });

  it("renders message text safely (no HTML injection), linkifies URLs and tags AI messages", async () => {
    replies["GET /public/rooms/room_1/messages"] = () => ({ json: { data: [
      mkMsg({ id: "m1", seq: 1, content_text: "<img src=x onerror=alert(1)> see https://example.test/a" }),
      mkMsg({ id: "m2", seq: 2, sender: { type: "bot", name: "AI Assistant" }, content_text: "bot", meta: { ai: true } }),
    ] } });
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    const list = shadow().querySelector(".msgs")!;
    expect(list.querySelector("img")).toBeNull();
    expect(list.querySelector("a")!.getAttribute("href")).toBe("https://example.test/a");
    expect(list.querySelector("a")!.getAttribute("rel")).toContain("noopener");
    expect(list.querySelector(".tag")!.textContent).toBe("AI");
  });
});

describe("widget messaging", () => {
  async function ready() {
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    sockets[0]!.connect();
    await flush(); await flush();
    return sockets[0]!;
  }

  it("sends optimistically over the socket with a client_msg_id and replaces the bubble on ack", async () => {
    const s = await ready();
    const input = shadow().querySelector("textarea") as HTMLTextAreaElement;
    input.value = "Hello there";
    void widget.send("Hello there");
    await flush();
    const sent = s.emitted.find((e) => e.event === "message:send")!;
    expect(sent.payload).toMatchObject({ room_id: "room_1", kind: "text", source: "dm", content: "Hello there" });
    expect(sent.payload.client_msg_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(shadow().querySelector(".m.out")!.textContent).toContain("Sending");
    sent.ack!({ ok: true, message: mkMsg({ id: "msg_srv", seq: 5, client_msg_id: sent.payload.client_msg_id, sender: { type: "contact" }, content_text: "Hello there" }) });
    expect(shadow().querySelectorAll(".m.out").length).toBe(1);
    expect(shadow().querySelector(".m.out")!.textContent).toContain("Sent");
    // the broadcast of the same message must not create a duplicate bubble
    s.fire("message:new", { message: mkMsg({ id: "msg_srv", seq: 5, client_msg_id: sent.payload.client_msg_id, sender: { type: "contact" }, content_text: "Hello there" }) });
    expect(shadow().querySelectorAll(".m.out").length).toBe(1);
  });

  it("marks a failed send and retries with the SAME client_msg_id", async () => {
    const s = await ready();
    void widget.send("flaky");
    await flush();
    const first = s.emitted.find((e) => e.event === "message:send")!;
    first.ack!({ ok: false, error: { code: "INTERNAL" } });
    const retry = shadow().querySelector("button[data-retry]") as HTMLButtonElement;
    expect(retry).not.toBeNull();
    retry.click();
    const again = s.emitted.filter((e) => e.event === "message:send")[1]!;
    expect(again.payload.client_msg_id).toBe(first.payload.client_msg_id);
  });

  it("falls back to REST while disconnected and resends pending messages after reconnecting", async () => {
    const s = await ready();
    s.connected = false;
    s.fire("disconnect");
    expect((shadow().querySelector(".status") as HTMLElement).hidden).toBe(false);
    replies["POST /public/rooms/room_1/messages"] = () => ({ status: 500, json: { error: { code: "X", message: "down" } } });
    void widget.send("offline msg");
    await flush();
    const attempt = calls.find((c) => c.path === "/public/rooms/room_1/messages" && c.method === "POST")!;
    expect(attempt.body.client_msg_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(shadow().querySelector(".m.failed")).not.toBeNull();
    // reconnect: the failed one is re-sent through the socket with the same id
    const pending = widget.getState().messages.find((m: any) => m.local);
    s.connect();
    await flush(); await flush(); await flush();
    const resent = s.emitted.filter((e) => e.event === "message:send").pop()!;
    expect(resent.payload.client_msg_id).toBe(pending.client_msg_id);
    expect((shadow().querySelector(".status") as HTMLElement).hidden).toBe(true);
  });

  it("shows incoming agent messages, typing indicator, unread badge while closed and read receipts", async () => {
    const s = await ready();
    widget.close();
    s.fire("message:new", { message: mkMsg({ id: "m_new", seq: 9, content_text: "Anyone here?" }) });
    const badge = shadow().querySelector(".badge") as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("1");
    widget.open();
    expect(badge.hidden).toBe(true);
    s.fire("typing", { room_id: "room_1", typing: true, who: { type: "agent", name: "Olivia" } });
    expect(shadow().querySelector(".typing")!.textContent).toBe("Olivia is typing…");
    s.fire("typing", { room_id: "room_1", typing: false, who: { type: "agent" } });
    expect(shadow().querySelector(".typing")!.textContent).toBe("");
    await new Promise((r) => setTimeout(r, 350));
    expect(s.emitted.some((e) => e.event === "message:read" && e.payload.message_id === "m_new")).toBe(true);
  });

  it("removes deleted messages and marks own messages read from agent receipts", async () => {
    const s = await ready();
    void widget.send("question");
    await flush();
    const e = s.emitted.find((x) => x.event === "message:send")!;
    e.ack!({ ok: true, message: mkMsg({ id: "mine", seq: 3, client_msg_id: e.payload.client_msg_id, sender: { type: "contact" }, content_text: "question" }) });
    s.fire("message:receipt", { reader: { type: "agent" }, up_to_seq: 3 });
    expect(shadow().querySelector(".m.out")!.textContent).toContain("Read");
    s.fire("message:deleted", { message_id: "mine" });
    expect(shadow().querySelector(".m.out")).toBeNull();
  });

  it("restores a stored session on load without showing the form", async () => {
    localStorage.setItem(`cv_${"cvt_testtoken1234".slice(-8)}_session`, JSON.stringify(session));
    widget = await boot({ required_info: ["email"] });
    await flush(); await flush(); await flush();
    expect(calls.some((c) => c.path === "/public/sessions")).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it("walks the OTP flow when the server demands verification", async () => {
    replies["GET /public/rooms"] = () => ({ status: 409, json: { error: { code: "VERIFICATION_REQUIRED", message: "verify" } } });
    replies["POST /public/sessions"] = () => ({ status: 201, json: { ...session, verified: false, requires_verification: true } });
    replies["POST /public/otp/send"] = () => ({ json: { channel: "email" } });
    replies["POST /public/otp/verify"] = (b) => (b.code === "12345" ? { json: { verified: true } } : { status: 422, json: { error: { code: "OTP_INVALID", message: "That code is not correct" } } });
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    expect(shadow().querySelector('input[name="code"]')).not.toBeNull();
    (shadow().querySelector("[data-send-code]") as HTMLButtonElement).click();
    await flush(); await flush();
    expect(shadow().textContent).toContain("5-digit code by email");
    const form = shadow().querySelector("form")!;
    (form.querySelector('[name="code"]') as HTMLInputElement).value = "00000";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush(); await flush();
    expect(shadow().textContent).toContain("That code is not correct");
    replies["GET /public/rooms"] = () => ({ json: { data: [{ id: "room_1" }] } });
    (shadow().querySelector('[name="code"]') as HTMLInputElement).value = "12345";
    shadow().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush(); await flush(); await flush(); await flush();
    expect(shadow().querySelector(".msgs")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith("_session"))!)!).verified).toBe(true);
  });

  it("polls over REST when the socket cannot connect", async () => {
    const s = await ready();
    let n = 0;
    replies["GET /public/rooms/room_1/messages"] = () => (n++, { json: { data: [mkMsg({ id: "p1", seq: 2, content_text: "via polling" })] } });
    s.fire("connect_error", new Error("nope"));
    await new Promise((r) => setTimeout(r, 160));
    expect(n).toBeGreaterThan(0);
    expect(shadow().querySelector(".msgs")!.textContent).toContain("via polling");
  });
});

describe("widget bootstrap", () => {
  it("requires a token and exposes the public API", () => {
    expect(() => (window as any).ConversationsWidget.init({})).toThrow(/missing token/);
    expect(typeof (window as any).ConversationsWidget.version).toBe("string");
    vi.restoreAllMocks();
  });
});

describe("satisfaction rating", () => {
  // the close line itself is internal and never sent to the visitor: the server states the closed state and where it happened
  const closedRoom = { id: "room_1", status: "closed", closed_marker: { id: "msg_closed", seq: 3 } };

  it("offers 1-5 once after the team closes the conversation, posts the score, and then thanks the visitor", async () => {
    replies["GET /public/rooms/room_1/messages"] = () => ({ json: { data: [mkMsg({ id: "msg_a", seq: 1, content_text: "Anything else?" })], room: closedRoom } });
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    const buttons = shadow().querySelectorAll<HTMLButtonElement>(".rate button");
    expect(buttons).toHaveLength(5);
    expect(shadow().querySelector(".rate")!.getAttribute("aria-label")).toBe("How did we do?");
    replies["POST /public/rooms/room_1/csat"] = () => ({ json: { ok: true } });
    buttons[3]!.click();
    await flush(); await flush();
    expect(calls.find((c) => c.path === "/public/rooms/room_1/csat")!.body).toEqual({ score: 4 });
    expect(shadow().querySelector(".rate")).toBeNull();
    expect(shadow().querySelector(".msgs")!.textContent).toContain("Thanks for your feedback");
  });

  it("is not offered while the conversation is live, or after the visitor writes again", async () => {
    replies["GET /public/rooms/room_1/messages"] = () => ({ json: { data: [mkMsg({ id: "msg_b", seq: 4, sender: { type: "contact" }, content_text: "one more thing" })], room: closedRoom } });
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    expect(shadow().querySelector(".rate")).toBeNull();
  });
});

describe("payment request card", () => {
  const card = (o: any = {}) => ({ type: "payment_request", id: "pay_1", amount: 2500, currency: "usd", description: "Deposit for the install", status: "open", url: "https://checkout.stripe.test/pay/1", paid_at: null, ...o });

  it("shows amount, description and a Pay now link to the Stripe page, and updates to Paid live", async () => {
    const pay = mkMsg({ id: "msg_pay", seq: 2, content_text: "Payment request: Deposit - $25.00\nPay securely: https://checkout.stripe.test/pay/1", meta: { card: card() } });
    replies["GET /public/rooms/room_1/messages"] = () => ({ json: { data: [pay] } });
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    const el = shadow().querySelector(".m.pay") as HTMLElement;
    expect(el.textContent).toContain("$25.00");
    expect(el.textContent).toContain("Deposit for the install");
    expect(el.textContent).toContain("Awaiting payment");
    expect(el.textContent).not.toContain("Pay securely"); // the card replaces the raw link text
    const a = el.querySelector("a.btn") as HTMLAnchorElement;
    expect([a.href, a.target, a.rel]).toEqual(["https://checkout.stripe.test/pay/1", "_blank", "noopener noreferrer"]);

    sockets[0]!.fire("message:updated", { message: { ...pay, meta: { card: card({ status: "paid", url: null, paid_at: "2026-03-02T10:00:00Z" }) } } });
    const paid = shadow().querySelector(".m.pay") as HTMLElement;
    expect(paid.classList.contains("paid")).toBe(true);
    expect(paid.textContent).toContain("Paid, thank you");
    expect(paid.querySelector("a")).toBeNull();
  });

  it("never links anything but an https URL", async () => {
    const evil = mkMsg({ id: "msg_evil", seq: 2, meta: { card: card({ url: "javascript:alert(1)" }) } });
    replies["GET /public/rooms/room_1/messages"] = () => ({ json: { data: [evil] } });
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    expect(shadow().querySelector(".m.pay a")).toBeNull();
  });
});

describe("AI agent in the widget", () => {
  const bot = (o: any = {}) => mkMsg({ id: "msg_ai", seq: 2, sender: { type: "bot", name: "Aria" }, content_text: "Open Settings, choose Security.", meta: { ai: true, agent: { name: "Aria", label: "AI helper" } }, ...o });
  const card = (answered?: string) => bot({ id: "msg_card", seq: 3, content_text: "Did this solve it?", meta: { ai: true, agent: { name: "Aria", label: "AI helper" }, card: { type: "quick_replies", purpose: "solved", answered, options: [{ id: "yes", label: "Yes, thanks" }, { id: "no", label: "No, I need more help" }, { id: "human", label: "Talk to a person" }] } } });
  const withMessages = (data: any[], ticket: any = { id: "tkt_1", number: 1, status: "bot_handling", resolved: false, csat_pending: false }) => {
    replies["GET /public/rooms/room_1/messages"] = () => ({ json: { data, room: { id: "room_1", status: "open", closed_marker: null, ticket } } });
  };
  const opened = async () => {
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
  };

  it("labels the AI answer with the agent's label, shows quick replies on the latest bot card and posts the tap", async () => {
    withMessages([bot(), card()]);
    await opened();
    expect(shadow().querySelector(".tag")!.textContent).toBe("AI helper");
    const buttons = [...shadow().querySelectorAll<HTMLButtonElement>(".qr button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Yes, thanks", "No, I need more help", "Talk to a person"]);
    replies["POST /public/rooms/room_1/quick-reply"] = () => ({ json: { ok: true, ticket: { id: "tkt_1", number: 1, status: "resolved", resolved: true, csat_pending: true } } });
    withMessages([bot(), card("yes")], { id: "tkt_1", number: 1, status: "resolved", resolved: true, csat_pending: true });
    buttons[0]!.click();
    await flush(); await flush(); await flush();
    expect(calls.find((c) => c.path === "/public/rooms/room_1/quick-reply")!.body).toEqual({ message_id: "msg_card", option_id: "yes" });
    expect(shadow().querySelector(".qr")).toBeNull();
  });

  it("does not offer buttons on a card that was answered or that is no longer the newest message", async () => {
    withMessages([card("no")]);
    await opened();
    expect(shadow().querySelector(".qr")).toBeNull();
    widget.destroy();
    document.body.innerHTML = "";
    withMessages([card(), mkMsg({ id: "msg_later", seq: 4, sender: { type: "contact" }, content_text: "something else" })]);
    widget = await boot();
    widget.open();
    await flush(); await flush(); await flush();
    expect(shadow().querySelector(".qr")).toBeNull();
  });

  it("offers Talk to a person while a bot has the conversation, posts the request and hides while a person has it", async () => {
    withMessages([bot()]);
    await opened();
    const human = shadow().querySelector<HTMLElement>(".human")!;
    expect(human.hidden).toBe(false);
    replies["POST /public/rooms/room_1/request-human"] = () => ({ json: { ok: true, already: false, ticket: { id: "tkt_1", number: 1, status: "waiting_for_human", resolved: false, csat_pending: false } } });
    withMessages([bot()], { id: "tkt_1", number: 1, status: "waiting_for_human", resolved: false, csat_pending: false });
    human.querySelector("button")!.click();
    await flush(); await flush(); await flush();
    expect(calls.some((c) => c.path === "/public/rooms/room_1/request-human" && c.method === "POST")).toBe(true);
    expect(shadow().querySelector<HTMLElement>(".human")!.hidden).toBe(true);
  });

  it("follows the ticket live: a handed-over ticket hides the button, a resolved one shows it again", async () => {
    withMessages([bot()]);
    await opened();
    sockets[0]!.fire("ticket:updated", { room_id: "room_1", ticket: { id: "tkt_1", number: 1, status: "open", resolved: false, csat_pending: false } });
    expect(shadow().querySelector<HTMLElement>(".human")!.hidden).toBe(true);
    sockets[0]!.fire("ticket:updated", { room_id: "room_1", ticket: { id: "tkt_1", number: 1, status: "resolved", resolved: true, csat_pending: true } });
    expect(shadow().querySelector<HTMLElement>(".human")!.hidden).toBe(false);
  });

  it("rates the latest AI answer once with thumbs", async () => {
    withMessages([bot()]);
    await opened();
    const up = shadow().querySelector<HTMLButtonElement>('.fb button[data-rating="1"]')!;
    expect(up.getAttribute("aria-label")).toBe("Helpful");
    replies["POST /public/rooms/room_1/messages/msg_ai/feedback"] = () => ({ json: { ok: true } });
    up.click();
    await flush(); await flush();
    expect(calls.find((c) => c.path === "/public/rooms/room_1/messages/msg_ai/feedback")!.body).toEqual({ rating: 1 });
    expect(shadow().querySelector(".fb button")).toBeNull();
    expect(shadow().querySelector(".fb")!.textContent).toContain("Thanks for your feedback");
  });

  it("asks for a 1-5 rating after the ticket is resolved and posts it to the ticket", async () => {
    const closing = mkMsg({ id: "msg_res", seq: 5, sender: { type: "system" }, kind: "system", content_text: "Glad we could help.", meta: { sub_type: "ticket_resolved", card: { type: "csat", ticket_id: "tkt_1", ticket_number: 1 } } });
    withMessages([bot(), closing], { id: "tkt_1", number: 1, status: "resolved", resolved: true, csat_pending: true });
    await opened();
    const buttons = shadow().querySelectorAll<HTMLButtonElement>(".rate button");
    expect(buttons).toHaveLength(5);
    replies["POST /public/rooms/room_1/ticket-csat"] = () => ({ json: { ok: true } });
    buttons[4]!.click();
    await flush(); await flush();
    expect(calls.find((c) => c.path === "/public/rooms/room_1/ticket-csat")!.body).toEqual({ score: 5 });
    expect(shadow().querySelector(".rate")).toBeNull();
  });
});
