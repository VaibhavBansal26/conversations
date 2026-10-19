import { Link } from "react-router";
import { useContact, useContactRooms, useMembers } from "../../api/hooks";
import type { Room } from "../../api/types";
import { formatRelative } from "../../lib/time";
import { Avatar } from "../ui/Avatar";
import { ErrorNotice } from "../ui/ErrorNotice";
import { Icon } from "../ui/Icon";
import { LoadingBlock } from "../ui/Spinner";
import { ContactForm } from "./ContactForm";
import { ContactNotes } from "./ContactNotes";

interface Props {
  room: Room;
  onClose: () => void;
}

export function ContactPanel({ room, onClose }: Props) {
  const contact = useContact(room.contact_id);
  const rooms = useContactRooms(room.contact_id);
  const members = useMembers().data ?? [];
  const followers = members.filter((m) => contact.data?.followers.includes(m.id));

  return (
    <aside className="contact-panel" aria-label="Contact details">
      <header>
        <h2>Contact</h2>
        <button type="button" className="icon-btn" aria-label="Close contact details" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      {contact.isPending && <LoadingBlock label="Loading contact" />}
      {contact.isError && <ErrorNotice error={contact.error} onRetry={() => void contact.refetch()} />}
      {contact.data && (
        <div className="panel-scroll">
          <div className="contact-hero">
            <Avatar name={contact.data.name || "?"} seed={contact.data.id} size="lg" />
            <strong>{contact.data.name || "Unnamed contact"}</strong>
            {contact.data.sms_opt_out && (
              <span className="tag tag-warn" role="status">
                SMS opted out
              </span>
            )}
          </div>
          <ContactForm key={`${contact.data.id}-${contact.data.updated_at}`} contact={contact.data} />
          <section aria-labelledby="followers-title">
            <h3 id="followers-title">Followers</h3>
            {followers.length ? (
              <ul className="followers">
                {followers.map((m) => (
                  <li key={m.id}>
                    <Avatar name={m.name} size="sm" /> {m.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nobody follows this contact.</p>
            )}
          </section>
          <ContactNotes contactId={contact.data.id} />
          <section aria-labelledby="rooms-title">
            <h3 id="rooms-title">Conversations</h3>
            {rooms.isPending && <LoadingBlock label="Loading conversations" />}
            <ul className="contact-rooms">
              {rooms.data?.map((r) => (
                <li key={r.id}>
                  <Link to={`/inbox/${r.id}`} aria-current={r.id === room.id ? "true" : undefined}>
                    <span>{r.last_message?.snippet || r.subject || "Conversation"}</span>
                    <small>
                      {r.status} · {formatRelative(r.last_message_at)}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </aside>
  );
}
