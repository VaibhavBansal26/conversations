import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useContactNotes } from "../../api/hooks";
import { formatDateTime } from "../../lib/time";
import { keys } from "../../state/keys";
import { ErrorNotice } from "../ui/ErrorNotice";
import { Icon } from "../ui/Icon";
import { LoadingBlock } from "../ui/Spinner";

/** Notes attached to the contact (visible to the whole team, independent of any one conversation). */
export function ContactNotes({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const notes = useContactNotes(contactId);
  const [body, setBody] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: keys.contactNotes(contactId) });
  const add = useMutation({
    mutationFn: () => api.post(`/contacts/${contactId}/notes`, { body: body.trim() }),
    onSuccess: () => {
      setBody("");
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/contacts/${contactId}/notes/${id}`), onSuccess: refresh });

  return (
    <section aria-labelledby="notes-title" className="contact-notes">
      <h3 id="notes-title">Notes</h3>
      {notes.isPending && <LoadingBlock label="Loading notes" />}
      {notes.isError && <ErrorNotice error={notes.error} onRetry={() => void notes.refetch()} compact />}
      <ul className="note-list">
        {notes.data?.map((n) => (
          <li key={n.id}>
            <p>{n.body}</p>
            <div className="note-foot">
              <time dateTime={n.created_at}>{formatDateTime(n.created_at)}</time>
              <button type="button" className="icon-btn sm" aria-label="Delete note" onClick={() => remove.mutate(n.id)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </li>
        ))}
        {notes.data?.length === 0 && <li className="muted">No notes yet.</li>}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) add.mutate();
        }}
      >
        <label className="sr-only" htmlFor="new-contact-note">
          New note
        </label>
        <textarea id="new-contact-note" rows={2} value={body} placeholder="Add a note about this contact" onChange={(e) => setBody(e.target.value)} />
        {(add.isError || remove.isError) && <ErrorNotice error={add.error ?? remove.error} compact />}
        <button type="submit" className="btn btn-outline btn-sm" disabled={!body.trim() || add.isPending}>
          Add note
        </button>
      </form>
    </section>
  );
}
