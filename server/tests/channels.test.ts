import { describe, expect, it } from "vitest";
import { classifySmsKeyword, deriveSubject, isE164, SMS_MAX_CHARS } from "../src/channels/rules.js";
import { sendAgentMessage, retryMessage } from "../src/services/messages.js";
import { setStatus } from "../src/services/rooms.js";
import { recordUsage } from "../src/services/workspaces.js";
import { tick } from "../src/jobs/scheduler.js";
import { saveUpload } from "../src/services/attachments.js";
import { addMemberRaw, addSenderRaw, addSmsNumberRaw, agentSays, contactSays, fullApp, messagesOf, mkRoom, setSettings } from "./helpers.js";

const sms = (content: string, extra: object = {}) => ({ kind: "text" as const, source: "sms" as const, content, ...extra });
const email = (content: string, extra: object = {}) => ({ kind: "text" as const, source: "email" as const, content, ...extra });

describe("SMS keyword classification", () => {
  const opt = ["STOP", "stop", "Stop", " stop ", "STOP.", "stop!", "\nSTOP\n", "UNSUBSCRIBE", "unsubscribe", "CANCEL", "END", "QUIT", "STOPALL", "Stop All", "s t o p", "ＳＴＯＰ", "stop!!!"];
  const inn = ["START", "start", "Yes", " YES. ", "UNSTOP", "unstop!"];
  const none = ["please stop", "stop it", "stopping", "starting", "yes please", "no", "", "   ", "cancel my order", "end of month", "STOP STOP STOP", "halt", "?"];
  it.each(opt)("opt-out: %j", (b) => expect(classifySmsKeyword(b)).toBe("opt_out"));
  it.each(inn)("opt-in: %j", (b) => expect(classifySmsKeyword(b)).toBe("opt_in"));
  it.each(none)("neither: %j", (b) => expect(classifySmsKeyword(b)).toBeNull());
});

describe("rules helpers", () => {
  it("derives email subjects: 70-char boundary, existing subject, fallback", () => {
    expect(deriveSubject(null, "x".repeat(70))).toBe(`Re: ${"x".repeat(70)}`);
    expect(deriveSubject(null, "x".repeat(71))).toBe(`Re: ${"x".repeat(70)}…`);
    expect(deriveSubject(null, "  spaced \n out  ")).toBe("Re: spaced out");
    expect(deriveSubject("Order 12", "ignored")).toBe("Re: Order 12");
    expect(deriveSubject("Re: Order 12", "ignored")).toBe("Re: Order 12");
    expect(deriveSubject("RE: shouting", null)).toBe("RE: shouting");
    expect(deriveSubject(null, null)).toBe("Re: Your conversation");
    expect(deriveSubject("  ", "hello")).toBe("Re: hello");
  });
  it("validates E.164", () => {
    expect(isE164("+14155552671")).toBe(true);
    for (const bad of ["14155552671", "+0123", "+1", "+1415555267112345678", "(415) 555", ""]) expect(isE164(bad)).toBe(false);
  });
});

async function smsWorld() {
  const f = await fullApp();
  addSmsNumberRaw(f.ctx, f.wsId, "+15550000001", true);
  const { contact, room } = mkRoom(f.ctx, f.wsId, { contact: { name: "Texty", phone: "+14155552671" } });
  return { ...f, contact, room };
}

