import type { ReactNode } from "react";
import { Icon } from "../components/ui/Icon";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <span className="brand">
          <Icon name="chat" size={22} /> Conversations
        </span>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}
