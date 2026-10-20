import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  History,
  KeyRound,
  LogOut,
  MapPin,
  Monitor,
  Moon,
  Palette,
  Save,
  ShieldCheck,
  Smartphone,
  Sun,
  Tablet,
  Trash2,
  User,
  Users,
  XCircle,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
} from "@/components/ui";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { useToast } from "@/context/ToastContext";
import { metaApi, safetyApi, settingsApi, type SafetyPerson } from "@/services/api";
import { ApiError, mediaUrl } from "@/services/http";
import type { SettingsData } from "@/services/types";
import { cn, timeAgo } from "@/lib/utils";

/* --------------------------------- config --------------------------------- */

type SettingKey = keyof SettingsData;
type SectionId = "account" | "privacy" | "notifications" | "security" | "appearance" | "preferences" | "danger";

/** Fields owned by each section. Text sections save explicitly, choice/toggle sections save on change. */
const SECTION_KEYS: Record<SectionId, SettingKey[]> = {
  account: ["email", "username", "phone"],
  privacy: ["visibility", "messagePermission", "connectionPermission", "activityVisible"],
  notifications: ["pushNotifications", "emailNotifications", "notifyMessages", "notifyMarketplace", "notifyNetwork"],
  security: ["twoFactorEnabled"],
  appearance: ["theme"],
  preferences: ["language", "location", "contentPreferences"],
  danger: [],
};

const NAV: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "account", label: "Account", icon: User },
  { id: "privacy", label: "Privacy", icon: Eye },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "preferences", label: "Preferences", icon: Globe },
  { id: "danger", label: "Sign out & deletion", icon: LogOut },
];

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
  { value: "ar", label: "العربية" },
  { value: "sw", label: "Kiswahili" },
  { value: "ha", label: "Hausa" },
  { value: "yo", label: "Yorùbá" },
  { value: "am", label: "አማርኛ" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "hi", label: "हिन्दी" },
  { value: "zh", label: "中文" },
];

const VISIBILITY_OPTIONS: { value: SettingsData["visibility"]; label: string; description: string; icon: LucideIcon }[] = [
  { value: "public", label: "Public", description: "Anyone on and outside Professionalist can open your profile.", icon: Globe },
  { value: "connections", label: "Connections only", description: "Only people you are connected with see your full profile.", icon: Users },
  { value: "private", label: "Private", description: "Your profile is hidden from search and from people you have not connected with.", icon: EyeOff },
];

const USERNAME_RE = /^[a-z0-9_.]{3,20}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* --------------------------------- helpers -------------------------------- */

function pick(settings: SettingsData, keys: SettingKey[]): Partial<SettingsData> {
  const out: Record<string, unknown> = {};
  keys.forEach((k) => {
    out[k] = settings[k];
  });
  return out as Partial<SettingsData>;
}

const isDirtyKeys = (a: SettingsData, b: SettingsData, keys: SettingKey[]) =>
  keys.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

/** Render a raw user-agent string as something a human recognises. */
function deviceLabel(ua: string): string {
  const s = ua || "Unknown device";
  const browser = /edg\//i.test(s)
    ? "Edge"
    : /OPR|Opera/i.test(s)
      ? "Opera"
      : /Firefox/i.test(s)
        ? "Firefox"
        : /curl/i.test(s)
          ? "Command line"
          : /Chrome/i.test(s)
            ? "Chrome"
            : /Safari/i.test(s)
              ? "Safari"
              : "Browser";
  const os = /Windows/i.test(s)
    ? "Windows"
    : /Android/i.test(s)
      ? "Android"
      : /iPhone|iPad|iPod/i.test(s)
        ? "iOS"
        : /Mac OS X/i.test(s)
          ? "macOS"
          : /Linux/i.test(s)
            ? "Linux"
            : "";
  const kind = /Android|iPhone|Mobile/i.test(s) ? "Mobile" : /iPad|Tablet/i.test(s) ? "Tablet" : "Desktop";
  return [browser, os, kind].join(" · ");
}

function deviceIcon(ua: string): LucideIcon {
  if (/Android|iPhone|Mobile/i.test(ua)) return Smartphone;
  if (/iPad|Tablet/i.test(ua)) return Tablet;
  return Monitor;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function strengthOf(pw: string): { score: number; label: string } {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const score = Math.min(4, s);
  return { score, label: ["Too short", "Weak", "Fair", "Strong", "Excellent"][score] };
}

/* ------------------------------ layout pieces ------------------------------ */

function SectionShell({
  id,
  title,
  description,
  icon,
  dirty,
  saving,
  showFooter,
  highlight,
  onSave,
  onDiscard,
  footerNote,
  children,
}: {
  id: SectionId;
  title: string;
  description: string;
  icon: ReactNode;
  dirty: boolean;
  saving: boolean;
  showFooter: boolean;
  highlight: boolean;
  onSave: () => void;
  onDiscard: () => void;
  footerNote?: string;
  children: ReactNode;
}) {
  return (
    <Card id={id} className={cn("scroll-mt-24 p-4 anim-fade-up transition-shadow sm:p-5", highlight && "ring-2 ring-accent")}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-bold">
            {title}
            {dirty && (
              <Badge tone="warn">
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> Unsaved changes
              </Badge>
            )}
            {saving && (
              <Badge tone="accent">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> Saving
              </Badge>
            )}
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-soft">{description}</p>
        </div>
      </div>

      {children}

      {showFooter ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <p className="min-w-0 flex-1 text-xs text-ink-faint">{dirty ? "You changed something here — save to keep it." : "Everything in this section is saved."}</p>
          <div className="flex shrink-0 gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={onDiscard}>
                Discard
              </Button>
            )}
            <Button size="sm" onClick={onSave} loading={saving} disabled={!dirty}>
              <Save size={15} aria-hidden /> Save changes
            </Button>
          </div>
        </div>
      ) : (
        footerNote && <p className="mt-4 border-t border-line pt-3 text-xs text-ink-faint">{footerNote}</p>
      )}
    </Card>
  );
}

