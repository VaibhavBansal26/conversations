// Screenshot matrix of the support features (tickets, departments, AI agents, visitor details, calls, support analytics, the widget with the AI agent):
// 3 viewports x light/dark. `npx playwright test tests/shots-support.spec.ts --project=shots` writes to SHOTS_DIR (default ../docs/design).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "@playwright/test";
import { loginApi } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import { startCustomerSite } from "../support/site";
import { expect, signIn, stamp, test } from "../support/fixtures";

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design");
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [
  { id: "1440x900", width: 1440, height: 900 },
  { id: "1024x768", width: 1024, height: 768 },
  { id: "390x844", width: 390, height: 844 },
] as const;
const SCHEMES = ["light", "dark"] as const;
const shot = async (page: Page, name: string, vp: string, scheme: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}-${vp}-${scheme}.jpg`), type: "jpeg", quality: 82 });
};

let visitorName = "";
// a worker restarted after a failure loses module state: the data the screens need is created once per stack and remembered in a file
const STATE = join(tmpdir(), `conv-e2e-shots-support-${process.env.E2E_PORT}`);
/** the workspace the screens need: an AI agent that is on, entries with links, calls and phone calls on, an email card at hand-off, and a few conversations */
async function setup(browser: Browser, baseURL: string) {
  if (visitorName) return;
  if (existsSync(STATE)) {
    visitorName = readFileSync(STATE, "utf8");
    return;
  }
  const api = await loginApi(baseURL);
  const patch = (path: string, body: unknown) => fetch(`${baseURL}/api${path}`, { method: "PATCH", headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const post = (path: string, body: unknown) => fetch(`${baseURL}/api${path}`, { method: "POST", headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const k of [
    { question: "How do I reset my password?", answer: "Open Settings, choose Security and press Reset password. We email you a link.", collection: "account", url: "https://help.demo.example.test/reset-password" },
    { question: "How can I download my invoice?", answer: "Open Billing, select the invoice and press Download PDF.", collection: "billing", url: "https://help.demo.example.test/invoices" },
  ]) await post("/kb", k);
  expect((await post("/agents", { name: "Aria", enabled: true, greeting: "Hi, I am Aria, Demo Co's AI assistant.", persona: "You help customers of Demo Co." })).status).toBe(201);
  expect((await patch("/calls/settings", { browser: { enabled: true }, phone: { enabled: true, caller_id: "+14155550100", allowed_countries: ["US"] } })).status).toBe(200);
  expect((await patch("/workspace", { settings: { widget: { visitor_info: { fields: { name: "off", email: "ask_when_needed", phone: "off" }, custom_fields: [], moments: { handoff: true, no_agent: true, callback: true, after: false }, consent: { enabled: true, text: "I agree that you may email me about this conversation.", privacy_url: "https://demo.example.test/privacy" } } } } })).status).toBe(200);
  // a few conversations through the real widget: an answered question, an unanswered one twice, a hand-over
  const site = await startCustomerSite(baseURL);
  for (const [n, lines] of [
    ["Shots Sam", ["How do I reset my password?", "thanks, that solved it"]],
    ["Shots Uma", ["my frobnicator makes a zorbling noise", "it started after the glimmer update"]],
    ["Shots Tia", ["I need a refund for last month"]],
  ] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(site.url);
    await p.getByRole("button", { name: "Open chat" }).click();
    await p.getByLabel("Your name").fill(`${n} ${stamp}`);
    await p.getByRole("button", { name: "Start chat" }).click();
    for (const l of lines) {
      const input = p.getByRole("textbox", { name: "Message" });
      await input.fill(l);
      await p.getByRole("button", { name: "Send message" }).click();
      await p.waitForTimeout(1500);
    }
    if (n === "Shots Sam") visitorName = `${n} ${stamp}`;
    await ctx.close();
  }
  await site.close();
  writeFileSync(STATE, visitorName);
}

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`support ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600 });

      test("settings screens", async ({ page, browser, baseURL }) => {
        test.setTimeout(120_000);
        await setup(browser, baseURL!);
        await signIn(page);
        await page.goto("/tickets");
        await expect(page.getByRole("heading", { name: "Tickets", level: 1 })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "tickets", vp.id, scheme);

        await page.goto("/settings/departments");
        await expect(page.getByText("Sales").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "departments", vp.id, scheme);
        await page.getByRole("button", { name: "Edit department Sales" }).click();
        await expect(page.getByRole("form", { name: "Edit department Sales" })).toBeVisible();
        await shot(page, "department-editor", vp.id, scheme);

        await page.goto("/settings/ai-agents");
        await expect(page.getByText("Aria").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "ai-agents", vp.id, scheme);
        await page.getByRole("button", { name: "Edit Aria" }).click();
        await page.getByLabel("Test message").fill("How do I reset my password?");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(page.getByRole("status", { name: "What the agent would do" })).toBeVisible();
        await page.getByRole("status", { name: "What the agent would do" }).scrollIntoViewIfNeeded();
        await shot(page, "ai-agent-sandbox", vp.id, scheme);
        await page.getByRole("tab", { name: "Review" }).click();
        await expect(page.getByRole("list", { name: "Agent turns" })).toBeVisible();
        await shot(page, "ai-review", vp.id, scheme);
        await page.getByRole("tab", { name: "Unanswered" }).click();
        await expect(page.getByText(/Asked \d+ time/).first()).toBeVisible();
        await shot(page, "ai-unanswered", vp.id, scheme);

        await page.goto("/settings/visitor-info");
        await expect(page.getByRole("heading", { name: "Visitor details" }).first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "visitor-info", vp.id, scheme);
        await page.goto("/settings/calls");
        await expect(page.getByRole("switch", { name: "Browser calls" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "calls-settings", vp.id, scheme);

        await page.goto("/analytics");
        await expect(page.getByRole("heading", { name: "Support", level: 2 })).toBeVisible();
        await page.getByRole("heading", { name: "Support", level: 2 }).scrollIntoViewIfNeeded();
        await page.waitForLoadState("networkidle");
        await shot(page, "analytics-support", vp.id, scheme);
      });

      test("a conversation the AI agent answered", async ({ page, browser, baseURL }) => {
        await setup(browser, baseURL!);
        await signIn(page);
        if (vp.width < 768) await page.getByRole("link", { name: new RegExp(visitorName) }).first().click();
        else await page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: new RegExp(visitorName) }).first().click();
        await expect(page.getByRole("log", { name: "Conversation messages" }).getByText(/Reset password/).first()).toBeVisible();
        await shot(page, "conversation-ai", vp.id, scheme);
        await page.getByRole("button", { name: /Ticket #/ }).first().click();
        await expect(page.getByRole("menu")).toBeVisible();
        await shot(page, "ticket-menu", vp.id, scheme);
      });

      test("the widget with the AI agent, the details card and a call", async ({ browser, baseURL }) => {
        test.setTimeout(120_000);
        await setup(browser, baseURL!);
        const site = await startCustomerSite(baseURL!);
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, permissions: ["microphone", "camera"], hasTouch: vp.width < 600, isMobile: vp.width < 600 });
        await ctx.addInitScript(FAKE_MEDIA_SCRIPT);
        const page = await ctx.newPage();
        await page.goto(site.url);
        await page.getByRole("button", { name: "Open chat" }).click();
        await page.getByLabel("Your name").fill(`Widget Wren ${vp.id} ${scheme} ${stamp}`);
        await page.getByRole("button", { name: "Start chat" }).click();
        const input = page.getByRole("textbox", { name: "Message" });
        await input.fill("How do I reset my password?");
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByRole("button", { name: "Yes, thanks" })).toBeVisible({ timeout: 15_000 });
        await shot(page, "widget-ai", vp.id, scheme);
        await page.getByRole("button", { name: "Talk to a person" }).last().click();
        await expect(page.getByRole("form", { name: "Your details" })).toBeVisible({ timeout: 15_000 });
        await shot(page, "widget-form", vp.id, scheme);
        await page.getByRole("button", { name: "Skip" }).click();

        // a call from the team: the visitor's incoming-call screen, then the running call
        const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone", "camera"] });
        await actx.addInitScript(FAKE_MEDIA_SCRIPT);
        const agent = await actx.newPage();
        await signIn(agent);
        await agent.getByRole("region", { name: "Conversations" }).getByRole("link", { name: new RegExp(`Widget Wren ${vp.id} ${scheme}`) }).first().click();
        await agent.getByRole("button", { name: "Video call" }).click();
        await expect(page.getByRole("dialog", { name: "Call" })).toContainText("is calling you");
        await shot(page, "widget-call-ringing", vp.id, scheme);
        await page.getByRole("dialog", { name: "Call" }).getByRole("button", { name: "Accept" }).click();
        await expect(agent.getByRole("timer")).toHaveText(/^\d\d:\d\d$/, { timeout: 20_000 });
        await page.waitForTimeout(2500);
        await shot(page, "widget-call-active", vp.id, scheme);
        if (vp.id === "1440x900") await shot(agent, "agent-call-panel", vp.id, scheme);
        await agent.getByRole("button", { name: "End call" }).click();
        await ctx.close();
        await actx.close();
        await site.close();
      });
    });
  }
}
