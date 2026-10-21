import { PlugZap } from "lucide-react";
import type { ChannelStatus } from "../../api/types";
import { cn } from "../../ui";
import { SettingsLink } from "./SettingsLink";

/**
 * "SMS is not connected. Messages are saved but not sent. Connect Twilio in Settings > Channels."
 * Shown above the composer on the SMS/email tab and at the top of Settings > Channels while the channel runs in test mode.
 */
export function ChannelBanner({ status, className, compact }: { status: ChannelStatus; className?: string; compact?: boolean }) {
  if (status.mode === "live") return null;
  if (status.mode === "attention") {
    return (
      <div role="status" data-testid={`channel-banner-${status.channel}`} className={cn("flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-text", className)}>
        <PlugZap className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0">
          {status.summary}{" "}
          <SettingsLink to="/settings/channels" className="font-medium underline underline-offset-2">
            Fix it in Settings &gt; Channels
          </SettingsLink>
        </p>
      </div>
    );
  }
  const provider = status.channel === "sms" ? "Twilio" : "SendGrid";
  const label = status.channel === "sms" ? "SMS" : "Email";
  return (
    <div
      role="status"
      data-testid={`channel-banner-${status.channel}`}
      className={cn("flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[13px] text-warning-text", className)}
    >
      <PlugZap className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0">
        <strong className="font-semibold">{label} is not connected.</strong> Messages are saved but not sent.{" "}
        {compact ? null : (
          <>
            Connect {provider} in{" "}
          </>
        )}
        <SettingsLink to="/settings/channels" className="font-medium underline underline-offset-2">
          {compact ? `Connect ${provider}` : "Settings > Channels"}
        </SettingsLink>
        {compact ? null : "."}
      </p>
    </div>
  );
}
