// Adapted from the legacy UI (see docs/PROVENANCE.md): live messenger preview beside the customiser.
import { MessageSquare, Send, X } from "lucide-react";
import type { CSSProperties } from "react";
import type { WidgetSettings } from "../../api/types";
import { cn } from "../../ui";
import { WIDGET_PALETTE } from "./contrast";

interface Props {
  settings: WidgetSettings;
  /** Show the away message instead of the welcome message. */
  away?: boolean;
  /** chat = conversation, form = the pre-chat details form, closed = only the launcher */
  view?: "chat" | "form" | "closed";
  theme?: "light" | "dark";
  device?: "desktop" | "mobile";
}

const REQUIRED_LABEL = { name: "Your name", email: "Email address", phone: "Phone number" } as const;

/**
 * Visual stand-in for the embeddable widget, driven by the (possibly unsaved) form values.
 * The palette and proportions mirror server/public/widget.js so what you see is what visitors get.
 */
export function WidgetPreview({ settings: s, away, view = "chat", theme = "light", device = "desktop" }: Props) {
  const p = WIDGET_PALETTE[theme];
  const side = s.launcher_position === "left" ? "left" : "right";
  const radius = s.radius ?? 16;
  const style = {
    "--w-bg": s.primary_color,
    "--w-fg": s.text_color,
    "--w-r": `${radius}px`,
    "--w-panel": p.bg,
    "--w-surface": p.bg2,
    "--w-text": p.fg,
    "--w-muted": p.muted,
    "--w-line": p.line,
    "--w-in": p.inBubble,
    "--w-bot": p.bot,
    "--w-botline": p.botLine,
  } as CSSProperties;
  const mobile = device === "mobile";
  const spacing = Math.min(s.launcher_spacing, 48);
  const sms = s.chat_type === "sms";
  const fields: (keyof typeof REQUIRED_LABEL)[] = sms && !s.required_info.includes("phone") ? [...s.required_info, "phone"] : s.required_info;
  const launcherStyle = s.launcher_style ?? "bubble";

  return (
    <div
      role="group"
      aria-label="Live widget preview"
      style={style}
      className={cn(
        "relative mx-auto overflow-hidden rounded-xl border border-border bg-surface-2 transition-[width] duration-200",
        mobile ? "h-[540px] w-[272px]" : "h-[560px] w-full max-w-[520px]",
      )}
    >
      {/* a stand-in web page behind the widget */}
      <div className="pointer-events-none absolute inset-0 select-none p-4 opacity-70" aria-hidden="true">
        <div className="mb-4 flex items-center gap-2">
          <span className="size-3 rounded-full bg-border-strong" />
          <span className="h-2.5 w-24 rounded bg-border-strong" />
          <span className="ml-auto h-2.5 w-10 rounded bg-border-strong" />
          <span className="h-2.5 w-10 rounded bg-border-strong" />
        </div>
        <div className="mb-3 h-5 w-2/3 rounded bg-border-strong" />
        <div className="mb-1.5 h-2.5 w-full rounded bg-border" />
        <div className="mb-1.5 h-2.5 w-11/12 rounded bg-border" />
        <div className="mb-5 h-2.5 w-3/4 rounded bg-border" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-20 rounded-lg bg-border" />
          <div className="h-20 rounded-lg bg-border" />
        </div>
      </div>

      {view !== "closed" && (
        <div
          data-testid="preview-panel"
          className={cn(
            "absolute flex flex-col overflow-hidden border border-[var(--w-line)] bg-[var(--w-panel)] text-[var(--w-text)] shadow-lg",
            mobile ? "inset-0 !rounded-none border-0" : "h-[calc(100%-5.5rem)] w-[min(340px,calc(100%-1.5rem))]",
          )}
          style={{ borderRadius: mobile ? 0 : "var(--w-r)", bottom: mobile ? 0 : spacing + 64, ...(mobile ? {} : { [side]: spacing }) }}
        >
          <div className="flex items-center gap-3 bg-[var(--w-bg)] px-4 py-3.5 text-[var(--w-fg)]">
            {s.logo_url && <img src={s.logo_url} alt="" className="size-9 rounded-full bg-white/20 object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />}
            <div className="min-w-0">
              <strong className="block truncate text-[15px] font-semibold leading-tight">{s.title || "Chat with us"}</strong>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs leading-snug opacity-90">
                {!away && <span className="inline-block size-2 shrink-0 rounded-full bg-[#4ade80] ring-2 ring-white/30" aria-hidden="true" />}
                <span className="line-clamp-2">{s.intro}</span>
              </p>
            </div>
            <span className="ml-auto grid size-8 shrink-0 place-items-center rounded-full" aria-hidden="true">
              <X className="size-5" />
            </span>
          </div>

          {view === "form" ? (
            <div className="flex flex-1 flex-col gap-3 overflow-hidden bg-[var(--w-panel)] p-4">
              <p className="text-[13px] text-[var(--w-muted)]">{sms ? "Share your details. We'll also reply by text message." : "Tell us a little about you so we can help."}</p>
              {fields.length === 0 && <p className="text-xs italic text-[var(--w-muted)]">No details are required: visitors go straight to the chat.</p>}
              {fields.map((f) => (
                <div key={f} className="flex flex-col gap-1">
                  <span className="text-[13px] font-medium">{REQUIRED_LABEL[f]}</span>
                  <div className="h-9 rounded-[calc(var(--w-r)*0.6)] border border-[var(--w-line)] bg-[var(--w-surface)]" />
                </div>
              ))}
              <div className="mt-1 grid h-10 place-items-center rounded-[calc(var(--w-r)*0.6)] bg-[var(--w-bg)] text-sm font-semibold text-[var(--w-fg)]">Start chat</div>
            </div>
          ) : (
            <>
              <div className="flex flex-1 flex-col gap-1.5 overflow-hidden bg-[var(--w-surface)] p-3">
                <p className="max-w-[82%] self-start whitespace-pre-wrap rounded-[calc(var(--w-r)*0.9)] rounded-bl-[4px] border border-[var(--w-botline)] bg-[var(--w-bot)] px-3 py-2 text-[13px] leading-snug">
                  <span className="block text-[11px] font-semibold text-[var(--w-muted)]">Chatbot</span>
                  {away ? s.away_message : s.welcome_message}
                </p>
                <p className="max-w-[82%] self-end rounded-[calc(var(--w-r)*0.9)] rounded-br-[4px] bg-[var(--w-bg)] px-3 py-2 text-[13px] leading-snug text-[var(--w-fg)]">
                  Hi! Do you ship internationally?
                  <span className="mt-0.5 block text-right text-[10px] opacity-85">Read</span>
                </p>
                <p className="max-w-[82%] self-start rounded-[calc(var(--w-r)*0.9)] rounded-bl-[4px] border border-[var(--w-line)] bg-[var(--w-in)] px-3 py-2 text-[13px] leading-snug">
                  <span className="block text-[11px] font-semibold text-[var(--w-muted)]">Olivia</span>
                  Yes, to most countries. Where are you?
                </p>
              </div>
              <div className="flex items-end gap-2 border-t border-[var(--w-line)] bg-[var(--w-panel)] p-2.5">
                <div className="flex min-h-10 flex-1 items-center rounded-[calc(var(--w-r)*0.75)] border border-[var(--w-line)] bg-[var(--w-surface)] px-3 text-[13px] text-[var(--w-muted)]">{sms ? "Reply by text message…" : "Type your message…"}</div>
                <span className="grid size-10 shrink-0 place-items-center rounded-[calc(var(--w-r)*0.75)] bg-[var(--w-bg)] text-[var(--w-fg)]" aria-hidden="true">
                  <Send className="size-[18px]" />
                </span>
              </div>
            </>
          )}
        </div>
      )}

      <div
        aria-hidden="true"
        data-testid="preview-launcher"
        data-style={launcherStyle}
        className={cn(
          "absolute flex h-14 items-center justify-center gap-2.5 bg-[var(--w-bg)] text-[15px] font-semibold text-[var(--w-fg)] shadow-lg",
          launcherStyle === "bubble" && "w-14 rounded-full",
          launcherStyle === "pill" && "rounded-full pl-4 pr-5",
          launcherStyle === "icon" && "!size-[52px] !rounded-[min(var(--w-r),18px)]",
          mobile && view !== "closed" && "hidden",
        )}
        style={{ bottom: spacing, [side]: spacing }}
      >
        <MessageSquare className="size-6" />
        {launcherStyle === "pill" && <span className="whitespace-nowrap">{s.launcher_label || "Chat with us"}</span>}
      </div>
    </div>
  );
}
