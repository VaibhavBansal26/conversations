import { useEffect } from "react";
import { Outlet } from "react-router";
import { useCounts } from "../api/hooks";
import { SocketProvider } from "../realtime/SocketProvider";
import { documentTitle } from "../lib/unread";
import { ReconnectBanner } from "./inbox/ReconnectBanner";

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
      <TitleSync />
      <Outlet />
    </SocketProvider>
  );
}
