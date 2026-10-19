import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Menu } from "./Menu";

describe("Menu", () => {
  const setup = () => {
    const picked: string[] = [];
    render(
      <Menu
        label="Assign"
        trigger="Assign"
        items={[
          { id: "a", label: "Me", onSelect: () => picked.push("a") },
          { id: "b", label: "Sam", onSelect: () => picked.push("b") },
          { id: "c", label: "Off", disabled: true, onSelect: () => picked.push("c") },
        ]}
      />,
    );
    return picked;
  };

  it("opens on click, focuses the first item and exposes menu semantics", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Assign" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.getByRole("menuitem", { name: "Me" })).toHaveFocus();
  });

  it("navigates with arrow keys (skipping disabled items), selects with Enter and closes", async () => {
    const picked = setup();
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Sam" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Me" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(picked).toEqual(["b"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
