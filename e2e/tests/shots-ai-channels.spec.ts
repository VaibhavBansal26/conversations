// Screenshots of AI agents answering SMS and email: Settings > AI agents > SMS and email answers, and an AI text in the inbox (3 viewports x light/dark).
// `npx playwright test tests/shots-ai-channels.spec.ts --project=shots`.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { loginApi } from "../support/api.mjs";
import { scrollToTop } from "../support/scroll";
import { expect, signIn, stamp, test } from "../support/fixtures";

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design");
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [{ id: "1440x900", width: 1440, height: 900 }, { id: "1024x768", width: 1024, height: 768 }, { id: "390x844", width: 390, height: 844 }] as const;
const shot = async (page: Page, name: string, vp: string, scheme: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}-${vp}-${scheme}.jpg`), type: "jpeg", quality: 82 });
};
async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
for (const vp of VIEWPORTS) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`ai channels ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
      test("settings and an AI text", async ({ page, baseURL }) => {
        const api = await loginApi(baseURL!);
        const kb = await req(baseURL!, api.token, "POST", "/kb", { question: "How do I reset my password?", answer: "Open Settings, choose Security and press Reset password. We email you a link." });
        const agent = await req(baseURL!, api.token, "POST", "/agents", { name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", channels: ["widget", "sms", "email"] });
        await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { routing: { require_online: false }, ai_channels: { sms: { enabled: true, quiet_hours: { enabled: true, start: "22:00", end: "07:00" } }, email: { enabled: true, signature: "Acme Support, Monday to Friday" } } } });
        const phone = `+1415556${String(Math.floor(1000 + Math.random() * 8999))}`;
        try {
          await signIn(page);
          await page.goto("/settings/ai-agents");
          const h = page.getByRole("heading", { name: "SMS and email answers" });
          await expect(h).toBeVisible();
          await scrollToTop(h);
          await shot(page, "ai-channels-settings", vp.id, scheme);
          await fetch(`${baseURL}/webhooks/twilio/sms`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: phone, To: "+14155550100", Body: "How do I reset my password?", MessageSid: `SMshot${stamp}${Date.now()}` }).toString() });
          await page.goto("/inbox");
          await page.getByRole("link", { name: new RegExp(phone.slice(-4)) }).first().click();
          await expect(page.getByText("Test mode: not sent").first()).toBeVisible({ timeout: 15_000 });
          await shot(page, "ai-channels-sms-reply", vp.id, scheme);
        } finally {
          await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { ai_channels: { sms: { enabled: false }, email: { enabled: false } } } }).catch(() => {});
          await req(baseURL!, api.token, "DELETE", `/agents/${agent.id}`).catch(() => {});
          await req(baseURL!, api.token, "DELETE", `/kb/${kb.id}`).catch(() => {});
        }
      });
    });
  }
}
