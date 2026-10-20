import { cva } from "class-variance-authority";
import { Avatar as AvatarPrimitive } from "radix-ui";
import { initials } from "../lib/ids";
import { cn } from "./cn";

// Hue-keyed pairs are legible on both themes: light bg + dark text, tinted by the hue.
const HUES = [250, 20, 160, 330, 200, 45, 140, 290];

function hueFor(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length] ?? 250;
}

const sizes = cva("", {
  variants: { size: { xs: "size-5 text-[9px]", sm: "size-6 text-[10px]", md: "size-9 text-xs", lg: "size-12 text-base", xl: "size-16 text-xl" } },
  defaultVariants: { size: "md" },
});

const dotSizes = { xs: "size-1.5", sm: "size-2", md: "size-2.5", lg: "size-3", xl: "size-3.5" } as const;

interface Props {
  name: string;
  seed?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  src?: string;
  /** undefined hides the dot; true/false draws the presence state */
  online?: boolean;
  className?: string;
}

export function Avatar({ name, seed, size = "md", src, online, className }: Props) {
  const hue = hueFor(seed ?? name);
  return (
    <span className={cn("relative inline-flex shrink-0", className)} role="img" aria-label={name} title={name}>
      <AvatarPrimitive.Root className={cn("inline-flex select-none items-center justify-center overflow-hidden rounded-full font-semibold", sizes({ size }))}>
        {src && <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" />}
        <AvatarPrimitive.Fallback
          aria-hidden="true"
          data-initials={initials(name)}
          // initials are drawn with CSS, not as text: the avatar is decoration, and text inside a labelled button would otherwise have to be part of its accessible name (WCAG 2.5.3)
          className="grid size-full place-items-center before:content-[attr(data-initials)]"
          style={{ background: `light-dark(hsl(${hue} 75% 90%), hsl(${hue} 38% 24%))`, color: `light-dark(hsl(${hue} 65% 27%), hsl(${hue} 85% 84%))` }}
        />
      </AvatarPrimitive.Root>
      {online !== undefined && (
        <span
          aria-hidden="true"
          data-online={online}
          className={cn("absolute -right-px -bottom-px rounded-full ring-2 ring-surface", dotSizes[size], online ? "bg-presence-on" : "bg-presence-off")}
        />
      )}
    </span>
  );
}
