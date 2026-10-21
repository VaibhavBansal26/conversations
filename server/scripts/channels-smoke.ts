/**
 * Real-provider smoke test for the channel adapters. NOT part of `npm test`: this is the one place that talks to Twilio and SendGrid.
 * Credentials come from environment variables only (never from a file, never from the database); nothing is printed except masked hints.
 *
 *   TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... npm run smoke:channels --prefix server
 *   SENDGRID_API_KEY=SG.... npm run smoke:channels --prefix server
 *
 * Read-only by default (fetch the account, list numbers, list key scopes, verified senders, authenticated domains).
 * Set SMOKE_SEND=1 as well to send ONE real text and/or ONE real email (this can cost money and, on trial accounts, only reaches verified numbers):
 *   SMOKE_SMS_FROM=+1... SMOKE_SMS_TO=+1...      (both must be set to send a text)
 *   SMOKE_EMAIL_FROM=verified@yourdomain SMOKE_EMAIL_TO=you@example.com
 * Optional: TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET to exercise API-key authentication.
 */
import { SendGridEmailProvider } from "../src/providers/sendgrid.js";
import { TwilioSmsProvider } from "../src/providers/twilio.js";
import { ProviderError } from "../src/providers/types.js";
import { maskTail } from "../src/util/redact.js";

const env = process.env;
let failures = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const warn = (m: string) => console.log(`  note  ${m}`);

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    ok(name);
    return r;
  } catch (e) {
    if (e instanceof ProviderError) bad(`${name}: [${e.code}] ${e.message}\n          fix: ${e.hint ?? "-"}`);
    else bad(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

const send = env.SMOKE_SEND === "1";

if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
  console.log(`Twilio account ${maskTail(env.TWILIO_ACCOUNT_SID)} (token ${maskTail(env.TWILIO_AUTH_TOKEN)})`);
  const tw = new TwilioSmsProvider(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, fetch, undefined, { apiKeySid: env.TWILIO_API_KEY_SID, apiKeySecret: env.TWILIO_API_KEY_SECRET });
  const acct = await step("fetch account", () => tw.fetchAccount());
  if (acct) {
    console.log(`        name=${JSON.stringify(acct.friendly_name)} status=${acct.status} type=${acct.type}`);
    if (/trial/i.test(acct.type)) warn("trial account: texts reach only verified numbers and carry a trial prefix");
  }
  const nums = await step("list incoming phone numbers", () => tw.listNumbers());
  if (nums) console.log(`        ${nums.length} number(s): ${nums.map((n) => `${n.e164}${n.sms_capable ? "" : " (no SMS)"}`).join(", ") || "none"}`);
  if (send) {
    if (env.SMOKE_SMS_FROM && env.SMOKE_SMS_TO) {
      const r = await step("send one text", () => tw.send({ from: env.SMOKE_SMS_FROM!, to: env.SMOKE_SMS_TO!, body: "Conversations smoke test", idempotencyKey: `smoke-${Date.now()}` }));
      if (r) {
        console.log(`        message ${r.providerMessageId}`);
        await new Promise((res) => setTimeout(res, 3000));
        await step("fetch its status", async () => console.log(`        ${JSON.stringify(await tw.fetchStatus(r.providerMessageId))}`));
      }
    } else warn("SMOKE_SEND=1 but SMOKE_SMS_FROM / SMOKE_SMS_TO are not both set: no text sent");
  }
} else warn("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set: Twilio skipped");

if (env.SENDGRID_API_KEY) {
  console.log(`SendGrid key ${maskTail(env.SENDGRID_API_KEY)}`);
  const sg = new SendGridEmailProvider(env.SENDGRID_API_KEY);
  const scopes = await step("list API key scopes", () => sg.fetchScopes());
  if (scopes) {
    console.log(`        ${scopes.length} scope(s); mail.send: ${scopes.includes("mail.send") ? "yes" : "NO"}`);
    if (!scopes.includes("mail.send")) bad("the key cannot send mail");
  }
  const senders = await step("list verified senders", () => sg.listVerifiedSenders());
  if (senders === null) warn("the key may not read Sender Authentication (403/404)");
  else if (senders) console.log(`        ${senders.filter((s) => s.verified).length} verified of ${senders.length}: ${senders.map((s) => `${s.email}${s.verified ? "" : " (unverified)"}`).join(", ")}`);
  const domains = await step("list authenticated domains", () => sg.listAuthenticatedDomains());
  if (domains) console.log(`        ${domains.map((d) => `${d.domain}${d.valid ? "" : " (invalid DNS)"}`).join(", ") || "none"}`);
  if (send) {
    if (env.SMOKE_EMAIL_FROM && env.SMOKE_EMAIL_TO) {
      const r = await step("send one email", () =>
        sg.send({ from: { address: env.SMOKE_EMAIL_FROM! }, to: env.SMOKE_EMAIL_TO!, subject: "Conversations smoke test", text: "It works.", html: "<p>It works.</p>", messageId: `<smoke-${Date.now()}@conversations.local>` }),
      );
      if (r) console.log(`        accepted, id ${r.providerMessageId}`);
    } else warn("SMOKE_SEND=1 but SMOKE_EMAIL_FROM / SMOKE_EMAIL_TO are not both set: no email sent");
  }
} else warn("SENDGRID_API_KEY not set: SendGrid skipped");

if (!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) && !env.SENDGRID_API_KEY) {
  console.log("Nothing to check: set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN and/or SENDGRID_API_KEY (see the header of this file).");
  process.exit(2);
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
