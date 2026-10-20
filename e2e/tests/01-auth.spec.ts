import { expect, signIn, test, DEMO } from "../support/fixtures";

test.describe("authentication", () => {
  test("a wrong password shows the server's message and keeps the form", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(DEMO.email);
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("password visibility can be toggled", async ({ page }) => {
    await page.goto("/login");
    const pw = page.getByLabel("Password", { exact: true });
    await pw.fill("secret-value");
    await expect(pw).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: /show password/i }).click();
    await expect(pw).toHaveAttribute("type", "text");
  });

  test("signs in, lands on the inbox and signs out through the account menu", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "All conversations" })).toBeVisible();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/login/);
  });

  test("the theme switch on the sign-in page pins dark mode and survives a reload", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});
