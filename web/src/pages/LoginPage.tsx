import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { fieldErrors } from "../lib/apiError";
import { Button, ErrorNotice, Field, Input } from "../ui";
import { AuthCard, PasswordInput, authLink } from "./AuthCard";

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
    <AuthCard title={mfaToken ? "Two-step verification" : "Sign in"} subtitle={mfaToken ? "Confirm it is you to finish signing in." : "Welcome back. Pick up where your team left off."}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        {mfaToken ? (
          <Field label="Authentication code" hint="From your authenticator app, or one of your recovery codes.">
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required data-autofocus autoFocus />
          </Field>
        ) : (
          <>
            <Field label="Email" error={errors.email}>
              <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-autofocus autoFocus />
            </Field>
            <Field label="Password" error={errors.password}>
              <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </>
        )}
        {error !== null && <ErrorNotice error={error} />}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={mfaToken ? !code : !email || !password}>
          {busy ? "Signing in…" : mfaToken ? "Verify" : "Sign in"}
        </Button>
      </form>
      <div className="space-y-1.5 text-center text-sm text-muted-foreground">
        <p>
          <Link to="/forgot-password" className={authLink}>
            Forgot your password?
          </Link>
        </p>
        <p>
          New here?{" "}
          <Link to="/register" className={authLink}>
            Create a workspace
          </Link>
        </p>
      </div>
    </AuthCard>
  );
}
