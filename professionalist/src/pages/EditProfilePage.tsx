import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  Award,
  BadgeCheck,
  Briefcase,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  GraduationCap,
  Image as ImageIcon,
  Images,
  Info,
  Link2,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Input,
  Modal,
  ProgressBar,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { metaApi, postsApi, usersApi } from "@/services/api";
import { ApiError, mediaUrl } from "@/services/http";
import type {
  AuthUser,
  Certification,
  EducationItem,
  ExperienceItem,
  PortfolioItem,
  Profile,
} from "@/services/types";
import { cn, fullName } from "@/lib/utils";

/* --------------------------------- models --------------------------------- */

type Patch = Partial<Profile> & { firstName?: string; lastName?: string; email?: string; username?: string };
type FormKey = keyof FormState;
type Key = Extract<FormKey, keyof Patch>;

interface FormState {
  firstName: string;
  lastName: string;
  email: string;
  username: string;
  avatarUrl: string;
  coverUrl: string;
  bio: string;
  title: string;
  company: string;
  website: string;
  phone: string;
  location: string;
  country: string;
  category: string;
  skills: string[];
  interests: string[];
  experience: ExperienceItem[];
  education: EducationItem[];
  certifications: Certification[];
  portfolio: PortfolioItem[];
  visibility: Profile["visibility"];
}

type ListKey = "experience" | "education" | "certifications" | "portfolio";

const EMPTY_FORM: FormState = {
  firstName: "",
  lastName: "",
  email: "",
  username: "",
  avatarUrl: "",
  coverUrl: "",
  bio: "",
  title: "",
  company: "",
  website: "",
  phone: "",
  location: "",
  country: "",
  category: "",
  skills: [],
  interests: [],
  experience: [],
  education: [],
  certifications: [],
  portfolio: [],
  visibility: "public",
};

function toForm(u: AuthUser): FormState {
  const p = u.profile;
  return {
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    username: u.username,
    avatarUrl: p.avatarUrl,
    coverUrl: p.coverUrl,
    bio: p.bio,
    title: p.title,
    company: p.company,
    website: p.website,
    phone: p.phone,
    location: p.location,
    country: p.country,
    category: p.category,
    skills: [...p.skills],
    interests: [...p.interests],
    experience: p.experience.map((e) => ({ ...e })),
    education: p.education.map((e) => ({ ...e })),
    certifications: p.certifications.map((c) => ({ ...c })),
    portfolio: p.portfolio.map((i) => ({ ...i })),
    visibility: p.visibility,
  };
}

function pick(form: FormState, keys: Key[]): Partial<FormState> {
  const out: Record<string, unknown> = {};
  keys.forEach((k) => {
    out[k] = form[k];
  });
  return out as Partial<FormState>;
}

const SECTION_FIELDS: Record<string, Key[]> = {
  identity: ["firstName", "lastName", "username", "email", "phone", "website", "location", "country", "category"],
  story: ["bio", "title", "company"],
  experience: ["experience"],
  education: ["education"],
  certifications: ["certifications"],
  portfolio: ["portfolio"],
  skills: ["skills", "interests"],
  visibility: ["visibility"],
};

const NAV: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "photos", label: "Photos", icon: Camera },
  { id: "identity", label: "Identity", icon: User },
  { id: "story", label: "Story", icon: Sparkles },
  { id: "experience", label: "Experience", icon: Briefcase },
  { id: "education", label: "Education", icon: GraduationCap },
  { id: "certifications", label: "Certifications", icon: BadgeCheck },
  { id: "portfolio", label: "Portfolio", icon: Images },
  { id: "skills", label: "Skills & interests", icon: Award },
  { id: "visibility", label: "Visibility", icon: Info },
  { id: "account", label: "Account", icon: Trash2 },
];

const BIO_MAX = 500;
const CHIP_MAX = 20;
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_RE = /^https?:\/\/.+\..+/i;

const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const isDirty = (a: FormState, b: FormState, keys: Key[]) => keys.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

/* ------------------------------ section shell ------------------------------ */

