import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useCredits, useSaveWorkspace } from "../../api/settingsHooks";
import { useSession } from "../../auth/AuthContext";
import { SaveBar, SettingsSection } from "../../components/settings/SettingsSection";
import { fieldErrors } from "../../lib/apiError";
import { formatDateTime } from "../../lib/time";
import { keys } from "../../state/keys";
import { Badge, Button, ErrorNotice, Field, Input, Skeleton, Switch, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, toast } from "../../ui";

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
      toast({ title: `${grant} credits added`, tone: "success" });
      setGrant("");
      void qc.invalidateQueries({ queryKey: keys.credits });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
  const errors = fieldErrors(save.error);
  const dirty = name !== workspace.name || region !== s.default_region || Number(editWindow) !== s.edit_window_seconds || enforced !== s.credits_enforced;
  const reset = () => {
    setName(workspace.name);
    setRegion(s.default_region);
    setEditWindow(String(s.edit_window_seconds));
    setEnforced(s.credits_enforced);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: name.trim(), settings: { default_region: region.toUpperCase(), edit_window_seconds: Number(editWindow), credits_enforced: enforced } });
  };

  return (
    <>
      <SettingsSection title="General" description="Workspace identity and messaging defaults.">
        <form className="flex max-w-lg flex-col gap-4" onSubmit={submit}>
          <Field label="Workspace name" error={errors.name}>
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default region" hint="Two-letter country code used to read phone numbers without a + prefix." error={errors["settings.default_region"]}>
              <Input value={region} maxLength={2} onChange={(e) => setRegion(e.target.value.toUpperCase())} pattern="[A-Za-z]{2}" required className="uppercase" />
            </Field>
            <Field label="Edit window (seconds)" hint="How long after sending an agent can still edit a message. 0 disables editing." error={errors["settings.edit_window_seconds"]}>
              <Input type="number" min={0} max={86400} value={editWindow} onChange={(e) => setEditWindow(e.target.value)} />
            </Field>
          </div>
          <Switch label="Enforce credits" hint="When on, SMS and email sends are blocked once the credit balance runs out." checked={enforced} onChange={setEnforced} />
          {save.isError && <ErrorNotice error={save.error} />}
          <SaveBar pending={save.isPending} saved={save.isSuccess} dirty={dirty} onReset={reset} />
        </form>
      </SettingsSection>

      <SettingsSection title="Credits" description="Outbound SMS and email each use credits.">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-full bg-primary-soft text-primary-text">
            <Coins className="size-5" aria-hidden="true" />
          </span>
          <p>
            <strong className="text-2xl font-semibold tabular-nums">{workspace.credit_balance.toLocaleString()}</strong>
            <span className="ml-2 text-muted-foreground">credits remaining</span>
          </p>
        </div>
        {member.role === "owner" && (
          <form
            className="flex max-w-sm gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (Number(grant) > 0) addCredits.mutate();
            }}
          >
            <label className="sr-only" htmlFor="grant">
              Credits to add
            </label>
            <Input id="grant" type="number" min={1} value={grant} placeholder="Credits to add" onChange={(e) => setGrant(e.target.value)} />
            <Button type="submit" variant="outline" disabled={!(Number(grant) > 0)} loading={addCredits.isPending}>
              Add credits
            </Button>
          </form>
        )}
        {addCredits.isError && <ErrorNotice error={addCredits.error} compact />}
        {credits.isPending && <Skeleton className="h-24 w-full" />}
        {credits.data && credits.data.ledger.length > 0 && (
          <Table>
            <caption className="sr-only">Recent credit activity</caption>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">When</TableHeaderCell>
                <TableHeaderCell scope="col">Type</TableHeaderCell>
                <TableHeaderCell scope="col" className="text-right">Change</TableHeaderCell>
                <TableHeaderCell scope="col" className="text-right">Balance</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {credits.data.ledger.slice(0, 10).map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(l.created_at)}</TableCell>
                  <TableCell>
                    <Badge>{l.kind}</Badge>
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${l.delta > 0 ? "text-success-text" : ""}`}>{l.delta > 0 ? `+${l.delta}` : l.delta}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.balance_after}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsSection>
    </>
  );
}
