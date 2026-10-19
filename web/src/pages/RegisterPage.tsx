import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { Field } from "../components/ui/Field";
import { fieldErrors } from "../lib/apiError";
import { AuthCard } from "./AuthCard";

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", workspace_name: "", email: "", password: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const errors = fieldErrors(error);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({ ...form, name: form.name.trim(), workspace_name: form.workspace_name.trim(), email: form.email.trim() });
      navigate("/inbox", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Create your workspace" subtitle="One inbox for live chat, SMS and email.">
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Your name" error={errors.name}>
          <input autoComplete="name" value={form.name} onChange={set("name")} required data-autofocus />
        </Field>
        <Field label="Workspace name" error={errors.workspace_name}>
          <input value={form.workspace_name} onChange={set("workspace_name")} required />
        </Field>
        <Field label="Work email" error={errors.email}>
          <input type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
        </Field>
        <Field label="Password" hint="At least 8 characters." error={errors.password}>
          <input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set("password")} required />
        </Field>
        {error !== null && <ErrorNotice error={error} />}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !form.name || !form.workspace_name || !form.email || form.password.length < 8}>
          {busy ? "Creating…" : "Create workspace"}
        </button>
      </form>
      <p className="auth-alt">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </AuthCard>
  );
}
