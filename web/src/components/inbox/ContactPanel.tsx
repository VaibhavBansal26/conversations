// Adapted from the legacy UI (see docs/PROVENANCE.md): contact card as an accordion (details, followers, notes, history, shared media).
import { Copy, Mail, Phone, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useContact, useContactRooms, useMembers, useThread } from "../../api/hooks";
import type { Room } from "../../api/types";
import { formatRelative } from "../../lib/time";
import { Accordion, AccordionSection, Avatar, Badge, Button, ErrorNotice, Skeleton, Tooltip, toast } from "../../ui";
import { Lightbox } from "../chat/Lightbox";
import { ContactForm } from "./ContactForm";
import { ContactNotes } from "./ContactNotes";

interface Props {
  room: Room;
  onClose: () => void;
}

function CopyLine({ icon: Icon, value, label }: { icon: typeof Mail; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <Tooltip content={`Copy ${label}`}>
        <button
          type="button"
          aria-label={`Copy ${label}`}
          className="grid size-6 place-items-center rounded text-subtle hover:bg-surface-2 hover:text-foreground"
          onClick={() => void navigator.clipboard?.writeText(value).then(() => toast({ title: `${label} copied`, tone: "success" }))}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}

export function ContactPanel({ room, onClose }: Props) {
  const contact = useContact(room.contact_id);
  const rooms = useContactRooms(room.contact_id);
  const members = useMembers().data ?? [];
  const thread = useThread(room.id);
  const [viewer, setViewer] = useState<number | null>(null);
  const followers = members.filter((m) => contact.data?.followers.includes(m.id));
  const images = useMemo(() => (thread.data?.messages ?? []).flatMap((m) => m.attachments).filter((a) => a.content_type.startsWith("image/")), [thread.data]);
  const files = useMemo(() => (thread.data?.messages ?? []).flatMap((m) => m.attachments).filter((a) => !a.content_type.startsWith("image/") && !a.content_type.startsWith("audio/")), [thread.data]);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Contact">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-[15px] font-semibold">Contact</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close contact details" onClick={onClose}>
          <X />
        </Button>
      </header>
      {contact.isPending && (
        <div className="space-y-3 p-4" role="status" aria-label="Loading contact">
          <Skeleton className="mx-auto size-16 rounded-full" />
          <Skeleton className="mx-auto h-4 w-32" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      )}
      {contact.isError && (
        <div className="p-4">
          <ErrorNotice error={contact.error} onRetry={() => void contact.refetch()} />
        </div>
      )}
      {contact.data && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col items-center gap-1.5 border-b border-border px-4 pb-4 pt-5 text-center">
            <Avatar name={contact.data.name || "?"} seed={contact.data.id} size="xl" />
            <strong className="mt-1 text-base font-semibold">{contact.data.name || "Unnamed contact"}</strong>
            <div className="w-full max-w-60 space-y-1">
              {contact.data.email && <CopyLine icon={Mail} value={contact.data.email} label="email" />}
              {contact.data.phone && <CopyLine icon={Phone} value={contact.data.phone} label="phone" />}
            </div>
            <div className="mt-1 flex flex-wrap justify-center gap-1.5">
              {contact.data.sms_opt_out && (
                <Badge tone="warning" role="status">
                  SMS opted out
                </Badge>
              )}
              {contact.data.tags.slice(0, 4).map((t) => (
                <Badge key={t} tone="primary">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
          <Accordion type="multiple" defaultValue={["details", "notes"]}>
            <AccordionSection value="details" title="Details">
              <ContactForm key={`${contact.data.id}-${contact.data.updated_at}`} contact={contact.data} />
            </AccordionSection>
            <AccordionSection value="followers" title="Followers" badge={followers.length ? <Badge>{followers.length}</Badge> : undefined}>
              {followers.length ? (
                <ul className="space-y-2">
                  {followers.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 text-sm">
                      <Avatar name={m.name} size="sm" /> {m.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-subtle">Nobody follows this contact.</p>
              )}
            </AccordionSection>
            <AccordionSection value="notes" title="Notes">
              <ContactNotes contactId={contact.data.id} />
            </AccordionSection>
            <AccordionSection value="media" title="Shared media" badge={images.length + files.length ? <Badge>{images.length + files.length}</Badge> : undefined}>
              {images.length + files.length === 0 && <p className="text-[13px] text-subtle">Images and files from this conversation appear here.</p>}
              {images.length > 0 && (
                <ul className="grid grid-cols-3 gap-1.5">
                  {images.slice(0, 9).map((a, i) => (
                    <li key={a.id}>
                      <button type="button" aria-label={`Open ${a.file_name}`} onClick={() => setViewer(i)} className="block aspect-square w-full overflow-hidden rounded-md bg-surface-3">
                        <img src={a.url} alt="" loading="lazy" className="size-full object-cover" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((a) => (
                    <li key={a.id}>
                      <a href={a.url} download={a.file_name} className="block truncate rounded-md px-2 py-1 text-[13px] text-primary-text hover:bg-surface-2">
                        {a.file_name}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </AccordionSection>
            <AccordionSection value="history" title="Conversations" badge={rooms.data?.length ? <Badge>{rooms.data.length}</Badge> : undefined} className="border-b-0">
              {rooms.isPending && <Skeleton className="h-10" />}
              <ul className="-mx-1 space-y-0.5">
                {rooms.data?.map((r) => (
                  <li key={r.id}>
                    <Link to={`/inbox/${r.id}`} aria-current={r.id === room.id ? "true" : undefined} className="flex flex-col rounded-md px-2 py-1.5 hover:bg-surface-2 aria-[current=true]:bg-primary-soft">
                      <span className="truncate text-[13px] font-medium">{r.last_message?.snippet || r.subject || "Conversation"}</span>
                      <small className="text-xs text-subtle">
                        {r.status} · {formatRelative(r.last_message_at)}
                      </small>
                    </Link>
                  </li>
                ))}
              </ul>
            </AccordionSection>
          </Accordion>
        </div>
      )}
      {viewer !== null && <Lightbox images={images} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
