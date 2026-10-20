import { Monitor, Moon, Sun } from "lucide-react";
import { Menu } from "./dropdown-menu";
import { useTheme, type ThemePref } from "./theme";
import { buttonVariants } from "./button";

const OPTIONS: { id: ThemePref; label: string; Icon: typeof Sun }[] = [
  { id: "system", label: "System", Icon: Monitor },
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
];

/** Light / dark / system switch. The choice is stored per browser. */
export function ThemeToggle({ className }: { className?: string }) {
  const [pref, setPref] = useTheme();
  const Current = OPTIONS.find((o) => o.id === pref)?.Icon ?? Monitor;
  return (
    <Menu
      label="Theme"
      align="end"
      triggerClassName={className ?? buttonVariants({ variant: "ghost", size: "icon" })}
      trigger={<Current className="size-[18px]" aria-hidden="true" />}
      items={OPTIONS.map((o) => ({
        id: o.id,
        checked: pref === o.id,
        onSelect: () => setPref(o.id),
        label: (
          <span className="flex items-center gap-2">
            <o.Icon className="size-4" aria-hidden="true" /> {o.label}
          </span>
        ),
      }))}
    />
  );
}
