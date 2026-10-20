import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Keyboard, LogOut, Settings } from "lucide-react";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import type { Availability, Member, Session } from "../../api/types";
import { useAuth, useSession } from "../../auth/AuthContext";
import { keys } from "../../state/keys";
import { Avatar, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuCheckItem, cn } from "../../ui";

const LEVELS: { id: Availability; label: string }[] = [
  { id: "active", label: "Available" },
  { id: "away", label: "Away" },
  { id: "inactive", label: "Inactive" },
];

interface Props {
  onHelp: () => void;
  side?: "right" | "top";
  className?: string;
  showName?: boolean;
}

export function UserMenu({ onHelp, side = "right", className, showName }: Props) {
  const { member, user } = useSession();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setAvailability = useMutation({
    mutationFn: (availability: Availability) => api.patch<Member>("/members/me", { availability }),
    onSuccess: (m) => qc.setQueryData<Session>(keys.me, (s) => (s ? { ...s, member: m } : s)),
  });
  const current = LEVELS.find((l) => l.id === member.availability)?.label;

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger aria-label="Account menu" className={cn("flex items-center gap-2.5 rounded-lg p-1 hover:bg-surface-2", className)}>
        <Avatar name={user.name} online={member.availability === "active"} />
        {showName && (
          <span className="min-w-0 text-left leading-tight">
            <strong className="block truncate text-[13px]">{user.name}</strong>
            <small className="text-xs text-subtle">{current}</small>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={side === "right" ? "end" : "end"} className="w-60">
        <div className="px-2.5 py-2">
          <p className="truncate text-sm font-semibold">{user.name}</p>
          <p className="truncate text-xs text-subtle">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        {LEVELS.map((l) => (
          <DropdownMenuCheckItem key={l.id} checked={member.availability === l.id} onCheckedChange={() => setAvailability.mutate(l.id)}>
            Status: {l.label}
          </DropdownMenuCheckItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/analytics")}>
          <BarChart3 className="size-4 text-subtle" aria-hidden="true" /> Analytics
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/settings")}>
          <Settings className="size-4 text-subtle" aria-hidden="true" /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onHelp}>
          <Keyboard className="size-4 text-subtle" aria-hidden="true" /> Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={logout}>
          <LogOut className="size-4" aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
