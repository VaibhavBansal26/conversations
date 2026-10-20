import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Laptop, LogOut, ShieldCheck, Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { CopyButton } from "../../components/settings/CopyButton";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { PasswordInput } from "../AuthCard";
import { Badge, Button, ErrorNotice, Field, Input, Skeleton, toast } from "../../ui";

interface SessionRow {
  id: string;
  created_at: string;
  last_used_at: string;
  user_agent: string | null;
  current: boolean;
}

const isPhone = (ua: string | null) => /iphone|android|mobile/i.test(ua ?? "");

export function SecuritySettings() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["auth-sessions"], queryFn: () => api.get<{ data: SessionRow[] }>("/auth/sessions") });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setNote("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const downloadCodes = () => {
    const url = URL.createObjectURL(new Blob([(recovery ?? []).join("\n") + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <SettingsSection title="Password" description="Changing your password signs you out of every other device.">
        <form
          className="flex max-w-sm flex-col gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(async () => {
              await api.post("/auth/password/change", { current_password: cur, new_password: next });
              setCur("");
              setNext("");
              setNote("Password changed. Other devices were signed out.");
              toast({ title: "Password changed", description: "Other devices were signed out.", tone: "success" });
              void qc.invalidateQueries({ queryKey: ["auth-sessions"] });
            });
          }}
        >
          <Field label="Current password">
            <PasswordInput autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <PasswordInput autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
          </Field>
          <div>
            <Button type="submit" loading={busy} disabled={!cur || next.length < 8}>
              Change password
            </Button>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title="Two-factor authentication" description="Require a code from an authenticator app (TOTP) after your password.">
        {recovery ? (
          <div role="status" className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-5 text-success" aria-hidden="true" />
              <span>
                <strong>Two-factor is on.</strong> Save these recovery codes now: each works once, and they are not shown again.
              </span>
            </p>
            <pre className="w-fit rounded-lg border border-border bg-surface-2 px-5 py-4 font-mono text-sm leading-7">{recovery.join("\n")}</pre>
            <div className="flex gap-1">
              <CopyButton text={recovery.join("\n")} label="Copy codes" />
              <Button variant="ghost" size="sm" onClick={downloadCodes}>
                <Download aria-hidden="true" /> Download
              </Button>
            </div>
          </div>
        ) : setup ? (
          <form
            className="flex max-w-md flex-col gap-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                const r = await api.post<{ recovery_codes: string[] }>("/auth/mfa/enable", { code: code.trim() });
                setRecovery(r.recovery_codes);
                setSetup(null);
              });
            }}
          >
            <p className="text-sm">
              Add this key to your authenticator app, then enter the 6-digit code it shows.
              <br />
              <code className="mt-2 inline-block break-all rounded-md bg-surface-2 px-3 py-1.5 font-mono text-[13px] tracking-wider">{setup.secret}</code>
            </p>
            <p className="text-xs text-subtle">
              Or open <code className="break-all">{setup.otpauth_url}</code> on the device that has the app.
            </p>
            <Field label="Code">
              <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required className="w-40 text-center font-mono tracking-[0.3em]" />
            </Field>
            <div>
              <Button type="submit" loading={busy} disabled={code.trim().length !== 6}>
                Turn on
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button variant="outline" onClick={() => void run(async () => setSetup(await api.post("/auth/mfa/setup")))}>
              <ShieldCheck aria-hidden="true" /> Set up two-factor
            </Button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Signed-in devices" description="Sessions that can still renew themselves.">
        {sessions.isPending && <Skeleton className="h-16" />}
        {sessions.data && (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {sessions.data.data.map((s) => {
              const Dev = isPhone(s.user_agent) ? Smartphone : Laptop;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Dev className="size-5 shrink-0 text-subtle" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{s.user_agent ?? "Unknown device"}</span> {s.current && <Badge tone="success">this device</Badge>}
                    </div>
                    <div className="text-[13px] text-muted-foreground">last active {new Date(s.last_used_at).toLocaleString()}</div>
                  </div>
                  {!s.current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void run(async () => {
                          await api.delete(`/auth/sessions/${s.id}`);
                          toast({ title: "Device signed out", tone: "success" });
                          void qc.invalidateQueries({ queryKey: ["auth-sessions"] });
                        })
                      }
                    >
                      <LogOut aria-hidden="true" /> Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>
      {note && (
        <p role="status" className="sr-only">
          {note}
        </p>
      )}
      {error !== null && <ErrorNotice error={error} />}
    </>
  );
}
