import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamCallProvider, useTeamCalls } from "./TeamCallProvider";
import { FakeMedia, FakePC, FakeStream } from "./fakes";

// the realtime socket and the session are replaced by small fakes; the engine, the provider and the screens are the real ones
const handlers = new Map<string, Set<(p: never) => void>>();
const emitted: { event: string; payload: any }[] = [];
let can = new Set(["calls:internal"]);
const socket = {
  connected: true,
  onlineMembers: new Set(["mem_ben"]),
  emit: vi.fn(async (event: string, payload: object) => {
    emitted.push({ event, payload });
    if (event === "tcall:invite") return { ok: true, call: { id: "tcall_1", channel_id: (payload as any).channel_id, kind: (payload as any).kind, state: "ringing", caller: { id: "mem_me", name: "Me" }, callee: { id: "mem_ben", name: "Ben" } }, ice: { iceServers: [], warning: null } };
    if (event === "tcall:accept") return { ok: true, call: {}, ice: { iceServers: [], warning: null } };
    return { ok: true };
  }),
  subscribe: (event: string, h: (p: never) => void) => {
    (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(h);
    return () => void handlers.get(event)?.delete(h);
  },
};
vi.mock("../realtime/SocketProvider", () => ({ useSocket: () => socket }));
vi.mock("../auth/AuthContext", () => ({ useCan: (p: string) => can.has(p), useSession: () => ({ member: { id: "mem_me" } }) }));

const media = new FakeMedia();
vi.stubGlobal("RTCPeerConnection", FakePC);
Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
vi.stubGlobal("MediaStream", FakeStream);

let config: unknown;
const fire = (event: string, payload: unknown) => act(() => void [...(handlers.get(event) ?? [])].forEach((h) => h(payload as never)));
const ringing = (over: Record<string, unknown> = {}) => ({ call: { id: "tcall_9", channel_id: "tch_9", kind: "video", state: "ringing", caller: { id: "mem_ben", name: "Ben Agent" }, callee: { id: "mem_me", name: "Me" }, ...over } });

function Probe() {
  const c = useTeamCalls();
  return (
    <div>
      <span data-testid="phase">{c?.view.phase}</span>
      <span data-testid="available">{String(c?.available)}</span>
      <button onClick={() => void c?.call("tch_1", "voice", "Ben")}>place</button>
    </div>
  );
}
function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      if (path === "/api/team-calls/config") return new Response(JSON.stringify(config), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TeamCallProvider>
        <Probe />
      </TeamCallProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handlers.clear();
  emitted.length = 0;
  FakePC.all = [];
  can = new Set(["calls:internal"]);
  config = { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 30, warning: null, live_call: null };
});

describe("calls between teammates in the app", () => {
  it("rings wherever the member is: an incoming call shows the caller, focuses Accept, and answering starts the call", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("available")).toHaveTextContent("true"));
    fire("tcall:state", ringing());
    const dlg = await screen.findByRole("alertdialog", { name: "Incoming call" });
    expect(dlg).toHaveTextContent("Ben Agent");
    expect(dlg).toHaveTextContent("is calling you (video)");
    const accept = screen.getByRole("button", { name: "Accept the call from Ben Agent" });
    await waitFor(() => expect(accept).toHaveFocus());
    await userEvent.click(accept);
    await waitFor(() => expect(emitted.some((e) => e.event === "tcall:accept")).toBe(true));
    expect(screen.getByRole("dialog", { name: "Call with Ben Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("declining sends the decline and closes the ring", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("available")).toHaveTextContent("true"));
    fire("tcall:state", ringing({ kind: "voice" }));
    await userEvent.click(await screen.findByRole("button", { name: "Decline the call from Ben Agent" }));
    expect(emitted.find((e) => e.event === "tcall:decline")!.payload).toEqual({ call_id: "tcall_9" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("the caller cancelling or the ring running out stops the ringing, and a missed call is said in a toast too", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("available")).toHaveTextContent("true"));
    fire("tcall:state", ringing());
    await screen.findByRole("alertdialog");
    fire("tcall:state", ringing({ state: "missed" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByRole("dialog", { name: "Call with Ben Agent" })).toHaveTextContent("Missed call from Ben Agent.");
  });

  it("a tab opened while a call rings shows the ring (from the config's live call)", async () => {
    config = { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 30, warning: null, live_call: ringing().call };
    mount();
    expect(await screen.findByRole("alertdialog", { name: "Incoming call" })).toHaveTextContent("Ben Agent");
  });

  it("placing a call shows the outgoing panel with a cancel button and the status", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("available")).toHaveTextContent("true"));
    await userEvent.click(screen.getByText("place"));
    const panel = await screen.findByRole("dialog", { name: "Call with Ben" });
    expect(panel).toHaveTextContent("Calling Ben...");
    expect(emitted.find((e) => e.event === "tcall:invite")!.payload).toEqual({ channel_id: "tch_1", kind: "voice" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel call" }));
    expect(emitted.some((e) => e.event === "tcall:end")).toBe(true);
  });

  it("is not available without the permission or when the workspace has it off, and then nothing rings", async () => {
    can = new Set();
    const first = mount();
    await waitFor(() => expect(screen.getByTestId("available")).toHaveTextContent("false"));
    fire("tcall:state", ringing());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    first.unmount();
    can = new Set(["calls:internal"]);
    config = { enabled: false, voice: true, video: true, screen_share: true, ring_seconds: 30, warning: null, live_call: null };
    mount();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("available")).toHaveTextContent("false"));
  });
});
