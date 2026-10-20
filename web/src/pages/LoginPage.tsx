import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { Field } from "../components/ui/Field";
import { fieldErrors } from "../lib/apiError";
import { AuthCard } from "./AuthCard";

export function LoginPage() {
  const { login, completeMfa } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/inbox";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const errors = fieldErrors(error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) await completeMfa(mfaToken, code.trim());
      else {
        const challenge = await login(email.trim(), password);
        if (challenge) {
          setMfaToken(challenge.mfa_token);
          return;
        }
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" subtitle="Welcome back. Pick up where your team left off.">
      <form onSubmit={(e) => void submit(e)} noValidate>
        {mfaToken ? (
          <Field label="Authentication code" hint="From your authenticator app, or one of your recovery codes.">
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required data-autofocus />
          </Field>
        ) : (
          <>
            <Field label="Email" error={errors.email}>
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-autofocus />
            </Field>
            <Field label="Password" error={errors.password}>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </>
        )}
        {error !== null && <ErrorNotice error={error} />}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || (mfaToken ? !code : !email || !password)}>
          {busy ? "Signing in…" : mfaToken ? "Verify" : "Sign in"}
        </button>
      </form>
      <p className="auth-alt">
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="auth-alt">
        New here? <Link to="/register">Create a workspace</Link>
      </p>
    </AuthCard>
  );
}
