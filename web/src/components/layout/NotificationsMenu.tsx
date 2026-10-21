import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { useNotifications } from "../../api/hooks";
import type { NotificationItem } from "../../api/types";
import { formatRelative } from "../../lib/time";
import { formatBadge } from "../../lib/unread";
import { onNotificationRead } from "../../state/events";
import { Button, cn, EmptyState, ErrorNotice, Popover, Skeleton } from "../../ui";

export function NotificationsMenu({ className, side = "right" }: { className?: string; side?: "right" | "up" }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useNotifications();
  const unread = q.data?.unread_count ?? 0;

  const markRead = useMutation({
    mutationFn: (id: string) => api.post<{ unread_count: number }>(`/notifications/${id}/read`),
    onSuccess: (r, id) => onNotificationRead(qc, { id, unread_count: r.unread_count }),
  });
  const markAll = useMutation({
    mutationFn: () => api.post<{ unread_count: number }>("/notifications/read-all"),
    onSuccess: (r) => onNotificationRead(qc, { all: true, unread_count: r.unread_count }),
  });

  const open = (n: NotificationItem, close: () => void) => {
    if (!n.read_at) markRead.mutate(n.id);
    close();
    if (n.channel_id) navigate(`/team/${n.channel_id}`);
    else if (n.room_id) navigate(`/inbox/${n.room_id}`);
  };

  return (
    <Popover
      label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      align={side === "right" ? "start" : "end"}
      triggerClassName={cn("relative grid size-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground", className)}
      panelClassName="w-[min(22rem,calc(100vw-1rem))] p-0"
      trigger={
        <>
          <Bell className="size-5" aria-hidden="true" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold leading-4 text-danger-foreground" aria-hidden="true">
              {formatBadge(unread)}
            </span>
          )}
        </>
      }
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h3 className="text-sm font-semibold">Notifications</h3>
            <Button variant="ghost" size="sm" disabled={!unread || markAll.isPending} onClick={() => markAll.mutate()}>
              Mark all read
            </Button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {q.isPending && (
              <div className="space-y-3 p-4">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            )}
            {q.isError && (
              <div className="p-3">
                <ErrorNotice error={q.error} onRetry={() => void q.refetch()} compact />
              </div>
            )}
            {q.data?.data.length === 0 && <EmptyState icon={BellOff} title="You're all caught up" hint="Mentions and assignments will show up here." className="py-8" />}
            <ul>
              {q.data?.data.map((n) => (
                <li key={n.id} className="border-b border-border last:border-0">
                  <button type="button" onClick={() => open(n, close)} className={cn("flex w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-surface-2", !n.read_at && "bg-primary-soft/50")}>
                    <span className="flex items-start gap-2">
                      {!n.read_at && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                      <strong className="text-[13px] font-semibold">{n.title}</strong>
                    </span>
                    <span className="line-clamp-2 text-[13px] text-muted-foreground">{n.body}</span>
                    <time dateTime={n.created_at} className="text-xs text-subtle">
                      {formatRelative(n.created_at)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Popover>
  );
}
