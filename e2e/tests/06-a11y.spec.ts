import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { composer, expect, openRoom, signIn, test } from "../support/fixtures";

/** WCAG 2.x A/AA rules, including colour contrast, on real rendered pages. Serious and critical findings fail the test. */
async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")} :: ${v.nodes[0]?.failureSummary?.split("\n").slice(1, 3).join(" ")}`);
  expect(summary, `${label}\n${summary.join("\n")}`).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`accessibility (axe, ${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test("sign-in and password reset pages", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
      await audit(page, "login");
      await page.goto("/forgot-password");
      await expect(page.getByRole("heading").first()).toBeVisible();
      await audit(page, "forgot password");
    });

    test("inbox, conversation, contact panel and composer states", async ({ page }) => {
      await signIn(page);
      await expect(page.getByRole("link", { name: /Alice Johnson/ })).toBeVisible();
      await audit(page, "inbox");
      await openRoom(page, "Alice Johnson");
      await page.getByRole("button", { name: "Contact details", exact: true }).click();
      await expect(page.getByRole("complementary", { name: "Contact details" }).or(page.getByRole("dialog", { name: "Contact details" }))).toBeVisible();
      await audit(page, "conversation with contact panel");
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "Note" }).click();
      await composer(page).fill("a note");
      await audit(page, "note composer");
    });

    test("overlays: command palette, shortcuts help, new conversation dialog, menus", async ({ page }) => {
      await signIn(page);
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      await audit(page, "command palette");
      await page.keyboard.press("Escape");
      await page.keyboard.press("?");
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
      await audit(page, "shortcuts help");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^New conversation/ }).first().click();
      await expect(page.getByRole("dialog", { name: "New conversation" })).toBeVisible();
      await audit(page, "new conversation");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Account menu" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await audit(page, "account menu");
    });

    test("settings pages, widget customiser, analytics", async ({ page }) => {
      await signIn(page);
      for (const path of ["/settings/general", "/settings/widget", "/settings/inboxes", "/settings/members", "/settings/roles", "/settings/templates", "/settings/billing", "/settings/security", "/analytics"]) {
        await page.goto(path);
        await expect(page.locator("main, #main").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await audit(page, path);
      }
    });

    test("operator console sign-in", async ({ page }) => {
      await page.goto("/admin");
      await expect(page.getByLabel("Email")).toBeVisible();
      await audit(page, "admin login");
    });
  });
}
