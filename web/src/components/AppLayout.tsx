import { Lock, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router";
import { useCounts } from "../api/hooks";
import { useAuth, useSession } from "../auth/AuthContext";
import { documentTitle } from "../lib/unread";
import { useShortcuts } from "../lib/useShortcuts";
import { CallProvider } from "../calls/CallProvider";
import { TeamCallProvider } from "../calls/TeamCallProvider";
import { GroupCallProvider } from "../calls/GroupCallProvider";
import { SocketProvider } from "../realtime/SocketProvider";
import { BottomNav, NavRail } from "./layout/AppNav";
import { ReconnectBanner } from "./layout/ReconnectBanner";
import { ShortcutsHelp } from "./layout/ShortcutsHelp";
import { CommandPaletteProvider, useCommandPalette } from "./palette/CommandPaletteProvider";

/** The token's own `imp` claim says this is a platform support view: read-only, ends by itself. */
export const isSupportToken = (token: string | null): boolean => {
  try {
    const payload = JSON.parse(atob((token ?? "").split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { imp?: string };
    return typeof payload.imp === "string";
  } catch {
    return false;
  }
};

const bannerClass = "flex items-center justify-center gap-2 border-b border-warning-border bg-warning-soft px-4 py-1.5 text-center text-[13px] text-warning-text";

function SupportBanner() {
  const { token } = useAuth();
  if (!isSupportToken(token)) return null;
  return (
    <div className={bannerClass} role="status">
      <Lock className="size-3.5" aria-hidden="true" />
      Support access: read-only view, ends automatically after 15 minutes.
    </div>
  );
}

/** Every member is told when billing is overdue (the workspace is about to be, or is, soft-locked); only billing admins can fix it. */
function BillingBanner() {
  const { workspace } = useSession();
  if (workspace.billing_access !== "grace" && workspace.billing_access !== "locked") return null;
  return (
    <div className={bannerClass} role="status">
      <TriangleAlert className="size-3.5" aria-hidden="true" />
      {workspace.billing_access === "locked" ? "Billing is overdue: SMS and email sending is paused." : "A payment failed. Please update the payment method soon."}
      <Link to="/settings/billing" className="font-semibold underline underline-offset-2">
        Billing
      </Link>
    </div>
  );
}

function TitleSync() {
  const unread = useCounts().data?.unread_rooms ?? 0;
  useEffect(() => {
    document.title = documentTitle(unread);
  }, [unread]);
  return null;
}

function Shell() {
  const [help, setHelp] = useState(false);
  const palette = useCommandPalette();
  const openHelp = () => setHelp(true);
  useEffect(() => palette.setGlobals({ help: openHelp }), [palette]);
  useShortcuts({ help: openHelp });
  return (
    <div className="flex h-dvh flex-col bg-background">
      <a className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[90] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground" href="#main">
        Skip to content
      </a>
      <ReconnectBanner />
      <BillingBanner />
      <SupportBanner />
      <TitleSync />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <NavRail onHelp={openHelp} />
        <div id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 focus:outline-none">
          <Outlet />
        </div>
        <BottomNav onHelp={openHelp} />
      </div>
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
    </div>
  );
}

/** Everything behind login: realtime connection, offline banner, navigation, command palette, unread count in the tab title. */
export function AppLayout() {
  return (
    <SocketProvider>
      <CallProvider>
        <TeamCallProvider>
          <GroupCallProvider>
            <CommandPaletteProvider>
              <Shell />
            </CommandPaletteProvider>
          </GroupCallProvider>
        </TeamCallProvider>
      </CallProvider>
    </SocketProvider>
  );
}
