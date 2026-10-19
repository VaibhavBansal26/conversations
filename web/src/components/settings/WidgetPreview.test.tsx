import { render, screen } from "@testing-library/react";
import type { WidgetSettings } from "../../api/types";
import { WidgetPreview } from "./WidgetPreview";

const settings: WidgetSettings = {
  title: "Ask Acme",
  intro: "We reply fast.",
  primary_color: "#ff5500",
  text_color: "#ffffff",
  logo_url: null,
  launcher_position: "left",
  launcher_spacing: 24,
  sound: true,
  welcome_message: "Welcome in!",
  away_message: "We are out.",
  required_info: ["name", "email"],
  chat_type: "live_chat",
  office_hours: { enabled: false, timezone: "UTC", days: [] },
  default_inbox_id: null,
};

describe("WidgetPreview", () => {
  it("renders the unsaved form values", () => {
    render(<WidgetPreview settings={settings} />);
    expect(screen.getByText("Ask Acme")).toBeInTheDocument();
    expect(screen.getByText("Welcome in!")).toBeInTheDocument();
    expect(screen.getByText("Your name")).toBeInTheDocument();
    expect(screen.getByText("Email address")).toBeInTheDocument();
    expect(screen.queryByText("Phone number")).toBeNull();
    expect(screen.getByRole("group", { name: "Live widget preview" })).toHaveStyle({ "--w-bg": "#ff5500" });
  });

  it("switches to the away message and follows the form on every change", () => {
    const { rerender } = render(<WidgetPreview settings={settings} away />);
    expect(screen.getByText("We are out.")).toBeInTheDocument();
    rerender(<WidgetPreview settings={{ ...settings, title: "New title", chat_type: "sms" }} />);
    expect(screen.getByText("New title")).toBeInTheDocument();
    expect(screen.getByText("Reply by text message…")).toBeInTheDocument();
  });
});
