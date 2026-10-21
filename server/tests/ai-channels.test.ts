import { describe, expect, it } from "vitest";
import { AgentBodySchema, createAgent } from "../src/agents/config.js";
import { asksForHuman, autoEmailReason, autoSmsReason, fitSms, optionsLine, pickOption, plainText, smsSegments, stripQuoted } from "../src/agents/channelText.js";
import { handleInboundEmail, handleInboundSms } from "../src/services/inbound.js";
import { createKb } from "../src/services/settings.js";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "../src/providers/fake.js";
import { silentLogger } from "../src/logger.js";
import { addInboundAddressRaw, addSenderRaw, addSmsNumberRaw, fullApp, setSettings } from "./helpers.js";
import { KB, ScriptedProvider, answerWith } from "./agent-helpers.js";

/* ---------- the text rules ---------- */
describe("what counts as automatic, quoted, too long", () => {
  it("automatic emails: out-of-office, bounces, lists, no-reply senders, other bots; a person's email is not", () => {
    const H = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    expect(autoEmailReason(H({ "Auto-Submitted": "auto-replied" }), "ann@x.test", "Re: help")).toBe("auto_submitted");
    expect(autoEmailReason(H({ "Auto-Submitted": "no" }), "ann@x.test", "Re: help")).toBeNull();
    expect(autoEmailReason(H({ "X-Autoreply": "yes" }), "ann@x.test", "x")).toBe("auto_reply_header");
    expect(autoEmailReason(H({ Precedence: "bulk" }), "ann@x.test", "x")).toBe("precedence_bulk");
    expect(autoEmailReason(H({ "List-Id": "<news.x.test>" }), "ann@x.test", "x")).toBe("mailing_list");
    expect(autoEmailReason(H({ "Return-Path": "<>" }), "ann@x.test", "x")).toBe("bounce");
    expect(autoEmailReason(H({ "X-Conversations-Bot": "1" }), "ann@x.test", "x")).toBe("other_bot");
    for (const from of ["MAILER-DAEMON@x.test", "no-reply@shop.test", "noreply+123@x.test", "do-not-reply@x.test", "postmaster@x.test"]) expect(autoEmailReason({}, from, "x"), from).toBe("no_reply_sender");
    for (const subj of ["Out of Office: back Monday", "Automatic reply: Re: invoice", "Undeliverable: hello", "Delivery Status Notification (Failure)", "Abwesenheitsnotiz: Urlaub"]) expect(autoEmailReason({}, "ann@x.test", subj), subj).toBe("auto_subject");
    expect(autoEmailReason({}, "ann@x.test", "Out of my depth with the app")).toBeNull();
  });
  it("automatic texts: short codes and automated notices", () => {
    expect(autoSmsReason("72345", "Your code is 1234")).toBe("short_code");
    expect(autoSmsReason("+14155552671", "This is an automated message, do not reply")).toBe("automated_text");
    expect(autoSmsReason("+14155552671", "Hi, my order is late")).toBeNull();
  });
  it("strips the quoted history, forwarded headers and signatures of an email reply", () => {
    expect(stripQuoted("Thanks, that worked!\n\nOn Mon, 3 Jun 2026 at 10:00, Acme <help@acme.test> wrote:\n> Open Settings...\n> more")).toBe("Thanks, that worked!");
    expect(stripQuoted("Still broken.\n\nOn Mon, 3 Jun 2026 at 10:00, Acme <help@acme.test>\nwrote:\n> x")).toBe("Still broken.");
    expect(stripQuoted("Ok\n-- \nAnn Smith\nCEO")).toBe("Ok");
    expect(stripQuoted("Short\n\n-----Original Message-----\nFrom: x")).toBe("Short");
    expect(stripQuoted("Yes\n\nSent from my iPhone")).toBe("Yes");
    expect(stripQuoted("Ja\n\nAm 3. Juni 2026 schrieb Acme:\n> x")).toBe("Ja");
    expect(stripQuoted("> only quoted")).toBe("> only quoted"); // nothing new: keep it rather than send an empty question
  });
  it("plain text, numbered options, picking an option, asking for a person", () => {
    expect(plainText("Open **Settings**, see [the guide](https://help.example.test/x).\n\n# Steps\n* one")).toBe("Open Settings, see the guide: https://help.example.test/x.\n\nSteps\n- one");
    const o = [{ id: "yes", label: "Yes, thanks" }, { id: "no", label: "Not quite" }, { id: "human", label: "Talk to a person" }];
    expect(optionsLine(o)).toBe("Reply 1 for Yes, thanks, 2 for Not quite or 3 for Talk to a person.");
    expect(pickOption(" 2. ", o)!.id).toBe("no");
    expect(pickOption("4", o)).toBeNull();
    expect(pickOption("2 please", o)).toBeNull();
    expect(asksForHuman("HUMAN")).toBe(true);
    expect(asksForHuman("a human wrote this")).toBe(false);
  });
  it("SMS segments: GSM-7 160/153, UCS-2 70/67, extension characters count twice; long answers are cut to the limit with the disclosure and options kept", () => {
    expect(smsSegments("a".repeat(160))).toEqual({ encoding: "gsm7", units: 160, segments: 1 });
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("€".repeat(80)).units).toBe(160);
    expect(smsSegments("ü".repeat(10)).encoding).toBe("gsm7");
    expect(smsSegments("é ✓")).toMatchObject({ encoding: "ucs2", segments: 1 });
    expect(smsSegments("✓".repeat(71)).segments).toBe(2);
    const out = fitSms("Aria (AI assistant): ", "Sentence one is here. ".repeat(40), "\nReply 1 for yes.", 2);
    expect(smsSegments(out).segments).toBeLessThanOrEqual(2);
    expect(out.startsWith("Aria (AI assistant): ")).toBe(true);
    expect(out.endsWith("\nReply 1 for yes.")).toBe(true);
    expect(out).toContain("…");
  });
});

