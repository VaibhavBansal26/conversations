import AxeBuilder from "@axe-core/playwright";
import { devices, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loginApi, makePng } from "../support/api.mjs";
import { expect, stamp, test } from "../support/fixtures";

/**
 * The hosted full-page chat (/chat) in real mobile emulation: touch, a phone viewport, light and dark. A few screenshots are kept in
 * docs/design/. The bridge (iframe transport) is exercised by /chat/bridge-test, the same page a developer runs against their own deployment.
 */
const SHOTS = process.env.HOSTED_SHOTS ? join(process.cwd(), "..", "docs", "design") : "";
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

async function hostedToken(baseURL: string, domain: string) {
  const api = await loginApi(baseURL);
  const t = await api.post("/tokens", { domain, hosted_chat_enabled: true });
  return { api, token: t.token as string };
}

async function agentReply(api: Awaited<ReturnType<typeof loginApi>>, contactName: string, text: string) {
  const rooms = await api.get("/rooms", { limit: 50 });
  const room = rooms.data.find((r: { contact: { name: string } }) => r.contact.name === contactName);
  expect(room, `room of ${contactName}`).toBeTruthy();
  return api.post(`/rooms/${room.id}/messages`, { kind: "text", source: "dm", content: text });
}

const phone = (b: Browser, scheme: "light" | "dark"): Promise<BrowserContext> => b.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, colorScheme: scheme, reducedMotion: "reduce" });
const desktop = (b: Browser, scheme: "light" | "dark"): Promise<BrowserContext> => b.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: scheme, reducedMotion: "reduce" });

for (const [label, make] of [["390x844 phone", phone], ["1024x768 desktop", desktop]] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`hosted chat, ${label}, ${scheme}: chat, attach a photo, agent answers, unread, CSAT-free flow, accessibility`, async ({ browser, baseURL }) => {
      const name = `Mobile Mia ${stamp} ${scheme} ${label.slice(0, 3)}`;
      const { api, token } = await hostedToken(baseURL!, `hosted-${scheme}-${label.slice(0, 3)}.${stamp}.example.com`);
      const ctx = await make(browser, scheme);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`/chat?token=${token}&bridge=none&name=${encodeURIComponent(name)}&safe_area=1`);
      const input = page.getByRole("textbox", { name: "Message" });
      await expect(input).toBeVisible();
      await expect(page.getByLabel("Conversation").getByText("Hi there! How can we help you today?")).toBeVisible();
      await shot(page, `hosted-chat-${label.slice(0, 3)}-${scheme}-1-welcome`);

      await input.click();
      await input.fill(`Hello, my order is late ${stamp}`);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByLabel("Conversation").getByText(`Hello, my order is late ${stamp}`)).toBeVisible();
      await expect(page.getByLabel("Conversation").getByText(/^Sent/)).toBeVisible();

      // photo from the camera roll / camera: a file input
      await page.locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(makePng(200, 120)) });
      await expect(page.getByText("receipt.png").first()).toBeVisible();
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByLabel("Conversation").locator("img[alt='receipt.png']")).toBeVisible();

      // an agent answers; typing text and a link
      await agentReply(api, name, `Thanks Mia, checking now. Details: https://example.com/orders/1 ${stamp}`);
      await expect(page.getByLabel("Conversation").getByText(`Thanks Mia, checking now.`)).toBeVisible({ timeout: 15_000 });
      await shot(page, `hosted-chat-${label.slice(0, 3)}-${scheme}-2-conversation`);

      // emoji picker
      await page.getByRole("button", { name: "Add an emoji" }).click();
      await expect(page.getByRole("group", { name: "Emoji" })).toBeVisible();
      await page.getByRole("button", { name: "👍" }).click();
      await expect(input).toHaveValue("👍");
      await shot(page, `hosted-chat-${label.slice(0, 3)}-${scheme}-3-emoji`);
      await page.getByRole("button", { name: "Add an emoji" }).click();

      // touch targets of the controls are at least 44px
      for (const n of ["Send message", "Attach a photo or file", "Add an emoji"]) {
        const box = (await page.getByRole("button", { name: n }).boundingBox())!;
        expect(box.width, n).toBeGreaterThanOrEqual(43.5);
        expect(box.height, n).toBeGreaterThanOrEqual(43.5);
      }
      // the composer font is 16px, so iOS does not zoom the page on focus
      expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");

      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
      expect(bad).toEqual([]);
      expect(errors).toEqual([]);
      await ctx.close();
    });
  }
}

