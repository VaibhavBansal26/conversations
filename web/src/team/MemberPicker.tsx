import { useId, useMemo, useState } from "react";
import { useMembers } from "../api/hooks";
import { useSession } from "../auth/AuthContext";
import { useSocket } from "../realtime/SocketProvider";
import { Avatar, Input } from "../ui";

/** Filterable checklist of teammates. `exclude` hides people who are already in. */
export function MemberPicker({ value, onChange, exclude = [], includeSelf = false, label = "People", autoFocus }: { value: string[]; onChange: (ids: string[]) => void; exclude?: string[]; includeSelf?: boolean; label?: string; autoFocus?: boolean }) {
  const { member } = useSession();
  const members = useMembers();
  const { onlineMembers } = useSocket();
  const [q, setQ] = useState("");
  const id = useId();
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (members.data ?? []).filter((m) => (includeSelf || m.id !== member.id) && !exclude.includes(m.id) && (!needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle)));
  }, [members.data, q, exclude, includeSelf, member.id]);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" data-autofocus={autoFocus || undefined} />
      <ul className="max-h-56 overflow-y-auto rounded-lg border border-border" aria-label={label}>
        {list.map((m) => (
          <li key={m.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-primary)]"
                checked={value.includes(m.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, m.id] : value.filter((x) => x !== m.id))}
              />
              <Avatar name={m.name} seed={m.id} size="sm" online={onlineMembers.has(m.id)} />
              <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
              <span className="hidden truncate text-xs text-subtle sm:block">{m.email}</span>
            </label>
          </li>
        ))}
        {!list.length && <li className="px-3 py-4 text-center text-[13px] text-subtle">{members.isPending ? "Loading…" : "No one found"}</li>}
      </ul>
    </div>
  );
}
