// Browser calls between the inbox and the widget, in two real Chrome contexts against the built server, with a synthetic camera, microphone and
// screen (support/fakeMedia.ts: no real devices, no real network: both peers connect over loopback). NOT exercised here: TURN relays, real NATs, mobile browsers.
import { expect, signIn, stamp, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import { startCustomerSite } from "../support/site";
import type { BrowserContext, Page } from "@playwright/test";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

/** every RTCPeerConnection the page creates, so the test can read its state and statistics */
const spy = `(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; })();`;
const connected = (p: Page) => p.waitForFunction(() => (window as any).__pcs?.some((pc: RTCPeerConnection) => pc.connectionState === "connected"), undefined, { timeout: 20_000 });
const stat = (p: Page, kind: string, field: string) =>
  p.evaluate(async ([k, f]) => {
    let total = 0;
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) (await pc.getStats()).forEach((r: any) => r.type === "inbound-rtp" && r.kind === k && (total += r[f] ?? 0));
    return total;
  }, [kind, field] as const);

async function setup(browser: import("@playwright/test").Browser, baseURL: string, calls: Record<string, unknown> = {}) {
  const api = await loginApi(baseURL);
  const patch = await fetch(`${baseURL}/api/workspace`, { method: "PATCH", headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" }, body: JSON.stringify({ settings: { calls: { browser: { enabled: true, voice: true, video: true, screen_share: true }, ring_seconds: 15, turn_provider: "none", ...calls } } }) });
  expect(patch.status).toBe(200);
  const site = await startCustomerSite(baseURL);
  const perms = ["microphone", "camera"];
  const vctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, permissions: perms });
  await vctx.addInitScript(spy);
  await vctx.addInitScript(FAKE_MEDIA_SCRIPT);
  const visitor = await vctx.newPage();
  await visitor.goto(site.url);
  await visitor.getByRole("button", { name: "Open chat" }).click();
  const name = `Caller Cass ${stamp}${Math.floor(Math.random() * 1000)}`;
  await visitor.getByLabel("Your name").fill(name);
  await visitor.getByLabel(/^Email/).fill(`cass.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`);
  await visitor.getByRole("button", { name: "Start chat" }).click();
  const input = visitor.getByRole("textbox", { name: "Message" });
  await input.click();
  await input.pressSequentially(`Can we talk? ${stamp}`, { delay: 5 });
  await visitor.getByRole("button", { name: "Send message" }).click();
  await expect(visitor.getByLabel("Conversation").getByText(`Can we talk? ${stamp}`)).toBeVisible();
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: perms });
  await actx.addInitScript(spy);
  await actx.addInitScript(FAKE_MEDIA_SCRIPT);
  const agent = await actx.newPage();
  await signIn(agent);
  await agent.getByRole("region", { name: "Conversations" }).getByRole("link", { name: new RegExp(name) }).first().click();
  await expect(agent.getByRole("log", { name: "Conversation messages" }).getByText(`Can we talk? ${stamp}`)).toBeVisible();
  return { api, site, vctx, actx, visitor, agent, name, close: async (...c: BrowserContext[]) => (await Promise.all(c.map((x) => x.close())), await site.close()) };
}

