// Screenshots of copies by email: Settings > Tickets > Copies by email, and the widget after asking for a copy (test mode), 3 viewports x light/dark.
// `npx playwright test tests/shots-transcripts.spec.ts --project=shots`.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { loginApi } from "../support/api.mjs";
import { scrollToTop } from "../support/scroll";
import { startCustomerSite } from "../support/site";
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
    test.describe(`transcripts ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
      test("settings and the widget", async ({ page, browser, baseURL }) => {
        const api = await loginApi(baseURL!);
        await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { transcripts: { enabled: true, send_after_resolve: true }, widget: { visitor_info: { fields: { email: "ask_when_needed" }, consent: { enabled: true, text: "You may email me about this conversation." } } } } });
        const site = await startCustomerSite(baseURL!);
        try {
          await signIn(page);
          await page.goto("/settings/tickets");
          const h = page.getByRole("heading", { name: "Copies by email" });
          await expect(h).toBeVisible();
          await scrollToTop(h);
          await shot(page, "transcripts-settings", vp.id, scheme);
          const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
          const v = await ctx.newPage();
          await v.goto(site.url);
          await v.getByRole("button", { name: "Open chat" }).click();
          await v.getByLabel("Your name").fill(`Shot ${stamp}`);
          await v.getByRole("button", { name: "Start chat" }).click();
          const box = v.getByRole("textbox", { name: "Message" });
          await box.fill("Can I get a copy of this chat?");
          await box.press("Enter");
          await v.getByRole("button", { name: "Email me a copy" }).click();
          await expect(v.getByText(/Share your email address in the form/)).toBeVisible();
          await v.getByLabel(/^Email/).last().fill(`shot.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`);
          await v.getByRole("checkbox", { name: /You may email me/ }).check();
          await v.getByRole("button", { name: "Send", exact: true }).last().click();
          await v.getByRole("button", { name: "Email me a copy" }).click();
          await expect(v.getByText("Test mode: the copy was not sent.")).toBeVisible();
          await shot(v, "transcripts-widget", vp.id, scheme);
          await ctx.close();
        } finally {
          await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { transcripts: { enabled: false, send_after_resolve: false }, widget: { visitor_info: { fields: { email: "off" }, consent: { enabled: false } } } } }).catch(() => {});
          await site.close();
        }
      });
    });
  }
}
