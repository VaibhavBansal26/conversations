import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useCredits, useSaveWorkspace } from "../../api/settingsHooks";
import { useSession } from "../../auth/AuthContext";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../ui";
import { Field } from "../../ui";
import { Switch } from "../../ui";
import { fieldErrors } from "../../lib/apiError";
import { formatDateTime } from "../../lib/time";
import { keys } from "../../state/keys";

export function GeneralSettings() {
  const { workspace, member } = useSession();
  const s = workspace.settings;
  const save = useSaveWorkspace();
  const credits = useCredits();
  const qc = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const [region, setRegion] = useState(s.default_region);
  const [editWindow, setEditWindow] = useState(String(s.edit_window_seconds));
  const [enforced, setEnforced] = useState(s.credits_enforced);
  const [grant, setGrant] = useState("");
  const addCredits = useMutation({
    mutationFn: () => api.post("/credits/grant", { amount: Number(grant) }),
    onSuccess: () => {
      setGrant("");
      void qc.invalidateQueries({ queryKey: keys.credits });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
  const errors = fieldErrors(save.error);
  const dirty = name !== workspace.name || region !== s.default_region || Number(editWindow) !== s.edit_window_seconds || enforced !== s.credits_enforced;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: name.trim(), settings: { default_region: region.toUpperCase(), edit_window_seconds: Number(editWindow), credits_enforced: enforced } });
  };

  return (
    <>
      <SettingsSection title="General" description="Workspace identity and messaging defaults.">
        <form className="stack narrow" onSubmit={submit}>
          <Field label="Workspace name" error={errors.name}>
            <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Default region" hint="Two-letter country code used to read phone numbers without a + prefix." error={errors["settings.default_region"]}>
            <input value={region} maxLength={2} onChange={(e) => setRegion(e.target.value.toUpperCase())} pattern="[A-Za-z]{2}" required />
          </Field>
          <Field label="Edit window (seconds)" hint="How long after sending an agent can still edit a message. 0 disables editing." error={errors["settings.edit_window_seconds"]}>
            <input type="number" min={0} max={86400} value={editWindow} onChange={(e) => setEditWindow(e.target.value)} />
          </Field>
          <Switch label="Enforce credits" hint="When on, SMS and email sends are blocked once the credit balance runs out." checked={enforced} onChange={setEnforced} />
          {save.isError && <ErrorNotice error={save.error} />}
          <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} />
        </form>
      </SettingsSection>
      <SettingsSection title="Credits" description="Outbound SMS and email each use credits.">
        <p className="stat">
          <strong>{workspace.credit_balance}</strong> credits remaining
        </p>
        {member.role === "owner" && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (Number(grant) > 0) addCredits.mutate();
            }}
          >
            <label className="sr-only" htmlFor="grant">
              Credits to add
            </label>
            <input id="grant" type="number" min={1} value={grant} placeholder="Credits to add" onChange={(e) => setGrant(e.target.value)} />
            <button type="submit" className="btn btn-outline" disabled={!(Number(grant) > 0) || addCredits.isPending}>
              Add credits
            </button>
          </form>
        )}
        {addCredits.isError && <ErrorNotice error={addCredits.error} compact />}
        {credits.data && credits.data.ledger.length > 0 && (
          <table className="table">
            <caption className="sr-only">Recent credit activity</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Type</th>
                <th scope="col">Change</th>
                <th scope="col">Balance</th>
              </tr>
            </thead>
            <tbody>
              {credits.data.ledger.slice(0, 10).map((l) => (
                <tr key={l.id}>
                  <td>{formatDateTime(l.created_at)}</td>
                  <td>{l.kind}</td>
                  <td>{l.delta > 0 ? `+${l.delta}` : l.delta}</td>
                  <td>{l.balance_after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsSection>
    </>
  );
}
