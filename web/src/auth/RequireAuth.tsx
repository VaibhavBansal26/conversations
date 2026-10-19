import { Navigate, Outlet, useLocation } from "react-router";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { LoadingBlock } from "../components/ui/Spinner";
import { useAuth } from "./AuthContext";

export function RequireAuth() {
  const { status, error, retry } = useAuth();
  const location = useLocation();
  if (status === "loading") return <LoadingBlock label="Signing you in" />;
  if (status === "error") {
    return (
      <div className="center-screen">
        <ErrorNotice error={error} onRetry={retry} />
      </div>
    );
  }
  if (status === "anon") return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

export function RedirectIfAuthed() {
  const { status } = useAuth();
  if (status === "authed") return <Navigate to="/inbox" replace />;
  if (status === "loading") return <LoadingBlock label="Loading" />;
  return <Outlet />;
}
