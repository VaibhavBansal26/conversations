// The page behind a call link (server/public/chat/callpage.js) in jsdom: the token leaves the address bar at once, only one generic message
// for every failure, the AI disclosure comes before anything is asked, the token only ever travels in a POST body, and the right call code starts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18nSource from "../../../server/public/chat/i18n.js?raw";
import source from "../../../server/public/chat/callpage.js?raw";

const w = window as unknown as { ConversationsI18n?: any; ConversationsCallPage?: any };
// eslint-disable-next-line no-eval
(0, eval)(i18nSource);
// eslint-disable-next-line no-eval
(0, eval)(source);
const Page = w.ConversationsCallPage;

const TOKEN = `${"A".repeat(22)}.${"B".repeat(43)}`;
const PREVIEW_AI = { mode: "ai", kind: "voice", workspace_name: "Acme", ai: { name: "Aria", label: "AI assistant", avatar_url: "/avatars/aria.webp", avatar_alt: "Aria" }, ai_config: { enabled: true, voice: true, video: true }, expires_at: "2030-01-01T00:00:00.000Z" };
const REDEEMED = { session_token: "s".repeat(40), device_id: "cl_x", workspace_id: "ws_1", room_id: "room_1", mode: "ai", kind: "voice", workspace_name: "Acme", ai: PREVIEW_AI.ai, ai_config: PREVIEW_AI.ai_config, expires_at: "2030-01-01T00:00:00.000Z", link_expires_at: "2030-01-01T00:00:00.000Z", display_name: null };

let calls: { url: string; init: any }[];
const reply = (routes: Record<string, { status?: number; body: unknown }>) =>
  vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = routes[url] ?? { status: 404, body: { error: { code: "LINK_UNAVAILABLE" } } };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  });
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const root = () => document.getElementById("cpage")!;

beforeEach(() => {
  document.body.innerHTML = '<main id="cpage"></main>';
  calls = [];
  window.history.pushState({}, "", `/call/${TOKEN}`);
});

