// Call links in two real Chrome contexts against the built server: a visitor who closed the chat (no session, no cookies) opens /call/<token> from
// a link the team or the AI assistant made, and joins a call with the AI (fake Web Speech) or with a teammate (synthetic microphone and camera).
// NOT exercised: email and SMS delivery of the link (covered by server tests with the not_sent_test_mode path), real speech, other browsers, real devices.
import { expect, signIn, stamp, test } from "../support/fixtures";
import { embedToken, loginApi, visitorConversation } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import { FAKE_SPEECH_SCRIPT } from "../support/fakeSpeech";
import { startCustomerSite } from "../support/site";
import type { Browser, BrowserContext, Page } from "@playwright/test";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

const spy = `(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; })();`;
const connected = (p: Page) => p.waitForFunction(() => (window as any).__pcs?.some((pc: RTCPeerConnection) => pc.connectionState === "connected"), undefined, { timeout: 20_000 });

async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** call links and calls with the AI switched on, one AI agent and a knowledge-base entry for the length of one test */
async function workspace(baseURL: string) {
  const api = await loginApi(baseURL);
  const kb = await req(baseURL, api.token, "POST", "/kb", { question: "How do I reset my password?", answer: "Open Settings, choose Security and press Reset password. We email you a link.", url: "https://help.example.test/reset-password" });
  const agent = await req(baseURL, api.token, "POST", "/agents", { name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", max_turns: 20 });
  await req(baseURL, api.token, "PATCH", "/workspace", { settings: { routing: { require_online: false }, calls: { browser: { enabled: true, voice: true, video: true, screen_share: true }, ring_seconds: 30, links: { enabled: true, ttl_minutes: 30, allow_ai: true, allow_team: true }, ai: { enabled: true, idle_timeout_s: 30, daily_limit: 500 } } } });
  return {
    api,
    cleanup: async () => {
      await req(baseURL, api.token, "PATCH", "/workspace", { settings: { calls: { browser: { enabled: false }, links: { enabled: false }, ai: { enabled: false } } } }).catch(() => {});
      await req(baseURL, api.token, "DELETE", `/agents/${agent.id}`).catch(() => {});
      await req(baseURL, api.token, "DELETE", `/kb/${kb.id}`).catch(() => {});
    },
  };
}

/** a visitor who wrote in once and left: the conversation exists, nobody is in the chat */
async function leftVisitor(baseURL: string) {
  const name = `Linked Lee ${stamp}${Math.floor(Math.random() * 1000)}`;
  const roomId = await visitorConversation(baseURL, await embedToken(baseURL), { name, email: `lee.${stamp}${Math.floor(Math.random() * 1e6)}@example.test` }, [`Please call me ${stamp}`]);
  return { name, roomId };
}

async function linkContext(browser: Browser, scripts: string[] = []) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, permissions: ["microphone", "camera"] });
  await ctx.addInitScript(spy);
  await ctx.addInitScript(FAKE_MEDIA_SCRIPT);
  for (const s of scripts) await ctx.addInitScript(s);
  return ctx;
}