test("a video call: the visitor accepts, media flows both ways, mute reaches the other side, and ending leaves a card in the thread", async ({ browser, baseURL }) => {
  const w = await setup(browser, baseURL!);
  await w.agent.getByRole("button", { name: "Video call" }).click();
  const incoming = w.visitor.getByRole("dialog", { name: "Call" });
  await expect(incoming).toContainText("is calling you (video)");
  await expect(w.agent.getByRole("dialog", { name: "Call" })).toContainText("Ringing");
  await incoming.getByRole("button", { name: "Accept" }).click();
  await Promise.all([connected(w.agent), connected(w.visitor)]);
  await expect(w.agent.getByRole("timer")).toHaveText(/^\d\d:\d\d$/);

  // frames really flow in both directions
  await expect.poll(() => stat(w.agent, "video", "framesDecoded"), { timeout: 15_000 }).toBeGreaterThan(5);
  await expect.poll(() => stat(w.visitor, "video", "framesDecoded"), { timeout: 15_000 }).toBeGreaterThan(5);
  await expect.poll(() => stat(w.visitor, "audio", "totalAudioEnergy"), { timeout: 15_000 }).toBeGreaterThan(0);

  // muting on one side silences it on the other: the audio energy stops growing
  await w.agent.getByRole("button", { name: "Mute microphone" }).click();
  await expect(w.agent.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
  await w.visitor.waitForTimeout(1500);
  const before = await stat(w.visitor, "audio", "totalAudioEnergy");
  await w.visitor.waitForTimeout(2000);
  expect(await stat(w.visitor, "audio", "totalAudioEnergy")).toBeLessThan(before + 0.0001);
  await w.agent.getByRole("button", { name: "Unmute microphone" }).click();
  await expect.poll(() => stat(w.visitor, "audio", "totalAudioEnergy"), { timeout: 10_000 }).toBeGreaterThan(before + 0.0001);

  // camera off toggles the control state on both ends of the UI
  await w.visitor.getByRole("button", { name: "Turn camera off" }).click();
  await expect(w.visitor.getByRole("button", { name: "Turn camera on" })).toHaveAttribute("aria-pressed", "true");

  // the agent ends it: both sides leave the call and the thread keeps a card
  await w.agent.getByRole("button", { name: "End call" }).click();
  await expect(w.visitor.getByRole("dialog", { name: "Call" })).toContainText("Call ended");
  await expect(w.agent.getByRole("dialog", { name: "Call" })).toContainText("The call ended.");
  await expect(w.agent.getByRole("log", { name: "Conversation messages" }).getByText(/Video call, .* ended by the agent/)).toBeVisible();
  await expect(w.visitor.getByLabel("Conversation").getByText(/Video call, .* ended by the agent/)).toBeVisible();
  // every media track was released
  const live = await w.agent.evaluate(() => (window as any).__pcs.every((pc: RTCPeerConnection) => pc.connectionState === "closed"));
  expect(live).toBe(true);
  await w.close(w.vctx, w.actx);
});

test("a voice call can be hung up by the visitor", async ({ browser, baseURL }) => {
  const w = await setup(browser, baseURL!);
  await w.agent.getByRole("button", { name: "Voice call" }).click();
  await w.visitor.getByRole("dialog", { name: "Call" }).getByRole("button", { name: "Accept" }).click();
  await Promise.all([connected(w.agent), connected(w.visitor)]);
  await w.visitor.getByRole("button", { name: "End call" }).click();
  await expect(w.agent.getByRole("dialog", { name: "Call" })).toContainText("The call ended.");
  await expect(w.agent.getByRole("log", { name: "Conversation messages" }).getByText(/Voice call, .* ended by the visitor/)).toBeVisible();
  await w.close(w.vctx, w.actx);
});

test("a declined call tells the agent and offers the visitor a callback form that saves the number", async ({ browser, baseURL }) => {
  const w = await setup(browser, baseURL!);
  await w.agent.getByRole("button", { name: "Voice call" }).click();
  await w.visitor.getByRole("dialog", { name: "Call" }).getByRole("button", { name: "Decline" }).click();
  await expect(w.agent.getByRole("dialog", { name: "Call" })).toContainText("declined");
  await expect(w.agent.getByRole("log", { name: "Conversation messages" }).getByText("Voice call declined")).toBeVisible();
  const form = w.visitor.getByRole("form", { name: "Your details" });
  await expect(form).toBeVisible();
  await form.getByLabel(/^Phone number/).fill("415 555 2671");
  await form.getByRole("button", { name: "Send" }).click();
  await expect(form).toBeHidden();
  await expect.poll(async () => JSON.stringify(await w.api.get("/contacts", { search: w.name }))).toContain("+14155552671");
  await w.close(w.vctx, w.actx);
});

test("a call nobody answers is missed after the ring time and the visitor can leave a number", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const w = await setup(browser, baseURL!);
  await w.agent.getByRole("button", { name: "Voice call" }).click();
  await expect(w.visitor.getByRole("dialog", { name: "Call" })).toContainText("is calling you");
  await expect(w.agent.getByRole("dialog", { name: "Call" })).toContainText("did not answer", { timeout: 30_000 });
  await expect(w.visitor.getByRole("dialog", { name: "Call" })).toBeHidden();
  await expect(w.agent.getByRole("log", { name: "Conversation messages" }).getByText("Missed voice call")).toBeVisible();
  await expect(w.visitor.getByLabel("Conversation").getByText("Sorry we missed each other.")).toBeVisible();
  await w.close(w.vctx, w.actx);
});

test("the visitor asks for a call and the agent starts it from the card in the thread", async ({ browser, baseURL }) => {
  const w = await setup(browser, baseURL!);
  await w.visitor.getByRole("button", { name: "Request a voice call" }).click();
  await expect(w.visitor.getByText("Request sent")).toBeVisible();
  const card = w.agent.getByRole("log", { name: "Conversation messages" }).getByText("Voice call requested");
  await expect(card).toBeVisible();
  await w.agent.getByRole("button", { name: "Call now" }).click();
  await w.visitor.getByRole("dialog", { name: "Call" }).getByRole("button", { name: "Accept" }).click();
  await Promise.all([connected(w.agent), connected(w.visitor)]);
  await w.agent.getByRole("button", { name: "End call" }).click();
  await w.close(w.vctx, w.actx);
});

test("the call buttons are hidden while calls are switched off", async ({ browser, baseURL }) => {
  const api = await loginApi(baseURL!);
  await fetch(`${baseURL}/api/workspace`, { method: "PATCH", headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" }, body: JSON.stringify({ settings: { calls: { browser: { enabled: false } } } }) });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page);
  await page.getByRole("region", { name: "Conversations" }).getByRole("link").first().click();
  await expect(page.getByRole("button", { name: "Voice call" })).toHaveCount(0);
  await ctx.close();
});