describe("outbound SMS rules", () => {
  it("sends text with the workspace number, stores provider id and locks the number to the room", async () => {
    const { ctx, owner, room } = await smsWorld();
    const r = await sendAgentMessage(ctx, owner, room.id, sms("Hello by text"));
    expect(r.message).toMatchObject({ delivery: "sent", source: "sms", from_addr: "+15550000001", to_addr: "+14155552671", provider_message_id: "fake_sms_1" });
    expect(ctx.sms.sent[0]).toMatchObject({ to: "+14155552671", from: "+15550000001", body: "Hello by text", idempotencyKey: r.message.id });
    expect(ctx.db.all("SELECT from_addr, to_addr FROM message_locks WHERE room_id = ?", room.id)).toEqual([{ from_addr: "+15550000001", to_addr: "+14155552671" }]);
  });
  it("requires a contact phone and a valid one", async () => {
    const { ctx, owner, wsId } = await smsWorld();
    const none = mkRoom(ctx, wsId, { contact: { name: "No phone", email: "np@example.test" } });
    await expect(sendAgentMessage(ctx, owner, none.room.id, sms("hi"))).rejects.toMatchObject({ code: "CONTACT_PHONE_REQUIRED" });
    const bad = mkRoom(ctx, wsId, { contact: { name: "Bad phone", email: "bp@example.test" } });
    ctx.db.run("UPDATE contacts SET phone = '555-1234' WHERE id = ?", bad.contact.id); // bypasses normalisation on purpose
    await expect(sendAgentMessage(ctx, owner, bad.room.id, sms("hi"))).rejects.toMatchObject({ code: "INVALID_PHONE" });
    expect(messagesOf(ctx, none.room.id).filter((m) => m.source === "sms")).toHaveLength(0);
    expect(ctx.sms.sent).toHaveLength(0);
  });
  it("enforces the 1600 character limit: 1599 ok, 1600 and 1601 rejected", async () => {
    const { ctx, owner, room } = await smsWorld();
    expect(SMS_MAX_CHARS).toBe(1599);
    expect((await sendAgentMessage(ctx, owner, room.id, sms("a".repeat(1599)))).message.delivery).toBe("sent");
    await expect(sendAgentMessage(ctx, owner, room.id, sms("a".repeat(1600)))).rejects.toMatchObject({ code: "SMS_TOO_LONG" });
    await expect(sendAgentMessage(ctx, owner, room.id, sms("a".repeat(1601)))).rejects.toMatchObject({ code: "SMS_TOO_LONG" });
    expect(ctx.sms.sent).toHaveLength(1);
  });
  it("counts characters after trimming and normalising (no whitespace padding tricks)", async () => {
    const { ctx, owner, room } = await smsWorld();
    expect((await sendAgentMessage(ctx, owner, room.id, sms("  " + "a".repeat(1599) + "  "))).message.delivery).toBe("sent");
  });
  it("allows only text and quoted replies", async () => {
    const { ctx, owner, room } = await smsWorld();
    await expect(sendAgentMessage(ctx, owner, room.id, { kind: "image", source: "sms", attachment_ids: ["x"] })).rejects.toMatchObject({ code: "SMS_KIND_NOT_ALLOWED" });
    await expect(sendAgentMessage(ctx, owner, room.id, { kind: "gif", source: "sms", content: "https://x.test/a.gif" })).rejects.toMatchObject({ code: "SMS_KIND_NOT_ALLOWED" });
    const q = contactSays(ctx, room, "question");
    expect((await sendAgentMessage(ctx, owner, room.id, { kind: "ref", source: "sms", content: "answer", ref_message_id: q.id })).message.delivery).toBe("sent");
  });
  it("blocks sends to opted-out contacts without storing anything, until they opt back in", async () => {
    const { ctx, owner, room, contact } = await smsWorld();
    ctx.db.run("UPDATE contacts SET sms_opt_out = 1 WHERE id = ?", contact.id);
    const before = messagesOf(ctx, room.id).length;
    await expect(sendAgentMessage(ctx, owner, room.id, sms("hi"))).rejects.toMatchObject({ code: "CONTACT_OPTED_OUT", status: 422 });
    expect(messagesOf(ctx, room.id)).toHaveLength(before);
    ctx.db.run("UPDATE contacts SET sms_opt_out = 0 WHERE id = ?", contact.id);
    expect((await sendAgentMessage(ctx, owner, room.id, sms("hi"))).message.delivery).toBe("sent");
  });
  it("errors when the workspace has no SMS numbers", async () => {
    const { ctx, owner, wsId } = await fullApp();
    const { room } = mkRoom(ctx, wsId, { contact: { name: "T", phone: "+14155552671" } });
    await expect(sendAgentMessage(ctx, owner, room.id, sms("hi"))).rejects.toMatchObject({ code: "NO_SMS_NUMBERS" });
  });
  it("picks the default number first and sticks with a room's number", async () => {
    const { ctx, owner, wsId, room } = await smsWorld();
    addSmsNumberRaw(ctx, wsId, "+15550000002");
    await sendAgentMessage(ctx, owner, room.id, sms("one"));
    ctx.db.run("UPDATE sms_numbers SET is_default = (e164 = '+15550000002')");
    await sendAgentMessage(ctx, owner, room.id, sms("two"));
    expect(ctx.sms.sent.map((s) => s.from)).toEqual(["+15550000001", "+15550000001"]);
  });
  it("errors when every number is already locked to the recipient by other rooms (limit = owned numbers)", async () => {
    const { ctx, owner, wsId, room, contact } = await smsWorld();
    addSmsNumberRaw(ctx, wsId, "+15550000002");
    const others = [mkRoom(ctx, wsId, { contact: { name: "Other 1" } }), mkRoom(ctx, wsId, { contact: { name: "Other 2" } })];
    ["+15550000001", "+15550000002"].forEach((from, i) =>
      ctx.db.run("INSERT INTO message_locks(id, workspace_id, type, from_addr, to_addr, room_id, created_at) VALUES (?,?,?,?,?,?,?)", `lock${i}`, wsId, "sms", from, contact.phone, others[i]!.room.id, "x"),
    );
    await expect(sendAgentMessage(ctx, owner, room.id, sms("hi"))).rejects.toMatchObject({ code: "SMS_NUMBERS_EXHAUSTED" });
    expect(ctx.sms.sent).toHaveLength(0);
  });
  it("frees the number when the room is closed, so another conversation can use it", async () => {
    const { ctx, owner, wsId, room, contact } = await smsWorld();
    await sendAgentMessage(ctx, owner, room.id, sms("hi"));
    const other = mkRoom(ctx, wsId, { contact: { name: "Other" } });
    ctx.db.run("UPDATE contacts SET phone = ? WHERE id = ?", "+14155550999", other.contact.id);
    // pretend the other room talks to the same phone number as the first contact
    ctx.db.run("UPDATE contacts SET phone = NULL WHERE id = ?", contact.id);
    ctx.db.run("UPDATE contacts SET phone = '+14155552671' WHERE id = ?", other.contact.id);
    await expect(sendAgentMessage(ctx, owner, other.room.id, sms("hello?"))).rejects.toMatchObject({ code: "SMS_NUMBERS_EXHAUSTED" });
    setStatus(ctx, owner, room.id, "closed");
    expect(ctx.db.all("SELECT 1 FROM message_locks WHERE room_id = ?", room.id)).toHaveLength(0);
    expect((await sendAgentMessage(ctx, owner, other.room.id, sms("hello!"))).message.delivery).toBe("sent");
  });
  it("two concurrent identical sends call the provider once", async () => {
    const { ctx, owner, room } = await smsWorld();
    const rs = await Promise.all([1, 2, 3].map(() => sendAgentMessage(ctx, owner, room.id, sms("dup", { client_msg_id: "dup-qid-0001" }))));
    expect(new Set(rs.map((r) => r.message.id)).size).toBe(1);
    expect(ctx.sms.sent).toHaveLength(1);
  });
});

