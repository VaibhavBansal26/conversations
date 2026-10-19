import type { SendPayload } from "../api/types";
import { makeMessage } from "../test/factories";
import { emptyThread } from "./messageCache";
import { addOptimistic, buildOptimistic, markFailed, markRetrying, markSent, nextSendState, payloadOf, sendStateOf } from "./optimistic";
import { upsertMessage } from "./messageCache";

const payload: SendPayload = { kind: "text", source: "dm", content: "Hi there", client_msg_id: "cid-11111111" };
const optimistic = () => buildOptimistic(payload, "room_1", { id: "mem_me", name: "Me" });

describe("send state machine", () => {
  it("moves sending -> sent | failed and failed -> sending only", () => {
    expect(nextSendState("sending", "ack")).toBe("sent");
    expect(nextSendState("sending", "fail")).toBe("failed");
    expect(nextSendState("failed", "retry")).toBe("sending");
    expect(nextSendState("sent", "fail")).toBe("sent");
    expect(nextSendState("sending", "retry")).toBe("sending");
    expect(nextSendState("failed", "ack")).toBe("failed");
  });
});

describe("optimistic sends", () => {
  it("shows a pending bubble keyed by client_msg_id", () => {
    const t = addOptimistic(emptyThread, optimistic());
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ client_msg_id: "cid-11111111", delivery: "pending" });
    expect(sendStateOf(t.messages[0]!)).toBe("sending");
  });

  it("does not add a second bubble for the same client_msg_id", () => {
    const once = addOptimistic(emptyThread, optimistic());
    expect(addOptimistic(once, optimistic()).messages).toHaveLength(1);
  });

  it("merges the ack into the optimistic bubble", () => {
    const confirmed = makeMessage({ id: "msg_srv", client_msg_id: "cid-11111111", sender: { type: "agent", id: "mem_me", name: "Me" } });
    const t = markSent(addOptimistic(emptyThread, optimistic()), confirmed);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]?.id).toBe("msg_srv");
    expect(sendStateOf(t.messages[0]!)).toBe("sent");
  });

  it("produces one bubble when the broadcast arrives BEFORE the ack", () => {
    const confirmed = makeMessage({ id: "msg_srv", client_msg_id: "cid-11111111", delivery: "sent" });
    let t = addOptimistic(emptyThread, optimistic());
    t = upsertMessage(t, confirmed); // message:new
    t = markSent(t, confirmed); // ack
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]?.id).toBe("msg_srv");
  });

  it("produces one bubble when the ack arrives BEFORE the broadcast, without regressing delivery", () => {
    const delivered = makeMessage({ id: "msg_srv", client_msg_id: "cid-11111111", delivery: "delivered" });
    let t = markSent(addOptimistic(emptyThread, optimistic()), delivered); // ack
    t = upsertMessage(t, { ...delivered, delivery: "sent" }); // late message:new
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]?.delivery).toBe("delivered");
  });

  it("marks failures with the reason and keeps the payload for retry", () => {
    const t = markFailed(addOptimistic(emptyThread, optimistic()), "cid-11111111", "Network down");
    expect(t.messages[0]).toMatchObject({ delivery: "failed", failure_reason: "Network down" });
    expect(sendStateOf(t.messages[0]!)).toBe("failed");
    expect(payloadOf(t, "cid-11111111")).toEqual(payload);
  });

  it("retry flips back to sending and reuses the same client_msg_id", () => {
    const failed = markFailed(addOptimistic(emptyThread, optimistic()), "cid-11111111", "Network down");
    const retrying = markRetrying(failed, "cid-11111111");
    expect(retrying.messages).toHaveLength(1);
    expect(retrying.messages[0]).toMatchObject({ client_msg_id: "cid-11111111", delivery: "pending", failure_reason: null });
    expect(sendStateOf(retrying.messages[0]!)).toBe("sending");
  });

  it("ignores failure reports for messages that were already confirmed", () => {
    const confirmed = makeMessage({ client_msg_id: "cid-11111111" });
    const t = upsertMessage(emptyThread, confirmed);
    expect(markFailed(t, "cid-11111111", "late timeout")).toBe(t);
  });
});
