import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DmCallButtons } from "./ChannelView";

const call = vi.fn();
let value: unknown;
vi.mock("../calls/TeamCallProvider", () => ({ useTeamCalls: () => value }));
// ChannelView pulls in the whole team chat; only the buttons are under test
vi.mock("../realtime/SocketProvider", () => ({ useSocket: () => ({}) }));
vi.mock("../auth/AuthContext", () => ({ useCan: () => true, useSession: () => ({ member: { id: "me" } }) }));

const calls = (over: Record<string, unknown> = {}, phase = "idle") => ({ available: true, config: { voice: true, video: true, screen_share: true }, view: { phase }, call, ...over });

describe("the call buttons of a direct message", () => {
  beforeEach(() => call.mockClear());

  it("offer voice and video to someone who is online, and start the call in this conversation", async () => {
    value = calls();
    render(<DmCallButtons peerId="mem_ben" peerName="Ben" channelId="tch_1" online />);
    await userEvent.click(screen.getByRole("button", { name: "Voice call with Ben" }));
    await userEvent.click(screen.getByRole("button", { name: "Video call with Ben" }));
    expect(call).toHaveBeenNthCalledWith(1, "tch_1", "voice", "Ben");
    expect(call).toHaveBeenNthCalledWith(2, "tch_1", "video", "Ben");
  });

  it("are disabled with the reason for someone who is offline and while the member is already in a call", async () => {
    value = calls();
    const { rerender } = render(<DmCallButtons peerId="mem_ben" peerName="Ben" channelId="tch_1" online={false} />);
    expect(screen.getByRole("button", { name: "Voice call with Ben" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Video call with Ben" })).toBeDisabled();
    value = calls({}, "active");
    rerender(<DmCallButtons peerId="mem_ben" peerName="Ben" channelId="tch_1" online />);
    expect(screen.getByRole("button", { name: "Voice call with Ben" })).toBeDisabled();
  });

  it("show only the kinds that are switched on, and nothing when calls are not available", () => {
    value = calls({ config: { voice: true, video: false, screen_share: true } });
    const { container, rerender } = render(<DmCallButtons peerId="mem_ben" peerName="Ben" channelId="tch_1" online />);
    expect(screen.getByRole("button", { name: "Voice call with Ben" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Video call with Ben" })).toBeNull();
    value = calls({ available: false });
    rerender(<DmCallButtons peerId="mem_ben" peerName="Ben" channelId="tch_1" online />);
    expect(container).toBeEmptyDOMElement();
    value = null;
    rerender(<DmCallButtons peerId="mem_ben" peerName="Ben" channelId="tch_1" online />);
    expect(container).toBeEmptyDOMElement();
  });
});