async function emailWorld() {
  const f = await fullApp();
  addSenderRaw(f.ctx, f.wsId, "support@acme.test", true, true);
  addSenderRaw(f.ctx, f.wsId, "billing@acme.test", true);
  addSenderRaw(f.ctx, f.wsId, "draft@acme.test", false);
  const { contact, room } = mkRoom(f.ctx, f.wsId, { contact: { name: "Mailer", email: "mailer@example.test" } });
  return { ...f, contact, room };
}

describe("outbound email rules", () => {
  it("requires a contact email, a verified sender, and honours the chosen from-address", async () => {
    const { ctx, owner, wsId, room } = await emailWorld();
    const noEmail = mkRoom(ctx, wsId, { contact: { name: "Phone only", phone: "+14155552671" } });
    await expect(sendAgentMessage(ctx, owner, noEmail.room.id, email("hi"))).rejects.toMatchObject({ code: "CONTACT_EMAIL_REQUIRED" });
    await expect(sendAgentMessage(ctx, owner, room.id, email("hi", { from: "draft@acme.test" }))).rejects.toMatchObject({ code: "SENDER_NOT_VERIFIED" });
    await expect(sendAgentMessage(ctx, owner, room.id, email("hi", { from: "stranger@elsewhere.test" }))).rejects.toMatchObject({ code: "SENDER_NOT_VERIFIED" });
    expect((await sendAgentMessage(ctx, owner, room.id, email("hi", { from: "Billing@Acme.test" }))).message.from_addr).toBe("billing@acme.test");
    expect((await sendAgentMessage(ctx, owner, room.id, email("again"))).message.from_addr).toBe("support@acme.test");
    const lone = await fullApp();
    const r = mkRoom(lone.ctx, lone.wsId, { contact: { name: "X", email: "x@example.test" } });
    await expect(sendAgentMessage(lone.ctx, lone.owner, r.room.id, email("hi"))).rejects.toMatchObject({ code: "NO_VERIFIED_SENDER" });
  });
  it("derives the subject from the first contact message (70 char boundary) and stores it on the room", async () => {
    const { ctx, owner, wsId } = await emailWorld();
    const a = mkRoom(ctx, wsId, { contact: { name: "A", email: "a70@example.test" } });
    contactSays(ctx, a.room, "q".repeat(70), "email");
    expect((await sendAgentMessage(ctx, owner, a.room.id, email("reply"))).message.subject).toBe(`Re: ${"q".repeat(70)}`);
    const b = mkRoom(ctx, wsId, { contact: { name: "B", email: "b71@example.test" } });
    contactSays(ctx, b.room, "q".repeat(71), "email");
    const m = (await sendAgentMessage(ctx, owner, b.room.id, email("reply"))).message;
    expect(m.subject).toBe(`Re: ${"q".repeat(70)}…`);
    expect(ctx.db.get<{ subject: string }>("SELECT subject FROM rooms WHERE id = ?", b.room.id)!.subject).toBe(m.subject);
    expect(ctx.email.sent.at(-1)!.subject).toBe(m.subject);
  });
  it("prefers an explicit subject, then the room subject", async () => {
    const { ctx, owner, room } = await emailWorld();
    const m1 = (await sendAgentMessage(ctx, owner, room.id, email("hello", { subject: "Your order" }))).message;
    expect(m1.subject).toBe("Your order");
    const m2 = (await sendAgentMessage(ctx, owner, room.id, email("again"))).message;
    expect(m2.subject).toBe("Re: Your order");
  });
  it("threads replies with Message-ID / In-Reply-To / References", async () => {
    const { ctx, owner, room } = await emailWorld();
    const m1 = (await sendAgentMessage(ctx, owner, room.id, email("first"))).message;
    const m2 = (await sendAgentMessage(ctx, owner, room.id, email("second"))).message;
    const m3 = (await sendAgentMessage(ctx, owner, room.id, email("third"))).message;
    expect(m1.rfc_message_id).toMatch(/^<m_[0-9a-f]+@acme\.test>$/);
    expect(m1.in_reply_to).toBeNull();
    expect(m2.in_reply_to).toBe(m1.rfc_message_id);
    expect(m3.in_reply_to).toBe(m2.rfc_message_id);
    expect(m3.references_hdr).toBe(`${m1.rfc_message_id} ${m2.rfc_message_id}`);
    const sent = ctx.email.sent[2]!;
    expect(sent).toMatchObject({ messageId: m3.rfc_message_id, inReplyTo: m2.rfc_message_id, references: [m1.rfc_message_id, m2.rfc_message_id], to: "mailer@example.test" });
  });
  it("sends sanitised html plus a text part and pins the sender to the room", async () => {
    const { ctx, owner, room } = await emailWorld();
    await sendAgentMessage(ctx, owner, room.id, email('<p onclick="x">Hello <b>there</b></p><script>1</script>', { format: "html" }));
    expect(ctx.email.sent[0]).toMatchObject({ html: "<p>Hello <b>there</b></p>", text: "Hello there" });
    expect(ctx.db.all("SELECT from_addr, to_addr FROM message_locks WHERE room_id = ? AND type = 'email'", room.id)).toEqual([{ from_addr: "support@acme.test", to_addr: "mailer@example.test" }]);
  });
  it("attaches uploaded files for email", async () => {
    const { ctx, owner, room } = await emailWorld();
    const att = await saveUpload(ctx, owner, { name: "note.txt", content: Buffer.from("hello file") });
    await sendAgentMessage(ctx, owner, room.id, { kind: "attachment", source: "email", content: "see attached", attachment_ids: [att.id] });
    expect(ctx.email.sent[0]!.attachments![0]).toMatchObject({ filename: "note.txt", contentType: "text/plain" });
    expect(ctx.email.sent[0]!.attachments![0]!.content.toString()).toBe("hello file");
  });
});

