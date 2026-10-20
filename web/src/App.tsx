import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router";
import { RedirectIfAuthed, RequireAuth } from "./auth/RequireAuth";
import { AppLayout } from "./components/AppLayout";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { AcceptInvitationPage, ForgotPasswordPage, ResetPasswordPage } from "./pages/PasswordPages";
import { RegisterPage } from "./pages/RegisterPage";
import { ImpersonatePage } from "./pages/ImpersonatePage";
import { SettingsLayout } from "./pages/settings/SettingsLayout";

const AdminApp = lazy(() => import("./admin/AdminApp"));
const AiSettings = lazy(() => import("./pages/settings/AiSettings").then((m) => ({ default: m.AiSettings })));
const ChannelSettings = lazy(() => import("./pages/settings/ChannelSettings").then((m) => ({ default: m.ChannelSettings })));
const GeneralSettings = lazy(() => import("./pages/settings/GeneralSettings").then((m) => ({ default: m.GeneralSettings })));
const InboxSettings = lazy(() => import("./pages/settings/InboxSettings").then((m) => ({ default: m.InboxSettings })));
const ContactSettings = lazy(() => import("./pages/settings/ContactSettings").then((m) => ({ default: m.ContactSettings })));
const KnowledgeBaseSettings = lazy(() => import("./pages/settings/KnowledgeBaseSettings").then((m) => ({ default: m.KnowledgeBaseSettings })));
const MemberSettings = lazy(() => import("./pages/settings/MemberSettings").then((m) => ({ default: m.MemberSettings })));
const NotificationSettings = lazy(() => import("./pages/settings/NotificationSettings").then((m) => ({ default: m.NotificationSettings })));
const TemplateSettings = lazy(() => import("./pages/settings/TemplateSettings").then((m) => ({ default: m.TemplateSettings })));
const TokenSettings = lazy(() => import("./pages/settings/TokenSettings").then((m) => ({ default: m.TokenSettings })));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const SecuritySettings = lazy(() => import("./pages/settings/SecuritySettings").then((m) => ({ default: m.SecuritySettings })));
const BillingSettings = lazy(() => import("./pages/settings/BillingSettings").then((m) => ({ default: m.BillingSettings })));
const RoleSettings = lazy(() => import("./pages/settings/RoleSettings").then((m) => ({ default: m.RoleSettings })));
const WidgetSettings = lazy(() => import("./pages/settings/WidgetSettings").then((m) => ({ default: m.WidgetSettings })));

export function App() {
  return (
    <Routes>
      <Route path="/admin/*" element={<Suspense fallback={null}><AdminApp /></Suspense>} />
      <Route path="/impersonate" element={<ImpersonatePage />} />
      <Route element={<RedirectIfAuthed />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/:roomId" element={<InboxPage />} />
          <Route path="/analytics" element={<Suspense fallback={null}><AnalyticsPage /></Suspense>} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="general" element={<GeneralSettings />} />
            <Route path="widget" element={<WidgetSettings />} />
            <Route path="inboxes" element={<InboxSettings />} />
            <Route path="members" element={<MemberSettings />} />
            <Route path="tokens" element={<TokenSettings />} />
            <Route path="channels" element={<ChannelSettings />} />
            <Route path="templates" element={<TemplateSettings />} />
            <Route path="contacts" element={<ContactSettings />} />
            <Route path="knowledge-base" element={<KnowledgeBaseSettings />} />
            <Route path="ai" element={<AiSettings />} />
            <Route path="security" element={<SecuritySettings />} />
            <Route path="roles" element={<RoleSettings />} />
            <Route path="billing" element={<BillingSettings />} />
            <Route path="notifications" element={<NotificationSettings />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
  );
}
