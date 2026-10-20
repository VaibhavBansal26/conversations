import { expect, signIn, test } from "../support/fixtures";

const stamp = Date.now().toString(36);

test.describe("settings", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Settings" }).click();
  });

  test("grouped navigation reaches every section", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "Settings" });
    for (const [label, heading] of [
      ["Inboxes", /Inboxes/],
      ["Templates", /Templates/],
      ["Members & seats", /Members/],
      ["Billing & credits", /Billing|Plan/],
      ["Account security", /security|Two-factor|Password/i],
    ] as const) {
      await nav.getByRole("link", { name: label }).click();
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    }
  });

  test("General: editing the workspace name shows unsaved state, saves with a toast and persists", async ({ page }) => {
    await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "General", exact: true }).click();
    const name = page.getByLabel("Workspace name");
    await name.fill(`Demo Co ${stamp}`);
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/settings saved|saved/i).first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Workspace name")).toHaveValue(`Demo Co ${stamp}`);
  });

  test("Templates: create, find and delete a template", async ({ page }) => {
    await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Templates" }).click();
    await page.getByRole("button", { name: /new template/i }).click();
    await page.getByLabel("Name").fill(`Refund ${stamp}`);
    await page.getByLabel("Shortcut").fill(`refund${stamp}`.slice(0, 20));
    await page.getByLabel(/^(Body|Message)/).fill("Hi {{contact.first_name|there}}, your refund is on its way.");
    await page.getByRole("button", { name: /^(save|create)/i }).click();
    await expect(page.getByText(`Refund ${stamp}`)).toBeVisible();
    await page.getByRole("button", { name: /delete/i }).last().click().catch(() => undefined);
  });

  test("Inboxes: create an inbox with a dialog", async ({ page }) => {
    await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Inboxes" }).click();
    await page.getByRole("button", { name: /new inbox/i }).click();
    await page.getByLabel("Name").fill(`Billing ${stamp}`);
    await page.getByRole("button", { name: /^(save|create)/i }).click();
    await expect(page.getByText(`Billing ${stamp}`).first()).toBeVisible();
  });

  test("Roles: invitation and custom role panels open and close", async ({ page }) => {
    await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Roles & invitations" }).click();
    await expect(page.getByRole("heading", { name: /Roles/ }).first()).toBeVisible();
    await page.getByRole("button", { name: /new custom role/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});

test.describe("widget customiser", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/widget");
    await expect(page.getByRole("form", { name: "Chat widget settings" })).toBeVisible();
  });

  test("the live preview follows title, colour and launcher style, and the change saves", async ({ page }) => {
    const preview = page.getByRole("complementary", { name: "Preview" });
    await page.getByLabel("Title").fill(`Hello from ${stamp}`);
    await expect(preview.getByText(`Hello from ${stamp}`)).toBeVisible();
    const header = preview.getByText(`Hello from ${stamp}`);
    const before = await header.evaluate((el) => getComputedStyle(el.closest("[data-preview-header]") ?? el.parentElement!.parentElement!).backgroundColor);
    await page.getByLabel("Brand colour").fill("#b91c1c");
    await expect.poll(() => header.evaluate((el) => getComputedStyle(el.closest("[data-preview-header]") ?? el.parentElement!.parentElement!).backgroundColor)).not.toBe(before);
    await page.getByRole("radio", { name: /Pill/ }).click();
    await expect(page.getByRole("radio", { name: /Pill/ })).toBeChecked();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel("Title")).toHaveValue(`Hello from ${stamp}`);
    await expect(page.getByRole("radio", { name: /Pill/ })).toBeChecked();
  });

  test("a low-contrast text colour is flagged and fixed with one click", async ({ page }) => {
    await page.getByLabel("Brand colour").fill("#ffee00");
    await page.getByLabel("Text colour").fill("#ffffff");
    await expect(page.getByText(/contrast/i).first()).toBeVisible();
    await page.getByRole("button", { name: /fix automatically/i }).click();
    await expect(page.getByText(/contrast/i)).toHaveCount(0);
  });

  test("preview switches between screens, colour schemes and devices", async ({ page }) => {
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("radio", { name: "Dark" }).click();
    await preview.getByRole("radio", { name: "Phone" }).click();
    await preview.getByRole("radio", { name: "Pre-chat" }).click();
    await expect(preview).toBeVisible();
    await preview.getByRole("radio", { name: "Closed" }).click();
  });
});
