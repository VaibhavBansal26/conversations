import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CallPanel } from "./CallPanel";
import type { CallView } from "./engine";
import { FakeStream } from "./fakes";

const base: CallView = { phase: "active", kind: "video", callId: "c1", roomId: "r1", muted: false, cameraOff: false, sharing: false, quality: "good", seconds: 75, local: new FakeStream(["audio", "video"]) as never, remote: null, message: "", warning: null };
const engine = { toggleMute: vi.fn(), toggleCamera: vi.fn(), toggleShare: vi.fn(), end: vi.fn(), reset: vi.fn() };
let view: CallView = base;
vi.mock("./CallProvider", () => ({ useCalls: () => (view.phase === ("none" as never) ? null : { view, engine, config: { browser: { screen_share: true } } }) }));

describe("CallPanel", () => {
  beforeEach(() => {
    Object.values(engine).forEach((f) => f.mockClear());
    view = base;
  });

  it("shows the timer, the quality, and working controls during a call", async () => {
    render(<CallPanel />);
    expect(screen.getByRole("timer")).toHaveTextContent("01:15");
    expect(screen.getByRole("img", { name: "Connection: good" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    await userEvent.click(screen.getByRole("button", { name: "Turn camera off" }));
    await userEvent.click(screen.getByRole("button", { name: "Share your screen" }));
    await userEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(engine.toggleMute).toHaveBeenCalled();
    expect(engine.toggleCamera).toHaveBeenCalled();
    expect(engine.toggleShare).toHaveBeenCalled();
    expect(engine.end).toHaveBeenCalled();
  });

  it("reflects the muted state and offers Cancel while it rings", () => {
    view = { ...base, muted: true, phase: "ringing" };
    render(<CallPanel />);
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Cancel call" })).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("Ringing");
    expect(screen.queryByRole("button", { name: "Share your screen" })).toBeNull();
  });

  it("an ended call says why and can be closed", async () => {
    view = { ...base, phase: "ended", message: "The visitor declined the call.", local: null };
    render(<CallPanel />);
    expect(screen.getByText("The visitor declined the call.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(engine.reset).toHaveBeenCalled();
  });

  it("shows nothing when idle", () => {
    view = { ...base, phase: "idle" };
    const { container } = render(<CallPanel />);
    expect(container).toBeEmptyDOMElement();
  });
});
