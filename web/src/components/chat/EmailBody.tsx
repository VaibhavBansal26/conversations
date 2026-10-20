import { useEffect, useState } from "react";
import { getWorkerClient } from "../../workers/client";
import type { EmailParts } from "../../workers/protocol";
import { RichText } from "./RichText";

/** Emails shorter than this are rendered as-is. */
export const COLLAPSE_FROM = 1200;
const WORKER_FROM = 40_000;

/** Long email bodies: show what the sender wrote, keep the quoted history behind a toggle. The split runs off the main thread for huge bodies. */
export function EmailBody({ text }: { text: string }) {
  const [parts, setParts] = useState<EmailParts | null>(null);
  const [showQuoted, setShowQuoted] = useState(false);
  useEffect(() => {
    let live = true;
    void getWorkerClient()
      .run("email", { text }, { size: text.length, inlineBelow: WORKER_FROM })
      .then((p) => live && setParts(p))
      .catch(() => live && setParts({ main: text, quoted: "" }));
    return () => {
      live = false;
    };
  }, [text]);
  const shown = parts ?? { main: text, quoted: "" };
  return (
    <>
      <RichText text={shown.main} />
      {shown.quoted && (
        <div className="mt-2">
          <button type="button" className="inline-flex items-center gap-1 rounded bg-black/5 px-2 py-0.5 text-xs font-medium hover:bg-black/10" aria-expanded={showQuoted} onClick={() => setShowQuoted((v) => !v)}>
            <span aria-hidden="true">···</span> {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </button>
          {showQuoted && (
            <div className="mt-2 whitespace-pre-wrap border-l-2 border-current/30 pl-3 opacity-80">
              <RichText text={shown.quoted} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
