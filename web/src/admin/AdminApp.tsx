import { NavLink, Navigate, Route, Routes } from "react-router";
import { AdminProvider, useAdmin } from "./AdminContext";
import { AdminLogin } from "./AdminLogin";
import { AdminsPage, AuditPage, RateLimitPage } from "./OperatorPages";
import { WorkspaceDetailPage, WorkspacesPage } from "./WorkspacePages";

function Shell() {
  const { admin, logout } = useAdmin();
  if (!admin) return <AdminLogin />;
  return (
    <div className="settings-shell admin-shell">
      <nav className="settings-nav" aria-label="Platform console">
        <h1>Platform</h1>
        <p className="muted">
          {admin.email} ({admin.role})
        </p>
        <ul>
          {[
            ["/admin", "Workspaces", true],
            ["/admin/audit", "Audit log", false],
            ["/admin/ratelimit", "Rate limits", false],
            ["/admin/admins", "Operators", false],
          ].map(([to, label, end]) => (
            <li key={String(to)}>
              <NavLink to={String(to)} end={Boolean(end)} className={({ isActive }) => `nav-item${isActive ? " current" : ""}`}>
                {String(label)}
              </NavLink>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-ghost" onClick={logout}>
          Sign out
        </button>
      </nav>
      <main className="settings-main" id="main">
        <Routes>
          <Route index element={<WorkspacesPage />} />
          <Route path="workspaces/:id" element={<WorkspaceDetailPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="ratelimit" element={<RateLimitPage />} />
          <Route path="admins" element={<AdminsPage />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
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
