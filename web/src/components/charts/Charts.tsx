import { useId, useRef, useState, type PointerEvent } from "react";
import { cn } from "../../ui";

export interface Point {
  label: string;
  value: number;
}

interface Props {
  title: string;
  /** one sentence a screen-reader user hears instead of the picture */
  summary: string;
  points: Point[];
  unit?: string;
  height?: number;
  format?: (v: number) => string;
  className?: string;
}

const W = 640;
const PAD = { l: 44, r: 12, t: 14, b: 28 };

function scale(points: Point[], height: number) {
  const max = niceMax(Math.max(1, ...points.map((p) => p.value)));
  const innerW = W - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH - (v / max) * innerH;
  return { max, x, y, innerH, innerW };
}

/** Round the axis maximum up to 1, 2, 2.5, 5 or 10 times a power of ten so gridline labels are tidy. */
function niceMax(v: number): number {
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * pow) return m * pow;
  return 10 * pow;
}

/** Every chart is an `img` with a title and description, and ships its data as a table for people who cannot see (or prefer not to read) the drawing. */
function DataTable({ title, points, unit, format }: Pick<Props, "title" | "points" | "unit" | "format">) {
  return (
    <details className="group mt-2 text-[13px]">
      <summary className="w-fit cursor-pointer rounded text-muted-foreground hover:text-foreground">Show data as a table</summary>
      <div className="mt-2 max-h-56 overflow-auto rounded-md border border-border">
        <table className="w-full text-left">
          <caption className="sr-only">{title}</caption>
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              <th scope="col" className="px-3 py-1.5 font-medium text-muted-foreground">
                Period
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium text-muted-foreground">
                {unit ?? "Value"}
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.label} className="border-t border-border">
                <th scope="row" className="px-3 py-1 font-normal">
                  {p.label}
                </th>
                <td className="px-3 py-1 tabular-nums">{format ? format(p.value) : p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Tracks the nearest data point under the pointer; the tooltip is positioned in SVG-viewBox percentages so it scales with the figure. */
function useHover(count: number, xOf: (i: number) => number) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !count) return;
    const vx = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(xOf(i) - vx);
      if (d < bd) (bd = d), (best = i);
    }
    setHover(best);
  };
  return { ref, hover, onMove, onLeave: () => setHover(null) };
}

function Tooltip({ p, xPct, yPct, format }: { p: Point; xPct: number; yPct: number; format: (v: number) => string }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md"
      style={{ left: `${Math.min(92, Math.max(8, xPct))}%`, top: `calc(${yPct}% - 10px)` }}
    >
      <span className="opacity-80">{p.label}</span> <span className="tabular-nums">{format(p.value)}</span>
    </div>
  );
}

function XLabels({ points, x, height }: { points: Point[]; x: (i: number) => number; height: number }) {
  if (!points.length) return null;
  const n = points.length;
  const step = Math.max(1, Math.ceil(n / 6));
  const idx = new Set<number>([0, n - 1]);
  for (let i = 0; i < n; i += step) idx.add(i);
  // drop interior ticks that would crowd the last label
  if (n > 1 && (n - 1) % step !== 0) idx.delete(Math.floor((n - 1) / step) * step);
  return (
    <>
      {[...idx].sort((a, b) => a - b).map((i) => (
        <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-subtle text-[11px]">
          {points[i]!.label}
        </text>
      ))}
    </>
  );
}

export function LineChart({ title, summary, points, unit, height = 200, format = String, className }: Props) {
  const id = useId();
  const { max, x, y } = scale(points, height);
  const { ref, hover, onMove, onLeave } = useHover(points.length, x);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = points.length > 1 ? `${d} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : "";
  const hp = hover === null ? null : points[hover]!;
  return (
    <figure className={cn("m-0", className)}>
      <figcaption className="mb-2 text-sm font-semibold">{title}</figcaption>
      <div className="relative">
        <svg ref={ref} viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="h-auto w-full touch-pan-y overflow-visible" onPointerMove={onMove} onPointerLeave={onLeave}>
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{summary}</desc>
          <defs>
            <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} className="stroke-border" strokeDasharray={f === 0 ? undefined : "3 4"} />
              <text x={PAD.l - 8} y={y(max * f) + 4} textAnchor="end" className="fill-subtle text-[11px]">
                {format(Math.round(max * f * 10) / 10)}
              </text>
            </g>
          ))}
          {area && <path d={area} fill={`url(#${id}-g)`} />}
          {points.length > 1 && <path d={d} fill="none" className="stroke-primary" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />}
          {points.map((p, i) => (
            <circle key={p.label} cx={x(i)} cy={y(p.value)} r={points.length > 45 ? 0 : 3} className="fill-surface stroke-primary" strokeWidth={2}>
              <title>{`${p.label}: ${format(p.value)}`}</title>
            </circle>
          ))}
          {hp && hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={y(0)} className="stroke-border-strong" />
              <circle cx={x(hover)} cy={y(hp.value)} r={5} className="fill-primary stroke-surface" strokeWidth={2} />
            </>
          )}
          <XLabels points={points} x={x} height={height} />
        </svg>
        {hp && hover !== null && <Tooltip p={hp} xPct={(x(hover) / W) * 100} yPct={(y(hp.value) / height) * 100} format={format} />}
      </div>
      <DataTable title={title} points={points} unit={unit} format={format} />
    </figure>
  );
}

export function BarChart({ title, summary, points, unit, height = 200, format = String, className }: Props) {
  const id = useId();
  const { max, x, y, innerW } = scale(points, height);
  const { ref, hover, onMove, onLeave } = useHover(points.length, x);
  const bw = Math.max(2, Math.min(36, (innerW / Math.max(1, points.length)) * 0.68));
  const hp = hover === null ? null : points[hover]!;
  return (
    <figure className={cn("m-0", className)}>
      <figcaption className="mb-2 text-sm font-semibold">{title}</figcaption>
      <div className="relative">
        <svg ref={ref} viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="h-auto w-full touch-pan-y overflow-visible" onPointerMove={onMove} onPointerLeave={onLeave}>
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{summary}</desc>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} className="stroke-border" strokeDasharray={f === 0 ? undefined : "3 4"} />
              <text x={PAD.l - 8} y={y(max * f) + 4} textAnchor="end" className="fill-subtle text-[11px]">
                {format(Math.round(max * f * 10) / 10)}
              </text>
            </g>
          ))}
          {points.map((p, i) => (
            <rect key={p.label} x={x(i) - bw / 2} y={y(p.value)} width={bw} height={Math.max(0, y(0) - y(p.value))} rx={Math.min(3, bw / 3)} className={cn("fill-primary transition-opacity", hover !== null && hover !== i && "opacity-45")}>
              <title>{`${p.label}: ${format(p.value)}`}</title>
            </rect>
          ))}
          <XLabels points={points} x={x} height={height} />
        </svg>
        {hp && hover !== null && <Tooltip p={hp} xPct={(x(hover) / W) * 100} yPct={(y(hp.value) / height) * 100} format={format} />}
      </div>
      <DataTable title={title} points={points} unit={unit} format={format} />
    </figure>
  );
}

/** Tiny trend line for KPI cards. Decorative: the card's text carries the number. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 100).toFixed(1)},${(22 - ((v - min) / span) * 20).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" className={cn("h-6 w-24", className)}>
      <path d={d} fill="none" className="stroke-primary" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
