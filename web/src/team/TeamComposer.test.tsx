import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamComposer } from "./TeamComposer";

const emit = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../auth/AuthContext", () => ({ useSession: () => ({ member: { id: "mem_me", name: "Me" } }) }));
vi.mock("../realtime/SocketProvider", () => ({ useSocket: () => ({ connected: true, emit }) }));

const members = [
  { id: "mem_ann", name: "Ann Agent", email: "ann@x.test" },
  { id: "mem_me", name: "Me", email: "me@x.test" },
  { id: "mem_bo", name: "Bo Agent", email: "bo@x.test" },
];
let seq = 0;
function mount(onSend = vi.fn(), key = `tch_${++seq}`) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: members }), { status: 200, headers: { "content-type": "application/json" } })));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TeamComposer draftKey={key} channelId="tch_1" placeholder="Message #ops" onSend={onSend} />
    </QueryClientProvider>,
  );
  return onSend;
}

describe("TeamComposer", () => {
  beforeEach(() => emit.mockClear());

  it("sends on Enter, keeps Shift+Enter for a new line, trims, and clears the box", async () => {
    const onSend = mount();
    const box = screen.getByRole("textbox", { name: "Message #ops" });
    await userEvent.type(box, "  hello team");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, "second line{Enter}");
    expect(onSend).toHaveBeenCalledWith({ content: "hello team\nsecond line", attachmentIds: [] });
    expect(box).toHaveValue("");
  });

  it("does not send an empty message", async () => {
    const onSend = mount();
    await userEvent.type(screen.getByRole("textbox", { name: "Message #ops" }), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("suggests teammates after @ (not yourself), inserts a mention token, and offers @channel", async () => {
    const onSend = mount();
    const box = screen.getByRole("textbox", { name: "Message #ops" });
    await userEvent.type(box, "hey @a");
    const opt = await screen.findByRole("option", { name: /Ann Agent/ });
    expect(screen.queryByRole("option", { name: /^Me/ })).toBeNull();
    await userEvent.click(opt);
    expect(box).toHaveValue("hey @[Ann Agent](mem_ann) ");
    await userEvent.type(box, "ok{Enter}");
    expect(onSend).toHaveBeenCalledWith({ content: "hey @[Ann Agent](mem_ann) ok", attachmentIds: [] });
    await userEvent.type(box, "@chan");
    expect(await screen.findByRole("option", { name: /@channel/ })).toBeInTheDocument();
  });

  it("navigates suggestions with the arrow keys and Enter picks instead of sending", async () => {
    const onSend = mount();
    const box = screen.getByRole("textbox", { name: "Message #ops" });
    await userEvent.type(box, "@");
    await screen.findByRole("option", { name: /Ann Agent/ });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}"); // @channel is first, then Ann, then Bo
    expect(box).toHaveValue("@[Bo Agent](mem_bo) ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps a draft per channel while you move around", async () => {
    mount(vi.fn(), "tch_draft");
    await userEvent.type(screen.getByRole("textbox", { name: "Message #ops" }), "unfinished thought");
    cleanup();
    mount(vi.fn(), "tch_draft");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message #ops" })).toHaveValue("unfinished thought"));
  });

  it("tells the others you are typing (throttled) and that you stopped after sending", async () => {
    mount();
    const box = screen.getByRole("textbox", { name: "Message #ops" });
    await userEvent.type(box, "abc");
    const typing = emit.mock.calls.filter((c) => c[0] === "team:typing" && c[1].typing === true);
    expect(typing).toHaveLength(1);
    expect(typing[0]![1]).toMatchObject({ channel_id: "tch_1" });
    await userEvent.type(box, "{Enter}");
    expect(emit.mock.calls.some((c) => c[0] === "team:typing" && c[1].typing === false)).toBe(true);
  });

  it("ArrowUp in an empty box asks to edit the last message", async () => {
    const onEditLast = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: members }), { status: 200, headers: { "content-type": "application/json" } })));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamComposer draftKey={`k${++seq}`} channelId="tch_1" placeholder="Message #ops" onSend={vi.fn()} onEditLast={onEditLast} />
      </QueryClientProvider>,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Message #ops" }), "{ArrowUp}");
    expect(onEditLast).toHaveBeenCalled();
  });

  it("is replaced by an explanation when writing is not possible", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamComposer draftKey={`k${++seq}`} channelId="tch_1" placeholder="Message #ops" onSend={vi.fn()} disabled disabledReason="This channel is archived and read-only." />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("archived and read-only");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
