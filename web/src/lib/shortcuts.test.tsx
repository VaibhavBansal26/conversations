import { render, renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { shortcutFor } from "./shortcuts";
import { useShortcuts } from "./useShortcuts";

describe("shortcutFor", () => {
  it.each([
    ["j", "next_room"],
    ["k", "prev_room"],
    ["e", "toggle_status"],
    ["a", "open_assign"],
    ["c", "focus_composer"],
    ["/", "focus_search"],
    ["n", "new_conversation"],
    ["i", "toggle_panel"],
    ["p", "toggle_priority"],
    ["f", "toggle_favorite"],
    ["s", "open_snooze"],
    ["?", "help"],
    ["Escape", "escape"],
  ])("maps %s to %s", (key, action) => {
    expect(shortcutFor({ key })).toBe(action);
  });

  it("ignores letter shortcuts while typing in inputs, textareas, selects and contenteditable", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(shortcutFor({ key: "j", target: { tagName } as unknown as EventTarget })).toBeNull();
    expect(shortcutFor({ key: "e", target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget })).toBeNull();
  });

  it("still lets Escape through while typing", () => {
    expect(shortcutFor({ key: "Escape", target: { tagName: "INPUT" } as unknown as EventTarget })).toBe("escape");
  });

  it("ignores modified keys and unknown keys", () => {
    expect(shortcutFor({ key: "c", metaKey: true })).toBeNull();
    expect(shortcutFor({ key: "a", ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: "z" })).toBeNull();
  });
});

describe("useShortcuts", () => {
  it("fires handlers from the document but not from inside a text field", async () => {
    const next = vi.fn();
    renderHook(() => useShortcuts({ next_room: next }));
    await userEvent.keyboard("j");
    expect(next).toHaveBeenCalledTimes(1);

    const { getByLabelText } = render(<input aria-label="search" />);
    await userEvent.click(getByLabelText("search"));
    await userEvent.keyboard("j");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not fire letter shortcuts while a modal dialog is open", async () => {
    const help = vi.fn();
    renderHook(() => useShortcuts({ help }));
    render(<div role="dialog" aria-modal="true" />);
    await userEvent.keyboard("?");
    expect(help).not.toHaveBeenCalled();
  });
});