describe("call page", () => {
  it("takes the token out of the address bar before anything else", async () => {
    Page.start({ win: window, doc: document, fetch: reply({}), io: vi.fn(), I18n: w.ConversationsI18n });
    expect(window.location.pathname).toBe("/call/");
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("reads the token only from a well-formed address", () => {
    expect(Page.tokenFromPath(`/call/${TOKEN}`)).toBe(TOKEN);
    expect(Page.tokenFromPath("/call/")).toBe("");
    expect(Page.tokenFromPath("/call/short.token")).toBe("");
    expect(Page.tokenFromPath(`/call/${TOKEN}/extra`)).toBe("");
  });

  it("shows one generic message whatever went wrong", async () => {
    for (const status of [404, 410, 429, 500]) {
      document.body.innerHTML = '<main id="cpage"></main>';
      window.history.pushState({}, "", `/call/${TOKEN}`);
      Page.start({ win: window, doc: document, fetch: reply({ "/public/call-links/preview": { status, body: { error: { code: "X" } } } }), io: vi.fn(), I18n: w.ConversationsI18n });
      await flush();
      expect(root().querySelector("[data-cp=gone]")!.textContent).toBe("This link is not available. Ask for a new one.");
    }
  });

  it("shows no login: the AI disclosure first, then an optional name and one button", async () => {
    Page.start({ win: window, doc: document, fetch: reply({ "/public/call-links/preview": { body: PREVIEW_AI } }), io: vi.fn(), I18n: w.ConversationsI18n });
    await flush();
    const text = root().textContent!;
    expect(root().querySelector("[data-cp=disclosure]")!.textContent).toContain("an AI assistant. It is not a person.");
    expect(text).toContain("Your browser will ask to use your microphone.");
    expect(root().querySelector("input[type=password]")).toBeNull();
    expect(root().querySelectorAll("input").length).toBe(1);
    expect(root().querySelector("img.cp-av")!.getAttribute("src")).toBe("/avatars/aria.webp");
    expect(root().querySelector("img.cp-av")!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("never loads an avatar from anywhere but this server", async () => {
    Page.start({ win: window, doc: document, fetch: reply({ "/public/call-links/preview": { body: { ...PREVIEW_AI, ai: { ...PREVIEW_AI.ai, avatar_url: "https://evil.example/x.png" } } } }), io: vi.fn(), I18n: w.ConversationsI18n });
    await flush();
    expect(root().querySelector("img.cp-av")).toBeNull();
  });

  it("redeems with the token in the body (never in a URL), then starts the AI call with the new session", async () => {
    const socket = { connected: true, on: vi.fn(), once: vi.fn(), close: vi.fn() };
    const io = vi.fn(() => socket);
    const started: string[] = [];
    const AiCall = { create: vi.fn(() => ({ bind: vi.fn(), start: (k: string) => started.push(k) })) };
    Page.start({ win: window, doc: document, fetch: reply({ "/public/call-links/preview": { body: PREVIEW_AI }, "/public/call-links/redeem": { status: 201, body: REDEEMED } }), io, AiCall, I18n: w.ConversationsI18n });
    await flush();
    (root().querySelector("[data-cp=name]") as HTMLInputElement).value = "  Sam ";
    (root().querySelector("[data-cp=join]") as HTMLButtonElement).click();
    await flush();
    const redeem = calls.find((c) => c.url === "/public/call-links/redeem")!;
    const body = JSON.parse(redeem.init.body);
    expect(body.token).toBe(TOKEN);
    expect(body.name).toBe("Sam");
    expect(body.device_id).toMatch(/^cl_[0-9a-f]{32}$/);
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.init.credentials).toBe("omit");
      expect(c.init.referrerPolicy).toBe("no-referrer");
    }
    expect(io).toHaveBeenCalledWith("/ws/ws_1", expect.objectContaining({ auth: { session: REDEEMED.session_token, deviceId: "cl_x" } }));
    expect(started).toEqual(["voice"]);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("a team link waits for the team and hands over to the call screen", async () => {
    const handlers: Record<string, (p: any) => void> = {};
    const socket = { connected: true, on: (e: string, h: any) => (handlers[e] = h), once: vi.fn(), close: vi.fn() };
    const bound = vi.fn();
    const Calls = { create: vi.fn(() => ({ bind: bound })) };
    const team = { ...REDEEMED, mode: "team", ai: null, ai_config: null };
    Page.start({ win: window, doc: document, fetch: reply({ "/public/call-links/preview": { body: { ...PREVIEW_AI, mode: "team", ai: null } }, "/public/call-links/redeem": { status: 201, body: team } }), io: () => socket, Calls, I18n: w.ConversationsI18n });
    await flush();
    expect(root().textContent).toContain("Acme would like to talk with you.");
    expect(root().querySelector("[data-cp=disclosure]")).toBeNull();
    (root().querySelector("[data-cp=join]") as HTMLButtonElement).click();
    await flush();
    expect(root().querySelector("[data-cp=waiting]")!.textContent).toContain("Waiting for Acme");
    expect(bound).toHaveBeenCalledWith(socket);
    handlers["call:state"]!({ call: { id: "c1", state: "ringing", transport: "browser" } });
    expect((root().querySelector(".cp-wait") as HTMLElement).hidden).toBe(true);
  });

  it("a refused redeem (used elsewhere) shows the same generic message", async () => {
    Page.start({ win: window, doc: document, fetch: reply({ "/public/call-links/preview": { body: PREVIEW_AI }, "/public/call-links/redeem": { status: 404, body: {} } }), io: vi.fn(), I18n: w.ConversationsI18n });
    await flush();
    (root().querySelector("[data-cp=join]") as HTMLButtonElement).click();
    await flush();
    expect(root().querySelector("[data-cp=gone]")).not.toBeNull();
  });
});
