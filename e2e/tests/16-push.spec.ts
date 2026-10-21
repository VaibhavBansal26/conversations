// Web Push against the built server: the real service worker in real Chrome, and a fake push service on loopback that receives what the server sends.
// NOT exercised: a real push service (FCM, Mozilla, Apple, Windows), subscribing through the browser's PushManager (it talks to those services),
// notifications on real phones, Safari and Firefox.
import { createServer, type Server } from "node:http";
import { createECDH, randomBytes } from "node:crypto";
import { DEMO, expect, signIn, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";

async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome/140" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
let fake: Server;
let fakeUrl = "";
const got: { path: string; encoding?: string; auth?: string; bytes: number }[] = [];
test.beforeAll(async () => {
  fake = createServer((rq, rs) => {
    let n = 0;
    rq.on("data", (c) => (n += c.length));
    rq.on("end", () => {
      got.push({ path: rq.url!, encoding: rq.headers["content-encoding"] as string, auth: rq.headers.authorization as string, bytes: n });
      rs.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
test.afterAll(() => new Promise<void>((r) => fake.close(() => r())));
const sub = (name: string) => {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { endpoint: `${fakeUrl}/push/${name}`, keys: { p256dh: e.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

test("Settings > Notifications lists a device, its events and sends a test through the push service", async ({ page, baseURL }) => {
  const owner = await loginApi(baseURL!);
  const name = `laptop-${Date.now()}`;
  const dev = await req(baseURL!, owner.token, "POST", "/push/subscriptions", { subscription: sub(name), label: "Work laptop" });
  try {
    await signIn(page);
    await page.goto("/settings/notifications");
    const list = page.getByRole("list", { name: "Your devices" });
    await expect(list).toContainText("Work laptop");
    await expect(list.getByRole("switch", { name: /Missed calls/ })).toBeChecked();
    await list.getByRole("button", { name: "Send a test" }).click();
    await expect.poll(() => got.filter((g) => g.path.endsWith(name)).length).toBe(1);
    const g = got.find((x) => x.path.endsWith(name))!;
    expect(g.encoding).toBe("aes128gcm");
    expect(g.auth).toMatch(/^vapid t=/);
    expect(g.bytes).toBeGreaterThan(86);
    await list.getByRole("switch", { name: /Customer messages/ }).click();
    await expect.poll(async () => (await req(baseURL!, owner.token, "GET", "/push/subscriptions")).data[0].events).toEqual(["missed_call", "assigned"]);
  } finally {
    await req(baseURL!, owner.token, "DELETE", `/push/subscriptions/${dev.id}`).catch(() => {});
  }
});

test("the service worker shows a pushed notification with the page to open", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ permissions: ["notifications"] });
  const page = await ctx.newPage();
  try {
    await signIn(page);
    await page.goto("/settings/notifications");
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.register("/sw.js", { scope: "/" })).scope);
    expect(scope).toBe(`${baseURL}/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // deliver a push message to the worker through the browser's DevTools protocol (no push service involved)
    const cdp = await ctx.newCDPSession(page);
    const regs: { registrationId: string; scopeURL: string }[] = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e: any) => regs.push(...e.registrations));
    await cdp.send("ServiceWorker.enable");
    await expect.poll(() => regs.find((r) => r.scopeURL === `${baseURL}/`)?.registrationId ?? null).not.toBeNull();
    const reg = regs.find((r) => r.scopeURL === `${baseURL}/`)!;
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: baseURL!, registrationId: reg.registrationId, data: JSON.stringify({ title: "Missed call", body: "Sam Agent called you.", url: "/team", tag: "call-e2e" }) });
    await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => [n.title, n.body, n.tag]))).toEqual([["Missed call", "Sam Agent called you.", "call-e2e"]]);
    // the click target travels with the notification; the worker opens only pages of this app (a click on an OS notification cannot be automated here)
    expect(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications())[0]!.data)).toEqual({ url: "/team" });
  } finally {
    await ctx.close();
  }
});

test("a teammate call that rings out is pushed to the callee's devices as a missed call", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const owner = await loginApi(baseURL!);
  await req(baseURL!, owner.token, "PATCH", "/calls/settings", { internal: { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 10 } });
  const sam = await loginApi(baseURL!, { email: "sam@example.test", password: DEMO.password });
  const name = `sam-${Date.now()}`;
  const dev = await req(baseURL!, sam.token, "POST", "/push/subscriptions", { subscription: sub(name), label: "Sam's phone" });
  const members = (await req(baseURL!, owner.token, "GET", "/members")).data as { id: string; email: string }[];
  const samId = members.find((m) => m.email === "sam@example.test")!.id;
  const dm = await req(baseURL!, owner.token, "POST", "/team/dms", { member_ids: [samId] });
  const perms = ["microphone", "camera"];
  const [oc, sc] = await Promise.all([browser.newContext({ permissions: perms }), browser.newContext({ permissions: perms })]);
  const { FAKE_MEDIA_SCRIPT } = await import("../support/fakeMedia");
  for (const c of [oc, sc]) await c.addInitScript(FAKE_MEDIA_SCRIPT);
  try {
    const op = await oc.newPage();
    const sp = await sc.newPage();
    await signIn(op);
    await signIn(sp, { email: "sam@example.test", password: DEMO.password });
    await op.goto(`/team/${dm.id}`);
    await op.getByRole("button", { name: "Voice call with Sam Agent" }).click();
    await expect(sp.getByRole("alertdialog", { name: "Incoming call" })).toBeVisible();
    await expect(sp.getByRole("alertdialog", { name: "Incoming call" })).toBeHidden({ timeout: 25_000 });
    await expect.poll(() => got.filter((g) => g.path.endsWith(name)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  } finally {
    await req(baseURL!, sam.token, "DELETE", `/push/subscriptions/${dev.id}`).catch(() => {});
    await req(baseURL!, owner.token, "PATCH", "/calls/settings", { internal: { enabled: false } }).catch(() => {});
    await oc.close();
    await sc.close();
  }
});
