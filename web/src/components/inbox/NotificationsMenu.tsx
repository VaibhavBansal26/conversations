import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { useNotifications } from "../../api/hooks";
import type { NotificationItem } from "../../api/types";
import { formatRelative } from "../../lib/time";
import { formatBadge } from "../../lib/unread";
import { onNotificationRead } from "../../state/events";
import { EmptyState } from "../ui/EmptyState";
import { ErrorNotice } from "../ui/ErrorNotice";
import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";
import { LoadingBlock } from "../ui/Spinner";

export function NotificationsMenu() {
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
    if (n.room_id) navigate(`/inbox/${n.room_id}`);
  };

  return (
    <Popover
      label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      triggerClassName="icon-btn bell"
      align="start"
      panelClassName="notif-panel"
      trigger={
        <>
          <Icon name="bell" />
          {unread > 0 && <span className="badge floating">{formatBadge(unread)}</span>}
        </>
      }
    >
      {(close) => (
        <div>
          <div className="panel-head">
            <h3>Notifications</h3>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!unread || markAll.isPending} onClick={() => markAll.mutate()}>
              Mark all read
            </button>
          </div>
          {q.isPending && <LoadingBlock label="Loading notifications" />}
          {q.isError && <ErrorNotice error={q.error} onRetry={() => void q.refetch()} compact />}
          {q.data?.data.length === 0 && <EmptyState title="You're all caught up" />}
          <ul className="notif-list">
            {q.data?.data.map((n) => (
              <li key={n.id}>
                <button type="button" className={`notif${n.read_at ? "" : " unread"}`} onClick={() => open(n, close)}>
                  <strong>{n.title}</strong>
                  <span>{n.body}</span>
                  <time dateTime={n.created_at}>{formatRelative(n.created_at)}</time>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}