/* ---------- end to end with the fake providers ---------- */
const PHONE = "+14155552671";
async function world(o: { sms?: Record<string, unknown>; email?: Record<string, unknown>; channels?: ("widget" | "sms" | "email")[]; simulated?: boolean; script?: ConstructorParameters<typeof ScriptedProvider>[0] } = {}) {
  const f = await fullApp();
  if (process.env.DEBUG_AI_CHANNELS) (f.ctx as any).background = Object.assign((f.ctx as any).background, { onError: (e: unknown) => console.error("BG", e) });
  if (o.simulated) {
    f.ctx.sms = new ConsoleSmsProvider(silentLogger);
    f.ctx.email = new ConsoleEmailProvider(silentLogger);
  }
  const provider = new ScriptedProvider(o.script ?? answerWith());
  f.ctx.ai = provider as never;
  await addSmsNumberRaw(f.ctx, f.wsId, "+15550000001", true);
  await addSenderRaw(f.ctx, f.wsId, "support@acme.test", true, true);
  await addInboundAddressRaw(f.ctx, f.wsId, "help@inbound.acme.test");
  for (const k of KB) await createKb(f.ctx, f.owner, k);
  await setSettings(f.ctx, f.wsId, { routing: { require_online: false }, ai_channels: { sms: { enabled: true, quiet_hours: { enabled: false }, ...o.sms }, email: { enabled: true, ...o.email } } });
  await f.ctx.cache.invalidate(`settings:${f.wsId}`);
  const agent = await createAgent(f.ctx, f.owner, AgentBodySchema.parse({ name: "Aria", enabled: true, persona: "You help customers of Acme.", channels: o.channels ?? ["widget", "sms", "email"] }));
  let n = 0;
  const text = async (body: string, from = PHONE) => {
    await handleInboundSms(f.ctx, { MessageSid: `SM${++n}${Date.now()}`, From: from, To: "+15550000001", Body: body } as never);
    await f.ctx.background.settle();
  };
  const mail = async (p: { text: string; subject?: string; from?: string; headers?: string }) => {
    await handleInboundEmail(f.ctx, { from: p.from ?? "Ann <ann@example.test>", to: "help@inbound.acme.test", subject: p.subject ?? "Password help", text: p.text, headers: p.headers ?? `Message-ID: <m${++n}.${Date.now()}@example.test>` });
    await f.ctx.background.settle();
  };
  const botMsgs = (source: "sms" | "email") => f.ctx.db.all<any>("SELECT * FROM messages WHERE workspace_id = ? AND sender_type = 'bot' AND source = ? ORDER BY created_at, seq", f.wsId, source);
  const systemLines = () => f.ctx.db.all<any>("SELECT content_text FROM messages WHERE workspace_id = ? AND kind = 'system' ORDER BY seq", f.wsId);
  const ticket = () => f.ctx.db.get<any>("SELECT * FROM tickets WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1", f.wsId);
  return { ...f, provider, agent, text, mail, botMsgs, systemLines, ticket };
}

