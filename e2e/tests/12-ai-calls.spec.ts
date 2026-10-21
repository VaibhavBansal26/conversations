// Calls with the AI assistant in a real Chrome against the built server. The Web Speech API is replaced by a fake injected into the page
// (support/fakeSpeech.ts: no microphone, no speech service, no speakers) and the microphone by the synthetic one; everything else is real: the widget,
// the sockets, the server pipeline (the offline rules agent answers from the knowledge base), tickets, hand-over and the human call that follows.
// NOT exercised: real speech recognition and synthesis, other browsers, real devices.
import { expect, signIn, stamp, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import { FAKE_NO_SPEECH_SCRIPT, FAKE_SPEECH_SCRIPT } from "../support/fakeSpeech";
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

/** an AI agent and two knowledge-base entries for the length of one test, calls with the AI on; removed afterwards so the other specs never meet an AI */
async function aiWorkspace(baseURL: string, ai: Record<string, unknown> = {}, browserCalls = false) {
  const api = await loginApi(baseURL);
  const kb = [
    await req(baseURL, api.token, "POST", "/kb", { question: "How do I reset my password?", answer: "Open Settings, choose Security and press Reset password. We email you a link.", url: "https://help.example.test/reset-password" }),
    await req(baseURL, api.token, "POST", "/kb", { question: "What are your opening hours?", answer: "Our support team is available Monday to Friday from 9 to 17 CET." }),
  ];
  const agent = await req(baseURL, api.token, "POST", "/agents", { name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", max_turns: 20 });
  await req(baseURL, api.token, "PATCH", "/workspace", { settings: { routing: { require_online: false }, calls: { browser: { enabled: browserCalls, voice: true, video: true, screen_share: true }, ring_seconds: 15, ai: { enabled: true, idle_timeout_s: 30, daily_limit: 500, ...ai } } } });
  return {
    api,
    cleanup: async () => {
      await req(baseURL, api.token, "PATCH", "/workspace", { settings: { calls: { browser: { enabled: false }, ai: { enabled: false } } } }).catch(() => {});
      await req(baseURL, api.token, "DELETE", `/agents/${agent.id}`).catch(() => {});
      for (const k of kb) await req(baseURL, api.token, "DELETE", `/kb/${k.id}`).catch(() => {});
    },
  };
}

async function visitorPage(browser: Browser, siteUrl: string, scripts: string[], name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, permissions: ["microphone", "camera"] });
  await ctx.addInitScript(spy);
  await ctx.addInitScript(FAKE_MEDIA_SCRIPT);
  for (const s of scripts) await ctx.addInitScript(s);
  const page = await ctx.newPage();
  await page.goto(siteUrl);
  await page.getByRole("button", { name: "Open chat" }).click();
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel(/^Email/).fill(`ai.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`);
  await page.getByRole("button", { name: "Start chat" }).click();
  return { ctx, page };
}
const name = () => `Caller Dee ${stamp}${Math.floor(Math.random() * 1000)}`;
const dialog = (p: Page) => p.getByRole("dialog", { name: /Call with Aria/ });
const speech = (p: Page) => ({
  hear: (t: string) => p.evaluate((x) => (window as any).__speech.hear(x), t),
  say: (t: string) => p.evaluate((x) => (window as any).__speech.say(x), t),
  finish: () => p.evaluate(() => (window as any).__speech.finish()),
  spoken: () => p.evaluate(() => [...(window as any).__speech.spoken] as string[]),
  cancelled: () => p.evaluate(() => (window as any).__speech.cancelled as number),
  running: () => p.evaluate(() => (window as any).__speech.running as boolean),
});

test("the loop: the visitor speaks, the assistant answers from the knowledge base, its voice reads the answer without the link, and the thread keeps both sides", async ({ browser, baseURL }) => {
  const w = await aiWorkspace(baseURL!);
  const site = await startCustomerSite(baseURL!);
  const v = await visitorPage(browser, site.url, [FAKE_SPEECH_SCRIPT], name());
  try {
    await v.page.getByRole("button", { name: "Talk to our AI assistant (voice)" }).click();
    const d = dialog(v.page);
    await expect(d).toBeVisible();
    await expect(d).toContainText("AI assistant, not a person");
    await expect(d).toContainText("This call is not recorded");
    const s = speech(v.page);
    // the disclosure is spoken first, and the visitor can already talk (so can interrupt)
    await expect.poll(async () => (await s.spoken()).join(" ")).toContain("not a person");
    await expect.poll(s.running).toBe(true);
    await s.finish();

    await s.hear("how do I");
    await expect(d.getByRole("log", { name: "Captions" })).toContainText("how do I");
    await s.say("how do I reset my password");
    await expect(d.getByRole("log", { name: "Captions" })).toContainText("Reset password", { timeout: 15_000 });
    await expect(d.getByRole("log", { name: "Captions" })).toContainText("help.example.test"); // the caption keeps the link
    const heard = (await s.spoken()).at(-1)!;
    expect(heard).toContain("Reset password");
    expect(heard).not.toContain("https://"); // the voice does not read it out
    await expect(d).toHaveAttribute("data-phase", "speaking");

    // barge-in: the visitor speaks over the answer and its voice is cut at once
    const cut = await s.cancelled();
    await s.hear("wait one moment");
    expect(await s.cancelled()).toBeGreaterThan(cut);
    await expect(d).toHaveAttribute("data-phase", "listening");

    // both sides are in the thread as ordinary messages
    await d.getByRole("button", { name: "End call" }).click();
    await expect(d.getByRole("button", { name: "Close" })).toBeVisible();
    await d.getByRole("button", { name: "Close" }).click();
    const thread = v.page.getByLabel("Conversation");
    await expect(thread.getByText("how do I reset my password", { exact: true })).toBeVisible();
    await expect(thread.getByText(/AI voice call, .* ended by the visitor/)).toBeVisible();
    await expect(thread.getByText(/Hi, I'm Aria \(AI assistant\), not a person/)).toBeVisible();
  } finally {
    await v.ctx.close();
    await site.close();
    await w.cleanup();
  }
});

test("silence: the assistant asks whether the visitor is there, then ends the call and the thread says so", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const w = await aiWorkspace(baseURL!, { idle_timeout_s: 30 });
  const site = await startCustomerSite(baseURL!);
  const v = await visitorPage(browser, site.url, [FAKE_SPEECH_SCRIPT], name());
  try {
    await v.page.getByRole("button", { name: "Talk to our AI assistant (voice)" }).click();
    const d = dialog(v.page);
    await expect(d).toBeVisible();
    const sp = speech(v.page);
    await expect.poll(async () => (await sp.spoken()).length).toBeGreaterThan(0); // the greeting
    await sp.finish();
    // idle timeout 30 s: the prompt comes after 5 s and the end after about 11 s
    await expect(d.getByRole("log", { name: "Captions" })).toContainText("Are you still there?", { timeout: 15_000 });
    await sp.finish();
    await expect(d.getByRole("status")).toContainText("I did not hear anything", { timeout: 25_000 });
    await d.getByRole("button", { name: "Close" }).click();
    await expect(v.page.getByLabel("Conversation").getByText(/AI voice call, .* ended after silence/)).toBeVisible();
  } finally {
    await v.ctx.close();
    await site.close();
    await w.cleanup();
  }
});

test("talk to a person: the call is handed over without dropping the visitor, the team rings, and the visitor answers on the same screen", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const w = await aiWorkspace(baseURL!, {}, true);
  const site = await startCustomerSite(baseURL!);
  const who = name();
  const v = await visitorPage(browser, site.url, [FAKE_SPEECH_SCRIPT], who);
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone", "camera"] });
  await actx.addInitScript(spy);
  await actx.addInitScript(FAKE_MEDIA_SCRIPT);
  try {
    await v.page.getByRole("button", { name: "Talk to our AI assistant (voice)" }).click();
    const d = dialog(v.page);
    await expect(d).toBeVisible();
    await d.getByRole("button", { name: "Talk to a person" }).click();
    await expect(d).toHaveAttribute("data-phase", "waiting");
    await expect(d.getByRole("status")).toContainText("they will call you here");

    const agent = await actx.newPage();
    await signIn(agent);
    await agent.getByRole("region", { name: "Conversations" }).getByRole("link", { name: new RegExp(who) }).first().click();
    const log = agent.getByRole("log", { name: "Conversation messages" });
    await expect(log.getByText(/AI voice call, .* handed to a person/)).toBeVisible();
    await expect(log.getByText("Voice call requested")).toBeVisible();
    await agent.getByRole("button", { name: "Call now" }).click();
    // the waiting screen gives way to the ordinary incoming-call screen
    const incoming = v.page.getByRole("dialog", { name: "Call" });
    await expect(incoming).toContainText("is calling you");
    await expect(dialog(v.page)).toBeHidden();
    await incoming.getByRole("button", { name: "Accept" }).click();
    await Promise.all([connected(agent), connected(v.page)]);
    await agent.getByRole("button", { name: "End call" }).click();
  } finally {
    await v.ctx.close();
    await actx.close();
    await site.close();
    await w.cleanup();
  }
});

test("a browser without speech recognition says so and opens the text chat with the same assistant (the fallback)", async ({ browser, baseURL }) => {
  const w = await aiWorkspace(baseURL!);
  const site = await startCustomerSite(baseURL!);
  const v = await visitorPage(browser, site.url, [FAKE_NO_SPEECH_SCRIPT], name());
  try {
    await v.page.getByRole("button", { name: "Talk to our AI assistant (voice)" }).click();
    await expect(v.page.getByText(/cannot recognise speech/)).toBeVisible();
    await expect(v.page.getByRole("dialog", { name: /Call with/ })).toHaveCount(0);
    await expect(v.page.getByRole("textbox", { name: "Message" })).toBeFocused();
    // the same assistant answers in writing
    await v.page.keyboard.type("What are your opening hours?");
    await v.page.getByRole("button", { name: "Send message" }).click();
    await expect(v.page.getByLabel("Conversation").getByText(/Monday to Friday/)).toBeVisible({ timeout: 15_000 });
  } finally {
    await v.ctx.close();
    await site.close();
    await w.cleanup();
  }
});

test("the buttons are not offered when calls with the AI are off", async ({ browser, baseURL }) => {
  const api = await loginApi(baseURL!);
  await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { calls: { ai: { enabled: false } } } });
  const site = await startCustomerSite(baseURL!);
  const v = await visitorPage(browser, site.url, [FAKE_SPEECH_SCRIPT], name());
  try {
    await expect(v.page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(v.page.getByRole("button", { name: /AI assistant/ })).toHaveCount(0);
  } finally {
    await v.ctx.close();
    await site.close();
  }
});
