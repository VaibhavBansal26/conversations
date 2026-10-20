import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { duration } from "../../pages/AnalyticsPage";
import { BarChart, LineChart } from "./Charts";

const pts = [
  { label: "Mar 1", value: 3 },
  { label: "Mar 2", value: 0 },
  { label: "Mar 3", value: 7 },
];

describe("accessible SVG charts", () => {
  it("a line chart is a named image with a description and its data in a table", () => {
    render(<LineChart title="Median first response" summary="Median reply time per day." points={pts} unit="Seconds" />);
    const img = screen.getByRole("img", { name: /Median first response/ });
    expect(img.getAttribute("aria-labelledby")).toBeTruthy();
    expect(img.querySelector("desc")!.textContent).toBe("Median reply time per day.");
    expect(img.querySelectorAll("circle")).toHaveLength(3);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(4); // header + 3 days
    expect(screen.getByRole("rowheader", { name: "Mar 3" }).nextElementSibling!.textContent).toBe("7");
  });
  it("a bar chart draws one bar per point, with a title on each, and survives empty data", () => {
    const { rerender, container } = render(<BarChart title="Opened" summary="s" points={pts} />);
    expect(container.querySelectorAll("rect")).toHaveLength(3);
    expect(container.querySelector("rect title")!.textContent).toBe("Mar 1: 3");
    rerender(<BarChart title="Opened" summary="s" points={[]} />);
    expect(container.querySelectorAll("rect")).toHaveLength(0);
  });
  it("formats durations for people", () => {
    expect([duration(null), duration(45), duration(300), duration(7200), duration(200000)]).toEqual(["n/a", "45 s", "5 min", "2.0 h", "2.3 d"]);
  });
});
