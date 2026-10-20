import { useEffect } from "react";
import { Outlet } from "react-router";
import { useCounts } from "../api/hooks";
import { SocketProvider } from "../realtime/SocketProvider";
import { documentTitle } from "../lib/unread";
import { Link } from "react-router";
import { useSession } from "../auth/AuthContext";
import { Icon } from "./ui/Icon";
import { ReconnectBanner } from "./inbox/ReconnectBanner";

/** Every member is told when billing is overdue (the workspace is about to be, or is, soft-locked); only billing admins can fix it. */
function BillingBanner() {
  const { workspace } = useSession();
  if (workspace.billing_access !== "grace" && workspace.billing_access !== "locked") return null;
  return (
    <div className="banner billing" role="status">
      <Icon name="flag" size={14} />
      {workspace.billing_access === "locked" ? "Billing is overdue: SMS and email sending is paused." : "A payment failed. Please update the payment method soon."}
      <Link to="/settings/billing">Billing</Link>
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

/** Everything behind login: realtime connection, offline banner, unread count in the tab title. */
export function AppLayout() {
  return (
    <SocketProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <ReconnectBanner />
      <BillingBanner />
      <TitleSync />
      <Outlet />
    </SocketProvider>
  );
}
