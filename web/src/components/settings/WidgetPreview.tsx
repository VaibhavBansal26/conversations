import type { WidgetSettings } from "../../api/types";
import { Icon } from "../ui/Icon";

interface Props {
  settings: WidgetSettings;
  /** Show the away message instead of the welcome message. */
  away?: boolean;
}

const REQUIRED_LABEL = { name: "Your name", email: "Email address", phone: "Phone number" } as const;

/** Visual stand-in for the embeddable widget, driven by the (possibly unsaved) form values. */
export function WidgetPreview({ settings: s, away }: Props) {
  const side = s.launcher_position === "left" ? { left: 16 } : { right: 16 };
  const style = { ["--w-bg" as string]: s.primary_color, ["--w-fg" as string]: s.text_color };
  return (
    <div className="widget-preview" style={style} aria-label="Live widget preview" role="group">
      <div className="wp-panel" style={side}>
        <div className="wp-head">
          {s.logo_url && <img src={s.logo_url} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
          <div>
            <strong>{s.title || "Chat with us"}</strong>
            <p>{s.intro}</p>
          </div>
        </div>
        <div className="wp-body">
          <p className="wp-bubble">{away ? s.away_message : s.welcome_message}</p>
          {s.required_info.map((f) => (
            <div key={f} className="wp-field">
              {REQUIRED_LABEL[f]}
            </div>
          ))}
          <div className="wp-input">{s.chat_type === "sms" ? "Reply by text message…" : "Type your message…"}</div>
        </div>
      </div>
      <div className="wp-launcher" style={{ ...side, bottom: Math.min(s.launcher_spacing, 60) }} aria-hidden="true">
        <Icon name="chat" size={24} />
      </div>
    </div>
  );
}
