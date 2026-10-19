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
        <div className="quoted-block">
          <button type="button" className="link-btn" aria-expanded={showQuoted} onClick={() => setShowQuoted((v) => !v)}>
            {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </button>
          {showQuoted && (
            <div className="quoted-text">
              <RichText text={shown.quoted} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
