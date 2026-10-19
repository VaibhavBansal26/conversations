import type { RoomFilter, RoomSort, RoomStatusTab } from "../api/types";
import type { RoomListFilters } from "../state/keys";

const STATUSES: RoomStatusTab[] = ["open", "closed", "snoozed"];
const FILTERS: RoomFilter[] = ["assigned_to_me", "unassigned", "mentions", "priority", "favorites"];
const SORTS: RoomSort[] = ["newest", "oldest", "waiting_longest", "priority_first"];

export function parseInboxParams(p: URLSearchParams): RoomListFilters {
  const status = p.get("status") as RoomStatusTab;
  const filter = p.get("filter") as RoomFilter;
  const sort = p.get("sort") as RoomSort;
  return {
    status: STATUSES.includes(status) ? status : "open",
    filter: FILTERS.includes(filter) ? filter : undefined,
    inbox_id: p.get("inbox") || undefined,
    search: p.get("q")?.trim() || undefined,
    sort: SORTS.includes(sort) ? sort : "newest",
  };
}

/** Query string for a set of filters; defaults are omitted so URLs stay short. */
export function inboxSearch(f: RoomListFilters): string {
  const p = new URLSearchParams();
  if (f.status !== "open") p.set("status", f.status);
  if (f.filter) p.set("filter", f.filter);
  if (f.inbox_id) p.set("inbox", f.inbox_id);
  if (f.search) p.set("q", f.search);
  if (f.sort !== "newest") p.set("sort", f.sort);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const SORT_LABELS: Record<RoomSort, string> = {
  newest: "Newest",
  oldest: "Oldest",
  waiting_longest: "Waiting longest",
  priority_first: "Priority first",
};
