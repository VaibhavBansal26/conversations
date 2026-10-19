import { initials } from "../../lib/ids";

const HUES = [172, 24, 262, 340, 205, 48, 142, 290];

function hueFor(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length] ?? 172;
}

interface Props {
  name: string;
  seed?: string;
  size?: "sm" | "md" | "lg";
  online?: boolean;
}

export function Avatar({ name, seed, size = "md", online }: Props) {
  const hue = hueFor(seed ?? name);
  return (
    <span className={`avatar avatar-${size}`} style={{ ["--hue" as string]: hue }} title={name} role="img" aria-label={name}>
      <span aria-hidden="true">{initials(name)}</span>
      {online !== undefined && <span className={`presence${online ? " on" : ""}`} aria-hidden="true" />}
    </span>
  );
}
