import { Suspense } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useIsManager } from "../../auth/AuthContext";
import { Icon } from "../../ui";

export const SETTINGS_PAGES = [
  { path: "general", label: "General", managerOnly: true },
  { path: "widget", label: "Chat widget", managerOnly: true },
  { path: "inboxes", label: "Inboxes", managerOnly: true },
  { path: "members", label: "Members & seats", managerOnly: true },
  { path: "roles", label: "Roles & invitations", managerOnly: true },
  { path: "tokens", label: "Embed tokens", managerOnly: true },
  { path: "channels", label: "Numbers & senders", managerOnly: true },
  { path: "billing", label: "Billing & credits", managerOnly: true },
  { path: "templates", label: "Templates", managerOnly: true },
  { path: "contacts", label: "Import contacts", managerOnly: false },
  { path: "knowledge-base", label: "Knowledge base", managerOnly: true },
  { path: "ai", label: "AI assistant", managerOnly: true },
  { path: "security", label: "Account security", managerOnly: false },
  { path: "notifications", label: "Notifications & availability", managerOnly: false },
] as const;

export function SettingsLayout() {
  const manager = useIsManager();
  const { pathname } = useLocation();
  const pages = SETTINGS_PAGES.filter((p) => manager || !p.managerOnly);
  const current = SETTINGS_PAGES.find((p) => pathname.startsWith(`/settings/${p.path}`));
  if (!current) return <Navigate to={`/settings/${pages[0]?.path ?? "notifications"}`} replace />;
  if (!pages.includes(current)) return <Navigate to="/settings/notifications" replace />;

  return (
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="Settings">
        <Link to="/inbox" className="back-link">
          <Icon name="left" size={16} /> Back to inbox
        </Link>
        <h1>Settings</h1>
        <ul>
          {pages.map((p) => (
            <li key={p.path}>
              <NavLink to={`/settings/${p.path}`} className={({ isActive }) => `nav-item${isActive ? " current" : ""}`}>
                {p.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="settings-main" id="main">
        <Suspense fallback={<p role="status" className="muted">Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
