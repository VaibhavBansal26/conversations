import { adminSignIn, expect, signIn, test } from "../support/fixtures";

test("analytics: KPI cards, range switch and the accessible data table", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByText("Conversations opened").first()).toBeVisible();
  await page.getByRole("tab", { name: "Last 7 days" }).click();
  await expect(page.getByRole("tab", { name: "Last 7 days" })).toHaveAttribute("aria-selected", "true");
  await page.getByText("Show data as a table").first().click();
  await expect(page.getByRole("table").first()).toBeVisible();
});

test("operator console: sign in with enrolment (TOTP), directory, workspace detail, audit", async ({ page }) => {
  await adminSignIn(page);
  await expect(page.getByRole("navigation", { name: "Platform console" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: /Demo Co/ }).first().click();
  await expect(page.getByRole("heading", { name: /Demo Co/ }).first()).toBeVisible();
  await page.getByRole("navigation", { name: "Platform console" }).getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByRole("table").first()).toBeVisible();
  await expect(page.getByText(/admin\.(login|mfa)|workspace/i).first()).toBeVisible();
});
