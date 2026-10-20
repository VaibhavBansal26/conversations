import {
  AlertTriangle, ArrowDown, AtSign, Bell, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock, Copy, CreditCard, FileText, Flag, Inbox, Layers,
  Lock, LogOut, Mail, Menu, MessageSquare, Mic, MoreHorizontal, PanelRight, Paperclip, Pencil, Play, Plus, RefreshCw, Reply, Search, SendHorizontal, SlidersHorizontal,
  Smartphone, Smile, Sparkles, Square, Star, StickyNote, Trash2, User, X, type LucideIcon,
} from "lucide-react";
import { cn } from "./cn";

const ICONS = {
  inbox: Inbox, chat: MessageSquare, sms: Smartphone, mail: Mail, user: User, flag: Flag, star: Star, card: CreditCard, clock: Clock, check: Check, checks: CheckCheck,
  x: X, plus: Plus, search: Search, bell: Bell, sliders: SlidersHorizontal, paperclip: Paperclip, mic: Mic, smile: Smile, send: SendHorizontal, left: ChevronLeft,
  right: ChevronRight, down: ChevronDown, more: MoreHorizontal, sparkles: Sparkles, arrowDown: ArrowDown, note: StickyNote, reply: Reply, trash: Trash2, edit: Pencil,
  copy: Copy, help: CircleHelp, menu: Menu, play: Play, stop: Square, alert: AlertTriangle, refresh: RefreshCw, lock: Lock, panel: PanelRight, file: FileText,
  logout: LogOut, at: AtSign, inboxes: Layers,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

interface Props {
  name: IconName;
  size?: number;
  className?: string;
  filled?: boolean;
}

/** Decorative lucide icon by short name: always paired with visible text or an aria-label on the parent control. */
export function Icon({ name, size = 18, className, filled }: Props) {
  const Cmp = ICONS[name];
  return <Cmp width={size} height={size} className={cn("shrink-0", className)} fill={filled ? "currentColor" : "none"} aria-hidden="true" focusable="false" />;
}
