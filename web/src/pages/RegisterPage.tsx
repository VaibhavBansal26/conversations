import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { fieldErrors } from "../lib/apiError";
import { Button, ErrorNotice, Field, Input } from "../ui";
import { AuthCard, PasswordInput, authLink } from "./AuthCard";

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
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <Field label="Your name" error={errors.name}>
          <Input autoComplete="name" value={form.name} onChange={set("name")} required data-autofocus autoFocus />
        </Field>
        <Field label="Workspace name" error={errors.workspace_name}>
          <Input value={form.workspace_name} onChange={set("workspace_name")} required />
        </Field>
        <Field label="Work email" error={errors.email}>
          <Input type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
        </Field>
        <Field label="Password" hint="At least 8 characters." error={errors.password}>
          <PasswordInput autoComplete="new-password" minLength={8} value={form.password} onChange={set("password")} required />
        </Field>
        {error !== null && <ErrorNotice error={error} />}
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!form.name || !form.workspace_name || !form.email || form.password.length < 8}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/login" className={authLink}>
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
