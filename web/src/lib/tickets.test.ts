import { handlerLabel, PRIORITY_LABEL, ticketIsLive, ticketLabel, TICKET_STATUS_LABEL, TICKET_STATUS_TONE } from "./tickets";

describe("ticket vocabulary", () => {
  it("every status has a label and a tone, and only closed is not live", () => {
    for (const s of ["new", "bot_handling", "waiting_for_human", "open", "pending_customer", "resolved", "closed"] as const) {
      expect(TICKET_STATUS_LABEL[s]).toBeTruthy();
      expect(TICKET_STATUS_TONE[s]).toBeTruthy();
      expect(ticketIsLive({ status: s })).toBe(s !== "closed");
    }
    expect(Object.values(PRIORITY_LABEL)).toEqual(["Low", "Normal", "High", "Urgent"]);
    expect(ticketLabel({ number: 12 })).toBe("#12");
  });

  it("names the handler from what the caller knows, with calm fallbacks", () => {
    const names = { members: new Map([["mem_1", "Olivia"]]), agents: new Map([["agt_1", "Aria"]]) };
    expect(handlerLabel("human:mem_1", names)).toBe("Olivia");
    expect(handlerLabel("bot:agt_1", names)).toBe("Aria");
    expect(handlerLabel("human:gone", names)).toBe("A teammate");
    expect(handlerLabel("bot:gone")).toBe("AI agent");
    expect(handlerLabel(null)).toBe("Nobody yet");
    expect(handlerLabel("weird")).toBe("Nobody yet");
  });
});
