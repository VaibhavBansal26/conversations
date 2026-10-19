export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span className="spinner-dot" />
    </span>
  );
}

export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state-block">
      <Spinner label={label} />
      <span>{label}…</span>
    </div>
  );
}
