import { ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PasswordInput } from "../pages/AuthCard";
import "./admin.css";
import { Button, ErrorNotice, Field, Input } from "../ui";
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
    <main className="admin-dark relative grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 shadow-lg">
        <span className="mb-5 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="size-[18px]" aria-hidden="true" />
          </span>
          Platform console
        </span>
        <h1 className="text-xl font-semibold tracking-tight">{step ? (step.mode === "enrol" ? "Set up your authenticator" : "Enter your code") : "Operator sign-in"}</h1>
        <p className="mb-6 mt-1.5 text-sm text-muted-foreground">{step ? (step.mode === "enrol" ? "Two-factor authentication is required for every operator." : "From your authenticator app.") : "Restricted. Every action is recorded."}</p>
        <form className="space-y-4" onSubmit={(e) => void submit(e)}>
          {!step && (
            <>
              <Field label="Email">
                <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password">
                <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </>
          )}
          {step?.mode === "enrol" && step.secret && (
            <p className="text-sm text-muted-foreground">
              Add this key to an authenticator app (manual entry, time-based):{" "}
              <code data-testid="totp-secret" className="mt-2 block break-all rounded-md bg-surface-2 px-3 py-2 font-mono text-[13px] tracking-wider text-foreground">
                {step.secret}
              </code>
            </p>
          )}
          {step && (
            <Field label="6-digit code">
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} data-autofocus autoFocus required className="text-center font-mono text-lg tracking-[0.4em]" />
            </Field>
          )}
          {error ? <ErrorNotice error={error} /> : null}
          <Button type="submit" size="lg" className="w-full" loading={busy}>
            {busy ? "Working…" : step ? "Verify" : "Continue"}
          </Button>
        </form>
      </div>
    </main>
  );
}
