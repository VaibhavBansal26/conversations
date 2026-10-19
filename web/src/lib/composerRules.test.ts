import { checkComposer, defaultEmailSubject, effectiveChannel, messageKindFor, SMS_LIMIT, type ComposerState } from "./composerRules";

const base: ComposerState = {
  channel: "dm",
  isNote: false,
  text: "Hello",
  subject: "",
  from: "",
  attachmentCount: 0,
  contact: { email: "ada@example.test", phone: "+14155550123", sms_opt_out: false },
  senders: [{ address: "help@acme.test", verified: true }],
};

describe("composer channel rules", () => {
  it("allows a plain chat reply", () => {
    expect(checkComposer(base)).toMatchObject({ canSend: true, channel: "dm", problems: [] });
  });

  it("blocks empty messages but allows attachment-only", () => {
    expect(checkComposer({ ...base, text: "   " }).canSend).toBe(false);
    expect(checkComposer({ ...base, text: "", attachmentCount: 1 }).canSend).toBe(true);
  });

  it("enforces the SMS limit at exactly 1599 / 1600 characters", () => {
    const sms = { ...base, channel: "sms" as const };
    expect(SMS_LIMIT).toBe(1599);
    const ok = checkComposer({ ...sms, text: "x".repeat(1599) });
    expect(ok.canSend).toBe(true);
    expect(ok.smsRemaining).toBe(0);
    const over = checkComposer({ ...sms, text: "x".repeat(1600) });
    expect(over.canSend).toBe(false);
    expect(over.smsRemaining).toBe(-1);
    expect(over.problems[0]).toMatch(/1599/);
  });

  it("requires a phone number for SMS", () => {
    const r = checkComposer({ ...base, channel: "sms", contact: { ...base.contact!, phone: null } });
    expect(r.canSend).toBe(false);
    expect(r.problems.join(" ")).toMatch(/no phone number/i);
  });

  it("blocks SMS to opted-out contacts", () => {
    const r = checkComposer({ ...base, channel: "sms", contact: { ...base.contact!, sms_opt_out: true } });
    expect(r.canSend).toBe(false);
    expect(r.problems.join(" ")).toMatch(/opted out/i);
  });

  it("does not allow attachments over SMS", () => {
    expect(checkComposer({ ...base, channel: "sms", attachmentCount: 1 }).canSend).toBe(false);
  });

  it("requires an email address, a verified sender and a subject for email", () => {
    const email = { ...base, channel: "email" as const, from: "help@acme.test", subject: "Re: Order" };
    expect(checkComposer(email).canSend).toBe(true);
    expect(checkComposer({ ...email, contact: { ...base.contact!, email: null } }).problems.join(" ")).toMatch(/no email address/i);
    expect(checkComposer({ ...email, from: "" }).problems.join(" ")).toMatch(/verified sender/i);
    expect(checkComposer({ ...email, senders: [{ address: "help@acme.test", verified: false }] }).canSend).toBe(false);
    expect(checkComposer({ ...email, subject: " " }).problems.join(" ")).toMatch(/subject/i);
  });

  it("treats notes as chat regardless of the selected channel, skipping channel validation", () => {
    expect(effectiveChannel("sms", true)).toBe("dm");
    const r = checkComposer({ ...base, channel: "sms", isNote: true, contact: { email: null, phone: null, sms_opt_out: true } });
    expect(r).toMatchObject({ canSend: true, channel: "dm", smsRemaining: null });
  });

  it("rejects attachments on notes", () => {
    expect(checkComposer({ ...base, isNote: true, attachmentCount: 1 }).canSend).toBe(false);
  });
});

describe("defaultEmailSubject", () => {
  it("prefixes Re: once and falls back to the contact name", () => {
    expect(defaultEmailSubject({ roomSubject: null, lastEmailSubject: "Order 42", contactName: "Ada" })).toBe("Re: Order 42");
    expect(defaultEmailSubject({ roomSubject: null, lastEmailSubject: "re: Order 42", contactName: "Ada" })).toBe("re: Order 42");
    expect(defaultEmailSubject({ roomSubject: "Billing", lastEmailSubject: null, contactName: "Ada" })).toBe("Re: Billing");
    expect(defaultEmailSubject({ roomSubject: null, lastEmailSubject: null, contactName: "Ada" })).toBe("Conversation with Ada");
  });
});

describe("messageKindFor", () => {
  it("maps attachments and quotes to the kinds the server accepts", () => {
    expect(messageKindFor({ isNote: true, hasRef: true, attachmentTypes: [] })).toBe("note");
    expect(messageKindFor({ isNote: false, hasRef: false, attachmentTypes: ["image/png", "image/jpeg"] })).toBe("image");
    expect(messageKindFor({ isNote: false, hasRef: false, attachmentTypes: ["audio/webm"] })).toBe("voice");
    expect(messageKindFor({ isNote: false, hasRef: false, attachmentTypes: ["application/pdf"] })).toBe("attachment");
    expect(messageKindFor({ isNote: false, hasRef: true, attachmentTypes: [] })).toBe("ref");
    expect(messageKindFor({ isNote: false, hasRef: false, attachmentTypes: [] })).toBe("text");
  });
});
