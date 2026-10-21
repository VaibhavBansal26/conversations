// Calls between two teammates in two real Chrome contexts against the built server, with a synthetic microphone and camera (support/fakeMedia.ts).
// NOT exercised: real networks and TURN relays, other browsers, real devices.
import { DEMO, expect, signIn, stamp, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import type { Browser, BrowserContext, Page } from "@playwright/test";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

const SAM = { email: "sam@example.test", password: DEMO.password };
const spy = `(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; })();`;
const connected = (p: Page) => p.waitForFunction(() => (window as any).__pcs?.some((pc: RTCPeerConnection) => pc.connectionState === "connected"), undefined, { timeout: 20_000 });
const stat = (p: Page, kind: string, field: string) =>
  p.evaluate(async ([k, f]) => {
    let total = 0;
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) (await pc.getStats()).forEach((r: any) => r.type === "inbound-rtp" && r.kind === k && (total += r[f] ?? 0));
    return total;
  }, [kind, field] as const);

async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function setup(browser: Browser, baseURL: string, internal: Record<string, unknown> = {}) {
  const owner = await loginApi(baseURL);
  await req(baseURL, owner.token, "PATCH", "/calls/settings", { internal: { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 30, ...internal } });
  const members = (await req(baseURL, owner.token, "GET", "/members")).data as { id: string; email: string; name: string }[];
  const sam = members.find((m) => m.email === SAM.email)!;
  const dm = await req(baseURL, owner.token, "POST", "/team/dms", { member_ids: [sam.id] });
  const perms = ["microphone", "camera"];
  const octx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: perms });
  const sctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: perms });
  for (const c of [octx, sctx]) {
    await c.addInitScript(spy);
    await c.addInitScript(FAKE_MEDIA_SCRIPT);
  }
  const ownerPage = await octx.newPage();
  const samPage = await sctx.newPage();
  await signIn(ownerPage);
  await signIn(samPage, SAM);
  await ownerPage.goto(`/team/${dm.id}`);
  await expect(ownerPage.getByRole("button", { name: "Video call with Sam Agent" })).toBeVisible();
  return {
    owner, sam, dm, octx, sctx, ownerPage, samPage, base: baseURL,
    done: async (...extra: BrowserContext[]) => {
      await req(baseURL, owner.token, "PATCH", "/calls/settings", { internal: { enabled: false } }).catch(() => {});
      await req(baseURL, owner.token, "PATCH", `/members/${sam.id}`, { dnd_until: null, availability: "active" }).catch(() => {});
      await octx.close();
      await sctx.close();
      for (const c of extra) await c.close();
    },
  };
}

test("a video call between teammates: it rings in another part of the app, media flows both ways, mute reaches the other side, ending leaves a card", async ({ browser, baseURL }) => {
  const w = await setup(browser, baseURL!);
  try {
    // Sam is on a completely different page (the inbox): the call still rings there
    await w.samPage.goto("/inbox");
    await expect(w.ownerPage.getByRole("button", { name: "Video call with Sam Agent" })).toBeEnabled();
    await w.ownerPage.getByRole("button", { name: "Video call with Sam Agent" }).click();
    await expect(w.ownerPage.getByRole("dialog", { name: "Call with Sam Agent" })).toContainText("Calling Sam Agent");
    const ring = w.samPage.getByRole("alertdialog", { name: "Incoming call" });
    await expect(ring).toContainText("is calling you (video)");
    await expect(ring.getByRole("button", { name: /^Accept the call from/ })).toBeFocused();
    await ring.getByRole("button", { name: /^Accept the call from/ }).click();
    await Promise.all([connected(w.ownerPage), connected(w.samPage)]);
    await expect(w.ownerPage.getByRole("timer")).toHaveText(/^\d\d:\d\d$/);
    await expect(w.samPage.getByRole("timer")).toHaveText(/^\d\d:\d\d$/);
    await expect.poll(() => stat(w.ownerPage, "video", "framesDecoded"), { timeout: 15_000 }).toBeGreaterThan(5);
    await expect.poll(() => stat(w.samPage, "video", "framesDecoded"), { timeout: 15_000 }).toBeGreaterThan(5);
    await expect.poll(() => stat(w.samPage, "audio", "totalAudioEnergy"), { timeout: 15_000 }).toBeGreaterThan(0);

    // muting on one side silences it on the other
    await w.ownerPage.getByRole("button", { name: "Mute microphone" }).click();
    await w.samPage.waitForTimeout(1500);
    const before = await stat(w.samPage, "audio", "totalAudioEnergy");
    await w.samPage.waitForTimeout(2000);
    expect(await stat(w.samPage, "audio", "totalAudioEnergy")).toBeLessThan(before + 0.0001);
    await w.ownerPage.getByRole("button", { name: "Unmute microphone" }).click();
    await expect.poll(() => stat(w.samPage, "audio", "totalAudioEnergy"), { timeout: 10_000 }).toBeGreaterThan(before + 0.0001);

    // the callee hangs up: both leave, the card says how long
    await w.samPage.getByRole("button", { name: "End call" }).click();
    await expect(w.ownerPage.getByRole("dialog", { name: "Call with Sam Agent" })).toContainText("The call ended.");
    await expect(w.ownerPage.getByText(/^Video call, (\d+ s|\d+ min)$/)).toBeVisible();
    expect(await w.ownerPage.evaluate(() => (window as any).__pcs.every((pc: RTCPeerConnection) => pc.connectionState === "closed"))).toBe(true);
  } finally {
    await w.done();
  }
});

