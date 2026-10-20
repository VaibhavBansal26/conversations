import { expect, signIn, test } from "../support/fixtures";

test("signs in and shows the inbox", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "All conversations" })).toBeVisible();
  await page.screenshot({ path: "/tmp/e2e-smoke.png" });
});
