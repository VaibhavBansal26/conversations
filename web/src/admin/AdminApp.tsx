import { Activity, Building2, Gauge, LogOut, ScrollText, ShieldCheck, Users } from "lucide-react";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { Badge, Button, ThemeToggle, cn } from "../ui";
import { AdminProvider, useAdmin } from "./AdminContext";
import { AdminLogin } from "./AdminLogin";
import { AdminsPage, AuditPage, RateLimitPage } from "./OperatorPages";
import { WorkspaceDetailPage, WorkspacesPage } from "./WorkspacePages";

const NAV = [
  { to: "/admin", label: "Workspaces", end: true, Icon: Building2 },
  { to: "/admin/audit", label: "Audit log", end: false, Icon: ScrollText },
  { to: "/admin/ratelimit", label: "Rate limits", end: false, Icon: Gauge },
  { to: "/admin/admins", label: "Operators", end: false, Icon: Users },
];

function Shell() {
  const { admin, logout } = useAdmin();
  if (!admin) return <AdminLogin />;
  return (
    <div className="flex h-dvh flex-col bg-background md:flex-row">
      {/* the operator console is deliberately dark in both themes so it never looks like a workspace */}
      <nav aria-label="Platform console" style={{ colorScheme: "dark" }} className="flex shrink-0 flex-col gap-1 border-b border-border bg-surface p-3 text-foreground md:w-60 md:border-b-0 md:border-r md:p-4">
        <div className="flex items-center justify-between gap-2 md:mb-4 md:block">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="size-[18px]" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Platform console</h1>
              <p className="hidden text-xs text-subtle md:block">Operator access</p>
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={logout} aria-label="Sign out">
            <LogOut aria-hidden="true" />
          </Button>
        </div>
        <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.map(({ to, label, end, Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn("flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground", isActive && "bg-primary-soft text-primary-text hover:bg-primary-soft hover:text-primary-text")
                }
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="mt-auto hidden flex-col gap-2 border-t border-border pt-3 md:flex">
          <p className="truncate text-xs text-muted-foreground" title={admin.email}>
            {admin.email}
          </p>
          <div className="flex items-center justify-between">
            <Badge tone={admin.role === "superadmin" ? "primary" : "neutral"}>{admin.role}</Badge>
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut aria-hidden="true" /> Sign out
            </Button>
          </div>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Activity className="size-3.5" aria-hidden="true" /> Every action here is recorded in the audit log
          </span>
          <ThemeToggle />
        </header>
        <main className="flex-1 overflow-y-auto" id="main">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-8">
            <Routes>
              <Route index element={<WorkspacesPage />} />
              <Route path="workspaces/:id" element={<WorkspaceDetailPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="ratelimit" element={<RateLimitPage />} />
              <Route path="admins" element={<AdminsPage />} />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}

/** The operator console, mounted at /admin/*. Its own provider and token: it shares nothing with a workspace session. */
export default function AdminApp() {
  return (
    <AdminProvider>
      <Shell />
    </AdminProvider>
  );
}