test("a voice call that is declined, then cancelled while ringing, leaves cards and clear words", async ({ browser, baseURL }) => {
  const w = await setup(browser, baseURL!);
  try {
    await w.ownerPage.getByRole("button", { name: "Voice call with Sam Agent" }).click();
    await w.samPage.getByRole("alertdialog", { name: "Incoming call" }).getByRole("button", { name: /^Decline the call/ }).click();
    await expect(w.ownerPage.getByRole("dialog", { name: "Call with Sam Agent" })).toContainText("Sam Agent declined the call.");
    await expect(w.ownerPage.getByText("Voice call declined")).toBeVisible();
    await w.ownerPage.getByRole("button", { name: "Close" }).click();
    await w.ownerPage.getByRole("button", { name: "Voice call with Sam Agent" }).click();
    await expect(w.samPage.getByRole("alertdialog", { name: "Incoming call" })).toBeVisible();
    await w.ownerPage.getByRole("button", { name: "Cancel call" }).click();
    await expect(w.samPage.getByRole("alertdialog", { name: "Incoming call" })).toBeHidden();
    await expect(w.samPage.getByRole("dialog", { name: /^Call with / })).toContainText("cancelled the call");
  } finally {
    await w.done();
  }
});

test("a call nobody answers is missed after the ring time and the callee is told", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const w = await setup(browser, baseURL!, { ring_seconds: 10 });
  try {
    await w.ownerPage.getByRole("button", { name: "Voice call with Sam Agent" }).click();
    await expect(w.samPage.getByRole("alertdialog", { name: "Incoming call" })).toBeVisible();
    await expect(w.samPage.getByRole("alertdialog", { name: "Incoming call" })).toBeHidden({ timeout: 25_000 });
    await expect(w.ownerPage.getByRole("dialog", { name: "Call with Sam Agent" })).toContainText("did not answer");
    await expect(w.ownerPage.getByText("Missed voice call")).toBeVisible();
    await expect(w.samPage.getByRole("dialog", { name: /Call with/ })).toContainText("Missed call from");
  } finally {
    await w.done();
  }
});

test("do not disturb and being offline stop the call before it rings, with the reason", async ({ browser, baseURL }) => {
  const w = await setup(browser, baseURL!);
  try {
    await req(w.base, w.owner.token, "PATCH", `/members/${w.sam.id}`, { dnd_until: new Date(Date.now() + 3600_000).toISOString() });
    await w.ownerPage.getByRole("button", { name: "Voice call with Sam Agent" }).click();
    await expect(w.ownerPage.getByText("They are not available for calls right now.")).toBeVisible();
    await expect(w.samPage.getByRole("alertdialog", { name: "Incoming call" })).toHaveCount(0);
    await req(w.base, w.owner.token, "PATCH", `/members/${w.sam.id}`, { dnd_until: null });
    await w.sctx.close();
    await expect(w.ownerPage.getByRole("button", { name: "Voice call with Sam Agent" })).toBeDisabled({ timeout: 10_000 });
  } finally {
    await w.done();
  }
});

test("the buttons are not there when calls between teammates are off, and group conversations have none", async ({ browser, baseURL }) => {
  const w = await setup(browser, baseURL!);
  try {
    await expect(w.ownerPage.getByRole("button", { name: "Voice call with Sam Agent" })).toBeVisible();
    await req(w.base, w.owner.token, "PATCH", "/calls/settings", { internal: { enabled: false } });
    await w.ownerPage.reload();
    await expect(w.ownerPage.getByRole("heading", { name: "Sam Agent" })).toBeVisible();
    await expect(w.ownerPage.getByRole("button", { name: /call with Sam Agent/i })).toHaveCount(0);
    await req(w.base, w.owner.token, "PATCH", "/calls/settings", { internal: { enabled: true } });
    await w.ownerPage.goto("/team");
    await w.ownerPage.getByRole("link", { name: /general/ }).click();
    await expect(w.ownerPage.getByRole("button", { name: /^(Voice|Video) call with/ })).toHaveCount(0);
  } finally {
    await w.done();
  }
});
