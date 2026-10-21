// A group call of three teammates in three real Chrome contexts against the built server, with synthetic microphones and cameras (support/fakeMedia.ts).
// It is a WebRTC mesh: each browser holds two connections. NOT exercised: four people on real networks, TURN relays, other browsers, real devices.
import { DEMO, expect, signIn, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import type { Page } from "@playwright/test";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
const spy = `(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; })();`;
const connectedCount = (p: Page, n: number) => p.waitForFunction((k) => (window as any).__pcs?.filter((pc: RTCPeerConnection) => pc.connectionState === "connected").length >= k, n, { timeout: 25_000 });
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

test("a group video call of three: rings two people, a mesh of connections, speaker highlight, mute, one screen share at a time, host leaves and it goes on, last leaves and it ends", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const owner = await loginApi(baseURL!);
  await req(baseURL!, owner.token, "PATCH", "/calls/settings", { internal: { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 30, group: true, group_max: 4 } });
  const members = (await req(baseURL!, owner.token, "GET", "/members")).data as { id: string; email: string }[];
  const sam = members.find((m) => m.email === "sam@example.test")!;
  const priya = members.find((m) => m.email === "priya@example.test")!;
  const group = await req(baseURL!, owner.token, "POST", "/team/dms", { member_ids: [sam.id, priya.id] });
  const perms = ["microphone", "camera"];
  const ctxs = await Promise.all([1, 2, 3].map(() => browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: perms })));
  for (const c of ctxs) {
    await c.addInitScript(spy);
    await c.addInitScript(FAKE_MEDIA_SCRIPT);
  }
  const [op, sp, pp] = await Promise.all(ctxs.map((c) => c.newPage()));
  try {
    await signIn(op!);
    await signIn(sp!, { email: "sam@example.test", password: DEMO.password });
    await signIn(pp!, { email: "priya@example.test", password: DEMO.password });
    await sp!.goto("/inbox");
    await op!.goto(`/team/${group.id}`);
    await op!.getByRole("button", { name: "Start a group video call" }).click();
    const picker = op!.getByRole("dialog", { name: "Start a group video call" });
    await expect(picker).toContainText("3 more people");
    await expect(picker.getByText("2 of 3 chosen")).toBeVisible();
    await picker.getByRole("button", { name: "Start the call" }).click();
    await expect(op!.getByRole("dialog", { name: /^Group call:/ })).toBeVisible();
    // both invitees ring, in another part of the app too
    for (const p of [sp!, pp!]) await expect(p.getByRole("alertdialog", { name: "Incoming group call" })).toContainText("invites you to a group video call");
    await sp!.getByRole("button", { name: /^Join the group call/ }).click();
    await pp!.getByRole("button", { name: /^Join the group call/ }).click();
    // a mesh: two connections each
    await Promise.all([connectedCount(op!, 2), connectedCount(sp!, 2), connectedCount(pp!, 2)]);
    for (const p of [op!, sp!, pp!]) {
      await expect(p.getByTestId("group-tile")).toHaveCount(3);
      await expect(p.getByText("3 of 4")).toBeVisible();
    }
    await expect.poll(() => stat(op!, "video", "framesDecoded"), { timeout: 15_000 }).toBeGreaterThan(5);
    await expect.poll(() => stat(pp!, "video", "framesDecoded"), { timeout: 15_000 }).toBeGreaterThan(5);
    await expect.poll(() => stat(sp!, "audio", "totalAudioEnergy"), { timeout: 15_000 }).toBeGreaterThan(0);
    // the card in the thread follows the call
    await expect(op!.getByText("Group video call: 3 in the call")).toBeVisible();
    // speaker highlight: somebody is marked as speaking (the synthetic microphones are tones)
    await expect(op!.locator('[data-testid="group-tile"][data-speaking]').first()).toBeVisible({ timeout: 10_000 });
    // mute: the others see the muted marker on that person's tile
    await op!.getByRole("button", { name: "Mute microphone" }).click();
    await expect(sp!.getByRole("listitem", { name: /Olivia Owner.*muted/ }).or(sp!.getByRole("listitem", { name: /Demo.*muted/ }))).toBeVisible();
    await op!.getByRole("button", { name: "Unmute microphone" }).click();
    // one screen share at a time
    await sp!.getByRole("button", { name: "Share your screen" }).click();
    await expect(pp!.getByRole("listitem", { name: /sharing their screen/ })).toBeVisible();
    await expect(pp!.getByRole("button", { name: "Share your screen" })).toBeDisabled();
    await expect(op!.getByRole("button", { name: "Share your screen" })).toBeDisabled();
    await sp!.getByRole("button", { name: "Stop sharing your screen" }).click();
    await expect(pp!.getByRole("button", { name: "Share your screen" })).toBeEnabled();
    // the host leaves: the call goes on between the other two
    await op!.getByRole("button", { name: "Leave the call" }).click();
    await expect(op!.getByRole("dialog", { name: "Group call ended" })).toContainText("You left the call.");
    await expect(sp!.getByText("2 of 4")).toBeVisible();
    await expect(pp!.getByText("2 of 4")).toBeVisible();
    await expect.poll(() => sp!.evaluate(() => (window as any).__pcs.filter((pc: RTCPeerConnection) => pc.connectionState === "connected").length)).toBeGreaterThanOrEqual(1);
    // the host rejoins from the card
    await op!.getByRole("dialog", { name: "Group call ended" }).getByRole("button", { name: "Close" }).click();
    await op!.getByRole("button", { name: "Join" }).last().click();
    await expect(op!.getByText("3 of 4")).toBeVisible();
    await op!.getByRole("button", { name: "Leave the call" }).click();
    // the last one out ends it
    await sp!.getByRole("button", { name: "Leave the call" }).click();
    await pp!.getByRole("button", { name: "Leave the call" }).click();
    await expect(op!.getByText(/^Group video call, (\d+ s|\d+ min)$/)).toBeVisible();
    expect(await pp!.evaluate(() => (window as any).__pcs.every((pc: RTCPeerConnection) => pc.connectionState === "closed"))).toBe(true);
  } finally {
    await req(baseURL!, owner.token, "PATCH", "/calls/settings", { internal: { enabled: false } }).catch(() => {});
    for (const c of ctxs) await c.close();
  }
});