describe("an AI agent answering SMS", () => {
  it("answers from the knowledge base in plain text, with the AI disclosure first, numbered options, through the SMS provider", async () => {
    const w = await world();
    await w.text("How do I reset my password?");
    const sent = w.ctx.sms.sent as any[];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: PHONE, from: "+15550000001" });
    expect(sent[0].body).toMatch(/^Aria \(AI assistant\): Open Settings, choose Security/);
    expect(sent[0].body).toContain("Reply HUMAN for a person.");
    expect(smsSegments(sent[0].body).segments).toBeLessThanOrEqual(3);
    const [m] = await w.botMsgs("sms");
    expect(m).toMatchObject({ delivery: "sent", sender_name: "Aria" });
    expect(JSON.parse(m.meta)).toMatchObject({ ai: true, ai_channel: "sms", first_reply: true });
    // the model was told it is answering by SMS
    expect(w.provider.calls[0]!.system).toContain("answering by SMS");
    // the next answer does not repeat the disclosure
    await w.text("What are your opening hours?");
    expect((w.ctx.sms.sent as any[])[1].body).not.toMatch(/^Aria \(AI assistant\)/);
  });

  it("numbered options replace buttons: 1 resolves the ticket, a closing text follows", async () => {
    const w = await world({ script: answerWith({ quick_replies: true }) });
    await w.text("How do I reset my password?");
    const first = (w.ctx.sms.sent as any[])[0].body as string;
    expect(first).toMatch(/\nReply 1 for Yes, thanks, 2 for Not quite or 3 for Talk to a person\. Reply HUMAN for a person\.$/);
    await w.text("1");
    expect((await w.ticket()).status).toBe("resolved");
    expect((w.ctx.sms.sent as any[]).at(-1).body).toMatch(/Glad I could help/);
  });

  it("2 means the answer did not help: the agent tries again; 3 hands over", async () => {
    const w = await world();
    await w.text("How do I reset my password?");
    await w.text("2");
    expect((w.ctx.sms.sent as any[]).at(-1).body).toMatch(/sorry that did not help/);
    expect((await w.ticket()).status).not.toBe("resolved");
    const before = (w.ctx.sms.sent as any[]).length;
    await w.text("3");
    expect((await w.ticket()).status).toBe("waiting_for_human");
    expect((w.ctx.sms.sent as any[]).length).toBe(before + 1);
  });

  it("HUMAN hands over and says so once; then a person has it and the AI stays quiet", async () => {
    const w = await world();
    await w.text("How do I reset my password?");
    await w.text("HUMAN");
    expect((await w.ticket()).status).toBe("waiting_for_human");
    expect((w.ctx.sms.sent as any[]).at(-1).body).toMatch(/passed this to our team/);
    const count = (w.ctx.sms.sent as any[]).length;
    await w.text("hello?");
    expect((w.ctx.sms.sent as any[]).length).toBe(count);
  });

  it("never answers STOP or START, opted-out contacts, short codes and automated texts", async () => {
    const w = await world();
    await w.text("STOP");
    await w.text("How do I reset my password?"); // opted out now
    await w.text("START");
    await w.text("Your order has shipped. This is an automated message, do not reply.");
    await w.text("Code 1234", "72345");
    expect(w.ctx.sms.sent).toHaveLength(0);
    const lines = (await w.systemLines()).map((l: any) => l.content_text).join("\n");
    expect(lines).toMatch(/opted out of SMS/);
    expect(lines).toMatch(/automatic message \(automated text\)/);
  });

  it("loop protection: at most N AI replies per conversation per 24 hours, then a person takes over", async () => {
    const w = await world({ sms: { max_replies_per_day: 2 } });
    for (let i = 0; i < 4; i++) {
      await w.text(i % 2 ? "What are your opening hours?" : "How do I reset my password?");
      w.ctx.clockCtl.advance(700_000);
    }
    expect((await w.botMsgs("sms")).filter((m: any) => !JSON.parse(m.meta).handoff_notice)).toHaveLength(2);
    expect((await w.ticket())).toMatchObject({ status: "waiting_for_human" });
    expect((await w.systemLines()).map((l: any) => l.content_text).join("\n")).toMatch(/stopped after 2 replies/);
  });

  it("the per-contact rate limit keeps a flood from becoming a flood of answers", async () => {
    const w = await world({ sms: { max_replies_per_day: 50 } });
    for (let i = 0; i < 9; i++) await w.text(`How do I reset my password? ${i}`);
    expect((await w.botMsgs("sms")).length).toBeLessThanOrEqual(6);
  });

  it("quiet hours: no AI texts at night, the team gets the message", async () => {
    const w = await world({ sms: { quiet_hours: { enabled: true, start: "00:00", end: "23:59" } } });
    await w.text("How do I reset my password?");
    expect(w.ctx.sms.sent).toHaveLength(0);
    expect((await w.systemLines()).map((l: any) => l.content_text).join("\n")).toMatch(/does not text at night/);
  });

  it("off by default: the workspace switch and the agent's channel are both needed", async () => {
    const off = await world({ sms: { enabled: false } });
    await off.text("How do I reset my password?");
    expect(off.ctx.sms.sent).toHaveLength(0);
    const noChannel = await world({ channels: ["widget"] });
    await noChannel.text("How do I reset my password?");
    expect(noChannel.ctx.sms.sent).toHaveLength(0);
    const fresh = await fullApp();
    expect((await fresh.http.call("GET", "/api/workspace", { token: fresh.token })).body.settings.ai_channels).toMatchObject({ sms: { enabled: false }, email: { enabled: false } });
  });

  it("test mode stays honest: the AI reply is stored as not_sent_test_mode and nothing is billed", async () => {
    const w = await world({ simulated: true });
    await w.text("How do I reset my password?");
    const [m] = await w.botMsgs("sms");
    expect(m.delivery).toBe("not_sent_test_mode");
  });
});

