import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bell, CheckSquare, ChevronDown, LogOut, Moon, Plus, Settings as SettingsIcon, Store, Sun, TrendingUp, User as UserIcon } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { metaApi, networkApi, notificationsApi, tasksApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import { Avatar, Button, Dropdown, MenuItem, Skeleton, Tooltip, VerifiedBadge } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { GlobalSearch } from "./GlobalSearch";
import { MOBILE_NAV, PRIMARY_NAV } from "./nav-items";
import { cn, fullName } from "@/lib/utils";
import { useAsync } from "@/hooks/useAsync";
import type { Person } from "@/services/types";

export function AppShell() {
  const { user, booting } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (!booting && !user) {
      sessionStorage.setItem("postLoginRedirect", location.pathname + location.search);
    }
  }, [booting, user, location.pathname, location.search]);

  if (booting) return <ShellSkeleton />;
  if (!user) return <Outlet />;

  const path = location.pathname;
  const fullBleed = path.startsWith("/messages");
  const wide = fullBleed || /^\/(network|marketplace|discover|profile|business|advertising|assistant|settings|opportunities|saved|tasks|progress|notifications|create-listing|search)/.test(path);

  return (
    <div className="min-h-dvh bg-canvas">
      <TopNav />
      <div className={cn("pt-14 md:pt-16 pb-16 md:pb-8", fullBleed ? "h-[calc(100dvh-3.5rem)] overflow-hidden" : "mx-auto max-w-[1440px] px-0 sm:px-4")}>
        <div className={cn("flex gap-6", fullBleed ? "h-full items-stretch gap-0" : "items-start")}>
          {!fullBleed && <LeftSidebar />}
          <main className={cn("min-w-0 flex-1 w-full", fullBleed ? "" : wide ? "max-w-5xl" : "max-w-3xl mx-auto md:mx-0")}>
            <Outlet />
          </main>
          {!fullBleed && !wide && <RightSidebar />}
        </div>
      </div>
      <MobileNav />
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div className="min-h-dvh bg-canvas">
      <div className="fixed top-0 inset-x-0 h-14 md:h-16 bg-surface border-b border-line z-40" />
      <div className="mx-auto max-w-[1440px] px-4 pt-20 flex gap-6">
        <div className="hidden lg:block w-60 space-y-4">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
        <div className="flex-1 max-w-3xl space-y-4">
          <Skeleton className="h-20 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- TopNav --------------------------------- */

function TopNav() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      notificationsApi
        .unreadCount()
        .then((r) => alive && setUnread(r.count))
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, 30_000);
    window.addEventListener("professionalist:notifications", load);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener("professionalist:notifications", load);
    };
  }, []);

  return (
    <header className="fixed top-0 inset-x-0 z-40 bg-surface/95 backdrop-blur border-b border-line">
      <div className="mx-auto max-w-[1440px] px-3 sm:px-4 h-14 md:h-16 flex items-center gap-2 sm:gap-4">
        <Link to="/home" aria-label="Professionalist home" className="shrink-0">
          <Logo size={30} wordmark={false} />
          <span className="sr-only">Professionalist</span>
        </Link>
        <div className="hidden sm:block w-full max-w-[300px] lg:max-w-xs">
          <GlobalSearch />
        </div>
        <nav aria-label="Primary" className="hidden md:flex items-center flex-1 justify-center gap-1">
          {PRIMARY_NAV.map((n) => (
            <Tooltip key={n.to} label={n.label}>
              <NavLink
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn(
                    "relative flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold transition-colors",
                    isActive ? "text-accent bg-accent-soft" : "text-ink-soft hover:text-ink hover:bg-surface-2"
                  )
                }
              >
                <n.icon size={19} aria-hidden />
                <span className="lg:hidden xl:inline">{n.label}</span>
              </NavLink>
            </Tooltip>
          ))}
        </nav>
        <div className="flex items-center gap-1 md:gap-1.5 ml-auto">
          <ThemeToggle />
          <NavLink
            to="/notifications"
            aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
            className={({ isActive }) =>
              cn(
                "relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
                isActive ? "text-accent bg-accent-soft" : "text-ink-soft hover:text-ink hover:bg-surface-2"
              )
            }
          >
            <Bell size={20} aria-hidden />
            {unread > 0 && (
              <span className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </NavLink>
          <div className="hidden sm:flex items-center">
            <Tooltip label="Progress">
              <NavLink
                to="/progress"
                className={({ isActive }) =>
                  cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
                    isActive ? "text-accent bg-accent-soft" : "text-ink-soft hover:text-ink hover:bg-surface-2"
                  )
                }
              >
                <TrendingUp size={20} aria-hidden />
              </NavLink>
            </Tooltip>
            <Tooltip label="Tasks">
              <NavLink
                to="/tasks"
                className={({ isActive }) =>
                  cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
                    isActive ? "text-accent bg-accent-soft" : "text-ink-soft hover:text-ink hover:bg-surface-2"
                  )
                }
              >
                <CheckSquare size={20} aria-hidden />
              </NavLink>
            </Tooltip>
          </div>
          <UserMenu />
        </div>
      </div>
      <div className="sm:hidden px-3 pb-2">
        <GlobalSearch compact />
      </div>
    </header>
  );
}

