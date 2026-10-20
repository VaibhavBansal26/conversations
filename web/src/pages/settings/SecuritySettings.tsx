import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../components/ui/ErrorNotice";
import { Field } from "../../components/ui/Field";

interface SessionRow {
  id: string;
  created_at: string;
  last_used_at: string;
  user_agent: string | null;
  current: boolean;
}

export function SecuritySettings() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["auth-sessions"], queryFn: () => api.get<{ data: SessionRow[] }>("/auth/sessions") });
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setNote("");
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <SettingsSection title="Password" description="Changing your password signs you out of every other device.">
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(async () => {
              await api.post("/auth/password/change", { current_password: cur, new_password: next });
              setCur("");
              setNext("");
              setNote("Password changed. Other devices were signed out.");
              void qc.invalidateQueries({ queryKey: ["auth-sessions"] });
            });
          }}
        >
          <Field label="Current password">
            <input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
          </Field>
          <button className="btn btn-primary" type="submit" disabled={!cur || next.length < 8}>
            Change password
          </button>
        </form>
      </SettingsSection>

      <SettingsSection title="Two-factor authentication" description="Require a code from an authenticator app (TOTP) after your password.">
        {recovery ? (
          <div role="status">
            <p>
              <strong>Two-factor is on.</strong> Save these recovery codes now: each works once, and they are not shown again.
            </p>
            <pre className="code-block">{recovery.join("\n")}</pre>
          </div>
        ) : setup ? (
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                const r = await api.post<{ recovery_codes: string[] }>("/auth/mfa/enable", { code: code.trim() });
                setRecovery(r.recovery_codes);
                setSetup(null);
              });
            }}
          >
            <p>
              Add this key to your authenticator app, then enter the 6-digit code it shows.
              <br />
              <code>{setup.secret}</code>
            </p>
            <p className="hint">
              Or open <code>{setup.otpauth_url}</code> on the device that has the app.
            </p>
            <Field label="Code">
              <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
            <button className="btn btn-primary" type="submit" disabled={code.trim().length !== 6}>
              Turn on
            </button>
          </form>
        ) : (
          <button className="btn" type="button" onClick={() => void run(async () => setSetup(await api.post("/auth/mfa/setup")))}>
            Set up two-factor
          </button>
        )}
      </SettingsSection>

      <SettingsSection title="Signed-in devices" description="Sessions that can still renew themselves.">
        <ul className="plain-list">
          {sessions.data?.data.map((s) => (
            <li key={s.id}>
              <span>
                {s.user_agent ?? "Unknown device"} {s.current && <em>(this device)</em>}
              </span>
              <span className="muted"> last active {new Date(s.last_used_at).toLocaleString()}</span>
              {!s.current && (
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => void run(async () => {
                    await api.delete(`/auth/sessions/${s.id}`);
                    void qc.invalidateQueries({ queryKey: ["auth-sessions"] });
                  })}
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      </SettingsSection>
      {note && <p role="status">{note}</p>}
      {error !== null && <ErrorNotice error={error} />}
    </>
  );
}
