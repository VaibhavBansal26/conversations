import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import { ErrorNotice } from "../ui";
import { Field } from "../ui";
import { AuthCard } from "./AuthCard";

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
        <p role="status">If an account exists for {email}, a reset link is on its way.</p>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <Field label="Email">
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-autofocus />
          </Field>
          {error !== null && <ErrorNotice error={error} />}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email}>
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
      <p className="auth-alt">
        <Link to="/login">Back to sign in</Link>
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
      <form onSubmit={(e) => void submit(e)}>
        <Field label="New password" hint="At least 8 characters.">
          <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required data-autofocus />
        </Field>
        {error !== null && <ErrorNotice error={error} />}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || password.length < 8}>
          {busy ? "Saving…" : "Set password"}
        </button>
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
      <form onSubmit={(e) => void submit(e)}>
        <Field label="Your name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" data-autofocus />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error !== null && <ErrorNotice error={error} />}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || password.length < 8}>
          {busy ? "Joining…" : "Accept invitation"}
        </button>
      </form>
    </AuthCard>
  );
}
