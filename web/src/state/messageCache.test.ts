import { makeMessage } from "../test/factories";
import type { MessagePage } from "../api/types";
import { applyReceipt, emptyThread, prependOlder, removeMessage, sortMessages, threadFromPage, upsertMessage, type Thread } from "./messageCache";

const thread = (...messages: ReturnType<typeof makeMessage>[]): Thread => ({ ...emptyThread, messages });
const page = (data: ReturnType<typeof makeMessage>[], more = false): MessagePage => ({
  data,
  pagination: { has_more_before: more, has_more_after: false, before_cursor: more ? (data[0]?.id ?? null) : null, after_cursor: null },
});

describe("messageCache", () => {
  it("appends a new message in sequence order", () => {
    const a = makeMessage({ seq: 1 });
    const b = makeMessage({ seq: 2 });
    expect(upsertMessage(thread(b), a).messages.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("dedupes by id", () => {
    const a = makeMessage();
    const out = upsertMessage(thread(a), { ...a, content_text: "edited" });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]?.content_text).toBe("edited");
  });

  it("dedupes by client_msg_id (optimistic bubble replaced by the confirmed message)", () => {
    const local = makeMessage({ id: "local-abc", seq: 0, client_msg_id: "abc12345", delivery: "pending", local: { status: "sending", payload: {} as never } });
    const confirmed = makeMessage({ id: "msg_real", seq: 9, client_msg_id: "abc12345", delivery: "sent" });
    const out = upsertMessage(thread(local), confirmed);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ id: "msg_real", delivery: "sent" });
    expect(out.messages[0]?.local).toBeUndefined();
  });

  it("never regresses delivery state when a stale event arrives late", () => {
    const delivered = makeMessage({ delivery: "delivered" });
    const out = upsertMessage(thread(delivered), { ...delivered, delivery: "sent" });
    expect(out.messages[0]?.delivery).toBe("delivered");
  });

  it("lets a retried message leave the failed state", () => {
    const failed = makeMessage({ delivery: "failed", failure_reason: "carrier error" });
    const out = upsertMessage(thread(failed), { ...failed, delivery: "sent", failure_reason: null });
    expect(out.messages[0]).toMatchObject({ delivery: "sent", failure_reason: null });
  });

  it("keeps unconfirmed local messages after confirmed ones", () => {
    const local = makeMessage({ seq: 0, local: { status: "sending", payload: {} as never } });
    const server = makeMessage({ seq: 50 });
    expect(sortMessages([local, server]).map((m) => m.id)).toEqual([server.id, local.id]);
  });

  it("removes deleted messages", () => {
    const a = makeMessage();
    const b = makeMessage();
    expect(removeMessage(thread(a, b), a.id).messages.map((m) => m.id)).toEqual([b.id]);
    const same = thread(a);
    expect(removeMessage(same, "nope")).toBe(same);
  });

  it("marks team messages read up to the receipt sequence when the contact reads", () => {
    const sent1 = makeMessage({ seq: 1, sender: { type: "agent", id: "m", name: "Me" }, delivery: "sent" });
    const sent2 = makeMessage({ seq: 5, sender: { type: "agent", id: "m", name: "Me" }, delivery: "sent" });
    const note = makeMessage({ seq: 2, kind: "note", sender: { type: "agent", id: "m", name: "Me" } });
    const out = applyReceipt(thread(sent1, note, sent2), { reader: { type: "contact" }, up_to_seq: 3, at: "2026-01-05T11:00:00.000Z" });
    expect(out.messages.find((m) => m.id === sent1.id)).toMatchObject({ read: true, delivery: "delivered", opened_at: "2026-01-05T11:00:00.000Z" });
    expect(out.messages.find((m) => m.id === note.id)?.read).toBe(false);
    expect(out.messages.find((m) => m.id === sent2.id)?.read).toBe(false);
  });

  it("ignores receipts from agents and returns the same thread when nothing changes", () => {
    const t = thread(makeMessage({ sender: { type: "agent", id: "m", name: "Me" } }));
    expect(applyReceipt(t, { reader: { type: "agent", id: "x" }, up_to_seq: 99, at: "x" })).toBe(t);
  });

  it("prepends an older page without duplicating known messages", () => {
    const m3 = makeMessage({ seq: 3 });
    const m2 = makeMessage({ seq: 2 });
    const m1 = makeMessage({ seq: 1 });
    const out = prependOlder(threadFromPage(page([m3], true)), page([m1, m2, m3], false));
    expect(out.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(out.hasMoreBefore).toBe(false);
  });
});