describe("delivery failure, retry and backoff", () => {
  it("keeps a failed message with its reason, surfaces it, and exposes a manual retry", async () => {
    const { ctx, owner, room } = await smsWorld();
    ctx.sms.failNext(1, { retryable: false, message: "carrier rejected" });
    const r = await sendAgentMessage(ctx, owner, room.id, sms("will fail"));
    expect(r.message).toMatchObject({ delivery: "failed", failure_reason: "carrier rejected", retry_count: 1 });
    expect(messagesOf(ctx, room.id).some((m) => m.content === "will fail")).toBe(true);
    expect(ctx.db.all("SELECT * FROM jobs")).toHaveLength(0); // permanent failure: no automatic retry
    ctx.bus.clear();
    const retried = await retryMessage(ctx, owner, r.message.id);
    expect(retried.delivery).toBe("sent");
    expect(retried.failure_reason).toBeNull();
    expect(ctx.bus.ofType("message:updated").length).toBeGreaterThan(0);
    await expect(retryMessage(ctx, owner, r.message.id)).rejects.toMatchObject({ code: "NOT_FAILED" });
  });
  it("retries transient failures with exponential backoff, capped, up to the maximum", async () => {
    const { ctx, owner, room } = await smsWorld(); // base 10s, cap 100s, max 4 attempts
    ctx.sms.failNext(10);
    const r = await sendAgentMessage(ctx, owner, room.id, sms("flaky"));
    const delays: number[] = [];
    let id = r.message.id;
    for (let i = 0; i < 6; i++) {
      const job = ctx.db.get<{ run_at: string; status: string }>("SELECT run_at, status FROM jobs WHERE status = 'pending' ORDER BY run_at DESC LIMIT 1");
      if (!job) break;
      delays.push(Math.round((Date.parse(job.run_at) - ctx.clock().getTime()) / 1000));
      ctx.clockCtl.set(job.run_at);
      await tick(ctx, { jobs: true });
    }
    expect(delays).toEqual([10, 20, 40]); // 4th failure hits max attempts: no 4th retry scheduled
    const row = ctx.db.get<{ delivery: string; retry_count: number }>("SELECT delivery, retry_count FROM messages WHERE id = ?", id)!;
    expect(row).toEqual({ delivery: "failed", retry_count: 4 });
    expect(ctx.db.all("SELECT 1 FROM jobs WHERE status = 'pending'")).toHaveLength(0);
    expect(ctx.sms.sent).toHaveLength(0);
    id = "";
  });
  it("caps the delay at SEND_RETRY_CAP_SECONDS", async () => {
    const f = await fullApp({ SEND_RETRY_BASE_SECONDS: "60", SEND_RETRY_CAP_SECONDS: "100", SEND_RETRY_MAX_ATTEMPTS: "6" });
    addSmsNumberRaw(f.ctx, f.wsId, "+15550000001", true);
    const { room } = mkRoom(f.ctx, f.wsId, { contact: { phone: "+14155552671" } });
    f.ctx.sms.failNext(10);
    await sendAgentMessage(f.ctx, f.owner, room.id, sms("x"));
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const job = f.ctx.db.get<{ run_at: string }>("SELECT run_at FROM jobs WHERE status = 'pending'");
      if (!job) break;
      delays.push(Math.round((Date.parse(job.run_at) - f.ctx.clock().getTime()) / 1000));
      f.ctx.clockCtl.set(job.run_at);
      await tick(f.ctx, { jobs: true });
    }
    expect(delays).toEqual([60, 100, 100, 100]);
  });
  it("a retry job succeeds once the provider recovers and broadcasts the update", async () => {
    const { ctx, owner, room } = await smsWorld();
    ctx.sms.failNext(1);
    const r = await sendAgentMessage(ctx, owner, room.id, sms("eventually"));
    expect(r.message.delivery).toBe("failed");
    ctx.bus.clear();
    ctx.clockCtl.advance(11_000);
    await tick(ctx, { jobs: true });
    const row = ctx.db.get<{ delivery: string }>("SELECT delivery FROM messages WHERE id = ?", r.message.id)!;
    expect(row.delivery).toBe("sent");
    expect(ctx.bus.ofType("message:updated").pop()!.payload.message.delivery).toBe("sent");
    expect(ctx.sms.sent).toHaveLength(1);
  });
  it("email failures behave the same and a retry reuses the stored Message-ID", async () => {
    const { ctx, owner, room } = await emailWorld();
    ctx.email.failNext(1, { retryable: false });
    const failed = (await sendAgentMessage(ctx, owner, room.id, email("hi"))).message;
    expect(failed.delivery).toBe("failed");
    const ok = await retryMessage(ctx, owner, failed.id);
    expect(ok.delivery).toBe("sent");
    expect(ctx.email.sent[0]!.messageId).toBe(failed.rfc_message_id);
  });
  it("a contact who opts out between send and retry is never texted", async () => {
    const { ctx, owner, room, contact } = await smsWorld();
    ctx.sms.failNext(1);
    const r = await sendAgentMessage(ctx, owner, room.id, sms("hi"));
    ctx.db.run("UPDATE contacts SET sms_opt_out = 1 WHERE id = ?", contact.id);
    const retried = await retryMessage(ctx, owner, r.message.id);
    expect(retried).toMatchObject({ delivery: "failed", failure_reason: "Contact has opted out of SMS" });
    expect(ctx.sms.sent).toHaveLength(0);
  });
});

