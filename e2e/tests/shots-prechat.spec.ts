// Screenshots of the pre-chat custom fields: the widget and the hosted chat forms, Settings > Visitor details and a department's override
// (3 viewports x light/dark). `npx playwright test tests/shots-prechat.spec.ts --project=shots`.
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
const VI = {
  fields: { name: "required", email: "optional", phone: "off" },
  custom_fields: [
    { key: "plan", label: "Your plan", type: "select", options: ["Free", "Pro"], mode: "required" },
    { key: "order_no", label: "Order number", type: "text", mode: "optional" },
    { key: "terms", label: "I accept the terms of service", type: "checkbox", mode: "required" },
  ],
  consent: { enabled: true, text: "You may email me about this conversation.", privacy_url: "https://example.com/privacy" },
};
for (const vp of VIEWPORTS) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`prechat ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
      test("forms and settings", async ({ page, baseURL }) => {
        const api = await loginApi(baseURL!);
        await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { widget: { visitor_info: VI } } });
        const site = await startCustomerSite(baseURL!);
        const t = await req(baseURL!, api.token, "POST", "/tokens", { domain: `shot-pre-${stamp}-${vp.id}-${scheme}.example.com`, hosted_chat_enabled: true });
        try {
          await page.goto(site.url);
          await page.getByRole("button", { name: "Open chat" }).click();
          await page.getByLabel("Your name").fill("Pat");
          await page.getByRole("button", { name: "Start chat" }).click();
          await expect(page.getByText("Please tick this box")).toBeVisible();
          await shot(page, "prechat-widget", vp.id, scheme);
          await page.goto(`/chat?token=${t.token}&bridge=none`);
          await expect(page.getByLabel("Your plan")).toBeVisible();
          await shot(page, "prechat-hosted", vp.id, scheme);
          await signIn(page);
          await page.goto("/settings/visitor-info");
          const h = page.getByRole("group", { name: "Custom field 3" });
          await expect(h).toBeVisible();
          await scrollToTop(page.getByRole("group", { name: "Custom field 1" }));
          await shot(page, "prechat-settings", vp.id, scheme);
          await page.goto("/settings/departments");
          await page.getByRole("button", { name: /^Edit department/ }).first().click();
          const g = page.getByRole("group", { name: "Custom fields in this department" });
          await expect(g).toBeVisible();
          await scrollToTop(g, 80);
          await shot(page, "prechat-department", vp.id, scheme);
        } finally {
          await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { widget: { visitor_info: { fields: { name: "off", email: "off", phone: "off" }, custom_fields: [], consent: { enabled: false } } } } }).catch(() => {});
          await site.close();
        }
      });
    });
  }
}
