// AI agents answering SMS and email against the built server: inbound messages arrive through the provider webhooks (unsigned in this development
// stack), the server pipeline answers, and the replies go through the console providers (TEST MODE: stored as not sent). The inbox shows the
// reply with its honest state. NOT exercised: a real Twilio or SendGrid account, real carriers and mail servers, real out-of-office systems.
import { expect, signIn, stamp, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";

async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const form = (base: string, path: string, fields: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

test("a text and an email are answered by the AI in plain text, with the AI disclosure, and shown as not sent in test mode; an out-of-office reply is not answered", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const api = await loginApi(baseURL!);
  const kb = await req(baseURL!, api.token, "POST", "/kb", { question: "How do I reset my password?", answer: "Open Settings, choose Security and press Reset password. We email you a link." });
  const agent = await req(baseURL!, api.token, "POST", "/agents", { name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", channels: ["widget", "sms", "email"] });
  await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { routing: { require_online: false }, ai_channels: { sms: { enabled: true, quiet_hours: { enabled: false } }, email: { enabled: true } } } });
  const phone = `+1415555${String(Math.floor(1000 + Math.random() * 8999))}`;
  const who = `ai.mail.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`;
  try {
    expect((await form(baseURL!, "/webhooks/twilio/sms", { From: phone, To: "+14155550100", Body: "How do I reset my password?", MessageSid: `SM${stamp}${Date.now()}` })).status).toBe(200);
    expect((await form(baseURL!, "/webhooks/sendgrid/inbound", { from: `Ann Mail <${who}>`, to: "inbound@parse.demo.example.test", subject: `Password ${stamp}`, text: "Hi, how do I reset my password?", headers: `Message-ID: <first.${stamp}@example.test>` })).status).toBe(200);
    expect((await form(baseURL!, "/webhooks/sendgrid/inbound", { from: `Ann Mail <${who}>`, to: "inbound@parse.demo.example.test", subject: `Automatic reply: Password ${stamp}`, text: "I am out of the office until Monday.", headers: `Message-ID: <ooo.${stamp}@example.test>\nAuto-Submitted: auto-replied` })).status).toBe(200);

    await signIn(page);
    // the SMS conversation: the AI's text, prefixed with its name and label, saved but not sent (test mode)
    await page.getByRole("link", { name: new RegExp(phone.slice(-4)) }).first().click();
    const thread = page.getByRole("log").or(page.locator("#main"));
    await expect(thread.first()).toContainText("Aria (AI assistant): Open Settings, choose Security", { timeout: 15_000 });
    await expect(thread.first()).toContainText("Reply 1 for Yes, thanks, 2 for Not quite or 3 for Talk to a person. Reply HUMAN for a person.");
    await expect(page.getByText("Test mode: not sent").first()).toBeVisible();
    // the email conversation: disclosure, sign-off; the out-of-office reply got no answer and the team is told why
    await page.getByRole("link", { name: /Ann Mail/ }).first().click();
    await expect(thread.first()).toContainText("This is Aria, the AI assistant of", { timeout: 15_000 });
    await expect(thread.first()).toContainText("Reply HUMAN to reach a person.");
    await expect(thread.first()).toContainText("did not answer: this looks like an automatic message");
  } finally {
    await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { ai_channels: { sms: { enabled: false }, email: { enabled: false } } } }).catch(() => {});
    await req(baseURL!, api.token, "DELETE", `/agents/${agent.id}`).catch(() => {});
    await req(baseURL!, api.token, "DELETE", `/kb/${kb.id}`).catch(() => {});
  }
});
