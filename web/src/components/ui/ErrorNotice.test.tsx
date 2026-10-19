import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../../lib/apiError";
import { ErrorNotice } from "./ErrorNotice";

describe("ErrorNotice", () => {
  it("shows the server message verbatim in an alert", () => {
    render(<ErrorNotice error={new ApiError(422, "SMS_TOO_LONG", "SMS messages must be shorter than 1600 characters")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("SMS messages must be shorter than 1600 characters");
  });

  it("renders a calm status (not an alert) for AI_UNAVAILABLE", () => {
    render(<ErrorNotice error={new ApiError(503, "AI_UNAVAILABLE", "AI is unavailable right now.")} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/AI unavailable/i);
  });

  it("offers a retry action when given a handler", async () => {
    const onRetry = vi.fn();
    render(<ErrorNotice error={new Error("nope")} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
