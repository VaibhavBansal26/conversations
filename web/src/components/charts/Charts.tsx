import { useId } from "react";

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
}

const W = 640;
const PAD = { l: 44, r: 12, t: 12, b: 28 };

function scale(points: Point[], height: number) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const innerW = W - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH - (v / max) * innerH;
  return { max, x, y, innerH, innerW };
}

/** Every chart is an `img` with a title and description, and ships its data as a table for people who cannot see (or prefer not to read) the drawing. */
function DataTable({ title, points, unit, format }: Pick<Props, "title" | "points" | "unit" | "format">) {
  return (
    <details className="chart-data">
      <summary>Show data as a table</summary>
      <table>
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">{unit ?? "Value"}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label}>
              <th scope="row">{p.label}</th>
              <td>{format ? format(p.value) : p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function LineChart({ title, summary, points, unit, height = 180, format = String }: Props) {
  const id = useId();
  const { max, x, y } = scale(points, height);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} preserveAspectRatio="xMidYMid meet">
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{summary}</desc>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={PAD.l - 6} y={y(max * f) + 4} textAnchor="end" className="axis">
              {format(Math.round(max * f * 10) / 10)}
            </text>
          </g>
        ))}
        {points.length > 1 && <path d={d} className="series" fill="none" />}
        {points.map((p, i) => (
          <circle key={p.label} cx={x(i)} cy={y(p.value)} r={points.length > 60 ? 0 : 3} className="dot">
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </circle>
        ))}
        {points.length > 0 && (
          <>
            <text x={PAD.l} y={height - 8} className="axis">
              {points[0]!.label}
            </text>
            <text x={W - PAD.r} y={height - 8} textAnchor="end" className="axis">
              {points[points.length - 1]!.label}
            </text>
          </>
        )}
      </svg>
      <DataTable title={title} points={points} unit={unit} format={format} />
    </figure>
  );
}

export function BarChart({ title, summary, points, unit, height = 180, format = String }: Props) {
  const id = useId();
  const { x, y, innerW } = scale(points, height);
  const bw = Math.max(2, Math.min(40, (innerW / Math.max(1, points.length)) * 0.7));
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`} preserveAspectRatio="xMidYMid meet">
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{summary}</desc>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="grid" />
        {points.map((p, i) => (
          <rect key={p.label} x={x(i) - bw / 2} y={y(p.value)} width={bw} height={Math.max(0, y(0) - y(p.value))} className="bar">
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </rect>
        ))}
        {points.length > 0 && (
          <>
            <text x={PAD.l} y={height - 8} className="axis">
              {points[0]!.label}
            </text>
            <text x={W - PAD.r} y={height - 8} textAnchor="end" className="axis">
              {points[points.length - 1]!.label}
            </text>
          </>
        )}
      </svg>
      <DataTable title={title} points={points} unit={unit} format={format} />
    </figure>
  );
}