test("hosted chat: offline banner, queued message is sent when the network returns, history paging and scroll anchoring", async ({ browser, baseURL }) => {
  const name = `Offline Olga ${stamp}`;
  const { api, token } = await hostedToken(baseURL!, `hosted-offline.${stamp}.example.com`);
  const ctx = await phone(browser, "light");
  const page = await ctx.newPage();
  await page.goto(`/chat?token=${token}&bridge=none&name=${encodeURIComponent(name)}`);
  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toBeVisible();
  await input.fill("first message");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByLabel("Conversation").getByText("first message")).toBeVisible();

  // pile up history so paging has something to do
  for (let i = 1; i <= 45; i++) await agentReply(api, name, `history line ${i}`);
  await page.reload();
  await expect(page.getByLabel("Conversation").getByText("history line 45")).toBeVisible();
  const list = page.getByLabel("Conversation");
  expect(await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5); // anchored to the newest
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeVisible();
  await list.evaluate((el) => { el.scrollTop = 0; });
  await expect(page.getByLabel("Conversation").getByText("first message")).toBeVisible({ timeout: 10_000 });
  await shot(page, "hosted-chat-390-light-4-history");

  // offline: banner, message is kept and goes out when back online
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await ctx.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "You are offline" })).toBeVisible();
  await shot(page, "hosted-chat-390-light-5-offline");
  await input.fill("sent while offline");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByLabel("Conversation").getByText(/Not sent|Sending/)).toBeVisible();
  await ctx.setOffline(false);
  await expect(page.getByLabel("Conversation").getByText("sent while offline")).toBeVisible();
  await expect(page.getByLabel("Conversation").getByText(/^Sent/).last()).toBeVisible({ timeout: 20_000 });
  await ctx.close();
});

test("hosted chat: the origin model in a real browser (flag off is refused; framing follows the token's domain)", async ({ browser, baseURL }) => {
  const api = await loginApi(baseURL!);
  const t = await api.post("/tokens", { domain: `hosted-off.${stamp}.example.com` });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const res = await page.goto(`/chat?token=${t.token}`);
  expect(res!.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "Chat is not available" })).toBeVisible();
  // a token with the flag on: the page may be framed by that site only
  await api.post("/tokens", { domain: `hosted-on.${stamp}.example.com`, hosted_chat_enabled: true });
  await ctx.close();
});

test("hosted chat: bridge conformance page passes every check in a real browser", async ({ browser, baseURL }) => {
  const { token } = await hostedToken(baseURL!, `hosted-bridge.${stamp}.example.com`);
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/chat/bridge-test?token=${token}&autorun=1`);
  await page.waitForFunction(() => (window as unknown as { __bridgeTest?: { done: boolean } }).__bridgeTest?.done === true, null, { timeout: 60_000 });
  const res = await page.evaluate(() => (window as unknown as { __bridgeTest: { passed: number; failed: number; results: { id: string; ok: boolean; detail: string }[] } }).__bridgeTest);
  expect(res.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
  expect(res.passed).toBeGreaterThanOrEqual(20);
  await shot(page, "bridge-test-1024-light");
  await ctx.close();
});

test("hosted chat: right-to-left locale and the Spanish strings", async ({ browser, baseURL }) => {
  const { token } = await hostedToken(baseURL!, `hosted-i18n.${stamp}.example.com`);
  const ctx = await phone(browser, "light");
  const page = await ctx.newPage();
  await page.goto(`/chat?token=${token}&bridge=none&locale=es&name=Ines${stamp}`);
  await expect(page.getByRole("textbox", { name: "Mensaje" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.goto(`/chat?token=${token}&bridge=none&locale=ar&name=Ines${stamp}`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible(); // Arabic falls back to the English strings
  await shot(page, "hosted-chat-390-light-6-rtl");
  await ctx.close();
});
