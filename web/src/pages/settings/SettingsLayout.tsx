// Adapted from the legacy UI (see docs/PROVENANCE.md): grouped settings navigation.
import { Bell, Bot, Building2, ChevronLeft, ChevronRight, CreditCard, FileUp, Inbox, KeyRound, LayoutTemplate, Library, MessageSquareText, Phone, Sparkles, Settings2, ShieldCheck, Ticket, UserCog, Users, type LucideIcon } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useIsManager } from "../../auth/AuthContext";
import { cn, LoadingBlock } from "../../ui";

export interface SettingsPageDef {
  path: string;
  label: string;
  managerOnly: boolean;
  group: string;
  icon: LucideIcon;
  /** wide pages (the widget customiser) use the full width for a side-by-side preview */
  wide?: boolean;
}

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  { path: "general", label: "General", managerOnly: true, group: "General", icon: Settings2 },
  { path: "notifications", label: "Notifications & availability", managerOnly: false, group: "General", icon: Bell },
  { path: "inboxes", label: "Inboxes", managerOnly: true, group: "Channels & inboxes", icon: Inbox },
  { path: "departments", label: "Departments & routing", managerOnly: true, group: "Channels & inboxes", icon: Building2 },
  { path: "channels", label: "SMS & email", managerOnly: true, group: "Channels & inboxes", icon: Phone },
  { path: "widget", label: "Chat widget", managerOnly: true, group: "Channels & inboxes", icon: MessageSquareText, wide: true },
  { path: "tokens", label: "Embed tokens", managerOnly: true, group: "Channels & inboxes", icon: KeyRound },
  { path: "members", label: "Members & seats", managerOnly: true, group: "Team", icon: Users },
  { path: "roles", label: "Roles & invitations", managerOnly: true, group: "Team", icon: UserCog },
  { path: "tickets", label: "Tickets", managerOnly: true, group: "Automation & AI", icon: Ticket },
  { path: "templates", label: "Templates", managerOnly: true, group: "Automation & AI", icon: LayoutTemplate },
  { path: "knowledge-base", label: "Knowledge base", managerOnly: true, group: "Automation & AI", icon: Library },
  { path: "ai", label: "AI assistant", managerOnly: true, group: "Automation & AI", icon: Bot },
  { path: "ai-agents", label: "AI agents", managerOnly: true, group: "Automation & AI", icon: Sparkles },
  { path: "contacts", label: "Import contacts", managerOnly: false, group: "Automation & AI", icon: FileUp },
  { path: "billing", label: "Billing & credits", managerOnly: true, group: "Account", icon: CreditCard },
  { path: "security", label: "Account security", managerOnly: false, group: "Account", icon: ShieldCheck },
];

function useIsDesktop(): boolean {
  const query = "(min-width: 768px)";
  const [yes, setYes] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setYes(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return yes;
}

export function SettingsLayout() {
  const manager = useIsManager();
  const desktop = useIsDesktop();
  const { pathname } = useLocation();
  const pages = SETTINGS_PAGES.filter((p) => manager || !p.managerOnly);
  const current = SETTINGS_PAGES.find((p) => pathname.startsWith(`/settings/${p.path}`));
  // on a phone /settings is the list of sections; on larger screens it opens the first one
  if (!current && desktop) return <Navigate to={`/settings/${pages[0]?.path ?? "notifications"}`} replace />;
  if (current && !pages.includes(current)) return <Navigate to="/settings/notifications" replace />;

  const groups = [...new Set(pages.map((p) => p.group))];

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Settings" className={cn("w-full shrink-0 overflow-y-auto border-border bg-surface md:block md:w-64 md:border-r", current ? "hidden" : "block")}>
        <div className="flex items-center gap-2 px-4 pb-2 pt-5">
          <Link to="/inbox" className="-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground hover:bg-surface-2 hover:text-foreground">
            <ChevronLeft className="size-4" aria-hidden="true" /> Back to inbox
          </Link>
        </div>
        <h2 className="px-4 pb-3 text-xl font-semibold tracking-tight">Settings</h2>
        <div className="flex flex-col gap-5 px-2 pb-8">
          {groups.map((g) => (
            <div key={g}>
              <h3 className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-subtle">{g}</h3>
              <ul className="flex flex-col gap-0.5">
                {pages
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <li key={p.path}>
                      <NavLink
                        to={`/settings/${p.path}`}
                        className={({ isActive }) =>
                          cn(
                            "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground",
                            isActive && "bg-primary-soft text-primary-text hover:bg-primary-soft hover:text-primary-text",
                          )
                        }
                      >
                        <p.icon className="size-[17px] shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{p.label}</span>
                        <ChevronRight className="size-4 text-subtle md:hidden" aria-hidden="true" />
                      </NavLink>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <main id="main" className={cn("min-w-0 flex-1 overflow-y-auto md:block", current ? "block" : "hidden")}>
        {current && (
          <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-surface/95 px-3 py-2 backdrop-blur md:hidden">
            <Link to="/settings" className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-primary-text">
              <ChevronLeft className="size-4" aria-hidden="true" /> Settings
            </Link>
            <span className="truncate text-sm font-semibold">{current.label}</span>
          </div>
        )}
        <div className={cn("mx-auto w-full px-4 py-6 md:px-8 md:py-8", current?.wide ? "max-w-6xl" : "max-w-3xl")}>
          {current && <h1 className="sr-only">{current.label}</h1>}
          <Suspense fallback={<LoadingBlock label="Loading" />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
