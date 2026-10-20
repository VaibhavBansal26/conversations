import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { FileUp } from "lucide-react";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { Button, ErrorNotice, Spinner, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, toast } from "../../ui";
import { getWorkerClient, CancelledError } from "../../workers/client";
import type { CsvPreview } from "../../workers/protocol";

interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; error: string }[];
}

/** Files above this are previewed in a worker; the parse of a 50k-row file would otherwise freeze the page. */
const WORKER_FROM = 200_000;
const MAX_BYTES = 5 * 1024 * 1024;

export function ContactSettings() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [parsing, setParsing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const upload = useMutation({
    mutationFn: () => api.upload<ImportResult>("/contacts/import", file!),
    onSuccess: (r) => {
      toast({ title: "Import finished", description: `${r.created} created, ${r.updated} updated`, tone: "success" });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });

  useEffect(() => () => abort.current?.abort(), []);

  const pick = async (f: File | null) => {
    abort.current?.abort();
    setPreview(null);
    setProblem(null);
    upload.reset();
    setFile(f);
    if (!f) return;
    if (f.size > MAX_BYTES) return setProblem("This file is larger than 5 MB. Split it into smaller files.");
    const ac = new AbortController();
    abort.current = ac;
    setParsing(true);
    try {
      const text = await f.text();
      setPreview(await getWorkerClient().run("csv", { text, maxRows: 5 }, { signal: ac.signal, size: text.length, inlineBelow: WORKER_FROM }));
    } catch (e) {
      if (!(e instanceof CancelledError)) setProblem("Could not read this file.");
    } finally {
      if (abort.current === ac) setParsing(false);
    }
  };

  const result = upload.data;
  return (
    <SettingsSection title="Import contacts" description="Upload a CSV with columns name, email, phone and tags (separated by ;). Other columns become custom attributes. Existing contacts are matched by email or phone and updated.">
      <div className="flex flex-col gap-4">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border-strong bg-surface-2/40 px-6 py-8 text-center transition-colors hover:border-primary hover:bg-primary-soft/40 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
          <FileUp className="size-7 text-primary-text" aria-hidden="true" />
          <span className="text-sm font-medium">{file ? file.name : "Choose a CSV file"}</span>
          <span className="text-xs text-subtle">{file ? `${(file.size / 1024).toFixed(1)} KB` : "Up to 5 MB"}</span>
          <span className="sr-only">CSV file</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
        </label>
        {parsing && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner label="Checking file" /> Checking file…
          </p>
        )}
        {problem && <ErrorNotice error={new Error(problem)} compact />}
        {preview && (
          <div aria-live="polite" className="flex flex-col gap-3">
            <p className="text-sm">
              <strong>{preview.total.toLocaleString()}</strong> rows, <strong>{preview.valid.toLocaleString()}</strong> look valid
              {preview.errors.length > 0 && <>, {preview.errors.length} with problems</>}.
            </p>
            {preview.preview.length > 0 && (
              <Table>
                <caption className="sr-only">First rows of the file</caption>
                <TableHead>
                  <TableRow>
                    {preview.headers.map((h, i) => (
                      <TableHeaderCell key={i} scope="col">
                        {h}
                      </TableHeaderCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {preview.preview.map((r, i) => (
                    <TableRow key={i}>
                      {preview.headers.map((_, j) => (
                        <TableCell key={j}>{r[j]}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {preview.errors.length > 0 && (
              <details className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-[13px] text-warning-text">
                <summary className="cursor-pointer font-medium">Show problems</summary>
                <ul className="mt-2 list-disc pl-5">
                  {preview.errors.slice(0, 20).map((e) => (
                    <li key={e.row}>
                      Row {e.row}: {e.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div>
              <Button loading={upload.isPending} disabled={preview.valid === 0} onClick={() => upload.mutate()}>
                {upload.isPending ? "Importing…" : `Import ${preview.valid.toLocaleString()} contacts`}
              </Button>
            </div>
          </div>
        )}
        {upload.isError && <ErrorNotice error={upload.error} />}
        {result && (
          <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-[13px] text-success-text">
            Imported: {result.created} created, {result.updated} updated, {result.skipped} skipped{result.errors.length ? `, ${result.errors.length} rejected by the server` : ""}.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
