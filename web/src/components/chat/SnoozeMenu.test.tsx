import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { snoozePresets } from "../../lib/snooze";
import { SnoozeMenu } from "./SnoozeMenu";

const NOW = new Date("2026-01-07T15:30:00"); // a Wednesday, local time

describe("snooze presets", () => {
  it("computes four future dates", () => {
    const presets = snoozePresets(NOW);
    expect(presets.map((p) => p.id)).toEqual(["1h", "3h", "tomorrow", "next_week"]);
    for (const p of presets) expect(p.until.getTime()).toBeGreaterThan(NOW.getTime());
    expect(presets[0]!.until.getTime() - NOW.getTime()).toBe(3_600_000);
    expect(presets[1]!.until.getTime() - NOW.getTime()).toBe(3 * 3_600_000);
  });

  it("uses 9:00 tomorrow and next Monday at 9:00", () => {
    const [, , tomorrow, nextWeek] = snoozePresets(NOW);
    expect([tomorrow?.until.getDate(), tomorrow?.until.getHours()]).toEqual([8, 9]);
    expect([nextWeek?.until.getDay(), nextWeek?.until.getDate(), nextWeek?.until.getHours()]).toEqual([1, 12, 9]);
  });

  it("never returns a past date, even late on a Sunday or Monday", () => {
    for (const day of ["2026-01-04T23:59:00", "2026-01-05T08:00:00", "2026-01-05T23:59:00"]) {
      const now = new Date(day);
      for (const p of snoozePresets(now)) expect(p.until.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("SnoozeMenu", () => {
  it("lists the presets and snoozes with a future ISO timestamp", async () => {
    const onSnooze = vi.fn();
    render(<SnoozeMenu snoozed={false} onSnooze={onSnooze} now={() => NOW} />);
    await userEvent.click(screen.getByRole("button", { name: "Snooze conversation" }));
    for (const label of ["In 1 hour", "In 3 hours", "Tomorrow, 9:00", "Next week, Mon 9:00"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "In 3 hours" }));
    const iso = onSnooze.mock.calls[0]?.[0] as string;
    expect(new Date(iso).getTime()).toBe(NOW.getTime() + 3 * 3_600_000);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects a custom time in the past", async () => {
    const onSnooze = vi.fn();
    render(<SnoozeMenu snoozed={false} onSnooze={onSnooze} now={() => NOW} />);
    await userEvent.click(screen.getByRole("button", { name: "Snooze conversation" }));
    await userEvent.type(screen.getByLabelText("Custom date and time"), "2026-01-01T10:00");
    await userEvent.click(screen.getByRole("button", { name: "Snooze" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/future/i);
    expect(onSnooze).not.toHaveBeenCalled();
  });

  it("offers to remove an active snooze", async () => {
    const onSnooze = vi.fn();
    render(<SnoozeMenu snoozed onSnooze={onSnooze} now={() => NOW} />);
    await userEvent.click(screen.getByRole("button", { name: "Snooze conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove snooze" }));
    expect(onSnooze).toHaveBeenCalledWith(null);
  });

  it("closes with Escape and returns focus to the trigger", async () => {
    render(<SnoozeMenu snoozed={false} onSnooze={() => undefined} now={() => NOW} />);
    const trigger = screen.getByRole("button", { name: "Snooze conversation" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Snooze until")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