function Fieldset({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <legend className="mb-2 text-[13px] font-bold">{legend}</legend>
      {/* The shared SegmentedControl exposes role="tablist" without its own name, so the group carries the label. */}
      <div role="group" aria-label={legend}>
        {children}
      </div>
      {hint && <p className="mt-2 text-xs text-ink-faint">{hint}</p>}
    </fieldset>
  );
}

function SwitchRow({ checked, onChange, label, description, busy }: { checked: boolean; onChange: (v: boolean) => void; label: string; description: string; busy: boolean }) {
  return (
    <div className={cn("flex min-h-[52px] items-center border-b border-line py-2 transition-opacity last:border-0", busy && "opacity-55")}>
      <Switch checked={checked} onChange={onChange} label={label} description={description} />
    </div>
  );
}

function OptionCards<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  busy,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string; description: string; icon?: LucideIcon }[];
  onChange: (v: T) => void;
  busy: boolean;
}) {
  return (
    <fieldset className={cn("border-t border-line pt-4 first:border-t-0 first:pt-0 transition-opacity", busy && "opacity-55")}>
      <legend className="mb-2.5 text-[13px] font-bold">{legend}</legend>
      <div className="grid gap-2">
        {options.map((o) => {
          const Icon = o.icon;
          const selected = value === o.value;
          return (
            <label
              key={o.value}
              className={cn(
                "flex min-h-[56px] cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2"
              )}
            >
              <input type="radio" name={name} value={o.value} checked={selected} onChange={() => onChange(o.value)} className="sr-only" />
              {Icon && (
                <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", selected ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-soft")} aria-hidden>
                  <Icon size={16} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{o.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-soft">{o.description}</span>
              </span>
              <span
                className={cn("mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2", selected ? "border-accent" : "border-line-strong")}
                aria-hidden
              >
                {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/* ------------------------------- password form ------------------------------ */

function PasswordForm() {
  const toast = useToast();
  const [values, setValues] = useState({ current: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const strength = strengthOf(values.next);

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    setErrors((prev) => (prev[k] ? { ...prev, [k]: "" } : prev));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!values.current) local.current = "Enter your current password";
    if (values.next.length < 8) local.next = "Use at least 8 characters";
    if (values.next === values.current) local.next = "New password must be different";
    if (values.confirm !== values.next) local.confirm = "Passwords do not match";
    setErrors(local);
    if (Object.keys(local).length) return;

    setBusy(true);
    try {
      await settingsApi.changePassword(values.current, values.next);
      setValues({ current: "", next: "", confirm: "" });
      setErrors({});
      toast.success("Password changed", "Use it the next time you sign in.");
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
        const map: Record<string, string> = {};
        if (err.fieldErrors.current) map.current = err.fieldErrors.current;
        if (err.fieldErrors.next) map.next = err.fieldErrors.next;
        setErrors(map);
      }
      toast.error("Could not change password", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 border-t border-line pt-4" noValidate>
      <div>
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <KeyRound size={15} className="text-accent" aria-hidden /> Change password
        </h3>
        <p className="mt-0.5 text-xs text-ink-soft">Changing your password does not sign other devices out — revoke them in Security.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="relative sm:col-span-2">
          <Input
            label="Current password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            value={values.current}
            onChange={set("current")}
            error={errors.current}
            placeholder="••••••••"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Hide passwords" : "Show passwords"}
            className="absolute right-3 top-[34px] rounded-lg p-1.5 text-ink-faint transition-colors hover:text-ink"
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        <div className="relative">
          <Input
            label="New password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={values.next}
            onChange={set("next")}
            error={errors.next}
            placeholder="At least 8 characters"
          />
          {values.next.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex h-1 flex-1 gap-1" role="meter" aria-valuenow={strength.score} aria-valuemin={0} aria-valuemax={4} aria-label="New password strength">
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      "flex-1 rounded-full",
                      i < strength.score
                        ? strength.score <= 1
                          ? "bg-danger"
                          : strength.score === 2
                            ? "bg-warn"
                            : "bg-success"
                        : "bg-surface-2"
                    )}
                  />
                ))}
              </div>
              <span className="w-[4.5rem] shrink-0 text-right text-xs font-semibold text-ink-soft">{strength.label}</span>
            </div>
          )}
        </div>

        <Input
          label="Confirm new password"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          value={values.confirm}
          onChange={set("confirm")}
          error={errors.confirm}
          placeholder="Repeat it"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={!values.current || !values.next || !values.confirm}>
          Update password
        </Button>
        <span className="text-xs text-ink-faint">Minimum 8 characters — mix case, numbers and a symbol.</span>
      </div>
    </form>
  );
}

/* ------------------------------ content prefs ----------------------------- */

function ContentPreferences({
  available,
  value,
  onChange,
  loading,
}: {
  available: string[];
  value: string[];
  onChange: (next: string[]) => void;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (loading && available.length === 0) {
    return (
      <div className="flex flex-wrap gap-1.5" aria-busy="true" aria-label="Loading content categories">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-28 rounded-full" />
        ))}
      </div>
    );
  }

  if (!available.length) {
    return <p className="text-sm text-ink-soft">Categories are unavailable right now — your existing picks are kept.</p>;
  }

  const visible = expanded ? available : available.slice(0, 8);
  const selectedOutside = value.filter((v) => !visible.includes(v));

  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Content preference categories">
        {visible.map((c) => {
          const on = value.includes(c);
          return (
            <Chip key={c} active={on} onClick={() => onChange(on ? value.filter((v) => v !== c) : [...value, c])}>
              {on && <CheckCircle2 size={13} aria-hidden />}
              {c}
            </Chip>
          );
        })}
        {selectedOutside.map((c) => (
          <Chip key={c} active onClick={() => onChange(value.filter((v) => v !== c))}>
            <CheckCircle2 size={13} aria-hidden />
            {c}
          </Chip>
        ))}
      </div>
      {available.length > 8 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2.5 inline-flex min-h-[36px] items-center gap-1 text-[13px] font-semibold text-accent hover:underline"
        >
          {expanded ? "Show fewer" : `Show all ${available.length} categories`}
          <ChevronDown size={14} className={cn("transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
      )}
    </div>
  );
}

/* -------------------------------- skeleton -------------------------------- */

function SettingsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading your settings">
      <Card className="space-y-3 p-4 sm:p-5">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-3.5 w-72" />
      </Card>
      <div className="grid items-start gap-4 lg:grid-cols-[218px_minmax(0,1fr)]">
        <Card className="hidden p-2 lg:block">
          <div className="space-y-1.5">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-9 rounded-lg" />
            ))}
          </div>
        </Card>
        <div className="min-w-0 space-y-4">
          <Card className="p-1.5 lg:hidden">
            <div className="flex gap-1.5 overflow-x-auto hide-scrollbar">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-28 shrink-0 rounded-lg" />
              ))}
            </div>
          </Card>
          {Array.from({ length: 3 }).map((_, s) => (
            <Card key={s} className="space-y-4 p-4 sm:p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-60" />
                </div>
              </div>
              {s === 0 ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 rounded-xl" />
                  ))}
                </div>
              ) : (
                <div>
                  {Array.from({ length: 3 }).map((_, r) => (
                    <div key={r} className="flex items-center justify-between gap-4 border-b border-line py-3 last:border-0">
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-3.5 w-40" />
                        <Skeleton className="h-3 w-64" />
                      </div>
                      <Skeleton className="h-6 w-11 rounded-full" />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function PageHeader({ anyDirty }: { anyDirty?: boolean }) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4 anim-fade-up sm:p-5">
      <div className="min-w-0">
        <h1 className="text-xl font-extrabold sm:text-2xl">Settings</h1>
        <p className="mt-0.5 text-sm text-ink-soft">Account, privacy, notifications and appearance — every section saves on its own.</p>
      </div>
      <div className="flex items-center gap-2">
        {anyDirty ? (
          <Badge tone="warn">
            <AlertTriangle size={12} aria-hidden /> Unsaved changes
          </Badge>
        ) : (
          <Badge tone="success">
            <CheckCircle2 size={12} aria-hidden /> All changes saved
          </Badge>
        )}
      </div>
    </Card>
  );
}

function DeleteAccountDialog({ onClose, onContact }: { onClose: () => void; onContact: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Deleting your account"
      mobileSheet
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="danger" onClick={onContact}>
            Contact support
          </Button>
        </>
      }
    >
      <ul className="space-y-2 text-sm text-ink-soft">
        <li className="flex gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <span>Your profile, listings, posts and messages are removed permanently.</span>
        </li>
        <li className="flex gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <span>Open orders and campaigns are cancelled first — a specialist checks them with you.</span>
        </li>
        <li className="flex gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <span>Requests are confirmed by email, so we never delete the wrong account.</span>
        </li>
      </ul>
      <p className="mt-3 rounded-xl bg-surface-2 p-3 text-xs leading-relaxed text-ink-soft">
        There is no self-service deletion endpoint in the app yet, so this screen cannot delete the account itself. Opening the Help Center lets you file
        the removal request with the team.
      </p>
    </Modal>
  );
}

/* ---------------------------------- page ---------------------------------- */

/**
 * The undo surface for the video feed's safety menu.  Mutes hide a creator's posts from YOUR
 * feeds on every device (the server filters them out of GET /posts/feed and the videos ranking);
 * blocks also tear down follows, which is why the platform asks before doing it.  Both lists are
 * server reads, so a mute made on a phone can be lifted here on the desktop.
 */
function SafetyLists() {
  const toast = useToast();
  const mutesQ = useAsync(() => safetyApi.mutes(), []);
  const blocksQ = useAsync(() => safetyApi.blocks(), []);
  const [busyId, setBusyId] = useState<string | null>(null);

  const undo = async (kind: "mute" | "block", id: number, name: string) => {
    setBusyId(`${kind}:${id}`);
    try {
      if (kind === "mute") await safetyApi.unmute(id);
      else await safetyApi.unblock(id);
      (kind === "mute" ? mutesQ : blocksQ).refetch();
      toast.success(kind === "mute" ? `${name} unmuted` : `${name} unblocked`, "Their posts are back in your feeds.");
    } catch (err) {
      toast.error(kind === "mute" ? "Could not unmute" : "Could not unblock", errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const list = (
    kind: "mute" | "block",
    query: { data: { items: SafetyPerson[] } | null; loading: boolean; error: unknown },
    emptyText: string,
  ) => {
    if (query.loading && !query.data) return <p className="text-xs text-ink-faint">Loading…</p>;
    if (query.error) return <p className="text-xs text-danger">{"Could not load this list."}</p>;
    const items = query.data?.items ?? [];
    if (!items.length) return <p className="text-xs text-ink-faint">{emptyText}</p>;
    return (
      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.id} className="flex items-center gap-3">
            <Avatar name={p.name || p.username} src={p.avatarUrl} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{p.name}</span>
              <span className="block truncate text-xs text-ink-faint">@{p.username}</span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busyId === `${kind}:${p.id}`}
              onClick={() => void undo(kind, p.id, p.name || p.username)}
            >
              {kind === "mute" ? "Unmute" : "Unblock"}
            </Button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <Fieldset legend="Muted & blocked creators" hint="Muting hides a creator from your feeds without touching follows; blocking also removes the follow. Both are account-wide.">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-soft">Muted</p>
          {list("mute", mutesQ, "You have not muted anyone.")}
        </div>
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-soft">Blocked</p>
          {list("block", blocksQ, "You have not blocked anyone.")}
        </div>
      </div>
    </Fieldset>
  );
}

export default function SettingsPage() {
  const { user, logout, refreshUser } = useAuth();
  const { theme, resolved, setTheme } = useTheme();
  const toast = useToast();
  const navigate = useNavigate();

  const q = useAsync(() => settingsApi.get(), []);
  const categoriesQ = useAsync(() => metaApi.professionalCategories(), []);

  const [form, setForm] = useState<SettingsData | null>(null);
  const [savingSection, setSavingSection] = useState<SectionId | null>(null);
  const [pendingKeys, setPendingKeys] = useState<Partial<Record<SettingKey, boolean>>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [activeSection, setActiveSection] = useState<SectionId>("account");
  const [flash, setFlash] = useState<SectionId | null>(null);
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null);
  const [revokeAllBusy, setRevokeAllBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const linkedRef = useRef(false);

  const baseline = q.data;
  const ready = !!form && !!baseline;

  useEffect(() => {
    document.title = "Settings | Professionalist";
  }, []);

  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);

  /* the theme provider owns the applied theme — mirror it into the form */
  useEffect(() => {
    setForm((f) => (f && f.theme !== theme ? { ...f, theme } : f));
  }, [theme]);

  /* deep links such as /settings#security */
  useEffect(() => {
    if (!ready || linkedRef.current) return;
    linkedRef.current = true;
    const raw = window.location.hash.replace("#", "") as SectionId;
    if (!raw) return;
    const el = document.getElementById(raw);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(raw);
    setFlash(raw);
    const t = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(t);
  }, [ready]);

  /* scroll spy drives aria-current on the anchor nav */
  useEffect(() => {
    if (!ready) return;
    const targets = NAV.map((n) => document.getElementById(n.id)).filter((el): el is HTMLElement => !!el);
    if (!targets.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveSection(visible.target.id as SectionId);
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: 0 }
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [ready]);

  const patchForm = useCallback((patch: Partial<SettingsData>) => setForm((f) => (f ? { ...f, ...patch } : f)), []);

  /** Save instantly (switches, radio groups, segmented controls, theme) with optimistic update + rollback. */
  const saveInstant = useCallback(
    async (patch: Partial<SettingsData>, message: string) => {
      if (!baseline || !form) return;
      const prevForm = form;
      const prevBaseline = baseline;
      const keys = Object.keys(patch) as SettingKey[];

      const markPending: Partial<Record<SettingKey, boolean>> = {};
      keys.forEach((k) => {
        markPending[k] = true;
      });
      setPendingKeys((p) => ({ ...p, ...markPending }));
      patchForm(patch);
      q.setData({ ...baseline, ...patch });

      try {
        await settingsApi.update(patch);
        toast.success(message);
      } catch (e) {
        setForm(prevForm);
        q.setData(prevBaseline);
        toast.error("Could not save", errorMessage(e));
      } finally {
        setPendingKeys((p) => {
          const next = { ...p };
          keys.forEach((k) => {
            delete next[k];
          });
          return next;
        });
      }
    },
    [baseline, form, patchForm, q, toast]
  );

  /** Explicit section save for text fields, with inline ApiError.fieldErrors. */
  const saveSection = async (id: SectionId) => {
    if (!form || !baseline) return;
    const keys = SECTION_KEYS[id];
    if (!keys.length) return;

    if (id === "account") {
      const local: Record<string, string> = {};
      if (!EMAIL_RE.test(form.email.trim())) local.email = "Enter a valid email address";
      if (!USERNAME_RE.test(form.username.trim())) local.username = "3-20 characters: letters, numbers, dots, underscores";
      if (Object.keys(local).length) {
        setFieldErrors(local);
        toast.error("Check the highlighted fields");
        return;
      }
    }

    const patch = pick(form, keys);
    setSavingSection(id);
    setFieldErrors({});
    try {
      const updated = await settingsApi.update(patch);
      const authoritative = pick(updated, keys);
      q.setData((prev) => ({ ...(prev ?? updated), ...authoritative }));
      patchForm(authoritative);
      if (id === "account" && updated.email !== baseline.email) void refreshUser();
      toast.success("Changes saved", id === "account" ? "Your account details are up to date." : "Your preferences are up to date.");
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setFieldErrors(e.fieldErrors);
      toast.error("Could not save", errorMessage(e));
    } finally {
      setSavingSection(null);
    }
  };

  const discardSection = (id: SectionId) => {
    if (!form || !baseline) return;
    patchForm(pick(baseline, SECTION_KEYS[id]));
    setFieldErrors({});
    toast.info("Changes discarded");
  };

  const dirtyFor = (id: SectionId) => !!form && !!baseline && isDirtyKeys(form, baseline, SECTION_KEYS[id]);
  const anyDirty = NAV.some((n) => dirtyFor(n.id));

  /* -------------------------------- sessions ------------------------------- */

  const sessions = form?.sessions ?? [];
  const currentSessionId = useMemo(() => {
    const currents = sessions.filter((s) => s.current);
    if (!currents.length) return null;
    return currents.reduce((a, b) => (new Date(a.lastActive) >= new Date(b.lastActive) ? a : b)).id;
  }, [sessions]);

  const revokeOne = async (id: string) => {
    if (!form || !baseline) return;
    const prevForm = form;
    const without = (s: SettingsData): SettingsData => ({ ...s, sessions: s.sessions.filter((x) => x.id !== id) });
    setForm(without(form));
    q.setData(without(baseline));
    setRevokeBusyId(id);
    try {
      await settingsApi.revokeSession(id);
      toast.success("Session revoked", "That device has been signed out.");
    } catch (e) {
      setForm(prevForm);
      q.setData(baseline);
      toast.error("Could not revoke session", errorMessage(e));
    } finally {
      setRevokeBusyId(null);
    }
  };

  const revokeAllOthers = async () => {
    if (!form) return;
    const others = form.sessions.filter((s) => s.id !== currentSessionId);
    if (!others.length) {
      toast.info("Nothing to revoke", "This is the only session we can see.");
      return;
    }
    const prevForm = form;
    const ids = new Set(others.map((o) => o.id));
    setRevokeAllBusy(true);
    setForm({ ...form, sessions: form.sessions.filter((s) => !ids.has(s.id)) });
    let failed = 0;
    await Promise.all(
      others.map((s) =>
        settingsApi.revokeSession(s.id).catch(() => {
          failed += 1;
        })
      )
    );
    setRevokeAllBusy(false);
    if (failed) {
      setForm(prevForm);
      toast.error(`${failed} of ${others.length} sessions could not be revoked`, "Refreshing the list to show what is still active.");
    } else {
      toast.success("Signed out everywhere else", `${others.length} session${others.length === 1 ? "" : "s"} revoked.`);
    }
    q.refetch();
  };

  /* -------------------------------- render --------------------------------- */

  if (!ready) {
    if (q.loading) return <SettingsSkeleton />;
    return (
      <div className="space-y-4">
        <PageHeader />
        <Card className="p-4 sm:p-6">
          <ErrorState message={errorMessage(q.error)} onRetry={q.refetch} />
        </Card>
      </div>
    );
  }

  const busy = (key: SettingKey) => !!pendingKeys[key];
  const anyPending = (id: SectionId) => SECTION_KEYS[id].some(busy);
  const loginHistory = form.loginHistory ?? [];
  const failedLogins = loginHistory.filter((l) => !l.success).length;
  const revocableCount = sessions.filter((s) => s.id !== currentSessionId).length;

  return (
    <div className="space-y-4">
      <PageHeader anyDirty={anyDirty} />

      <div className="grid items-start gap-4 lg:grid-cols-[218px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="card sticky top-14 z-20 hidden max-h-[calc(100dvh-5rem)] overflow-y-auto p-1.5 hide-scrollbar sm:top-16 lg:block">
          <ul className="space-y-0.5">
            {NAV.map((n) => (
              <li key={n.id}>
                <a
                  href={`#${n.id}`}
                  aria-current={activeSection === n.id ? "true" : undefined}
                  className={cn(
                    "flex min-h-[40px] items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors",
                    activeSection === n.id ? "bg-accent-soft text-accent" : "text-ink-soft hover:bg-surface-2 hover:text-ink"
                  )}
                >
                  <n.icon size={16} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  {dirtyFor(n.id) && (
                    <>
                      <span className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
                      <span className="sr-only">unsaved changes</span>
                    </>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-4">
          <nav aria-label="Settings sections, compact" className="card flex gap-1.5 overflow-x-auto p-1.5 hide-scrollbar lg:hidden">
            {NAV.map((n) => (
              <a
                key={n.id}
                href={`#${n.id}`}
                aria-current={activeSection === n.id ? "true" : undefined}
                className={cn(
                  "flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors",
                  activeSection === n.id ? "bg-accent-soft text-accent" : "text-ink-soft hover:bg-surface-2"
                )}
              >
                <n.icon size={14} aria-hidden />
                {n.label}
                {dirtyFor(n.id) && (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
                    <span className="sr-only">unsaved changes</span>
                  </>
                )}
              </a>
            ))}
          </nav>

          {/* -------------------------------- account ------------------------------- */}
          <SectionShell
            id="account"
            title="Account"
            description="Your sign-in details. The username is what appears in your profile URL."
            icon={<User size={18} />}
            dirty={dirtyFor("account")}
            saving={savingSection === "account"}
            showFooter
            highlight={flash === "account"}
            onSave={() => void saveSection("account")}
            onDiscard={() => discardSection("account")}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Email address"
                type="email"
                autoComplete="email"
                icon={<Globe size={15} />}
                value={form.email}
                onChange={(e) => patchForm({ email: e.target.value })}
                error={fieldErrors.email}
                hint="Used for sign-in and receipts"
              />
              <Input
                label="Username"
                autoComplete="username"
                value={form.username}
                onChange={(e) => patchForm({ username: e.target.value })}
                error={fieldErrors.username}
                hint={`Your profile lives at /profile/${form.username || "username"}`}
              />
              <Input
                label="Phone"
                type="tel"
                autoComplete="tel"
                icon={<Smartphone size={15} />}
                value={form.phone}
                onChange={(e) => patchForm({ phone: e.target.value })}
                error={fieldErrors.phone}
                placeholder="+234 800 000 0000"
                hint="Optional — only buyers see it if it is on your profile"
              />
              <div className="flex min-w-0 items-center gap-3 rounded-xl border border-line bg-surface-2/60 p-3">
                <Avatar name={user ? `${user.firstName} ${user.lastName}` : form.username} src={mediaUrl(user?.profile.avatarUrl)} size="md" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold">{user ? `${user.firstName} ${user.lastName}` : form.username}</p>
                  <p className="truncate text-xs text-ink-soft">Name, photo and bio live on your profile</p>
                  <button type="button" onClick={() => navigate("/profile/edit")} className="mt-1 text-xs font-semibold text-accent hover:underline">
                    Edit public profile
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-5">
              <PasswordForm />
            </div>
          </SectionShell>

          {/* -------------------------------- privacy ------------------------------- */}
          <SectionShell
            id="privacy"
            title="Privacy"
            description="Who can see your profile, message you and send invitations."
            icon={<Eye size={18} />}
            dirty={dirtyFor("privacy")}
            saving={anyPending("privacy")}
            showFooter={false}
            highlight={flash === "privacy"}
            onSave={() => void saveSection("privacy")}
            onDiscard={() => discardSection("privacy")}
            footerNote="Choices in this section save the moment you change them."
          >
            <div className="space-y-5">
              <OptionCards
                legend="Profile visibility"
                name="visibility"
                value={form.visibility}
                options={VISIBILITY_OPTIONS}
                busy={busy("visibility")}
                onChange={(v) => void saveInstant({ visibility: v }, v === "public" ? "Profile is now public" : v === "connections" ? "Profile is now connections-only" : "Profile is now private")}
              />

              <Fieldset legend="Who can message you" hint="Anyone already in a conversation with you can always reply.">
                <SegmentedControl
                  className="w-full [&>button]:flex-1"
                  value={form.messagePermission}
                  onChange={(v) => void saveInstant({ messagePermission: v as SettingsData["messagePermission"] }, "Message permission saved")}
                  options={[
                    { value: "everyone", label: "Everyone" },
                    { value: "connections", label: "Connections only" },
                  ]}
                />
              </Fieldset>

              <Fieldset legend="Who can send connection requests" hint="Restricting this cuts spam but slows network growth.">
                <SegmentedControl
                  className="w-full [&>button]:flex-1"
                  value={form.connectionPermission}
                  onChange={(v) => void saveInstant({ connectionPermission: v as SettingsData["connectionPermission"] }, "Connection permission saved")}
                  options={[
                    { value: "everyone", label: "Everyone" },
                    { value: "connections", label: "Connections only" },
                  ]}
                />
              </Fieldset>

              <SwitchRow
                checked={form.activityVisible}
                busy={busy("activityVisible")}
                label="Show my activity"
                description="Let your network see when you publish posts, listings and reviews."
                onChange={(v) => void saveInstant({ activityVisible: v }, v ? "Activity is now visible" : "Activity is now hidden")}
              />

              <SafetyLists />
            </div>
          </SectionShell>

          {/* ----------------------------- notifications ---------------------------- */}
          <SectionShell
            id="notifications"
            title="Notifications"
            description="Choose what reaches you and how. Muting a channel never hides it from your inbox."
            icon={<Bell size={18} />}
            dirty={dirtyFor("notifications")}
            saving={anyPending("notifications")}
            showFooter={false}
            highlight={flash === "notifications"}
            onSave={() => void saveSection("notifications")}
            onDiscard={() => discardSection("notifications")}
            footerNote="Every switch here saves instantly."
          >
            <div>
              <SwitchRow
                checked={form.pushNotifications}
                busy={busy("pushNotifications")}
                label="Push notifications"
                description="Real-time alerts on this device."
                onChange={(v) => void saveInstant({ pushNotifications: v }, v ? "Push notifications on" : "Push notifications off")}
              />
              <SwitchRow
                checked={form.emailNotifications}
                busy={busy("emailNotifications")}
                label="Email notifications"
                description="Important account emails plus a daily digest."
                onChange={(v) => void saveInstant({ emailNotifications: v }, v ? "Email notifications on" : "Email notifications off")}
              />
              <SwitchRow
                checked={form.notifyMessages}
                busy={busy("notifyMessages")}
                label="Messages"
                description="New direct messages and replies inside threads."
                onChange={(v) => void saveInstant({ notifyMessages: v }, v ? "Message alerts on" : "Message alerts off")}
              />
              <SwitchRow
                checked={form.notifyMarketplace}
                busy={busy("notifyMarketplace")}
                label="Marketplace"
                description="Offers, orders and price drops on saved listings."
                onChange={(v) => void saveInstant({ notifyMarketplace: v }, v ? "Marketplace alerts on" : "Marketplace alerts off")}
              />
              <SwitchRow
                checked={form.notifyNetwork}
                busy={busy("notifyNetwork")}
                label="Network & mentions"
                description="Invitations, follows and mentions of you."
                onChange={(v) => void saveInstant({ notifyNetwork: v }, v ? "Network alerts on" : "Network alerts off")}
              />
            </div>
          </SectionShell>

          {/* -------------------------------- security ------------------------------ */}
          <SectionShell
            id="security"
            title="Security"
            description="Two-factor authentication, active sessions and recent sign-in attempts."
            icon={<ShieldCheck size={18} />}
            dirty={dirtyFor("security")}
            saving={anyPending("security")}
            showFooter={false}
            highlight={flash === "security"}
            onSave={() => void saveSection("security")}
            onDiscard={() => discardSection("security")}
            footerNote="Two-factor saves instantly. Password changes live in the Account section."
          >
            <div className="space-y-5">
              <SwitchRow
                checked={form.twoFactorEnabled}
                busy={busy("twoFactorEnabled")}
                label="Two-factor authentication"
                description="Ask for a verification code in addition to your password at every sign-in."
                onChange={(v) => void saveInstant({ twoFactorEnabled: v }, v ? "Two-factor enabled" : "Two-factor disabled")}
              />

              <div className="rounded-xl border border-line bg-surface-2/50 p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-2 text-sm font-bold">
                      <Monitor size={15} className="text-accent" aria-hidden /> Active sessions
                    </h3>
                    <p className="mt-0.5 text-xs text-ink-soft">
                      {sessions.length ? `${sessions.length} device${sessions.length === 1 ? "" : "s"} signed in` : "No devices are signed in right now."}
                      {revocableCount > 0 && ` · ${revocableCount} revocable`}
                      {failedLogins > 0 && <span className="font-semibold text-danger"> · {failedLogins} failed sign-in attempt{failedLogins === 1 ? "" : "s"}</span>}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => void revokeAllOthers()} loading={revokeAllBusy} disabled={revocableCount === 0}>
                    <LogOut size={14} aria-hidden /> Sign out of all others
                  </Button>
                </div>

                {sessions.length === 0 ? (
                  <EmptyState
                    icon={<ShieldCheck />}
                    title="No active sessions"
                    description="Sign-ins from other devices appear here so you can revoke them."
                    action={
                      <Button size="sm" variant="outline" onClick={q.refetch}>
                        Refresh list
                      </Button>
                    }
                  />
                ) : (
                  <>
                    <div className="mt-3 hidden overflow-x-auto md:block">
                      <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                        <caption className="sr-only">Active sessions for {form.email}</caption>
                        <thead>
                          <tr className="border-b border-line">
                            <th scope="col" className="py-2 pr-3 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Device</th>
                            <th scope="col" className="py-2 pr-3 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Location</th>
                            <th scope="col" className="py-2 pr-3 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Last active</th>
                            <th scope="col" className="py-2 text-right text-[11px] font-bold uppercase tracking-wide text-ink-faint">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sessions.map((s) => {
                            const Icon = deviceIcon(s.device);
                            const isCurrent = s.id === currentSessionId;
                            return (
                              <tr key={s.id} className="border-b border-line last:border-0">
                                <td className="py-3 pr-3">
                                  <span className="flex items-center gap-2.5">
                                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden>
                                      <Icon size={15} />
                                    </span>
                                    <span className="min-w-0">
                                      <span className="block max-w-[240px] truncate font-semibold">{deviceLabel(s.device)}</span>
                                      <span className="block text-[11px] text-ink-faint">Session {s.id}</span>
                                    </span>
                                  </span>
                                </td>
                                <td className="py-3 pr-3 text-ink-soft">{s.location || "Unknown"}</td>
                                <td className="py-3 pr-3 text-ink-soft" title={formatDateTime(s.lastActive)}>
                                  {timeAgo(s.lastActive)} ago
                                </td>
                                <td className="py-3 text-right">
                                  {isCurrent ? (
                                    <Badge tone="success">
                                      <CheckCircle2 size={11} aria-hidden /> This device
                                    </Badge>
                                  ) : (
                                    <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-soft" loading={revokeBusyId === s.id} onClick={() => void revokeOne(s.id)}>
                                      Revoke
                                      <span className="sr-only"> session on {deviceLabel(s.device)}</span>
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <ul className="mt-3 space-y-2.5 md:hidden">
                      {sessions.map((s) => {
                        const Icon = deviceIcon(s.device);
                        const isCurrent = s.id === currentSessionId;
                        return (
                          <li key={s.id} className="rounded-xl border border-line bg-surface p-3">
                            <div className="flex items-start gap-3">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden>
                                <Icon size={16} />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-bold">{deviceLabel(s.device)}</p>
                                <p className="text-xs text-ink-soft">
                                  {s.location || "Unknown location"} · active {timeAgo(s.lastActive)} ago
                                </p>
                              </div>
                              {isCurrent && (
                                <Badge tone="success">
                                  <CheckCircle2 size={11} aria-hidden /> This device
                                </Badge>
                              )}
                            </div>
                            {!isCurrent && (
                              <Button size="sm" variant="outline" fullWidth className="mt-3" loading={revokeBusyId === s.id} onClick={() => void revokeOne(s.id)}>
                                <Trash2 size={14} aria-hidden /> Revoke this session
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>

              <div>
                <h3 className="flex items-center gap-2 text-sm font-bold">
                  <History size={15} className="text-ink-soft" aria-hidden /> Login history
                </h3>
                {loginHistory.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-soft">No sign-in events recorded yet.</p>
                ) : (
                  <ul className="mt-2.5 divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {loginHistory.map((l) => (
                      <li key={`login-${l.id}`} className="flex items-center gap-3 bg-surface px-3 py-2.5">
                        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", l.success ? "bg-success-soft text-success" : "bg-danger-soft text-danger")} aria-hidden>
                          {l.success ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold">{deviceLabel(l.device)}</span>
                          <span className="block truncate text-[11px] text-ink-faint">
                            {l.ip} · {formatDateTime(l.time)}
                          </span>
                        </span>
                        <Badge tone={l.success ? "success" : "danger"}>
                          {l.success ? <CheckCircle2 size={11} aria-hidden /> : <XCircle size={11} aria-hidden />}
                          {l.success ? "Success" : "Failed"}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </SectionShell>

          {/* ------------------------------- appearance ----------------------------- */}
          <SectionShell
            id="appearance"
            title="Appearance"
            description="Applies instantly across the app and is stored on your account."
            icon={<Palette size={18} />}
            dirty={dirtyFor("appearance")}
            saving={busy("theme")}
            showFooter={false}
            highlight={flash === "appearance"}
            onSave={() => void saveSection("appearance")}
            onDiscard={() => discardSection("appearance")}
            footerNote="System follows your device setting; light and dark override it."
          >
            <div className="space-y-4">
              <div>
                <p id="theme-picker-label" className="mb-2 text-[13px] font-bold">
                  Theme
                </p>
                <div role="group" aria-labelledby="theme-picker-label">
                  <SegmentedControl
                    className="w-full [&>button]:flex-1"
                    value={theme}
                    onChange={(v) => {
                      const next = v as SettingsData["theme"];
                      setTheme(next);
                      void saveInstant({ theme: next }, next === "system" ? "Theme follows your system" : next === "dark" ? "Dark mode on" : "Light mode on");
                    }}
                    options={[
                      { value: "light", label: <span className="inline-flex items-center gap-1.5"><Sun size={14} aria-hidden /> Light</span> },
                      { value: "dark", label: <span className="inline-flex items-center gap-1.5"><Moon size={14} aria-hidden /> Dark</span> },
                      { value: "system", label: <span className="inline-flex items-center gap-1.5"><Monitor size={14} aria-hidden /> System</span> },
                    ]}
                  />
                </div>
                <p className="mt-2 text-xs text-ink-faint" aria-live="polite">
                  {theme === "system" ? `Following your device — currently ${resolved} mode.` : `Using ${theme} mode.`}
                </p>
              </div>

              <div className="grid gap-2.5 sm:grid-cols-2" aria-hidden>
                {(["light", "dark"] as const).map((mode) => (
                  <div
                    key={mode}
                    className={cn(
                      "rounded-xl border border-line bg-surface p-3 text-ink",
                      mode === "dark" && "dark",
                      resolved === mode && "ring-2 ring-accent"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 text-ink-soft">
                        {mode === "dark" ? <Moon size={13} /> : <Sun size={13} />}
                      </span>
                      <span className="text-xs font-bold capitalize">{mode} preview</span>
                    </div>
                    <div className="mt-2.5 space-y-1.5 rounded-lg bg-surface-2 p-2.5">
                      <div className="h-2 w-2/3 rounded-full bg-line-strong" />
                      <div className="h-2 w-full rounded-full bg-line" />
                      <div className="h-2 w-1/3 rounded-full bg-accent" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </SectionShell>

          {/* ------------------------------ preferences ----------------------------- */}
          <SectionShell
            id="preferences"
            title="Preferences"
            description="Language, location and the topics Professionalist prioritises for you."
            icon={<Globe size={18} />}
            dirty={dirtyFor("preferences")}
            saving={savingSection === "preferences"}
            showFooter
            highlight={flash === "preferences"}
            onSave={() => void saveSection("preferences")}
            onDiscard={() => discardSection("preferences")}
          >
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  label="Language"
                  value={form.language}
                  onChange={(e) => patchForm({ language: e.target.value })}
                  options={LANGUAGES}
                />
                <Input
                  label="Location"
                  icon={<MapPin size={15} />}
                  value={form.location}
                  onChange={(e) => patchForm({ location: e.target.value })}
                  placeholder="Lagos, Nigeria"
                  hint="Powers nearby results and distance labels"
                />
              </div>

              <div>
                <p className="text-[13px] font-bold">Content preferences</p>
                <p className="mb-2.5 mt-0.5 text-xs text-ink-faint">
                  Pick the topics you want in your feed and marketplace recommendations — {form.contentPreferences.length} selected.
                </p>
                <ContentPreferences
                  available={categoriesQ.data ?? []}
                  value={form.contentPreferences}
                  loading={categoriesQ.loading}
                  onChange={(next) => patchForm({ contentPreferences: next })}
                />
                {categoriesQ.error && !categoriesQ.loading && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-danger-soft p-3">
                    <p className="min-w-0 flex-1 text-xs text-danger">{errorMessage(categoriesQ.error)}</p>
                    <Button size="sm" variant="outline" onClick={categoriesQ.refetch}>
                      Retry categories
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </SectionShell>

          {/* ---------------------------- sign out / deletion ---------------------- */}
          <SectionShell
            id="danger"
            title="Sign out & deletion"
            description="End your session on this device, or reach the team that handles account removal."
            icon={<LogOut size={18} />}
            dirty={false}
            saving={false}
            showFooter={false}
            highlight={flash === "danger"}
            onSave={() => undefined}
            onDiscard={() => undefined}
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-bold">Sign out of this account</p>
                  <p className="mt-0.5 text-xs text-ink-soft">Clears your session on this device. Other devices stay signed in until you revoke them in Security.</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void logout().then(() => {
                      toast.info("Signed out");
                      navigate("/login");
                    })
                  }
                >
                  <LogOut size={14} aria-hidden /> Sign out
                </Button>
              </div>

              <div className="rounded-xl border border-danger/40 bg-danger-soft/60 p-3.5">
                <p className="flex items-center gap-2 text-sm font-bold text-danger">
                  <AlertTriangle size={16} aria-hidden /> Delete account
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                  Account removal is verified by a person for your protection: it deletes your profile, listings, posts and messages, and cannot be undone.
                </p>
                <Button variant="danger" size="sm" className="mt-3" onClick={() => setDeleteOpen(true)}>
                  Contact support to delete
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                <span>Need something else?</span>
                <button type="button" onClick={() => navigate("/support")} className="font-semibold text-accent hover:underline">
                  Open Help Center
                </button>
                <span aria-hidden>·</span>
                <button type="button" onClick={() => navigate("/profile/edit")} className="font-semibold text-accent hover:underline">
                  Edit public profile
                </button>
              </div>
            </div>
          </SectionShell>
        </div>
      </div>

      {deleteOpen && (
        <DeleteAccountDialog
          onClose={() => setDeleteOpen(false)}
          onContact={() => {
            setDeleteOpen(false);
            navigate("/support");
          }}
        />
      )}
    </div>
  );
}
