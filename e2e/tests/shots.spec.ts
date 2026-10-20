// Screenshot matrix for docs/design: pages x 3 viewports x light/dark. Run with `npm run shots` (writes to ../docs/design).
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { adminSignIn, expect, openRoom, signIn, test } from "../support/fixtures";

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { id: "1440x900", width: 1440, height: 900 },
  { id: "1024x768", width: 1024, height: 768 },
  { id: "390x844", width: 390, height: 844 },
] as const;
const SCHEMES = ["light", "dark"] as const;

const shot = async (page: Page, name: string, vp: string, scheme: string) => {
  await page.waitForTimeout(350); // let transitions settle
  await page.screenshot({ path: join(OUT, `${name}-${vp}-${scheme}.jpg`), type: "jpeg", quality: 82 });
};

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600 });

      test("login", async ({ page }) => {
        await page.goto("/login");
        await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
        await shot(page, "login", vp.id, scheme);
      });

      test("inbox and conversation", async ({ page }) => {
        await signIn(page);
        await expect(page.getByRole("link", { name: /Alice Johnson/ })).toBeVisible();
        await shot(page, "inbox", vp.id, scheme);
        await openRoom(page, "Alice Johnson");
        await expect(page.getByTestId("voice-note").first()).toBeVisible();
        await shot(page, "conversation", vp.id, scheme);
        await page.getByRole("button", { name: "Contact details", exact: true }).click();
        await page.getByRole("button", { name: "Details", exact: true }).click().catch(() => undefined);
        await shot(page, "contact-panel", vp.id, scheme);
      });

      test("composer, palette and dialogs", async ({ page }) => {
        await signIn(page);
        await openRoom(page, "Grace Hopper");
        await page.getByRole("tab", { name: "Note" }).click();
        await page.getByRole("textbox", { name: /internal note/ }).fill("Carrier says the label was voided. Re-issuing. cc");
        await shot(page, "composer-note", vp.id, scheme);
        await page.getByRole("textbox", { name: /internal note/ }).fill("");
        await page.getByRole("tab", { name: "Email" }).click();
        await shot(page, "composer-email", vp.id, scheme);
        if (vp.width >= 768) {
          await page.keyboard.press("ControlOrMeta+k");
          await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
          await shot(page, "command-palette", vp.id, scheme);
          await page.keyboard.press("Escape");
        }
        // on a phone the account menu lives in the bottom navigation, which the thread screen hides: go back to the list first
        if (vp.width < 768) await page.getByRole("link", { name: "Back to conversations" }).click();
        await page.getByRole("button", { name: "Account menu" }).click();
        await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
        await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
        await shot(page, "shortcuts-help", vp.id, scheme);
      });

      test("settings, widget customiser, analytics", async ({ page }) => {
        await signIn(page);
        await page.goto("/settings/general");
        await page.waitForLoadState("networkidle");
        await shot(page, "settings", vp.id, scheme);
        await page.goto("/settings/widget");
        await expect(page.getByRole("form", { name: "Chat widget settings" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "widget-customiser", vp.id, scheme);
        await page.goto("/settings/members");
        await page.waitForLoadState("networkidle");
        await shot(page, "members", vp.id, scheme);
        await page.goto("/analytics");
        await expect(page.getByText("Conversations opened").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "analytics", vp.id, scheme);
      });

      test("operator console sign-in", async ({ page }) => {
        await page.goto("/admin");
        await expect(page.getByLabel("Email")).toBeVisible();
        await shot(page, "admin-login", vp.id, scheme);
      });
    });
  }
}

// The operator console: one sign-in (a TOTP code can be used once per 30 s window), then every size and scheme in the same session.
test("operator console, all sizes", async ({ page }) => {
  test.setTimeout(180_000);
  await adminSignIn(page);
  await page.waitForLoadState("networkidle");
  const go = async (path: string) => {
    await page.evaluate((p) => {
      history.pushState({}, "", p);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
  };
  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.emulateMedia({ colorScheme: scheme });
      await go("/admin");
      await expect(page.getByRole("link", { name: /Demo Co/ }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await shot(page, "admin", vp.id, scheme);
      await page.getByRole("link", { name: /Demo Co/ }).first().click();
      await expect(page.getByRole("heading", { name: /Demo Co/ }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await shot(page, "admin-workspace", vp.id, scheme);
    }
  }
});

// The embeddable widget on a host page (it follows the visitor's colour scheme).
for (const scheme of SCHEMES) {
  test(`widget on a host page, ${scheme}`, async ({ browser, baseURL }) => {
    const { startCustomerSite } = await import("../support/site");
    const site = await startCustomerSite(baseURL!, "<h1>Acme Shop</h1><p>Handmade ceramics, shipped worldwide. Questions about an order? Chat with us any time.</p>");
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(site.url);
    await page.getByRole("button", { name: "Open chat" }).click();
    await page.waitForTimeout(600);
    await shot(page, "widget", "1024x768", scheme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await shot(page, "widget", "390x844", scheme);
    await ctx.close();
    await site.close();
  });
}
