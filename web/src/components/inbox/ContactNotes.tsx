import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import { useContactNotes } from "../../api/hooks";
import { formatDateTime } from "../../lib/time";
import { keys } from "../../state/keys";
import { Trash2 } from "lucide-react";
import { Button, ErrorNotice, Skeleton, Textarea } from "../../ui";

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
    <section aria-label="Contact notes" className="space-y-3">
      {notes.isPending && <Skeleton className="h-12" />}
      {notes.isError && <ErrorNotice error={notes.error} onRetry={() => void notes.refetch()} compact />}
      <ul className="space-y-2">
        {notes.data?.map((n) => (
          <li key={n.id} className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2">
            <p className="whitespace-pre-wrap text-[13px]">{n.body}</p>
            <div className="mt-1 flex items-center justify-between text-xs text-subtle">
              <time dateTime={n.created_at}>{formatDateTime(n.created_at)}</time>
              <button type="button" className="grid size-6 place-items-center rounded hover:bg-black/5" aria-label="Delete note" onClick={() => remove.mutate(n.id)}>
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
        {notes.data?.length === 0 && <li className="text-[13px] text-subtle">No notes yet.</li>}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) add.mutate();
        }}
      >
        <label className="sr-only" htmlFor="new-contact-note">
          New note
        </label>
        <Textarea id="new-contact-note" rows={2} value={body} placeholder="Add a note about this contact" onChange={(e) => setBody(e.target.value)} />
        {(add.isError || remove.isError) && <ErrorNotice error={add.error ?? remove.error} compact />}
        <Button type="submit" variant="outline" size="sm" disabled={!body.trim()} loading={add.isPending}>
          Add note
        </Button>
      </form>
    </section>
  );
}
