import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ErrorNotice } from "../../ui";
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["contacts"] }),
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
      <div className="stack narrow">
        <label className="field">
          <span className="label">CSV file</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
        </label>
        {parsing && <p role="status">Checking file…</p>}
        {problem && <ErrorNotice error={new Error(problem)} compact />}
        {preview && (
          <div aria-live="polite">
            <p>
              <strong>{preview.total.toLocaleString()}</strong> rows, <strong>{preview.valid.toLocaleString()}</strong> look valid
              {preview.errors.length > 0 && <>, {preview.errors.length} with problems</>}.
            </p>
            {preview.preview.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">First rows of the file</caption>
                  <thead>
                    <tr>
                      {preview.headers.map((h, i) => (
                        <th key={i} scope="col">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.map((r, i) => (
                      <tr key={i}>
                        {preview.headers.map((_, j) => (
                          <td key={j}>{r[j]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.errors.length > 0 && (
              <details>
                <summary>Show problems</summary>
                <ul>
                  {preview.errors.slice(0, 20).map((e) => (
                    <li key={e.row}>
                      Row {e.row}: {e.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button type="button" className="btn btn-primary" disabled={upload.isPending || preview.valid === 0} onClick={() => upload.mutate()}>
              {upload.isPending ? "Importing…" : `Import ${preview.valid.toLocaleString()} contacts`}
            </button>
          </div>
        )}
        {upload.isError && <ErrorNotice error={upload.error} />}
        {result && (
          <p role="status">
            Imported: {result.created} created, {result.updated} updated, {result.skipped} skipped{result.errors.length ? `, ${result.errors.length} rejected by the server` : ""}.
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
