import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO, OPERATOR_CREDS } from "./creds";
import { totp } from "./totp";

export { DEMO };

/** One value per run (the config sets it once), so a worker restarted after a failure still finds the data earlier tests created. */
export const stamp = process.env.E2E_STAMP ?? Date.now().toString(36);

/** Real sign-in through the form: click, type, submit. */
export async function signIn(page: Page, creds: { email: string; password: string } = DEMO): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/inbox/);
  // the app shell is a lazy chunk: wait until it is mounted (keyboard shortcuts and the palette are registered by then)
  await expect(page.locator("#main")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Conversation status" })).toBeVisible();
}

/** Opens a conversation from the room list by the contact's name. */
export async function openRoom(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name: new RegExp(name) }).first().click();
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
}

export const composer = (page: Page): Locator => page.getByRole("textbox", { name: /write a reply|write an internal note/i });

/** Types into the composer like a person and presses Enter. */
export async function sendReply(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.click();
  await box.fill("");
  await box.pressSequentially(text, { delay: 5 });
  await box.press("Enter");
}

/** A brand-new website visitor writes in through the public API (exactly like the widget); returns the visitor's name. */
export async function freshVisitor(baseURL: string, name: string, lines: string[]): Promise<string> {
  const { embedToken, visitorConversation } = await import("./api.mjs");
  await visitorConversation(baseURL, await embedToken(baseURL), { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@example.test` }, lines);
  return name;
}

/**
 * Operator console sign-in through the form. The first run enrols an authenticator (the secret is shown on screen and kept in a temp
 * file for this stack); later runs answer the TOTP challenge with a code computed from it. A code can only be used once per 30 s
 * window, so a rejected code waits for the next window and tries again.
 */
export async function adminSignIn(page: Page): Promise<void> {
  const secretFile = join(tmpdir(), `conv-e2e-operator-secret-${process.env.E2E_PORT}`);
  await page.goto("/admin");
  await page.getByLabel("Email").fill(OPERATOR_CREDS.email);
  await page.getByLabel("Password", { exact: true }).fill(OPERATOR_CREDS.password);
  await page.getByRole("button", { name: /sign in|continue/i }).click();
  const code = page.getByLabel("6-digit code");
  await expect(code).toBeVisible();
  const shown = page.locator("[data-secret], code").first();
  let secret: string | null = existsSync(secretFile) ? readFileSync(secretFile, "utf8") : null;
  if (await shown.isVisible().catch(() => false)) {
    secret = (await shown.innerText()).replace(/\s/g, "");
    writeFileSync(secretFile, secret);
  }
  if (!secret) throw new Error("operator is enrolled but the secret is unknown for this stack");
  const console_ = page.getByRole("navigation", { name: "Platform console" });
  const saved = page.getByRole("button", { name: /i have saved|done|continue/i });
  for (let attempt = 0; attempt < 2; attempt++) {
    await code.fill(totp(secret));
    await page.getByRole("button", { name: /enable|verify|confirm|continue|sign in/i }).last().click();
    // success is either the console itself or a recovery-codes step that has to be acknowledged first
    await expect(console_.or(saved).or(page.getByRole("alert"))).toBeVisible({ timeout: 20_000 });
    if (await saved.isVisible().catch(() => false)) await saved.click();
    if (await console_.isVisible({ timeout: 15_000 }).catch(() => false)) return;
    // rejected (that 30 s window was already used): wait for the next one
    await page.waitForTimeout(31_000 - (Date.now() % 30_000));
  }
}

export { OPERATOR_CREDS };
export const test = base;
export { expect };