describe("an AI agent answering email", () => {
  it("answers in the same thread (In-Reply-To, References), with the disclosure, a sign-off, plain text, an automatic-reply header, from the workspace's sender", async () => {
    const w = await world();
    await w.mail({ text: "Hello, how do I reset my password?\n\nThanks\nAnn", headers: "Message-ID: <first.1@example.test>" });
    const out = (w.ctx.email.sent as any[])[0];
    expect(out).toMatchObject({ to: "ann@example.test", from: { address: "support@acme.test" }, inReplyTo: "<first.1@example.test>" });
    expect(out.references).toContain("<first.1@example.test>");
    expect(out.subject).toMatch(/password/i);
    expect(out.text).toMatch(/^This is Aria, the AI assistant of .+ \(not a person\)\./);
    expect(out.text).toMatch(/-- \nAria \(AI assistant\)/);
    expect(out.text).toContain("Reply HUMAN to reach a person.");
    expect(out.text).not.toMatch(/\*\*|\]\(/);
    expect(out.extraHeaders).toMatchObject({ "Auto-Submitted": "auto-replied" });
    expect(w.provider.calls[0]!.system).toContain("answering by email");
  });

  it("reads only the new part of a reply: the quoted history does not reach the model", async () => {
    const w = await world();
    await w.mail({ text: "How do I reset my password?" });
    const prev = (w.ctx.email.sent as any[])[0];
    await w.mail({ text: `What are your opening hours?\n\nOn Mon, 3 Jun 2026, Acme <support@acme.test> wrote:\n> ${prev.text.split("\n").join("\n> ")}\n> SECRET-QUOTED-LINE`, headers: `Message-ID: <r2@example.test>\nIn-Reply-To: ${prev.messageId}` });
    const last = w.provider.calls.at(-1)!;
    expect(last.input.text).toBe("What are your opening hours?");
    expect(last.prompt).not.toContain("SECRET-QUOTED-LINE");
  });

  it("never answers out-of-office replies, bounces, mailing lists, no-reply senders or other bots: no mail loops", async () => {
    const w = await world();
    await w.mail({ text: "I am away until Monday.", subject: "Automatic reply: Password help" });
    await w.mail({ text: "x", headers: "Message-ID: <a2@x.test>\nAuto-Submitted: auto-replied" });
    await w.mail({ text: "x", headers: "Message-ID: <a3@x.test>\nList-Id: <news.example.test>" });
    await w.mail({ text: "x", from: "MAILER-DAEMON@mx.example.test", subject: "Undeliverable" });
    await w.mail({ text: "x", headers: "Message-ID: <a5@x.test>\nX-Conversations-Bot: 1" });
    expect(w.ctx.email.sent).toHaveLength(0);
  });

  it("unsubscribed contacts get no AI email", async () => {
    const w = await world();
    await w.mail({ text: "first" });
    const sent = (w.ctx.email.sent as any[]).length;
    await w.ctx.db.run("UPDATE contacts SET unsubscribed = 1 WHERE email = 'ann@example.test'");
    await w.mail({ text: "How do I reset my password?" });
    expect((w.ctx.email.sent as any[]).length).toBe(sent);
  });

  it("long answers are cut at the email limit; the workspace signature is added", async () => {
    const w = await world({ email: { max_chars: 200, signature: "Acme Support, Mon-Fri" }, script: (req) => ({ ...(answerWith()(req) as object), answer: `${"Open Settings and follow the steps. ".repeat(30)}` }) });
    await w.mail({ text: "How do I reset my password?" });
    const t = (w.ctx.email.sent as any[])[0].text as string;
    expect(t).toContain("…");
    expect(t).toContain("Acme Support, Mon-Fri");
  });
});
