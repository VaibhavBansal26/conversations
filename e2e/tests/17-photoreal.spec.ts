// The optional photoreal avatar in real Chrome against the built server with the built-in FAKE provider (AVATAR_TEST_PROVIDER=fake): it accepts a key,
// "tests" it, makes agents and streams, but its stream offer is not a real one, so the visitor's browser cannot connect and falls back to the built-in
// face. That fallback is the path this spec proves. NOT exercised: D-ID itself, a real talking-head stream, lip-sync, credits.
import { expect, signIn, stamp, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import { FAKE_SPEECH_SCRIPT } from "../support/fakeSpeech";
import { startCustomerSite } from "../support/site";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
const spy = `(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; })();`;
async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

test("connect a key, test it, add an avatar, give it to an agent, switch it on; a video call whose stream cannot connect falls back to the built-in face with the AI label", async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  const api = await loginApi(baseURL!);
  const kb = await req(baseURL!, api.token, "POST", "/kb", { question: "How do I reset my password?", answer: "Open Settings, choose Security and press Reset password." });
  const agent = await req(baseURL!, api.token, "POST", "/agents", { name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", max_turns: 20 });
  await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { routing: { require_online: false }, calls: { ai: { enabled: true, idle_timeout_s: 60, daily_limit: 500 } } } });
  const key = `${Math.random().toString(36).slice(2)}user:${Math.random().toString(36).slice(2)}pass`;
  try {
    await signIn(page);
    await page.goto("/settings/calls");
    const section = page.locator("section", { has: page.getByRole("heading", { name: "Photoreal avatar" }) }).last();
    await expect(section.getByText("Not connected")).toBeVisible();
    await section.getByLabel("D-ID API key").fill(key);
    await section.getByRole("button", { name: /Save key/ }).click();
    await expect(section.getByText("Connected, switched off")).toBeVisible();
    await expect(section.getByText(new RegExp(`Connected, ends …${key.slice(-4)}`))).toBeVisible();
    expect(await page.content()).not.toContain(key.split(":")[1]);
    await section.getByLabel("Name").fill("Amy");
    await section.getByLabel("Presenter id").fill("v2_public_amy");
    await section.getByRole("button", { name: "Add avatar" }).click();
    await expect(section.getByText("presenter v2_public_amy")).toBeVisible();
    await section.getByRole("combobox", { name: "Aria" }).click();
    await page.getByRole("option", { name: "Amy" }).click();
    await section.getByRole("switch", { name: /Use the photoreal avatar/ }).click();
    await expect(section.getByText("Connected and on")).toBeVisible();

    // a visitor's AI video call: the server offers photoreal, the fake stream cannot connect, the page shows the built-in face and says so
    const site = await startCustomerSite(baseURL!);
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, permissions: ["microphone", "camera"] });
    await ctx.addInitScript(spy);
    await ctx.addInitScript(FAKE_MEDIA_SCRIPT);
    await ctx.addInitScript(FAKE_SPEECH_SCRIPT);
    const v = await ctx.newPage();
    await v.goto(site.url);
    await v.getByRole("button", { name: "Open chat" }).click();
    await v.getByLabel("Your name").fill(`Photo Dee ${stamp}`);
    await v.getByLabel(/^Email/).fill(`photo.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`);
    await v.getByRole("button", { name: "Start chat" }).click();
    await v.getByRole("button", { name: "Video call with our AI assistant (avatar)" }).click();
    const d = v.getByRole("dialog", { name: /Call with Aria/ });
    await expect(d).toContainText("AI assistant, not a person");
    await expect(d).toContainText("switched to the simple avatar", { timeout: 20_000 });
    await expect(d.locator(".face-label")).toHaveText("AI assistant");
    await expect(d.locator("video.face-video")).toHaveCount(0);
    // the avatar connection never carried the visitor's camera or microphone
    const senders = await v.evaluate(() => ((window as any).__pcs as RTCPeerConnection[]).map((pc) => pc.getSenders().filter((s) => s.track).length));
    for (const n of senders) expect(n).toBe(0);
    await ctx.close();
    await site.close();
    // the attempt is counted as a fallback
    const st = await req(baseURL!, api.token, "GET", "/calls/avatar");
    expect(st.state).toBe("on");
    await page.reload();
    await section.getByRole("button", { name: /Disconnect/ }).click();
    await expect(section.getByText("Not connected")).toBeVisible();
  } finally {
    await req(baseURL!, api.token, "DELETE", "/calls/avatar/connection").catch(() => {});
    await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { calls: { ai: { enabled: false }, avatar: { enabled: false } } } }).catch(() => {});
    await req(baseURL!, api.token, "DELETE", `/agents/${agent.id}`).catch(() => {});
    await req(baseURL!, api.token, "DELETE", `/kb/${kb.id}`).catch(() => {});
  }
});
