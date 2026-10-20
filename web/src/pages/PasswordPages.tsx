import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import { Button, ErrorNotice, Field, Input } from "../ui";
import { AuthCard, PasswordInput, authLink } from "./AuthCard";

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    await api.post("/auth/password/forgot", { email: email.trim() });
    setSent(true);
  });
  return (
    <AuthCard title="Reset your password" subtitle="We will email you a link that works for one hour.">
      {sent ? (
        <p role="status" className="rounded-md bg-success-soft px-3 py-2.5 text-sm text-success-text">If an account exists for {email}, a reset link is on its way.</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <Field label="Email">
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-autofocus />
          </Field>
          {error !== null && <ErrorNotice error={error} />}
          <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!email}>
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <p className="text-center text-sm">
        <Link to="/login" className={authLink}>
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await api.post("/auth/password/reset", { token: params.get("token") ?? "", password });
    navigate("/login", { replace: true });
  });
  return (
    <AuthCard title="Choose a new password" subtitle="You will be signed out everywhere else.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="New password" hint="At least 8 characters.">
          <PasswordInput autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required data-autofocus autoFocus />
        </Field>
        {error !== null && <ErrorNotice error={error} />}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={password.length < 8}>
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
    </AuthCard>
  );
}

export function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await api.post("/auth/invitations/accept", { token, name: name.trim() || undefined, password });
    navigate("/login", { replace: true });
  });
  return (
    <AuthCard title="Join your team" subtitle="Choose a name and password to accept the invitation. If you already have an account, enter your current password.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" data-autofocus />
        </Field>
        <Field label="Password">
          <PasswordInput autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error !== null && <ErrorNotice error={error} />}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={password.length < 8}>
          {busy ? "Joining…" : "Accept invitation"}
        </Button>
      </form>
    </AuthCard>
  );
}
