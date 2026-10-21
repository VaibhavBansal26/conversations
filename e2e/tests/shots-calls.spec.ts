// Screenshot matrix for the call screens added with AI calls, teammate calls and call links (screens x 3 viewports x light/dark).
// Run with `npx playwright test tests/shots-calls.spec.ts --project=shots` (writes to ../docs/design, or SHOTS_DIR).
// Every picture is a generated placeholder: the bundled portraits are replaced by placeholders in the browser (a route) before they are drawn.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import { embedToken, loginApi, visitorConversation } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import { FAKE_SPEECH_SCRIPT } from "../support/fakeSpeech";
import { placeholderPng } from "../support/placeholder";
import { startCustomerSite } from "../support/site";
import { DEMO, expect, signIn, stamp, test } from "../support/fixtures";

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design");
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [
  { id: "1440x900", width: 1440, height: 900 },
  { id: "1024x768", width: 1024, height: 768 },
  { id: "390x844", width: 390, height: 844 },
] as const;
const SCHEMES = ["light", "dark"] as const;
const shot = async (page: Page, name: string, vp: string, scheme: string) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}-${vp}-${scheme}.jpg`), type: "jpeg", quality: 82 });
};
const SAM = { email: "sam@example.test", password: DEMO.password };
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
/** the bundled portraits are never drawn in a screenshot: the browser is given placeholders for them */
const placeholders = async (ctx: BrowserContext) => {
  await ctx.route(/\/avatars\/(aria|vb)\.webp$/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: placeholderPng(256, route.request().url().includes("vb") ? [16, 130, 100] : [79, 70, 229]) }));
};

let owner: Awaited<ReturnType<typeof loginApi>>;
let agentId = "";
let kbId = "";
test.beforeAll(async ({ baseURL }) => {
  owner = await loginApi(baseURL!);
  const kb = await req(baseURL!, owner.token, "POST", "/kb", { question: "How do I reset my password?", answer: "Open Settings, choose Security and press Reset password. We email you a link." });
  kbId = kb.id;
  const agent = await req(baseURL!, owner.token, "POST", "/agents", { name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", max_turns: 20 });
  agentId = agent.id;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(placeholderPng(256))], { type: "image/png" }), "aria.png");
  form.append("alt", "A placeholder portrait");
  const up = await fetch(`${baseURL}/api/agents/${agentId}/avatar`, { method: "POST", headers: { authorization: `Bearer ${owner.token}` }, body: form });
  expect(up.status).toBe(200);
  await req(baseURL!, owner.token, "PATCH", "/workspace", { settings: { routing: { require_online: false }, calls: { browser: { enabled: true, voice: true, video: true, screen_share: true }, internal: { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 30 }, links: { enabled: true, ttl_minutes: 30, allow_ai: true, allow_team: true }, ai: { enabled: true, idle_timeout_s: 60, daily_limit: 900 } } } });
});
test.afterAll(async ({ baseURL }) => {
  await req(baseURL!, owner.token, "PATCH", "/workspace", { settings: { calls: { browser: { enabled: false }, internal: { enabled: false }, links: { enabled: false }, ai: { enabled: false } } } }).catch(() => {});
  await req(baseURL!, owner.token, "DELETE", `/agents/${agentId}`).catch(() => {});
  await req(baseURL!, owner.token, "DELETE", `/kb/${kbId}`).catch(() => {});
});

async function visitor(page: Page, siteUrl: string, label: string) {
  await page.goto(siteUrl);
  await page.getByRole("button", { name: "Open chat" }).click();
  await page.getByLabel("Your name").fill(`Shot ${label} ${stamp}`);
  await page.getByLabel(/^Email/).fill(`shot.${label}.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`);
  await page.getByRole("button", { name: "Start chat" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`call screens ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600, permissions: ["microphone", "camera"] });

      test("AI call: voice with the photo face, video with the photo face, video with the drawn face", async ({ browser, baseURL }) => {
        test.setTimeout(120_000);
        const site = await startCustomerSite(baseURL!);
        // a fresh browser context per visitor: the widget keeps its session in the page's storage
        const made: BrowserContext[] = [];
        const mk = async () => {
          const c = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600, permissions: ["microphone", "camera"] });
          await c.addInitScript(FAKE_MEDIA_SCRIPT);
          await c.addInitScript(FAKE_SPEECH_SCRIPT);
          made.push(c);
          return c;
        };
        try {
          const page = await (await mk()).newPage();
          await visitor(page, site.url, "voice");
          await page.getByRole("button", { name: "Talk to our AI assistant (voice)" }).click();
          const d = page.getByRole("dialog", { name: /Call with Aria/ });
          await expect(d).toBeVisible();
          await page.evaluate(() => (window as any).__speech.finish());
          await page.evaluate(() => (window as any).__speech.say("how do I reset my password"));
          await expect(d.getByRole("log", { name: "Captions" })).toContainText("Reset password", { timeout: 15_000 });
          await shot(page, "ai-call-voice", vp.id, scheme);
          await d.getByRole("button", { name: "End call" }).click();

          const page2 = await (await mk()).newPage();
          await visitor(page2, site.url, "video");
          await page2.getByRole("button", { name: "Video call with our AI assistant (avatar)" }).click();
          const d2 = page2.getByRole("dialog", { name: /Call with Aria/ });
          await expect(d2).toBeVisible();
          await page2.evaluate(() => (window as any).__speech.finish());
          await shot(page2, "ai-call-video-photo", vp.id, scheme);
          await d2.getByRole("button", { name: "End call" }).click();

          // no picture: the drawn face
          await req(baseURL!, owner.token, "DELETE", `/agents/${agentId}/avatar`);
          const page3 = await (await mk()).newPage();
          await visitor(page3, site.url, "svg");
          await page3.getByRole("button", { name: "Video call with our AI assistant (avatar)" }).click();
          const d3 = page3.getByRole("dialog", { name: /Call with Aria/ });
          await expect(d3).toBeVisible();
          await page3.evaluate(() => (window as any).__speech.finish());
          await shot(page3, "ai-call-video-drawn-face", vp.id, scheme);
          const form = new FormData();
          form.append("file", new Blob([new Uint8Array(placeholderPng(256))], { type: "image/png" }), "aria.png");
          form.append("alt", "A placeholder portrait");
          await fetch(`${baseURL}/api/agents/${agentId}/avatar`, { method: "POST", headers: { authorization: `Bearer ${owner.token}` }, body: form });
        } finally {
          for (const c of made) await c.close();
          await site.close();
        }
      });

      test("call link: the join page for the AI and for the team, and the card in the chat", async ({ browser, baseURL }) => {
        test.setTimeout(90_000);
        const name = `Link Shot ${stamp}${vp.width}${scheme}`;
        const roomId = await visitorConversation(baseURL!, await embedToken(baseURL!), { name, email: `link.${stamp}${vp.width}${scheme}@example.test` }, [`Please call me ${stamp}`]);
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600, permissions: ["microphone", "camera"] });
        await ctx.addInitScript(FAKE_MEDIA_SCRIPT);
        await placeholders(ctx);
        try {
          const ai = await req(baseURL!, owner.token, "POST", `/rooms/${roomId}/call-links`, { mode: "ai", kind: "video" });
          const page = await ctx.newPage();
          await page.goto(ai.url);
          await expect(page.getByRole("button", { name: "Join call" })).toBeVisible();
          await shot(page, "call-link-page-ai", vp.id, scheme);
          const team = await req(baseURL!, owner.token, "POST", `/rooms/${roomId}/call-links`, { mode: "team", kind: "voice" });
          const page2 = await ctx.newPage();
          await page2.goto(team.url);
          await expect(page2.getByRole("button", { name: "Join call" })).toBeVisible();
          await shot(page2, "call-link-page-team", vp.id, scheme);
          const gone = await ctx.newPage();
          await gone.goto(ai.url);
          await expect(gone.locator("[data-cp=gone]")).toBeVisible();
          await shot(gone, "call-link-page-unavailable", vp.id, scheme);
          // the card in the visitor's own chat (hosted chat)
          const site = await startCustomerSite(baseURL!);
          try {
            const chat = await ctx.newPage();
            await chat.goto(site.url);
            await chat.getByRole("button", { name: "Open chat" }).click();
            await chat.getByLabel("Your name").fill(`Card Shot ${stamp}${vp.width}${scheme}`);
            await chat.getByLabel(/^Email/).fill(`card.${stamp}${vp.width}${scheme}@example.test`);
            await chat.getByRole("button", { name: "Start chat" }).click();
            const input = chat.getByRole("textbox", { name: "Message" });
            await input.click();
            await input.pressSequentially(`Hello ${stamp}`, { delay: 5 });
            await chat.getByRole("button", { name: "Send message" }).click();
            await expect(chat.getByLabel("Conversation").getByText(`Hello ${stamp}`)).toBeVisible();
            const rooms = (await req(baseURL!, owner.token, "GET", "/rooms?status=open&limit=50")).data as { id: string; contact?: { name?: string } }[];
            const room = rooms.find((r) => r.contact?.name === `Card Shot ${stamp}${vp.width}${scheme}`)!;
            await req(baseURL!, owner.token, "POST", `/rooms/${room.id}/call-links`, { mode: "team", kind: "video" });
            await expect(chat.getByLabel("Conversation").locator(".calllink")).toBeVisible();
            await shot(chat, "call-link-card-widget", vp.id, scheme);
          } finally {
            await site.close();
          }
        } finally {
          await ctx.close();
        }
      });

      test("teammate call: incoming screen, calling panel and the call in progress", async ({ browser, baseURL }) => {
        test.setTimeout(90_000);
        const members = (await req(baseURL!, owner.token, "GET", "/members")).data as { id: string; email: string }[];
        const sam = members.find((m) => m.email === SAM.email)!;
        const dm = await req(baseURL!, owner.token, "POST", "/team/dms", { member_ids: [sam.id] });
        const o = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600, permissions: ["microphone", "camera"] });
        const s = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600, permissions: ["microphone", "camera"] });
        for (const c of [o, s]) await c.addInitScript(FAKE_MEDIA_SCRIPT);
        try {
          const op = await o.newPage();
          const sp = await s.newPage();
          await signIn(op);
          await signIn(sp, SAM);
          await op.goto(`/team/${dm.id}`);
          const call = op.getByRole("button", { name: "Video call with Sam Agent" });
          await expect(call).toBeVisible();
          await shot(op, "team-call-dm-header", vp.id, scheme);
          await call.click();
          const ring = sp.getByRole("alertdialog", { name: "Incoming call" });
          await expect(ring).toBeVisible();
          await shot(sp, "team-call-incoming", vp.id, scheme);
          await shot(op, "team-call-calling", vp.id, scheme);
          await ring.getByRole("button", { name: /^Accept the call from/ }).click();
          await expect(op.getByRole("timer")).toHaveText(/^\d\d:\d\d$/, { timeout: 20_000 });
          await expect(sp.getByRole("timer")).toHaveText(/^\d\d:\d\d$/);
          await shot(op, "team-call-active", vp.id, scheme);
          await op.getByRole("button", { name: "End call" }).click();
        } finally {
          await req(baseURL!, owner.token, "PATCH", "/calls/settings", { internal: { enabled: true } }).catch(() => {});
          await o.close();
          await s.close();
        }
      });

      test("settings: calls (teammates, AI, links) and the agent editor with presets and picture", async ({ page, context }) => {
        await placeholders(context);
        await signIn(page);
        await page.goto("/settings/calls");
        await expect(page.getByRole("switch", { name: "Browser calls" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "calls-settings-full", vp.id, scheme);
        await page.getByText("Call links", { exact: true }).scrollIntoViewIfNeeded();
        await shot(page, "calls-settings-links", vp.id, scheme);
        await page.goto("/settings/ai-agents");
        await expect(page.getByText("Aria").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: /New agent|Add agent|Create agent/ }).first().click();
        await expect(page.getByRole("group", { name: "Start from a preset" })).toBeVisible();
        await shot(page, "ai-agent-presets", vp.id, scheme);
        await page.getByRole("button", { name: /Aria/ }).first().click();
        await expect(page.getByText("Picture", { exact: true })).toBeVisible();
        await page.getByText("Picture", { exact: true }).scrollIntoViewIfNeeded();
        await shot(page, "ai-agent-picture", vp.id, scheme);
      });
    });
  }
}