function ThemeToggle() {
  const { resolved, setTheme, theme } = useTheme();
  return (
    <button
      onClick={() => setTheme(resolved === "dark" ? "light" : theme === "dark" ? "light" : "dark")}
      aria-label={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
      className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-soft hover:text-ink hover:bg-surface-2 transition-colors"
    >
      {resolved === "dark" ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const name = fullName(user);
  return (
    <Dropdown
      trigger={({ toggle, open }) => (
        <button
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
          className="flex items-center gap-1 rounded-xl p-1 hover:bg-surface-2 transition-colors"
        >
          <Avatar name={name} src={user.profile.avatarUrl} size="md" />
          <ChevronDown size={15} className="text-ink-soft hidden sm:block" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-3 py-2.5 border-b border-line mb-1">
            <button onClick={() => { navigate(`/profile/${user.username}`); close(); }} className="flex items-center gap-2.5 w-full text-left">
              <Avatar name={name} src={user.profile.avatarUrl} size="md" />
              <span className="min-w-0">
                <span className="block text-sm font-bold truncate">{name}</span>
                <span className="block text-xs text-ink-soft truncate">{user.profile.title || `@${user.username}`}</span>
              </span>
            </button>
          </div>
          <MenuItem icon={<UserIcon size={16} />} onClick={() => { navigate(`/profile/${user.username}`); close(); }}>
            View profile
          </MenuItem>
          <MenuItem icon={<SettingsIcon size={16} />} onClick={() => { navigate("/settings"); close(); }}>
            Settings
          </MenuItem>
          <MenuItem icon={<Store size={16} />} onClick={() => { navigate("/create-listing"); close(); }}>
            Create listing
          </MenuItem>
          <MenuItem icon={<LogOut size={16} />} danger onClick={() => { void logout().then(() => navigate("/login")); close(); }}>
            Sign out
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}

/* ------------------------------- Left sidebar ------------------------------ */

function LeftSidebar() {
  const { user } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const name = fullName(user);
  return (
    <aside className="hidden lg:flex flex-col w-60 shrink-0 sticky top-20 gap-4 max-h-[calc(100dvh-6rem)] overflow-y-auto pb-4 hide-scrollbar">
      <div className="card overflow-hidden">
        <div
          className="h-16 bg-cover bg-center"
          style={{ backgroundImage: user.profile.coverUrl ? `url("${mediaUrl(user.profile.coverUrl)}")` : "linear-gradient(120deg,#0B5CD8,#22C0FF)" }}
          aria-hidden
        />
        <Link to={`/profile/${user.username}`} className="block px-4 pb-4 -mt-7">
          <Avatar name={name} src={user.profile.avatarUrl} size="lg" ring className="shadow" />
          <p className="mt-2 text-sm font-bold flex items-center gap-1">
            {name}
            {user.verified && <VerifiedDot />}
          </p>
          <p className="text-xs text-ink-soft line-clamp-2">{user.profile.title || `@${user.username}`}</p>
        </Link>
      </div>
      <nav aria-label="Secondary" className="card p-1.5">
        <NavLink to="/home" className={sideLinkClass}>Feed</NavLink>
        <NavLink to="/network" className={sideLinkClass}>My Network</NavLink>
        <NavLink to="/discover" className={sideLinkClass}>Discover</NavLink>
        <NavLink to="/marketplace" className={sideLinkClass}>Marketplace</NavLink>
        <NavLink to="/messages" className={sideLinkClass}>Messages</NavLink>
        <NavLink to="/opportunities" className={sideLinkClass}>Opportunities</NavLink>
        <NavLink to="/saved" className={sideLinkClass}>Saved</NavLink>
        <NavLink to="/progress" className={sideLinkClass}>Progress</NavLink>
        <NavLink to="/tasks" className={sideLinkClass}>Tasks</NavLink>
        <NavLink to="/assistant" className={sideLinkClass}>AI Assistant</NavLink>
        <NavLink to="/settings" className={sideLinkClass}>Settings</NavLink>
      </nav>
      <div className="card p-3 space-y-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint px-1">Quick actions</p>
        <Button variant="soft" size="sm" fullWidth onClick={() => navigate("/home?compose=1")}>
          <Plus size={15} /> Create post
        </Button>
        <Button variant="outline" size="sm" fullWidth onClick={() => navigate("/create-listing")}>
          <Store size={15} /> Sell / offer a service
        </Button>
      </div>
    </aside>
  );
}

function VerifiedDot() {
  return <span className="h-3.5 w-3.5 rounded-full bg-accent text-white text-[8px] font-bold grid place-items-center" aria-label="Verified">✓</span>;
}

function sideLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    "block rounded-lg px-3 py-2 text-[13.5px] font-semibold transition-colors",
    isActive ? "bg-accent-soft text-accent" : "text-ink-soft hover:bg-surface-2 hover:text-ink"
  );
}

/* ------------------------------- Right sidebar ----------------------------- */

function RightSidebar() {
  const suggestions = useAsync(() => networkApi.suggestions({ pageSize: 4 }), []);
  const trends = useAsync(() => metaApi.trends(), []);
  const tasks = useAsync(() => tasksApi.list({ view: "today" }), []);

  return (
    <aside className="hidden xl:flex flex-col w-72 shrink-0 sticky top-20 gap-4 max-h-[calc(100dvh-6rem)] overflow-y-auto pb-4 hide-scrollbar">
      <section className="card p-4" aria-label="People you may know">
        <h3 className="text-sm font-bold mb-3">People you may know</h3>
        {suggestions.loading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
          </div>
        )}
        {suggestions.data && (
          <ul className="space-y-3">
            {suggestions.data.slice(0, 4).map((p: Person) => (
              <li key={p.id} className="flex items-center gap-2.5">
                <Link to={`/profile/${p.username}`} className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={fullName(p)} src={p.avatarUrl} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold flex items-center gap-1">
                      {fullName(p)} {p.verified && <VerifiedBadge color={p.verifiedColor} size={12} />}
                    </span>
                    <span className="block truncate text-[11px] text-ink-soft">{p.title}</span>
                  </span>
                </Link>
                <FollowMiniButton person={p} onDone={suggestions.refetch} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-4" aria-label="Trending topics">
        <h3 className="text-sm font-bold mb-3">Trending topics</h3>
        {trends.loading && <Skeleton className="h-24" />}
        {trends.data && (
          <ul className="space-y-2.5">
            {trends.data.slice(0, 5).map((t) => (
              <li key={t.tag}>
                <Link to={`/search?q=${encodeURIComponent(t.tag)}`} className="block group">
                  <p className="text-[13px] font-semibold text-accent group-hover:underline">#{t.tag.replace(/^#/, "")}</p>
                  <p className="text-[11px] text-ink-faint">{t.posts} posts</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-4" aria-label="Today's tasks">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold">Today</h3>
          <Link to="/tasks" className="text-xs font-semibold text-accent hover:underline">All tasks</Link>
        </div>
        {tasks.loading && <Skeleton className="h-16" />}
        {tasks.data && tasks.data.length === 0 && <p className="text-xs text-ink-soft">Nothing due today. Well done.</p>}
        {tasks.data && tasks.data.length > 0 && (
          <ul className="space-y-2">
            {tasks.data.slice(0, 3).map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[13px]">
                <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", t.priority === "high" ? "bg-danger" : t.priority === "medium" ? "bg-warn" : "bg-ink-faint")} aria-hidden />
                <span className="truncate">{t.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden" aria-label="Sponsored">
        <div className="p-4 bg-gradient-to-br from-[#0B5CD8] to-[#22C0FF] text-white">
          <p className="text-[10px] font-bold uppercase tracking-widest opacity-80">Grow with Professionalist Ads</p>
          <p className="mt-1.5 text-sm font-bold leading-snug">Put your products and services in front of professionals who buy.</p>
          <Link to="/advertising">
            <Button size="sm" variant="secondary" className="mt-3 bg-white text-ink hover:bg-white/90">Start a campaign</Button>
          </Link>
        </div>
      </section>
    </aside>
  );
}

function FollowMiniButton({ person, onDone }: { person: Person; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState(person.connectionStatus);
  if (status === "connected" || status === "pending_out") {
    return <span className="ml-auto text-[11px] font-semibold text-ink-faint shrink-0">{status === "connected" ? "Connected" : "Sent"}</span>;
  }
  return (
    <button
      disabled={pending}
      onClick={() => {
        setPending(true);
        networkApi
          .connect(person.id)
          .then(() => {
            setStatus("pending_out");
            onDone();
          })
          .catch(() => undefined)
          .finally(() => setPending(false));
      }}
      className="ml-auto shrink-0 rounded-full border border-accent px-2.5 py-1 text-[11px] font-bold text-accent hover:bg-accent-soft transition-colors disabled:opacity-50"
    >
      {status === "pending_in" ? "Accept" : "Connect"}
    </button>
  );
}

/* -------------------------------- Mobile nav ------------------------------- */

function MobileNav() {
  const { user } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <>
      <button
        onClick={() => navigate("/home?compose=1")}
        aria-label="Create"
        className="fixed bottom-20 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-white shadow-pop active:scale-95 transition-transform md:hidden"
      >
        <Plus size={24} />
      </button>
      <nav aria-label="Mobile" className="fixed bottom-0 inset-x-0 z-40 bg-surface border-t border-line md:hidden safe-bottom">
        <div className="grid grid-cols-5 h-14">
          {MOBILE_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition-colors",
                  isActive ? "text-accent" : "text-ink-soft"
                )
              }
            >
              <n.icon size={21} aria-hidden />
              {n.short}
            </NavLink>
          ))}
          <NavLink
            to={`/profile/${user.username}`}
            className={({ isActive }) =>
              cn("flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold", isActive ? "text-accent" : "text-ink-soft")
            }
          >
            <Avatar name={fullName(user)} src={user.profile.avatarUrl} size="xs" />
            Profile
          </NavLink>
        </div>
      </nav>
    </>
  );
}
