import { Navigate, Route, Routes } from "react-router";
import { RedirectIfAuthed, RequireAuth } from "./auth/RequireAuth";
import { AppLayout } from "./components/AppLayout";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { AiSettings } from "./pages/settings/AiSettings";
import { ChannelSettings } from "./pages/settings/ChannelSettings";
import { GeneralSettings } from "./pages/settings/GeneralSettings";
import { InboxSettings } from "./pages/settings/InboxSettings";
import { KnowledgeBaseSettings } from "./pages/settings/KnowledgeBaseSettings";
import { MemberSettings } from "./pages/settings/MemberSettings";
import { NotificationSettings } from "./pages/settings/NotificationSettings";
import { SettingsLayout } from "./pages/settings/SettingsLayout";
import { TemplateSettings } from "./pages/settings/TemplateSettings";
import { TokenSettings } from "./pages/settings/TokenSettings";
import { WidgetSettings } from "./pages/settings/WidgetSettings";

export function App() {
  return (
    <Routes>
      <Route element={<RedirectIfAuthed />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/:roomId" element={<InboxPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="general" element={<GeneralSettings />} />
            <Route path="widget" element={<WidgetSettings />} />
            <Route path="inboxes" element={<InboxSettings />} />
            <Route path="members" element={<MemberSettings />} />
            <Route path="tokens" element={<TokenSettings />} />
            <Route path="channels" element={<ChannelSettings />} />
            <Route path="templates" element={<TemplateSettings />} />
            <Route path="knowledge-base" element={<KnowledgeBaseSettings />} />
            <Route path="ai" element={<AiSettings />} />
            <Route path="notifications" element={<NotificationSettings />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
  );
}
