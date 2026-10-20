import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { setToken } from "../api/client";

/** Landing page for the platform console's read-only support view: takes the token from the URL fragment, removes it from the address bar, signs in. */
export function ImpersonatePage() {
  const [done, setDone] = useState<"pending" | "ok" | "bad">("pending");
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
    window.history.replaceState(null, "", window.location.pathname);
    if (!t) return setDone("bad");
    setToken(t, null); // no refresh token: the support session simply ends after 15 minutes
    // a full load so the auth provider starts from the new token
    window.location.replace("/inbox");
    setDone("ok");
  }, []);
  if (done === "bad") return <Navigate to="/login" replace />;
  return <p role="status" className="muted">Opening support view…</p>;
}
