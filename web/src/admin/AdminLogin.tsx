import { useState, type FormEvent } from "react";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { Field } from "../components/ui/Field";
import { useAdmin } from "./AdminContext";

/** Password, then an authenticator code, always. First sign-in enrols the authenticator (nothing else is reachable before that). */
export function AdminLogin() {
  const { login, startEnrol, finish } = useAdmin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<{ token: string; mode: "verify" | "enrol"; secret?: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!step) {
        const r = await login(email.trim(), password);
        const enrol = r.mode === "enrol" ? await startEnrol(r.mfaToken) : undefined;
        setPassword("");
        setStep({ token: r.mfaToken, mode: r.mode, secret: enrol?.secret });
      } else await finish(step.mode, step.token, code.trim());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <span className="brand">Platform console</span>
        <h1>{step ? (step.mode === "enrol" ? "Set up your authenticator" : "Enter your code") : "Operator sign-in"}</h1>
        <p className="muted">{step ? (step.mode === "enrol" ? "Two-factor authentication is required for every operator." : "From your authenticator app.") : "Restricted. Every action is recorded."}</p>
        <form className="stack" onSubmit={(e) => void submit(e)}>
          {!step && (
            <>
              <Field label="Email">
                <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password">
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </>
          )}
          {step?.mode === "enrol" && step.secret && (
            <p>
              Add this key to an authenticator app (manual entry, time-based): <code data-testid="totp-secret">{step.secret}</code>
            </p>
          )}
          {step && (
            <Field label="6-digit code">
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} data-autofocus required />
            </Field>
          )}
          {error ? <ErrorNotice error={error} /> : null}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Working…" : step ? "Verify" : "Continue"}
          </button>
        </form>
      </div>
    </main>
  );
}
