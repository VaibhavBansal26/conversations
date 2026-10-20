import type { Channel, EmailSender } from "../../api/types";
import { verifiedSenders } from "../../lib/composerRules";
import { Icon, type IconName } from "../../ui";

const CHANNELS: { id: Channel; label: string; icon: IconName }[] = [
  { id: "dm", label: "Chat", icon: "chat" },
  { id: "sms", label: "SMS", icon: "sms" },
  { id: "email", label: "Email", icon: "mail" },
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

export function ChannelBar({ channel, onChannel, isNote, onNote, senders, from, onFrom, subject, onSubject }: Props) {
  const showEmail = channel === "email" && !isNote;
  const verified = verifiedSenders(senders);
  return (
    <div className="channel-bar">
      <div className="segmented" role="radiogroup" aria-label="Reply channel">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={!isNote && channel === c.id}
            className={!isNote && channel === c.id ? "active" : ""}
            disabled={isNote}
            onClick={() => onChannel(c.id)}
          >
            <Icon name={c.icon} size={14} /> {c.label}
          </button>
        ))}
      </div>
      <button type="button" className={`note-toggle${isNote ? " on" : ""}`} aria-pressed={isNote} onClick={() => onNote(!isNote)}>
        <Icon name="lock" size={14} /> Internal note
      </button>
      {showEmail && (
        <div className="email-fields">
          <label>
            <span>From</span>
            <select value={from} onChange={(e) => onFrom(e.target.value)}>
              {!verified.length && <option value="">No verified sender</option>}
              {verified.map((s) => (
                <option key={s.id} value={s.address}>
                  {s.display_name ? `${s.display_name} <${s.address}>` : s.address}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            <span>Subject</span>
            <input value={subject} onChange={(e) => onSubject(e.target.value)} maxLength={300} />
          </label>
        </div>
      )}
    </div>
  );
}