test("an AI link opened by a visitor with no chat open: the address is cleaned, the AI is announced, the call works, and the used link says only that it is not available", async ({ browser, baseURL }) => {
  const w = await workspace(baseURL!);
  const v = await leftVisitor(baseURL!);
  const ctx = await linkContext(browser, [FAKE_SPEECH_SCRIPT]);
  try {
    const made = await req(baseURL!, w.api.token, "POST", `/rooms/${v.roomId}/call-links`, { mode: "ai", kind: "voice" });
    expect(made.url).toMatch(/\/call\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const token = made.url.split("/call/")[1] as string;
    const page = await ctx.newPage();
    const sent: string[] = [];
    page.on("request", (r) => sent.push(`${r.method()} ${r.url()} ${r.headers()["referer"] ?? ""}`));
    const res = await page.goto(made.url);
    expect(res!.headers()["referrer-policy"]).toBe("no-referrer");
    expect(res!.headers()["cache-control"]).toMatch(/no-store/);
    // the credential left the address bar and never appears in a request URL or a Referer
    await expect(page.getByRole("button", { name: "Join call" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/call/");
    expect(sent.filter((l) => l.includes(token) && !l.startsWith("GET " + made.url))).toEqual([]);
    // the AI is announced before the visitor is asked for anything
    await expect(page.locator("[data-cp=disclosure]")).toContainText("AI assistant");
    await expect(page.locator("[data-cp=disclosure]")).toContainText("It is not a person");
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await page.getByLabel("Your name (optional)").fill("Lee");
    await page.getByRole("button", { name: "Join call" }).click();
    const d = page.getByRole("dialog", { name: /Call with Aria/ });
    await expect(d).toBeVisible();
    await expect(d).toContainText("AI assistant, not a person");
    const hear = (t: string) => page.evaluate((x) => (window as any).__speech.say(x), t);
    await expect.poll(() => page.evaluate(() => (window as any).__speech.running as boolean)).toBe(true);
    await page.evaluate(() => (window as any).__speech.finish());
    await hear("how do I reset my password");
    await expect(d.getByRole("log", { name: "Captions" })).toContainText("Reset password", { timeout: 15_000 });
    await d.getByRole("button", { name: "End call" }).click();
    // the link is used up: a second visit shows the one generic message
    const again = await ctx.newPage();
    await again.goto(made.url);
    await expect(again.locator("[data-cp=gone]")).toHaveText("This link is not available. Ask for a new one.");
    // the team sees the call in the conversation, with the redirect-free link not repeated in any message
    const msgs = (await req(baseURL!, w.api.token, "GET", `/rooms/${v.roomId}/messages`)).data as { content_text?: string; content?: string }[];
    expect(JSON.stringify(msgs)).not.toContain(token);
    expect(msgs.some((m) => /AI voice call/.test(m.content_text ?? m.content ?? ""))).toBe(true);
  } finally {
    await ctx.close();
    await w.cleanup();
  }
});

test("a team link: the visitor waits on the page, the team starts the call from the request card, media flows, the link is then spent", async ({ browser, baseURL }) => {
  const w = await workspace(baseURL!);
  const v = await leftVisitor(baseURL!);
  const vctx = await linkContext(browser);
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone", "camera"] });
  await actx.addInitScript(spy);
  await actx.addInitScript(FAKE_MEDIA_SCRIPT);
  try {
    const made = await req(baseURL!, w.api.token, "POST", `/rooms/${v.roomId}/call-links`, { mode: "team", kind: "voice" });
    const agent = await actx.newPage();
    await signIn(agent);
    await agent.getByRole("region", { name: "Conversations" }).getByRole("link", { name: new RegExp(v.name) }).first().click();
    const thread = agent.getByRole("log", { name: "Conversation messages" });
    await expect(thread.getByText(/Join a call with our team/)).toBeVisible();
    const page = await vctx.newPage();
    await page.goto(made.url);
    await expect(page.locator("[data-cp=disclosure]")).toHaveCount(0);
    await page.getByRole("button", { name: "Join call" }).click();
    await expect(page.locator("[data-cp=waiting]")).toContainText("Waiting for");
    await expect(thread.getByText("Voice call requested")).toBeVisible({ timeout: 15_000 });
    await agent.getByRole("button", { name: "Call now" }).click();
    await page.getByRole("dialog", { name: "Call" }).getByRole("button", { name: "Accept" }).click();
    await Promise.all([connected(agent), connected(page)]);
    await agent.getByRole("button", { name: "End call" }).click();
    await expect(page.locator("[data-cp=done]")).toBeVisible({ timeout: 10_000 });
    const again = await vctx.newPage();
    await again.goto(made.url);
    await expect(again.locator("[data-cp=gone]")).toBeVisible();
  } finally {
    await vctx.close();
    await actx.close();
    await w.cleanup();
  }
});

test("the link card in the widget has a Join button that opens the page in a new tab; a revoked link no longer opens", async ({ browser, baseURL }) => {
  const w = await workspace(baseURL!);
  const site = await startCustomerSite(baseURL!);
  const ctx: BrowserContext = await linkContext(browser);
  try {
    const page = await ctx.newPage();
    await page.goto(site.url);
    await page.getByRole("button", { name: "Open chat" }).click();
    await page.getByLabel("Your name").fill(`Widget Wes ${stamp}`);
    await page.getByLabel(/^Email/).fill(`wes.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`);
    await page.getByRole("button", { name: "Start chat" }).click();
    const input = page.getByRole("textbox", { name: "Message" });
    await input.click();
    await input.pressSequentially(`Hello ${stamp}`, { delay: 5 });
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByLabel("Conversation").getByText(`Hello ${stamp}`)).toBeVisible();
    const rooms = (await req(baseURL!, w.api.token, "GET", "/rooms?status=open&limit=50")).data as { id: string; contact?: { name?: string } }[];
    const room = rooms.find((r) => r.contact?.name === `Widget Wes ${stamp}`)!;
    const made = await req(baseURL!, w.api.token, "POST", `/rooms/${room.id}/call-links`, { mode: "team", kind: "video" });
    const card = page.getByLabel("Conversation").locator(".calllink");
    await expect(card).toContainText("Call with our team");
    await expect(card).toContainText("Video call");
    const join = card.getByRole("link", { name: "Join call" });
    await expect(join).toHaveAttribute("target", "_blank");
    await expect(join).toHaveAttribute("rel", /noopener/);
    expect(await join.getAttribute("href")).toBe(made.url);
    const [popup] = await Promise.all([ctx.waitForEvent("page"), join.click()]);
    await expect(popup.getByRole("button", { name: "Join call" })).toBeVisible();
    expect(new URL(popup.url()).pathname).toBe("/call/");
    await popup.close();
    // revoking replaces the card's button with a status line and the address stops working
    await req(baseURL!, w.api.token, "DELETE", `/rooms/${room.id}/call-links/${made.id}`);
    await expect(card).toContainText("Link cancelled");
    await expect(card.getByRole("link", { name: "Join call" })).toHaveCount(0);
    const dead = await ctx.newPage();
    await dead.goto(made.url);
    await expect(dead.locator("[data-cp=gone]")).toBeVisible();
  } finally {
    await ctx.close();
    await site.close();
    await w.cleanup();
  }
});