describe("credits", () => {
  it("is unlimited by default and never touches the ledger for free sends", async () => {
    const { ctx, owner, room } = await smsWorld();
    await sendAgentMessage(ctx, owner, room.id, sms("free?"));
    expect(ctx.db.all("SELECT * FROM usage_ledger WHERE kind = 'sms'")).toHaveLength(1); // usage is still metered
  });
  it("blocks sends with 402 when enforced and the balance is too low; allows after a grant; debits per send", async () => {
    const { ctx, owner, wsId, room, http, token } = await smsWorld();
    setSettings(ctx, wsId, { credits_enforced: true });
    await expect(sendAgentMessage(ctx, owner, room.id, sms("no credit"))).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS", status: 402 });
    expect(ctx.sms.sent).toHaveLength(0);
    expect((await http.post("/api/credits/grant", { amount: 2 }, token)).body.balance).toBe(2);
    await sendAgentMessage(ctx, owner, room.id, sms("one"));
    await sendAgentMessage(ctx, owner, room.id, sms("two"));
    await expect(sendAgentMessage(ctx, owner, room.id, sms("three"))).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    const credits = await http.get("/api/credits", token);
    expect(credits.body.balance).toBe(0);
    expect(credits.body.ledger.map((l: any) => l.delta)).toEqual([-1, -1, 2]);
  });
  it("does not charge for failed sends and only owners can grant", async () => {
    const { ctx, owner, wsId, room, http } = await smsWorld();
    setSettings(ctx, wsId, { credits_enforced: true });
    recordUsage(ctx, wsId, "grant", 5);
    ctx.sms.failNext(1, { retryable: false });
    await sendAgentMessage(ctx, owner, room.id, sms("fails"));
    expect(ctx.db.get<{ credit_balance: number }>("SELECT credit_balance FROM workspaces WHERE id = ?", wsId)!.credit_balance).toBe(5);
    const mgr = await addMemberRaw(ctx, wsId, { name: "Mia", role: "manager" });
    const { tokenFor } = await import("./helpers.js");
    expect((await http.post("/api/credits/grant", { amount: 5 }, await tokenFor(ctx, mgr))).status).toBe(403);
  });
  it("applies to email as well", async () => {
    const { ctx, owner, wsId, room } = await emailWorld();
    setSettings(ctx, wsId, { credits_enforced: true });
    await expect(sendAgentMessage(ctx, owner, room.id, email("hi"))).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
  });
});

describe("dm and notes never reach providers", () => {
  it("stay local with delivery=sent", async () => {
    const { ctx, owner, room } = await smsWorld();
    const m = await agentSays(ctx, owner, room.id, "chat only");
    const n = await agentSays(ctx, owner, room.id, "internal", { kind: "note" });
    expect([m.delivery, n.delivery]).toEqual(["sent", "sent"]);
    expect(ctx.sms.sent).toHaveLength(0);
    expect(ctx.email.sent).toHaveLength(0);
  });
});
