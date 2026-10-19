import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../lib/apiError";
import type { Message, SendPayload } from "../api/types";
import { makeMessage } from "../test/factories";
import { keys } from "./keys";
import type { Thread } from "./messageCache";
import { retryLocal, sendNew, transmit, type SendTransport } from "./sendFlow";

const payload: SendPayload = { kind: "text", source: "dm", content: "Hello", client_msg_id: "cid-22222222" };
const sender = { id: "mem_me", name: "Me" };
const confirmed = (over: Partial<Message> = {}) => makeMessage({ id: "msg_srv", client_msg_id: payload.client_msg_id, sender: { type: "agent", id: "mem_me", name: "Me" }, ...over });

const thread = (qc: QueryClient) => qc.getQueryData<Thread>(keys.thread("room_1"))!;
function transport(over: Partial<SendTransport> = {}): SendTransport {
  return { connected: () => true, viaSocket: vi.fn(async () => confirmed()), viaRest: vi.fn(async () => confirmed()), ...over };
}

describe("send flow", () => {
  it("sends over the socket when connected and replaces the optimistic bubble with the ack", async () => {
    const qc = new QueryClient();
    const t = transport();
    expect(await sendNew(qc, "room_1", payload, sender, t)).toBe(true);
    expect(t.viaSocket).toHaveBeenCalledWith(payload);
    expect(t.viaRest).not.toHaveBeenCalled();
    expect(thread(qc).messages).toHaveLength(1);
    expect(thread(qc).messages[0]?.id).toBe("msg_srv");
  });

  it("uses REST when the socket is down", async () => {
    const qc = new QueryClient();
    const t = transport({ connected: () => false });
    await sendNew(qc, "room_1", payload, sender, t);
    expect(t.viaSocket).not.toHaveBeenCalled();
    expect(t.viaRest).toHaveBeenCalledWith(payload);
  });

  it("falls back to REST with the same client_msg_id after a socket transport failure", async () => {
    const qc = new QueryClient();
    const t = transport({ viaSocket: vi.fn(async () => Promise.reject(new Error("operation has timed out"))) });
    expect(await sendNew(qc, "room_1", payload, sender, t)).toBe(true);
    expect(t.viaRest).toHaveBeenCalledWith(expect.objectContaining({ client_msg_id: "cid-22222222" }));
  });

  it("does not fall back when the server rejected the message", async () => {
    const qc = new QueryClient();
    const t = transport({ viaSocket: vi.fn(async () => Promise.reject(new ApiError(422, "CONTACT_OPTED_OUT", "This contact has opted out of SMS"))) });
    expect(await sendNew(qc, "room_1", payload, sender, t)).toBe(false);
    expect(t.viaRest).not.toHaveBeenCalled();
    expect(thread(qc).messages[0]).toMatchObject({ delivery: "failed", failure_reason: "This contact has opted out of SMS" });
  });

  it("retry resends the SAME client_msg_id and payload, then confirms", async () => {
    const qc = new QueryClient();
    const down = transport({ connected: () => false, viaRest: vi.fn(async () => Promise.reject(new ApiError(0, "NETWORK_ERROR", "Cannot reach the server"))) });
    await sendNew(qc, "room_1", payload, sender, down);
    expect(thread(qc).messages[0]?.local?.status).toBe("failed");

    const up = transport({ connected: () => false });
    expect(await retryLocal(qc, "room_1", "cid-22222222", up)).toBe(true);
    expect(up.viaRest).toHaveBeenCalledWith(payload);
    expect(thread(qc).messages).toHaveLength(1);
    expect(thread(qc).messages[0]).toMatchObject({ id: "msg_srv", delivery: "sent" });
  });

  it("retry of an unknown client_msg_id does nothing", async () => {
    const qc = new QueryClient();
    expect(await retryLocal(qc, "room_1", "missing", transport())).toBe(false);
  });

  it("transmit alone does not duplicate when the broadcast already created the message", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Thread>(keys.thread("room_1"), { messages: [confirmed()], hasMoreBefore: false, beforeCursor: null });
    await transmit(qc, "room_1", payload, transport());
    expect(thread(qc).messages).toHaveLength(1);
  });
});
