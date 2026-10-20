import { Bell, Bookmark, CheckSquare, Clapperboard, Compass, Home, LifeBuoy, Megaphone, MessageCircle, Settings, Sparkles, Store, TrendingUp, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: LucideIcon;
  end?: boolean;
}

export const PRIMARY_NAV: NavItem[] = [
  { to: "/home", label: "Feed", short: "Home", icon: Home, end: true },
  { to: "/network", label: "Network", short: "Network", icon: Users },
  { to: "/videos", label: "Videos", short: "Videos", icon: Clapperboard },
  { to: "/marketplace", label: "Marketplace", short: "Market", icon: Store },
  { to: "/messages", label: "Messages", short: "Messages", icon: MessageCircle },
];

export const UTILITY_NAV: NavItem[] = [
  { to: "/notifications", label: "Notifications", short: "Alerts", icon: Bell },
  { to: "/progress", label: "Progress", short: "Progress", icon: TrendingUp },
  { to: "/tasks", label: "Tasks", short: "Tasks", icon: CheckSquare },
];

export const MOBILE_NAV: NavItem[] = [
  { to: "/home", label: "Home", short: "Home", icon: Home, end: true },
  { to: "/network", label: "Network", short: "Network", icon: Users },
  { to: "/videos", label: "Videos", short: "Videos", icon: Clapperboard },
  { to: "/marketplace", label: "Market", short: "Market", icon: Store },
  { to: "/messages", label: "Messages", short: "Chats", icon: MessageCircle },
];

export const SIDEBAR_NAV: NavItem[] = [
  { to: "/discover", label: "Discover", short: "Discover", icon: Compass },
  { to: "/opportunities", label: "Opportunities", short: "Opportunities", icon: TrendingUp },
  { to: "/saved", label: "Saved", short: "Saved", icon: Bookmark },
  { to: "/advertising", label: "Advertising", short: "Advertising", icon: Megaphone },
  { to: "/assistant", label: "AI Assistant", short: "AI Assistant", icon: Sparkles },
  { to: "/support", label: "Support", short: "Support", icon: LifeBuoy },
  { to: "/settings", label: "Settings", short: "Settings", icon: Settings },
];
