import type { ReactNode } from "react";
import { Link, useInRouterContext } from "react-router";

/** A router link that degrades to a plain anchor outside a router (isolated component tests, the widget preview). */
export function SettingsLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const inRouter = useInRouterContext();
  return inRouter ? (
    <Link to={to} className={className}>
      {children}
    </Link>
  ) : (
    <a href={to} className={className}>
      {children}
    </a>
  );
}
