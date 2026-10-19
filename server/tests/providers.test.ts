import { describe, expect, it, vi } from "vitest";
import { TwilioSmsProvider } from "../src/providers/twilio.js";
import { SendGridEmailProvider } from "../src/providers/sendgrid.js";
import { ProviderError } from "../src/providers/types.js";
import { LocalDiskStorage } from "../src/providers/storage.js";
import { FakeSmsProvider, FakeEmailProvider, ConsoleSmsProvider, ConsoleEmailProvider } from "../src/providers/fake.js";
import { createAiProvider, AnthropicProvider } from "../src/ai/provider.js";
import { HeuristicProvider } from "../src/ai/heuristic.js";
import { silentLogger } from "../src/logger.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("TwilioSmsProvider (mocked fetch)", () => {
  const make = (f: typeof fetch) => new TwilioSmsProvider("AC123", "tok", f, "https://twilio.test");
  it("posts a form-encoded message with basic auth, idempotency token and status callback", async () => {
    const f = vi.fn(async () => json(201, { sid: "SM999", status: "queued" }));
    const r = await make(f as never).send({ to: "+14155552671", from: "+15550000001", body: "Hi", idempotencyKey: "msg_1", statusCallbackUrl: "https://app.test/webhooks/twilio/status" });
    expect(r).toEqual({ providerMessageId: "SM999" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://twilio.test/2010-04-01/Accounts/AC123/Messages.json");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Basic " + Buffer.from("AC123:tok").toString("base64"));
    expect(h["I-Twilio-Idempotency-Token"]).toBe("msg_1");
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({ To: "+14155552671", From: "+15550000001", Body: "Hi", StatusCallback: "https://app.test/webhooks/twilio/status" });
  });
  it("classifies failures: 4xx permanent, 429/5xx/network transient", async () => {
    const send = (f: typeof fetch) => make(f).send({ to: "+1", from: "+2", body: "x", idempotencyKey: "k" });
    await expect(send((async () => json(400, { code: 21211, message: "Invalid 'To' Phone Number" })) as never)).rejects.toMatchObject({ retryable: false, status: 400, message: expect.stringContaining("21211") });
    await expect(send((async () => json(401, { message: "Authenticate" })) as never)).rejects.toMatchObject({ retryable: false });
    await expect(send((async () => json(429, { message: "slow down" })) as never)).rejects.toMatchObject({ retryable: true });
    await expect(send((async () => json(503, {})) as never)).rejects.toMatchObject({ retryable: true });
    await expect(send((async () => { throw new Error("ECONNRESET"); }) as never)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining("ECONNRESET") });
    await expect(send((async () => json(200, {})) as never)).rejects.toBeInstanceOf(ProviderError);
  });
  it("maps provider status for reconciliation", async () => {
    const st = async (status: string, error_code: number | null = null) => make((async () => json(200, { status, error_code })) as never).fetchStatus("SM1");
    expect(await st("delivered")).toEqual({ state: "delivered" });
    expect(await st("undelivered", 30003)).toEqual({ state: "failed", error: "Carrier error 30003" });
    expect(await st("failed")).toMatchObject({ state: "failed" });
    expect(await st("queued")).toEqual({ state: "sent" });
    expect(await st("mystery")).toEqual({ state: "unknown" });
    expect(await make((async () => json(404, {})) as never).fetchStatus("SM1")).toEqual({ state: "unknown" });
  });
});

