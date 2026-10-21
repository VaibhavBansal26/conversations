// Copies of a conversation by email in real Chrome against the built server. The stack's email provider is the console one (TEST MODE): the copy is
// recorded and the visitor and the team are told it was not sent. NOT exercised: a real SendGrid account, real mailboxes, spam filters.
import { expect, signIn, stamp, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";
import { startCustomerSite } from "../support/site";

async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

test("a visitor asks for a copy, gives an address with consent in the chat, and gets it (test mode says so honestly); the team can send one from the conversation menu", async ({ browser, page, baseURL }) => {
  const api = await loginApi(baseURL!);
  await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { transcripts: { enabled: true }, widget: { visitor_info: { fields: { email: "ask_when_needed" }, consent: { enabled: true, text: "You may email me about this conversation." } } } } });
  const site = await startCustomerSite(baseURL!);
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  const name = `Copy Cat ${stamp}`;
  try {
    await v.goto(site.url);
    await v.getByRole("button", { name: "Open chat" }).click();
    await v.getByLabel("Your name").fill(name);
    await v.getByRole("button", { name: "Start chat" }).click();
    const box = v.getByRole("textbox", { name: "Message" });
    await box.fill("Where is my order 1234?");
    await box.press("Enter");
    await v.getByRole("button", { name: "Email me a copy" }).click();
    await expect(v.getByText(/Share your email address in the form/)).toBeVisible();
    await v.getByLabel(/^Email/).last().fill(`copy.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`);
    await v.getByRole("checkbox", { name: /You may email me/ }).check();
    await v.getByRole("button", { name: "Send", exact: true }).last().click();
    await v.getByRole("button", { name: "Email me a copy" }).click();
    await expect(v.getByText("Test mode: the copy was not sent.")).toBeVisible();

    await signIn(page);
    await page.getByRole("link", { name: new RegExp(name) }).first().click();
    await expect(page.getByText(/A copy of this conversation was NOT emailed \(test mode/)).toBeVisible();
    await page.getByRole("button", { name: /More actions|Conversation actions|More/ }).first().click();
    await page.getByRole("menuitem", { name: "Email a copy to the contact" }).click();
    await expect(page.getByText("Not sent: test mode").first()).toBeVisible();
  } finally {
    await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { transcripts: { enabled: false }, widget: { visitor_info: { fields: { email: "off" }, consent: { enabled: false } } } } }).catch(() => {});
    await ctx.close();
    await site.close();
  }
});
