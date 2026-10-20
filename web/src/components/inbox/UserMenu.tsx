import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import type { Availability, Member, Session } from "../../api/types";
import { useAuth, useSession } from "../../auth/AuthContext";
import { keys } from "../../state/keys";
import { Avatar } from "../../ui";
import { Menu, type MenuItem } from "../../ui";

const LEVELS: { id: Availability; label: string }[] = [
  { id: "active", label: "Available" },
  { id: "away", label: "Away" },
  { id: "inactive", label: "Inactive" },
];

export function UserMenu({ onHelp }: { onHelp: () => void }) {
  const { member, user } = useSession();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setAvailability = useMutation({
    mutationFn: (availability: Availability) => api.patch<Member>("/members/me", { availability }),
    onSuccess: (m) => qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, member: m } : s)),
  });

  const items: MenuItem[] = [
    ...LEVELS.map<MenuItem>((l) => ({ id: l.id, label: `Status: ${l.label}`, checked: member.availability === l.id, onSelect: () => setAvailability.mutate(l.id) })),
    { id: "analytics", label: "Analytics", onSelect: () => navigate("/analytics") },
    { id: "settings", label: "Settings", onSelect: () => navigate("/settings") },
    { id: "help", label: "Keyboard shortcuts", onSelect: onHelp },
    { id: "logout", label: "Sign out", danger: true, onSelect: logout },
  ];

  return (
    <Menu
      label="Account menu"
      triggerClassName="user-btn"
      items={items}
      trigger={
        <>
          <Avatar name={user.name} online={member.availability === "active"} />
          <span className="user-text">
            <strong>{user.name}</strong>
            <small>{LEVELS.find((l) => l.id === member.availability)?.label}</small>
          </span>
        </>
      }
    />
  );
}
