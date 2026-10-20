import { expect, openRoom, signIn, test } from "../support/fixtures";

test.describe("mobile (390x844): list and chat are separate screens with bottom navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("list -> chat -> back, bottom navigation, no horizontal scroll", async ({ page }) => {
    await signIn(page);
    const bottom = page.getByRole("navigation", { name: "Main" });
    await expect(bottom).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Contact details" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Conversation" })).toBeHidden();
    await openRoom(page, "Alice Johnson");
    await expect(page.getByRole("region", { name: "Conversations" })).toBeHidden();
    await expect(bottom).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Write a reply" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("link", { name: "Back to conversations" }).click();
    await expect(page.getByRole("region", { name: "Conversations" })).toBeVisible();
    await expect(bottom).toBeVisible();
    await bottom.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole("link", { name: "Chat widget" })).toBeVisible();
    await page.getByRole("link", { name: "Chat widget" }).click();
    await expect(page.getByRole("form", { name: "Chat widget settings" })).toBeVisible();
    await page.getByRole("link", { name: /back/i }).first().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("the filters drawer and the contact drawer open as sheets", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("link", { name: /Priority/ })).toBeVisible();
    await drawer.getByRole("link", { name: /Priority/ }).click();
    await expect(page.getByRole("heading", { name: "Priority" })).toBeVisible();
    await openRoom(page, "Dave Kim");
    await page.getByRole("button", { name: "Contact details", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("the narrowest supported width (360x640) has no horizontal overflow on the main screens", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await signIn(page);
    for (const path of ["/inbox", "/settings", "/analytics", "/settings/widget", "/settings/billing"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  });
});

test.describe("tablet (1024x768): the sidebar and the contact panel are drawers", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("sidebar sheet from the list header, contact panel sheet from the thread", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("navigation", { name: "Inbox navigation" })).toBeHidden();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog").getByRole("link", { name: /Unassigned/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await openRoom(page, "Alice Johnson");
    await expect(page.getByRole("region", { name: "Conversations" })).toBeVisible();
    await page.getByRole("button", { name: "Contact details", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("animations and transitions collapse to ~0ms", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Account menu" }).click();
    const d = await page.getByRole("menu").evaluate((el) => parseFloat(getComputedStyle(el).animationDuration) * (getComputedStyle(el).animationDuration.endsWith("ms") ? 1 : 1000));
    expect(d).toBeLessThan(5);
  });
});