describe("SendGridEmailProvider (mocked fetch)", () => {
  const make = (f: typeof fetch) => new SendGridEmailProvider("SG.key", f, "https://sg.test");
  const input = {
    from: { address: "support@acme.test", name: "Acme Support" }, to: "cust@example.test", subject: "Re: Hello", html: "<p>Hi</p>", text: "Hi",
    messageId: "<m1@acme.test>", inReplyTo: "<m0@acme.test>", references: ["<a@x>", "<m0@acme.test>"], replyTo: "inbound@parse.acme.test",
    attachments: [{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hello") }],
  };
  it("builds the v3 payload with threading headers, reply-to, attachments and returns x-message-id", async () => {
    const f = vi.fn(async () => new Response(null, { status: 202, headers: { "x-message-id": "SGID123" } }));
    const r = await make(f as never).send(input);
    expect(r).toEqual({ providerMessageId: "SGID123" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sg.test/v3/mail/send");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer SG.key");
    const p = JSON.parse(init.body as string);
    expect(p).toMatchObject({
      personalizations: [{ to: [{ email: "cust@example.test" }] }], from: { email: "support@acme.test", name: "Acme Support" }, reply_to: { email: "inbound@parse.acme.test" }, subject: "Re: Hello",
      headers: { "Message-ID": "<m1@acme.test>", "In-Reply-To": "<m0@acme.test>", References: "<a@x> <m0@acme.test>" },
      content: [{ type: "text/plain", value: "Hi" }, { type: "text/html", value: "<p>Hi</p>" }],
      attachments: [{ content: Buffer.from("hello").toString("base64"), filename: "a.txt", type: "text/plain", disposition: "attachment" }],
    });
  });
  it("omits optional pieces and falls back to the Message-ID when no id header is returned", async () => {
    const f = vi.fn(async () => new Response(null, { status: 202 }));
    const r = await make(f as never).send({ from: { address: "a@b.test" }, to: "c@d.test", subject: "s", html: "", text: "", messageId: "<z@b.test>" });
    expect(r.providerMessageId).toBe("<z@b.test>");
    const p = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(p.reply_to).toBeUndefined();
    expect(p.attachments).toBeUndefined();
    expect(p.headers).toEqual({ "Message-ID": "<z@b.test>" });
  });
  it("classifies failures", async () => {
    const send = (f: typeof fetch) => make(f).send(input);
    await expect(send((async () => json(400, { errors: [{ message: "bad from" }] })) as never)).rejects.toMatchObject({ retryable: false, message: "SendGrid 400: bad from" });
    await expect(send((async () => json(429, {})) as never)).rejects.toMatchObject({ retryable: true });
    await expect(send((async () => json(500, {})) as never)).rejects.toMatchObject({ retryable: true });
    await expect(send((async () => { throw new Error("socket hang up"); }) as never)).rejects.toMatchObject({ retryable: true });
  });
});

describe("fake and console providers", () => {
  it("produce deterministic ids and can be told to fail", async () => {
    const sms = new FakeSmsProvider();
    expect((await sms.send({ to: "+1", from: "+2", body: "a", idempotencyKey: "1" })).providerMessageId).toBe("fake_sms_1");
    expect((await sms.send({ to: "+1", from: "+2", body: "b", idempotencyKey: "2" })).providerMessageId).toBe("fake_sms_2");
    sms.failNext(1, { message: "boom" });
    await expect(sms.send({ to: "+1", from: "+2", body: "c", idempotencyKey: "3" })).rejects.toThrow("boom");
    expect((await sms.fetchStatus("fake_sms_1")).state).toBe("sent");
    const lines: string[] = [];
    const log = { debug() {}, info: (m: string) => lines.push(m), warn() {}, error() {} };
    await new ConsoleSmsProvider(log).send({ to: "+1", from: "+2", body: "c", idempotencyKey: "3" });
    await new ConsoleEmailProvider(log).send({ from: { address: "a@b.test" }, to: "c@d.test", subject: "s", html: "", text: "", messageId: "<m>" });
    expect(lines).toEqual(["sms (console provider)", "email (console provider)"]);
    expect((await new FakeEmailProvider().send({ from: { address: "a@b.test" }, to: "c@d.test", subject: "s", html: "", text: "", messageId: "<m>" })).providerMessageId).toBe("fake_email_1");
  });
});

describe("LocalDiskStorage", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "stor-"));
  const ws = "ws_" + "a".repeat(24);
  it("stores per-workspace and rejects traversal-shaped keys", async () => {
    const s = new LocalDiskStorage(dir(), "http://x.test", "secret");
    const f = await s.put(ws, { name: "../../etc/passwd", contentType: "text/plain", content: Buffer.from("data") });
    expect(f.key).toMatch(new RegExp(`^${ws}/f_[0-9a-f]{24}$`));
    expect((await s.read(f.key))!.toString()).toBe("data");
    for (const bad of ["../x", `${ws}/../../x`, "/etc/passwd", `${ws}/f_..`, "ws_x/f_y", `${ws}/f_${"a".repeat(24)}/../f_${"b".repeat(24)}`]) {
      expect(await s.read(bad)).toBeNull();
    }
    await s.remove(f.key);
    expect(await s.read(f.key)).toBeNull();
  });
  it("signs URLs that expire and fail on tampering", async () => {
    let now = 1_000_000_000_000;
    const s = new LocalDiskStorage(dir(), "http://x.test/", "secret", () => now);
    const key = `${ws}/f_${"c".repeat(24)}`;
    const url = new URL(s.signedUrl(key, { ttlSeconds: 60 }));
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig")!;
    expect(url.pathname).toBe(`/files/${key}`);
    expect(s.verify(key, exp, sig)).toBe(true);
    expect(s.verify(key, exp + 1, sig)).toBe(false);
    expect(s.verify(`${ws}/f_${"d".repeat(24)}`, exp, sig)).toBe(false);
    expect(s.verify(key, exp, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"))).toBe(false);
    expect(new LocalDiskStorage(dir(), "http://x.test", "other-secret", () => now).verify(key, exp, sig)).toBe(false);
    now += 59_000;
    expect(s.verify(key, exp, sig)).toBe(true);
    now += 2_000;
    expect(s.verify(key, exp, sig)).toBe(false);
  });
});

describe("ai provider factory", () => {
  it("uses the offline heuristic provider without a key and Anthropic with one", () => {
    expect(createAiProvider({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: "m", AI_TIMEOUT_MS: 1000 })).toBeInstanceOf(HeuristicProvider);
    const p = createAiProvider({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "claude-sonnet-5-5", AI_TIMEOUT_MS: 1000 });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.name).toBe("anthropic");
  });
  it("silent logger swallows everything", () => {
    silentLogger.info("x");
    expect(true).toBe(true);
  });
});