/** Module-level so its identity stays stable while the user types. */
function Section(props: {
  id: string;
  title: string;
  description?: string;
  icon: React.ReactNode;
  dirty: boolean;
  saving: boolean;
  showFooter: boolean;
  flash: boolean;
  saveLabel: string;
  onSave: () => void;
  onDiscard: () => void;
  children: React.ReactNode;
}) {
  const { id, title, description, icon, dirty, saving, showFooter, flash, saveLabel, onSave, onDiscard, children } = props;
  return (
    <Card id={id} className={cn("scroll-mt-24 p-4 anim-fade-up transition-shadow sm:p-5", flash && "ring-2 ring-accent")}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-bold">
            {title}
            {dirty && <Badge tone="warn">Unsaved</Badge>}
          </h2>
          {description && <p className="mt-0.5 text-[13px] text-ink-soft">{description}</p>}
        </div>
      </div>

      {children}

      {showFooter && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <p className="text-xs text-ink-faint">{dirty ? "You have unsaved changes in this section." : "Everything here is saved."}</p>
          <div className="flex gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={onDiscard}>
                Discard
              </Button>
            )}
            <Button size="sm" onClick={onSave} loading={saving} disabled={!dirty}>
              <Save size={15} /> {saveLabel}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------- chip input -------------------------------- */

function ChipInput({
  label,
  hint,
  values,
  onChange,
  placeholder,
  error,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  error?: string;
}) {
  const [draft, setDraft] = useState("");
  const toast = useToast();

  const add = () => {
    const value = draft.trim().replace(/,+$/, "");
    if (!value) return;
    if (values.length >= CHIP_MAX) {
      toast.info("Limit reached", `Up to ${CHIP_MAX} entries per list.`);
      return;
    }
    if (!values.some((v) => v.toLowerCase() === value.toLowerCase())) onChange([...values, value]);
    setDraft("");
  };

  return (
    <div className="w-full">
      <label htmlFor={`chip-${label}`} className="mb-1.5 block text-[13px] font-semibold">
        {label}
      </label>
      <input
        id={`chip-${label}`}
        value={draft}
        placeholder={values.length ? "Press Enter to add another" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
          if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
        }}
        aria-describedby={hint ? `chip-hint-${label}` : undefined}
        className={cn(
          "h-10 w-full rounded-xl border bg-surface px-3.5 text-sm transition-colors placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none",
          error ? "border-danger" : "border-line"
        )}
      />
      {values.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {values.map((v) => (
            <li key={v}>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 py-1 pl-3 pr-1.5 text-[13px] font-semibold">
                {v}
                <button
                  type="button"
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  aria-label={`Remove ${v}`}
                  className="rounded-full p-1 text-ink-soft transition-colors hover:bg-surface hover:text-danger"
                >
                  <X size={13} />
                </button>
              </span>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={add}
              disabled={!draft.trim()}
              className="rounded-full border border-dashed border-line-strong px-3 py-1 text-[13px] font-semibold text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
            >
              Add
            </button>
          </li>
        </ul>
      )}
      {error ? (
        <p className="mt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`chip-hint-${label}`} className="mt-1 text-xs text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------- page ---------------------------------- */

export default function EditProfilePage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [form, setForm] = useState<FormState>(() => (user ? toForm(user) : EMPTY_FORM));
  const [saved, setSaved] = useState<FormState>(() => (user ? toForm(user) : EMPTY_FORM));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState<"avatar" | "cover" | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ kind: ListKey | "certification"; id?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => void } | null>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);

  const avatarInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  const progressQ = useAsync(() => usersApi.progress(), []);
  const countriesQ = useAsync(() => metaApi.countries(), []);
  const categoriesQ = useAsync(() => metaApi.professionalCategories(), []);

  useEffect(() => {
    document.title = "Edit profile | Professionalist";
  }, []);

  /* jump + highlight the section named in the URL hash */
  useEffect(() => {
    const id = location.hash.replace("#", "");
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlash(id);
    const t = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(t);
  }, [location.hash]);

  const dirtySections = useMemo(
    () => Object.entries(SECTION_FIELDS).filter(([, keys]) => isDirty(form, saved, keys)).map(([id]) => id),
    [form, saved]
  );
  const anyDirty = dirtySections.length > 0;

  /* warn before navigating away with unsaved edits (BrowserRouter has no blocker) */
  useEffect(() => {
    if (!anyDirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href || href.startsWith("#") || /^https?:/i.test(href) || anchor.target === "_blank" || anchor.download) return;
      e.preventDefault();
      setLeaveTo(href);
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, [anyDirty]);

  useEffect(() => {
    if (!anyDirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [anyDirty]);

  if (!user) return null;

  const setField = <K extends FormKey>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  /** Persist a patch and sync the authoritative values back into form + saved snapshots. */
  const applyPatch = async (patch: Patch, keys: Key[], message: string) => {
    const updated = await usersApi.updateProfile(patch);
    const authoritative = toForm(updated);
    setUser(updated);
    setForm((f) => ({ ...f, ...pick(authoritative, keys) }));
    setSaved((s) => ({ ...s, ...pick(authoritative, keys) }));
    setFieldErrors({});
    progressQ.refetch();
    toast.success(message);
  };

  const saveSection = async (id: string) => {
    const keys = SECTION_FIELDS[id];
    if (!keys) return;
    if (id === "identity") {
      const local: Record<string, string> = {};
      if (!form.firstName.trim()) local.firstName = "First name is required";
      if (!form.lastName.trim()) local.lastName = "Last name is required";
      if (!EMAIL_RE.test(form.email)) local.email = "Enter a valid email address";
      if (!USERNAME_RE.test(form.username)) local.username = "3-20 characters: letters, numbers, dots, underscores";
      if (form.website && !URL_RE.test(form.website)) local.website = "Use a full URL, e.g. https://studio.example";
      if (Object.keys(local).length) {
        setFieldErrors(local);
        toast.error("Check the highlighted fields");
        return;
      }
    }
    setSavingSection(id);
    try {
      await applyPatch(pick(form, keys) as Patch, keys, "Changes saved");
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setFieldErrors(e.fieldErrors);
      toast.error(errorMessage(e));
    } finally {
      setSavingSection(null);
    }
  };

  const resetSection = (id: string) => {
    const keys = SECTION_FIELDS[id];
    if (!keys) return;
    setForm((f) => ({ ...f, ...pick(saved, keys) }));
    setFieldErrors({});
    toast.info("Changes discarded");
  };

  const commitList = async (key: ListKey, next: FormState[ListKey], message: string) => {
    setSavingSection(key);
    try {
      await applyPatch({ [key]: next } as Patch, [key], message);
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setFieldErrors(e.fieldErrors);
      toast.error(errorMessage(e));
    } finally {
      setSavingSection(null);
    }
  };

  const uploadPhoto = async (kind: "avatar" | "cover", file: File) => {
    setPhotoBusy(kind);
    const key: Key = kind === "avatar" ? "avatarUrl" : "coverUrl";
    try {
      const r = kind === "avatar" ? await usersApi.uploadAvatar(file) : await usersApi.uploadCover(file);
      await applyPatch({ [key]: r.url } as Patch, [key], kind === "avatar" ? "Profile photo updated" : "Cover image updated");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPhotoBusy(null);
    }
  };

  const removePhoto = (kind: "avatar" | "cover") => {
    const key: Key = kind === "avatar" ? "avatarUrl" : "coverUrl";
    setConfirm({
      title: kind === "avatar" ? "Remove profile photo?" : "Remove cover image?",
      body: kind === "avatar"
        ? "Your profile will fall back to the initials badge."
        : "Your profile will fall back to the branded gradient cover.",
      action: () => {
        setSavingSection("photos");
        applyPatch({ [key]: "" } as Patch, [key], "Photo removed")
          .catch((e) => toast.error(errorMessage(e)))
          .finally(() => setSavingSection(null));
      },
    });
  };

  const removeListRow = (key: ListKey, id: string, label: string) => {
    setConfirm({
      title: `Delete ${label.toLowerCase()}?`,
      body: "This removes it from your profile straight away. You can add it again any time.",
      action: () => {
        const next = (form[key] as { id: string }[]).filter((row) => row.id !== id) as FormState[ListKey];
        void commitList(key, next, `${label} deleted`);
      },
    });
  };

  /* ------------------------------ render pieces ----------------------------- */

  const section = (
    id: string,
    title: string,
    description: string,
    icon: React.ReactNode,
    children: React.ReactNode,
    opts?: { saveLabel?: string; fields?: Key[] }
  ) => {
    const keys = opts?.fields ?? SECTION_FIELDS[id] ?? [];
    return (
      <Section
        id={id}
        title={title}
        description={description}
        icon={icon}
        dirty={keys.length > 0 && isDirty(form, saved, keys)}
        saving={savingSection === id}
        showFooter={keys.length > 0}
        flash={flash === id}
        saveLabel={opts?.saveLabel ?? "Save changes"}
        onSave={() => void saveSection(id)}
        onDiscard={() => resetSection(id)}
      >
        {children}
      </Section>
    );
  };

  const photoBlock = (kind: "avatar" | "cover", label: string, hint: string, value: string, alt: string) => (
    <div className="min-w-0">
      <p className="text-[13px] font-semibold">{label}</p>
      <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>
      <div className={cn("mt-2.5 overflow-hidden rounded-xl border border-line bg-surface-2", kind === "cover" ? "h-28 w-full sm:h-36 sm:max-w-md" : "h-24 w-24")}>
        {value ? (
          <img src={mediaUrl(value)} alt={alt} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center gap-2 text-ink-faint">
            {kind === "cover" ? <ImageIcon size={20} aria-hidden /> : <Avatar name={fullName(user)} size="sm" />}
            <span className="text-xs font-semibold">No image yet</span>
          </div>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          loading={photoBusy === kind}
          onClick={() => (kind === "avatar" ? avatarInput.current?.click() : coverInput.current?.click())}
        >
          <Camera size={14} /> Change
        </Button>
        {value && (
          <Button size="sm" variant="ghost" onClick={() => removePhoto(kind)} disabled={savingSection === "photos"}>
            <Trash2 size={14} /> Remove
          </Button>
        )}
      </div>
    </div>
  );

  const listRow = (primary: string, secondary?: string, meta?: string, id?: string, onEdit?: () => void, onDelete?: () => void) => (
    <li key={id} className="flex items-start gap-3 border-t border-line py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold break-words">{primary}</p>
        {secondary && <p className="text-[13px] text-ink-soft break-words">{secondary}</p>}
        {meta && <p className="mt-0.5 text-xs text-ink-faint tabular-nums">{meta}</p>}
      </div>
      <div className="flex shrink-0 gap-1">
        {onEdit && (
          <button onClick={onEdit} aria-label={`Edit ${primary}`} className="rounded-lg p-2.5 text-ink-soft transition-colors hover:bg-surface-2 hover:text-accent">
            <Pencil size={15} />
          </button>
        )}
        {onDelete && (
          <button onClick={onDelete} aria-label={`Delete ${primary}`} className="rounded-lg p-2.5 text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger">
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </li>
  );

  const metaField = (
    id: string,
    label: string,
    q: { data: string[] | null; loading: boolean; error: unknown; refetch: () => void },
    value: string,
    onChange: (v: string) => void,
    placeholder: string
  ) => (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold">
        {label}
      </label>
      {q.loading ? (
        <Skeleton className="h-10 w-full rounded-xl" />
      ) : q.error ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-danger/40 bg-danger-soft/40 p-2">
          <p className="min-w-0 flex-1 break-words text-xs text-danger">{errorMessage(q.error)}</p>
          <Button size="sm" variant="outline" onClick={q.refetch}>
            Try again
          </Button>
        </div>
      ) : (
        <Select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          options={(q.data ?? []).map((c) => ({ value: c, label: c }))}
        />
      )}
    </div>
  );

  const emptyRow = (text: string) => (
    <p className="rounded-xl border border-dashed border-line p-4 text-sm text-ink-soft">{text}</p>
  );

  const expItem = editor?.kind === "experience" && editor.id ? form.experience.find((e) => e.id === editor.id) : undefined;
  const eduItem = editor?.kind === "education" && editor.id ? form.education.find((e) => e.id === editor.id) : undefined;
  const certItem = editor?.kind === "certification" && editor.id ? form.certifications.find((c) => c.id === editor.id) : undefined;
  const portItem = editor?.kind === "portfolio" && editor.id ? form.portfolio.find((p) => p.id === editor.id) : undefined;

  return (
    <div className="space-y-4">
      {/* ------------------------------ page header ------------------------------ */}
      <Card className="p-4 anim-fade-up sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold">Edit profile</h1>
            <p className="mt-0.5 text-[13px] text-ink-soft">Everything here is what clients and partners see on your profile.</p>
          </div>
          <Link to={`/profile/${form.username || user.username}`}>
            <Button variant="outline" size="sm">
              View public profile <ChevronRight size={15} />
            </Button>
          </Link>
        </div>

        <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold">
              Profile {progressQ.data ? `${progressQ.data.profileCompletion}%` : ""} complete
            </p>
            {anyDirty && (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-warn">
                <CircleAlert size={13} aria-hidden />
                {dirtySections.length} section{dirtySections.length > 1 ? "s" : ""} unsaved
              </p>
            )}
          </div>
          {progressQ.loading ? (
            <Skeleton className="mt-3 h-1.5 w-full rounded-full" />
          ) : progressQ.error ? (
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 text-xs text-danger">{errorMessage(progressQ.error)}</p>
              <Button size="sm" variant="outline" onClick={progressQ.refetch}>
                Retry
              </Button>
            </div>
          ) : (
            <>
              <ProgressBar value={progressQ.data?.profileCompletion ?? 0} showLabel className="mt-3" />
              {progressQ.data && progressQ.data.profileSuggestions.length > 0 && (
                <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
                  {progressQ.data.profileSuggestions.slice(0, 3).map((s) => (
                    <li key={s} className="flex items-center gap-1.5 text-xs text-ink-soft">
                      <Sparkles size={12} className="text-accent" aria-hidden /> {s}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
        {/* ------------------------------ anchor nav ------------------------------ */}
        <nav aria-label="Profile sections" className="card sticky top-14 z-20 hidden p-1.5 sm:top-16 lg:block">
          <ul className="space-y-0.5">
            {NAV.map((n) => (
              <li key={n.id}>
                <a
                  href={`#${n.id}`}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors",
                    flash === n.id ? "bg-accent-soft text-accent" : "text-ink-soft hover:bg-surface-2 hover:text-ink"
                  )}
                >
                  <n.icon size={16} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  {dirtySections.includes(n.id) && <span className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-label="has unsaved changes" />}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-4">
          {/* mobile anchor rail */}
          <div className="card flex gap-1.5 overflow-x-auto p-1.5 hide-scrollbar lg:hidden">
            {NAV.map((n) => (
              <a
                key={n.id}
                href={`#${n.id}`}
                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-semibold text-ink-soft hover:bg-surface-2"
              >
                <n.icon size={14} aria-hidden />
                {n.label}
              </a>
            ))}
          </div>

          {section(
            "photos",
            "Photo & cover",
            "JPG, PNG or WebP up to 5 MB — uploads save instantly.",
            <Camera size={18} />,
            <>
              <div className="flex flex-wrap gap-6">
                {photoBlock("avatar", "Profile photo", "A clear face shot wins the most trust.", form.avatarUrl, `${fullName(user)} profile photo`)}
                {photoBlock("cover", "Cover image", "1584 × 396 works best.", form.coverUrl, `${fullName(user)} cover image`)}
              </div>
              <p className="mt-5 border-t border-line pt-4 text-xs text-ink-faint">
                Square images look best for the profile photo. Covers are cropped to fit every screen size.
              </p>
              <input
                ref={avatarInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                aria-label="Choose profile photo file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadPhoto("avatar", file);
                }}
              />
              <input
                ref={coverInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                aria-label="Choose cover image file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadPhoto("cover", file);
                }}
              />
            </>,
            { fields: [] }
          )}

          {section(
            "identity",
            "Identity & contact",
            "Your name, handle and the details buyers use to reach you.",
            <User size={18} />,
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="First name" value={form.firstName} onChange={(e) => setField("firstName", e.target.value)} error={fieldErrors.firstName} autoComplete="given-name" />
              <Input label="Last name" value={form.lastName} onChange={(e) => setField("lastName", e.target.value)} error={fieldErrors.lastName} autoComplete="family-name" />
              <Input
                label="Username"
                value={form.username}
                onChange={(e) => setField("username", e.target.value)}
                error={fieldErrors.username}
                hint={`Shown as professionalist.app/profile/${form.username || "yourname"}`}
              />
              <Input label="Email" type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} error={fieldErrors.email} autoComplete="email" />
              <Input label="Phone" type="tel" value={form.phone} onChange={(e) => setField("phone", e.target.value)} error={fieldErrors.phone} placeholder="+234 801 555 0123" />
              <Input label="Website" value={form.website} onChange={(e) => setField("website", e.target.value)} error={fieldErrors.website} placeholder="https://studio.example" icon={<Link2 size={15} />} />
              <Input label="Location" value={form.location} onChange={(e) => setField("location", e.target.value)} placeholder="Lagos, Nigeria" />
              {metaField("f-country", "Country", countriesQ, form.country, (v) => setField("country", v), "Select a country")}
              <div className="sm:col-span-2">
                {metaField("f-category", "Professional category", categoriesQ, form.category, (v) => setField("category", v), "Select your category")}
              </div>
            </div>
          )}

          {section(
            "story",
            "Story & headline",
            "One paragraph that makes people want to work with you.",
            <Sparkles size={18} />,
            <div className="space-y-4">
              <div>
                <Textarea
                  label="Bio"
                  rows={5}
                  maxLength={BIO_MAX}
                  value={form.bio}
                  onChange={(e) => setField("bio", e.target.value.slice(0, BIO_MAX))}
                  error={fieldErrors.bio}
                  placeholder="What you do, who you do it for, and the result they get."
                />
                <p className="mt-1 text-right text-xs tabular-nums text-ink-faint">
                  {form.bio.length}/{BIO_MAX}
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="Professional title" value={form.title} onChange={(e) => setField("title", e.target.value)} error={fieldErrors.title} placeholder="Product designer" />
                <Input label="Company" value={form.company} onChange={(e) => setField("company", e.target.value)} error={fieldErrors.company} placeholder="Independent · Atlas Design Co" />
              </div>
            </div>
          )}

          {section(
            "experience",
            "Experience",
            "Roles that prove you can deliver the work you sell.",
            <Briefcase size={18} />,
            <>
              {form.experience.length ? (
                <ul>
                  {form.experience.map((e) =>
                    listRow(
                      e.role,
                      [e.company, e.location].filter(Boolean).join(" · "),
                      `${e.start || "—"} — ${e.end || "Present"}`,
                      e.id,
                      () => setEditor({ kind: "experience", id: e.id }),
                      () => removeListRow("experience", e.id, "Experience")
                    )
                  )}
                </ul>
              ) : (
                emptyRow("No roles yet. Add your current position first.")
              )}
              <Button size="sm" variant="soft" className="mt-4" onClick={() => setEditor({ kind: "experience" })}>
                <Plus size={14} /> Add experience
              </Button>
            </>,
            { fields: [] }
          )}

          {section(
            "education",
            "Education",
            "Degrees, diplomas and programmes.",
            <GraduationCap size={18} />,
            <>
              {form.education.length ? (
                <ul>
                  {form.education.map((e) =>
                    listRow(
                      e.school,
                      [e.degree, e.field].filter(Boolean).join(" · "),
                      `${e.start || "—"} — ${e.end || "—"}`,
                      e.id,
                      () => setEditor({ kind: "education", id: e.id }),
                      () => removeListRow("education", e.id, "Education")
                    )
                  )}
                </ul>
              ) : (
                emptyRow("No education added yet.")
              )}
              <Button size="sm" variant="soft" className="mt-4" onClick={() => setEditor({ kind: "education" })}>
                <Plus size={14} /> Add education
              </Button>
            </>,
            { fields: [] }
          )}

          {section(
            "certifications",
            "Certifications",
            "Credentials that raise trust instantly.",
            <BadgeCheck size={18} />,
            <>
              {form.certifications.length ? (
                <ul>
                  {form.certifications.map((c) =>
                    listRow(
                      c.name,
                      c.issuer,
                      c.year,
                      c.id,
                      () => setEditor({ kind: "certification", id: c.id }),
                      () => removeListRow("certifications", c.id, "Certification")
                    )
                  )}
                </ul>
              ) : (
                emptyRow("No certifications yet — add one to stand out.")
              )}
              <Button size="sm" variant="soft" className="mt-4" onClick={() => setEditor({ kind: "certification" })}>
                <Plus size={14} /> Add certification
              </Button>
            </>,
            { fields: [] }
          )}

          {section(
            "portfolio",
            "Portfolio",
            "Show real work with an image and a link.",
            <Images size={18} />,
            <>
              {form.portfolio.length ? (
                <ul className="space-y-3">
                  {form.portfolio.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 border-t border-line pt-3 first:border-t-0 first:pt-0">
                      <span className="h-14 w-20 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2">
                        {p.imageUrl ? (
                          <img src={mediaUrl(p.imageUrl)} alt={p.title} className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-ink-faint">
                            <ImageIcon size={16} aria-hidden />
                          </span>
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{p.title}</p>
                        <p className="truncate text-xs text-ink-soft">{p.description || "No description"}</p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button onClick={() => setEditor({ kind: "portfolio", id: p.id })} aria-label={`Edit ${p.title}`} className="rounded-lg p-2.5 text-ink-soft hover:bg-surface-2 hover:text-accent">
                          <Pencil size={15} />
                        </button>
                        <button onClick={() => removeListRow("portfolio", p.id, "Portfolio item")} aria-label={`Delete ${p.title}`} className="rounded-lg p-2.5 text-ink-soft hover:bg-danger-soft hover:text-danger">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                emptyRow("Nothing in your portfolio yet. Two or three pieces is ideal.")
              )}
              <Button size="sm" variant="soft" className="mt-4" onClick={() => setEditor({ kind: "portfolio" })}>
                <Plus size={14} /> Add portfolio item
              </Button>
            </>,
            { fields: [] }
          )}

          {section(
            "skills",
            "Skills & interests",
            "Skills power search; interests tune your feed.",
            <Award size={18} />,
            <div className="space-y-5">
              <ChipInput
                label="Skills"
                values={form.skills}
                onChange={(next) => setField("skills", next)}
                placeholder="Brand strategy, TypeScript, Data analysis"
                hint={`Type and press Enter · up to ${CHIP_MAX} · duplicates ignored`}
              />
              <ChipInput
                label="Interests"
                values={form.interests}
                onChange={(next) => setField("interests", next)}
                placeholder="Renewables, Logistics, Design systems"
                hint="Used to personalise your feed and recommendations"
              />
            </div>
          )}

          {section(
            "visibility",
            "Visibility",
            "Who can find and browse your profile.",
            <Info size={18} />,
            <>
              <Select
                label="Profile visibility"
                value={form.visibility}
                onChange={(e) => setField("visibility", e.target.value as Profile["visibility"])}
                options={[
                  { value: "public", label: "Public — anyone on Professionalist" },
                  { value: "connections", label: "Connections — only people you are connected with" },
                  { value: "private", label: "Private — hidden from search and discovery" },
                ]}
              />
              <p className="mt-2 text-xs text-ink-faint">Marketplace listings keep their own availability rules.</p>
            </>
          )}

          {section(
            "account",
            "Account",
            "Session controls for this device.",
            <Trash2 size={18} />,
            <div className="rounded-xl border border-danger/40 bg-danger-soft/50 p-4">
              <p className="text-sm font-bold text-danger">Danger zone</p>
              <p className="mt-1 text-[13px] text-ink-soft">
                Signing out clears the session on this device. Your profile, listings and messages stay untouched.
              </p>
              <Button
                variant="danger"
                size="sm"
                className="mt-3"
                onClick={() =>
                  setConfirm({
                    title: "Sign out of this device?",
                    body: anyDirty ? "You have unsaved changes on this page — they will be lost." : "You can sign back in any time.",
                    action: () => {
                      setForm(saved);
                      void logout().then(() => navigate("/login"));
                    },
                  })
                }
              >
                Sign out
              </Button>
            </div>,
            { fields: [] }
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
            <Link to={`/profile/${form.username || user.username}`} className="text-sm font-semibold text-accent hover:underline">
              Back to profile
            </Link>
            {anyDirty && (
              <p className="text-xs font-semibold text-warn">
                {dirtySections.length} section{dirtySections.length > 1 ? "s" : ""} still have unsaved changes.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ---------------------------- list editor modals ---------------------------- */}
      {editor?.kind === "experience" && (
        <ExperienceForm
          initial={expItem}
          onClose={() => setEditor(null)}
          onSubmit={(item) => {
            const list = editor.id ? form.experience.map((e) => (e.id === editor.id ? item : e)) : [...form.experience, item];
            setEditor(null);
            void commitList("experience", list, editor.id ? "Experience updated" : "Experience added");
          }}
        />
      )}
      {editor?.kind === "education" && (
        <EducationForm
          initial={eduItem}
          onClose={() => setEditor(null)}
          onSubmit={(item) => {
            const list = editor.id ? form.education.map((e) => (e.id === editor.id ? item : e)) : [...form.education, item];
            setEditor(null);
            void commitList("education", list, editor.id ? "Education updated" : "Education added");
          }}
        />
      )}
      {editor?.kind === "certification" && (
        <CertificationForm
          initial={certItem}
          onClose={() => setEditor(null)}
          onSubmit={(item) => {
            const list = editor.id ? form.certifications.map((c) => (c.id === editor.id ? item : c)) : [...form.certifications, item];
            setEditor(null);
            void commitList("certifications", list, editor.id ? "Certification updated" : "Certification added");
          }}
        />
      )}
      {editor?.kind === "portfolio" && (
        <PortfolioForm
          initial={portItem}
          onClose={() => setEditor(null)}
          onSubmit={(item) => {
            const list = editor.id ? form.portfolio.map((p) => (p.id === editor.id ? item : p)) : [...form.portfolio, item];
            setEditor(null);
            void commitList("portfolio", list, editor.id ? "Portfolio item updated" : "Portfolio item added");
          }}
        />
      )}

      {/* -------------------------------- dialogs -------------------------------- */}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.title}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                confirm?.action();
                setConfirm(null);
              }}
            >
              <Check size={15} /> Confirm
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">{confirm?.body}</p>
      </Modal>

      <Modal
        open={leaveTo !== null}
        onClose={() => setLeaveTo(null)}
        title="Leave with unsaved changes?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaveTo(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const to = leaveTo;
                setForm(saved);
                setLeaveTo(null);
                if (to) navigate(to);
              }}
            >
              Discard & leave
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          {dirtySections.length > 0 ? `Not saved yet: ${dirtySections.join(", ")}.` : "Unsaved changes will be lost."}
        </p>
      </Modal>
    </div>
  );
}

/* ------------------------------ form modals ------------------------------- */

type TextKeys<T> = { [K in keyof T]-?: T[K] extends string ? K : never }[keyof T];

function missing<T extends object>(value: T, required: TextKeys<T>[]): Record<string, string> {
  const errors: Record<string, string> = {};
  required.forEach((k) => {
    if (!String(value[k] ?? "").trim()) errors[k as string] = "Required";
  });
  return errors;
}

function ExperienceForm({ initial, onClose, onSubmit }: { initial?: ExperienceItem; onClose: () => void; onSubmit: (v: ExperienceItem) => void }) {
  const [v, setV] = useState<ExperienceItem>(
    initial ?? { id: makeId("exp"), role: "", company: "", location: "", start: "", end: "", description: "" }
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<ExperienceItem>) => setV((x) => ({ ...x, ...patch }));
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? "Edit experience" : "Add experience"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const e = missing(v, ["role", "company"]);
              setErrors(e);
              if (!Object.keys(e).length) onSubmit(v);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Role" value={v.role} onChange={(e) => set({ role: e.target.value })} error={errors.role} placeholder="Senior product designer" />
        <Input label="Company" value={v.company} onChange={(e) => set({ company: e.target.value })} error={errors.company} placeholder="Atlas Design Co" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Location" value={v.location ?? ""} onChange={(e) => set({ location: e.target.value })} placeholder="Remote" />
          <Input label="Start" value={v.start} onChange={(e) => set({ start: e.target.value })} placeholder="2021" />
          <Input label="End" value={v.end} onChange={(e) => set({ end: e.target.value })} placeholder="Present" hint="Blank means current role" />
        </div>
        <Textarea label="What you delivered" rows={4} value={v.description ?? ""} onChange={(e) => set({ description: e.target.value })} placeholder="Outcomes, not duties — numbers win." />
      </div>
    </Modal>
  );
}

function EducationForm({ initial, onClose, onSubmit }: { initial?: EducationItem; onClose: () => void; onSubmit: (v: EducationItem) => void }) {
  const [v, setV] = useState<EducationItem>(initial ?? { id: makeId("edu"), school: "", degree: "", field: "", start: "", end: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<EducationItem>) => setV((x) => ({ ...x, ...patch }));
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? "Edit education" : "Add education"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const e = missing(v, ["school", "degree"]);
              setErrors(e);
              if (!Object.keys(e).length) onSubmit(v);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="School" value={v.school} onChange={(e) => set({ school: e.target.value })} error={errors.school} placeholder="University of Lagos" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Degree" value={v.degree} onChange={(e) => set({ degree: e.target.value })} error={errors.degree} placeholder="B.Sc." />
          <Input label="Field of study" value={v.field ?? ""} onChange={(e) => set({ field: e.target.value })} placeholder="Computer Science" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Start year" value={v.start} onChange={(e) => set({ start: e.target.value })} placeholder="2012" />
          <Input label="End year" value={v.end} onChange={(e) => set({ end: e.target.value })} placeholder="2016" />
        </div>
      </div>
    </Modal>
  );
}

function CertificationForm({ initial, onClose, onSubmit }: { initial?: Certification; onClose: () => void; onSubmit: (v: Certification) => void }) {
  const [v, setV] = useState<Certification>(initial ?? { id: makeId("cert"), name: "", issuer: "", year: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<Certification>) => setV((x) => ({ ...x, ...patch }));
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? "Edit certification" : "Add certification"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const e = missing(v, ["name", "issuer"]);
              setErrors(e);
              if (!Object.keys(e).length) onSubmit(v);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Certification" value={v.name} onChange={(e) => set({ name: e.target.value })} error={errors.name} placeholder="AWS Solutions Architect" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Issuer" value={v.issuer} onChange={(e) => set({ issuer: e.target.value })} error={errors.issuer} placeholder="Amazon Web Services" />
          <Input label="Year" value={v.year} onChange={(e) => set({ year: e.target.value })} placeholder="2024" />
        </div>
      </div>
    </Modal>
  );
}

function PortfolioForm({ initial, onClose, onSubmit }: { initial?: PortfolioItem; onClose: () => void; onSubmit: (v: PortfolioItem) => void }) {
  const toast = useToast();
  const [v, setV] = useState<PortfolioItem>(initial ?? { id: makeId("pf"), title: "", description: "", url: "", imageUrl: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const set = (patch: Partial<PortfolioItem>) => setV((x) => ({ ...x, ...patch }));

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const r = await postsApi.uploadMedia([file]);
      const first = r.urls[0];
      if (!first) throw new Error("The server did not return the image.");
      set({ imageUrl: first.url });
      toast.success("Image attached");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? "Edit portfolio item" : "Add portfolio item"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const e = missing(v, ["title"]);
              if (v.url && !URL_RE.test(v.url)) e.url = "Use a full URL starting with https://";
              setErrors(e);
              if (!Object.keys(e).length) onSubmit(v);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Project title" value={v.title} onChange={(e) => set({ title: e.target.value })} error={errors.title} placeholder="Marketplace rebrand" />
        <Textarea label="Short story" rows={3} value={v.description} onChange={(e) => set({ description: e.target.value })} placeholder="The problem, your part, the outcome." />
        <Input label="Link (optional)" value={v.url} onChange={(e) => set({ url: e.target.value })} error={errors.url} placeholder="https://studio.example/work" />
        <div>
          <p className="mb-1.5 text-[13px] font-semibold">Cover image</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="h-20 w-28 shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2">
              {v.imageUrl ? (
                <img src={mediaUrl(v.imageUrl)} alt={v.title} className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-ink-faint">
                  <ImageIcon size={18} aria-hidden />
                </span>
              )}
            </span>
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3.5 text-sm font-semibold hover:bg-surface-2">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  aria-label="Choose portfolio image"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void upload(file);
                  }}
                />
                {uploading ? "Uploading…" : "Upload image"}
              </label>
              {v.imageUrl && (
                <Button size="sm" variant="ghost" onClick={() => set({ imageUrl: "" })}>
                  <Trash2 size={14} /> Remove
                </Button>
              )}
            </div>
          </div>
          <p className="mt-1.5 text-xs text-ink-faint">JPG, PNG or WebP up to 5 MB.</p>
        </div>
      </div>
    </Modal>
  );
}
