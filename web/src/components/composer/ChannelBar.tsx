// Adapted from the legacy UI (see docs/PROVENANCE.md): channel switch with From address and Subject for email.
import { Lock, Mail, MessageSquare, Smartphone, type LucideIcon } from "lucide-react";
import type { Channel, EmailSender } from "../../api/types";
import { verifiedSenders } from "../../lib/composerRules";
import { Input, NativeSelect, SegmentedList, SegmentedTrigger, Tabs } from "../../ui";

const CHANNELS: { id: Channel; label: string; icon: LucideIcon }[] = [
  { id: "dm", label: "Chat", icon: MessageSquare },
  { id: "sms", label: "SMS", icon: Smartphone },
  { id: "email", label: "Email", icon: Mail },
];

interface Props {
  channel: Channel;
  onChannel: (c: Channel) => void;
  isNote: boolean;
  onNote: (on: boolean) => void;
  senders: EmailSender[];
  from: string;
  onFrom: (v: string) => void;
  subject: string;
  onSubject: (v: string) => void;
}

/** Channel tabs (Chat / SMS / Email) plus the internal-note tab, and the From/Subject row for email. */
export function ChannelBar({ channel, onChannel, isNote, onNote, senders, from, onFrom, subject, onSubject }: Props) {
  const showEmail = channel === "email" && !isNote;
  const verified = verifiedSenders(senders);
  const value = isNote ? "note" : channel;
  return (
    <div className="border-b border-border/70 px-2 pt-2">
      <Tabs
        value={value}
        onValueChange={(v) => {
          if (v === "note") onNote(true);
          else {
            onNote(false);
            onChannel(v as Channel);
          }
        }}
      >
        <SegmentedList aria-label="Reply channel" className="mb-2">
          {CHANNELS.map((c) => (
            <SegmentedTrigger key={c.id} value={c.id}>
              <c.icon className="size-3.5" aria-hidden="true" /> {c.label}
            </SegmentedTrigger>
          ))}
          <SegmentedTrigger value="note" className="data-[state=active]:bg-warning-soft data-[state=active]:text-warning-text">
            <Lock className="size-3.5" aria-hidden="true" /> Note
          </SegmentedTrigger>
        </SegmentedList>
      </Tabs>
      {showEmail && (
        <div className="mb-2 grid gap-2 sm:grid-cols-[minmax(0,19rem)_1fr]">
          <label className="flex items-center gap-2 text-xs text-subtle">
            <span className="w-12 shrink-0 sm:w-auto">From</span>
            <NativeSelect value={from} onChange={(e) => onFrom(e.target.value)} className="h-8 text-[13px]">
              {!verified.length && <option value="">No verified sender</option>}
              {verified.map((s) => (
                <option key={s.id} value={s.address}>
                  {s.display_name ? `${s.display_name} <${s.address}>` : s.address}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex items-center gap-2 text-xs text-subtle">
            <span className="w-12 shrink-0 sm:w-auto">Subject</span>
            <Input value={subject} onChange={(e) => onSubject(e.target.value)} maxLength={300} className="h-8 text-[13px]" />
          </label>
        </div>
      )}
    </div>
  );
}
