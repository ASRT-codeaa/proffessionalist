import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Briefcase,
  Building2,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Code2,
  Coffee,
  Cpu,
  Dumbbell,
  Globe,
  Heart,
  Image as ImageIcon,
  Leaf,
  Loader2,
  MapPin,
  Megaphone,
  Music,
  PartyPopper,
  Pencil,
  Rocket,
  Sparkles,
  Trash2,
  TrendingUp,
  Upload,
  User,
  Users,
  Video,
  X,
} from "lucide-react";
import { Logo, LogoSymbol } from "@/components/Logo";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CheckPill,
  EmptyState,
  ErrorState,
  Input,
  ProgressRing,
  Select,
  Skeleton,
  Textarea,
  VerifiedBadge,
} from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { ApiError, mediaUrl } from "@/services/http";
import { metaApi, networkApi, onboardingApi, type OnboardingPayload } from "@/services/api";
import type { Person } from "@/services/types";
import { cn, formatNumber, fullName } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*                              Static UI options                             */
/* -------------------------------------------------------------------------- */

const SUGGESTED_SKILLS = [
  "Product Design", "UX Research", "TypeScript", "React", "Brand Strategy",
  "Copywriting", "Data Analysis", "SEO", "Growth Marketing", "Project Management",
  "Photography", "Video Editing", "Python", "Public Speaking", "Financial Modeling",
  "Content Creation", "Figma", "B2B Sales", "Negotiation", "Team Leadership",
];

interface Topic {
  id: string;
  label: string;
  icon: typeof Globe;
  pros: number;
}

const INTEREST_TOPICS: Topic[] = [
  { id: "design", label: "Design & UX", icon: ImageIcon, pros: 18400 },
  { id: "tech", label: "Technology", icon: Cpu, pros: 32100 },
  { id: "marketing", label: "Marketing", icon: Megaphone, pros: 21700 },
  { id: "finance", label: "Finance", icon: TrendingUp, pros: 14900 },
  { id: "startups", label: "Startups", icon: Rocket, pros: 27300 },
  { id: "photo", label: "Photography", icon: Camera, pros: 9800 },
  { id: "writing", label: "Writing", icon: BookOpen, pros: 12600 },
  { id: "data", label: "Data & AI", icon: Code2, pros: 24800 },
  { id: "video", label: "Film & Video", icon: Video, pros: 8300 },
  { id: "wellness", label: "Health & Wellness", icon: Dumbbell, pros: 11200 },
  { id: "travel", label: "Travel", icon: Globe, pros: 16500 },
  { id: "food", label: "Food & Coffee", icon: Coffee, pros: 7400 },
  { id: "music", label: "Music", icon: Music, pros: 10100 },
  { id: "climate", label: "Sustainability", icon: Leaf, pros: 6900 },
];

interface StepDef {
  key: string;
  label: string;
  title: string;
  subtitle: string;
  icon: typeof Globe;
  optional: boolean;
}

const STEPS: StepDef[] = [
  { key: "welcome", label: "Welcome", title: "Welcome to Professionalist", subtitle: "Let's set up your profile in a few quick steps.", icon: Sparkles, optional: false },
  { key: "photo", label: "Photo", title: "Add a profile picture", subtitle: "A real photo makes you easier to find and trust.", icon: Camera, optional: true },
  { key: "profession", label: "Profession", title: "Professional information", subtitle: "Tell people what you do and where you work.", icon: Briefcase, optional: false },
  { key: "skills", label: "Skills", title: "Highlight your skills", subtitle: "Add the skills you want to be known for.", icon: Code2, optional: true },
  { key: "interests", label: "Interests", title: "Pick your interests", subtitle: "We'll tailor your feed to topics you care about.", icon: Heart, optional: true },
  { key: "location", label: "Location", title: "Where you're based", subtitle: "Your location helps nearby people find you.", icon: MapPin, optional: true },
  { key: "network", label: "Network", title: "People to follow", subtitle: "Follow a few professionals to jump-start your feed.", icon: Users, optional: true },
  { key: "finish", label: "Finish", title: "Complete your profile", subtitle: "Review everything, then you're in.", icon: CheckCircle2, optional: false },
];

/* -------------------------------------------------------------------------- */
/*                                 Wizard state                               */
/* -------------------------------------------------------------------------- */

interface WizardState {
  avatarUrl: string;
  title: string;
  company: string;
  bio: string;
  website: string;
  skills: string[];
  interests: string[];
  country: string;
  location: string;
  followUserIds: number[];
}

const MAX_SKILLS = 15;
const MAX_BIO = 500;
const ACCEPTED_IMAGE = /^image\/(png|jpe?g|webp|gif)$/i;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function profileStrength(s: WizardState): number {
  let score = 0;
  if (s.avatarUrl) score += 15;
  if (s.title.trim()) score += 15;
  if (s.company.trim()) score += 10;
  if (s.bio.trim().length >= 30) score += 15;
  else if (s.bio.trim()) score += 8;
  if (s.website.trim()) score += 5;
  score += Math.min(1, s.skills.length / 5) * 15;
  score += Math.min(1, s.interests.length / 4) * 10;
  if (s.country || s.location.trim()) score += 10;
  score += Math.min(1, s.followUserIds.length / 3) * 5;
  return Math.round(Math.min(100, score));
}

/* -------------------------------------------------------------------------- */
/*                                  Component                                 */
/* -------------------------------------------------------------------------- */

export default function OnboardingPage() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const profile = user?.profile;

  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  const [state, setState] = useState<WizardState>({
    avatarUrl: profile?.avatarUrl ?? "",
    title: profile?.title ?? "",
    company: profile?.company ?? "",
    bio: profile?.bio ?? "",
    website: profile?.website ?? "",
    skills: profile?.skills ? [...profile.skills] : [],
    interests: profile?.interests ? [...profile.interests] : [],
    country: profile?.country ?? "",
    location: profile?.location ?? "",
    followUserIds: [],
  });
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [apiErrors, setApiErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // avatar
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<string | null>(null);

  // skills chip input
  const [skillDraft, setSkillDraft] = useState("");

  const countries = useAsync(() => metaApi.countries(), []);
  const suggestions = useAsync(() => networkApi.suggestions({ pageSize: 8 }), []);

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  const patch = useCallback((p: Partial<WizardState>) => setState((s) => ({ ...s, ...p })), []);

  const errorsFor = useCallback(
    (index: number): Record<string, string> => {
      const errs: Record<string, string> = {};
      if (index === 2) {
        if (!state.title.trim()) errs.title = "Add your professional title so people know what you do.";
        if (state.bio.length > MAX_BIO) errs.bio = `Bio must be ${MAX_BIO} characters or fewer.`;
        const site = state.website.trim();
        if (site && !/^https?:\/\/.+\..+/i.test(site)) {
          errs.website = "Enter a full URL, starting with https://";
        }
      }
      return errs;
    },
    [state.title, state.bio, state.website]
  );

  const goNext = useCallback(() => {
    const errs = errorsFor(step);
    setLocalErrors(errs);
    if (Object.keys(errs).length) {
      const firstKey = Object.keys(errs)[0];
      toast.error("Just one more thing", errs[firstKey]);
      return;
    }
    setApiErrors({});
    setStep((i) => {
      const next = Math.min(STEPS.length - 1, i + 1);
      setMaxReached((m) => Math.max(m, next));
      return next;
    });
  }, [step, errorsFor, toast]);

  const goBack = useCallback(() => {
    setLocalErrors({});
    setStep((i) => Math.max(0, i - 1));
  }, []);

  const goTo = useCallback(
    (index: number) => {
      if (index > maxReached) return;
      setLocalErrors({});
      setStep(index);
    },
    [maxReached]
  );

  /* --------------------------------- avatar -------------------------------- */

  const clearAvatarPreview = useCallback(() => {
    if (previewRef.current) {
      URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    }
    setAvatarPreview(null);
  }, []);

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return;
      if (!ACCEPTED_IMAGE.test(file.type)) {
        toast.error("Unsupported file", "Please choose a PNG, JPG, WEBP or GIF image.");
        return;
      }
      if (file.size > MAX_AVATAR_BYTES) {
        toast.error("That image is too large", "Keep it under 5 MB.");
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      previewRef.current = objectUrl;
      setAvatarPreview(objectUrl);
      setUploading(true);
      try {
        const res = await onboardingApi.uploadAvatar(file);
        patch({ avatarUrl: res.url });
        clearAvatarPreview();
        toast.success("Nice — photo added");
      } catch (e) {
        clearAvatarPreview();
        toast.error("Upload failed", errorMessage(e));
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [clearAvatarPreview, patch, toast]
  );

  const removeAvatar = useCallback(() => {
    clearAvatarPreview();
    patch({ avatarUrl: "" });
    if (fileInputRef.current) fileInputRef.current.value = "";
    toast.info("Photo removed", "You can add one anytime from your profile.");
  }, [clearAvatarPreview, patch, toast]);

  const avatarSrc = avatarPreview ?? (state.avatarUrl ? mediaUrl(state.avatarUrl) : "");

  /* --------------------------------- skills -------------------------------- */

  const addSkill = useCallback(
    (raw: string) => {
      const value = raw.trim().replace(/\s+/g, " ");
      if (!value) return;
      setState((s) => {
        if (s.skills.length >= MAX_SKILLS) return s;
        if (s.skills.some((k) => k.toLowerCase() === value.toLowerCase())) return s;
        return { ...s, skills: [...s.skills, value] };
      });
      setSkillDraft("");
    },
    []
  );

  const removeSkill = useCallback((value: string) => {
    setState((s) => ({ ...s, skills: s.skills.filter((k) => k !== value) }));
  }, []);

  const toggleSkill = useCallback((value: string) => {
    setState((s) => {
      if (s.skills.includes(value)) return { ...s, skills: s.skills.filter((k) => k !== value) };
      if (s.skills.length >= MAX_SKILLS) return s;
      return { ...s, skills: [...s.skills, value] };
    });
  }, []);

  const onSkillKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addSkill(skillDraft);
    } else if (e.key === "Backspace" && !skillDraft && state.skills.length) {
      removeSkill(state.skills[state.skills.length - 1]);
    }
  };

  /* -------------------------------- interests ------------------------------ */

  const toggleInterest = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      interests: s.interests.includes(id) ? s.interests.filter((x) => x !== id) : [...s.interests, id],
    }));
  }, []);

  /* --------------------------------- follow -------------------------------- */

  const toggleFollow = useCallback((id: number) => {
    setState((s) => ({
      ...s,
      followUserIds: s.followUserIds.includes(id)
        ? s.followUserIds.filter((x) => x !== id)
        : [...s.followUserIds, id],
    }));
  }, []);

  const suggestedPeople = useMemo<Person[]>(() => suggestions.data ?? [], [suggestions.data]);
  const suggestedLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const t of INTEREST_TOPICS) map[t.id] = t.label;
    return map;
  }, []);

  /* --------------------------------- finish -------------------------------- */

  const finish = useCallback(async () => {
    setSubmitting(true);
    setApiErrors({});
    try {
      const payload: OnboardingPayload = {
        // Always sent, empty string included, so removing a photo sticks.
        avatarUrl: state.avatarUrl,
        title: state.title.trim() || undefined,
        company: state.company.trim() || undefined,
        bio: state.bio.trim() || undefined,
        skills: state.skills,
        interests: state.interests.map((id) => suggestedLabels[id] ?? id),
        location: state.location.trim() || undefined,
        country: state.country || undefined,
        followUserIds: state.followUserIds,
        onboardingDone: true,
      };
      // `website` lives on Profile (and the endpoint persists the whole body)
      // but isn't part of OnboardingPayload, so we attach it via a typed cast.
      const withWebsite = state.website.trim()
        ? ({ ...payload, website: state.website.trim() } as OnboardingPayload)
        : payload;

      const updated = await onboardingApi.save(withWebsite);
      setUser(updated);
      toast.success("You're all set!", "Welcome to Professionalist.");
      navigate("/home", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        setApiErrors(e.fieldErrors);
        const keys = Object.keys(e.fieldErrors);
        const infoKeys = ["title", "company", "bio", "website"];
        const locKeys = ["country", "location"];
        if (keys.some((k) => infoKeys.includes(k))) setStep(2);
        else if (keys.some((k) => locKeys.includes(k))) setStep(5);
        else if (keys.includes("avatarUrl")) setStep(1);
      }
      toast.error("Couldn't save your profile", errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }, [state, suggestedLabels, setUser, toast, navigate]);

  const strength = profileStrength(state);
  const current = STEPS[step];
  const pct = ((step) / (STEPS.length - 1)) * 100;

  /* --------------------------------- render -------------------------------- */

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      {profile?.onboardingDone && (
        <div className="flex items-center justify-center gap-2 bg-accent-soft px-4 py-2 text-center text-[13px] text-accent">
          <Sparkles size={14} aria-hidden />
          <span>Your profile is already complete.</span>
          <Link to="/home" className="font-semibold underline underline-offset-2">Go to feed</Link>
        </div>
      )}

      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link to="/home" aria-label="Professionalist home" className="rounded-xl">
            <Logo size={30} />
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm font-medium text-ink-soft sm:inline">
              Step {step + 1} of {STEPS.length}
            </span>
            <span className="text-sm font-semibold tabular-nums text-ink">{Math.round(pct)}%</span>
          </div>
        </div>
        {/* mobile progress bar */}
        <div className="mx-auto w-full max-w-5xl px-4 sm:hidden">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-5xl flex-1 gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[248px_1fr] lg:py-10">
        {/* Desktop step rail */}
        <nav aria-label="Onboarding steps" className="hidden lg:block">
          <ol className="sticky top-24 space-y-1">
            {STEPS.map((s, i) => {
              const done = i < maxReached && i !== step;
              const active = i === step;
              const reachable = i <= maxReached;
              const Icon = s.icon;
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    disabled={!reachable}
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                      active ? "bg-accent-soft text-accent" : "text-ink-soft hover:bg-surface-2",
                      !reachable && "cursor-not-allowed opacity-45 hover:bg-transparent"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                        active ? "bg-accent text-white" : done ? "bg-success-soft text-success" : "bg-surface-2 text-ink-faint"
                      )}
                    >
                      {done ? <Check size={14} aria-hidden /> : i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm", active ? "font-bold" : "font-semibold")}>{s.label}</span>
                    </span>
                    <Icon size={16} className="shrink-0 opacity-60" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Main content */}
        <main className="min-w-0">
          <div key={step} className="anim-fade-up">
            {/* Mobile compact step header */}
            <div className="mb-4 flex items-center gap-2 lg:hidden">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-bold text-white">
                {step + 1}
              </span>
              <h2 className="text-sm font-semibold text-ink-soft">{current.label}</h2>
            </div>

            {step === 0 && <WelcomeStep onStart={goNext} />}
            {step === 1 && (
              <PhotoStep
                name={user ? fullName(user) : "you"}
                avatarSrc={avatarSrc}
                uploading={uploading}
                dragging={dragging}
                fileInputRef={fileInputRef}
                onPick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); void handleFile(e.dataTransfer.files?.[0]); }}
                onFile={(f) => void handleFile(f)}
                onRemove={removeAvatar}
                hasAvatar={!!state.avatarUrl || !!avatarPreview}
              />
            )}
            {step === 2 && (
              <InfoStep
                state={state}
                errors={localErrors}
                apiErrors={apiErrors}
                onChange={patch}
              />
            )}
            {step === 3 && (
              <SkillsStep
                skills={state.skills}
                draft={skillDraft}
                onDraftChange={setSkillDraft}
                onDraftKeyDown={onSkillKeyDown}
                onAdd={addSkill}
                onRemove={removeSkill}
                onToggleSuggestion={toggleSkill}
              />
            )}
            {step === 4 && <InterestsStep selected={state.interests} onToggle={toggleInterest} />}
            {step === 5 && (
              <LocationStep
                country={state.country}
                location={state.location}
                apiErrors={apiErrors}
                countries={countries}
                onChange={patch}
              />
            )}
            {step === 6 && (
              <FollowStep
                suggestions={suggestions}
                selected={state.followUserIds}
                onToggle={toggleFollow}
                onRefresh={suggestions.refetch}
              />
            )}
            {step === 7 && (
              <FinishStep
                state={state}
                strength={strength}
                suggestedLabels={suggestedLabels}
                people={suggestedPeople}
                submitting={submitting}
                onEdit={goTo}
                onFinish={finish}
                error={Object.keys(apiErrors).length ? "Please review the highlighted fields." : ""}
              />
            )}
          </div>
        </main>
      </div>

      {/* Sticky footer navigation */}
      <footer className="sticky bottom-0 z-20 border-t border-line bg-surface/90 backdrop-blur">
        <div className="safe-bottom mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          {step === 0 ? (
            <span className="text-xs text-ink-faint">Takes about 2 minutes</span>
          ) : (
            <Button variant="ghost" onClick={goBack} disabled={submitting}>
              <ArrowLeft size={16} aria-hidden /> Back
            </Button>
          )}

          <div className="flex items-center gap-2">
            {current.optional && step > 0 && step < 7 && (
              <Button variant="ghost" onClick={goNext} disabled={submitting}>
                Skip for now
              </Button>
            )}
            {step > 0 && step < 7 && (
              <Button onClick={goNext} disabled={submitting}>
                Next <ArrowRight size={16} aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Step 1                                    */
/* -------------------------------------------------------------------------- */

function WelcomeStep({ onStart }: { onStart: () => void }) {
  return (
    <section className="overflow-hidden">
      <div className="relative rounded-3xl border border-line bg-surface p-6 sm:p-10">
        <div
          className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-70 blur-2xl"
          style={{ background: "radial-gradient(circle at 30% 30%, rgba(30,111,255,0.35), transparent 70%)" }}
          aria-hidden
        />
        <div className="anim-scale-in flex justify-center">
          <span className="flex h-24 w-24 items-center justify-center rounded-3xl bg-canvas ring-1 ring-line">
            <LogoSymbol size={64} />
          </span>
        </div>
        <div className="mt-6 text-center">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-[32px]">
            Where real professionals connect
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft sm:text-[15px]">
            Let's build a profile that gets read. We'll add a photo, your work, skills, interests and a few
            people to follow — you can change any of it later.
          </p>
        </div>

        <ul className="mx-auto mt-8 grid max-w-xl gap-3 sm:grid-cols-2">
          {[
            { icon: Camera, text: "A friendly profile photo" },
            { icon: Briefcase, text: "What you do and where" },
            { icon: Code2, text: "Skills you're great at" },
            { icon: Heart, text: "Topics for your feed" },
            { icon: Users, text: "People worth following" },
            { icon: CheckCircle2, text: "One tap to finish" },
          ].map((f) => (
            <li key={f.text} className="flex items-center gap-3 rounded-xl bg-canvas px-3 py-2.5 text-sm">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <f.icon size={16} aria-hidden />
              </span>
              <span className="font-medium text-ink-soft">{f.text}</span>
            </li>
          ))}
        </ul>

        <div className="mt-8 flex justify-center">
          <Button size="lg" onClick={onStart}>
            Let's go <ChevronRight size={18} aria-hidden />
          </Button>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Step 2                                    */
/* -------------------------------------------------------------------------- */

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6 lg:mb-8">
      <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">{title}</h1>
      <p className="mt-1.5 text-sm text-ink-soft">{subtitle}</p>
    </div>
  );
}

function PhotoStep(props: {
  name: string;
  avatarSrc: string;
  uploading: boolean;
  dragging: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onPick: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFile: (file: File) => void;
  onRemove: () => void;
  hasAvatar: boolean;
}) {
  return (
    <section>
      <StepHeading title="Add a profile picture" subtitle="A clear photo of your face builds trust. It's optional — you can skip." />

      <input
        ref={props.fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        aria-label="Choose a profile photo"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) props.onFile(f);
        }}
      />

      <div
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
        className={cn(
          "flex flex-col items-center gap-5 rounded-2xl border-2 border-dashed p-6 transition-colors sm:p-8",
          props.dragging ? "border-accent bg-accent-soft" : "border-line-strong bg-surface"
        )}
      >
        <div className="relative">
          <Avatar name={props.name} src={props.avatarSrc || undefined} size="2xl" />
          {props.uploading && (
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45">
              <Loader2 size={26} className="animate-spin text-white" aria-hidden />
            </span>
          )}
        </div>

        <div className="text-center">
          <p className="text-sm font-semibold">
            {props.dragging ? "Drop it right here" : props.hasAvatar ? "Looking good!" : "Drag a photo here"}
          </p>
          <p className="mt-1 text-xs text-ink-faint">PNG, JPG, WEBP or GIF · up to 5 MB</p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" onClick={props.onPick} disabled={props.uploading}>
            <Upload size={16} aria-hidden /> {props.hasAvatar ? "Replace photo" : "Choose a photo"}
          </Button>
          {props.hasAvatar && (
            <Button variant="ghost" onClick={props.onRemove} disabled={props.uploading}>
              <Trash2 size={16} aria-hidden /> Remove
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Step 3                                    */
/* -------------------------------------------------------------------------- */

function InfoStep(props: {
  state: WizardState;
  errors: Record<string, string>;
  apiErrors: Record<string, string>;
  onChange: (p: Partial<WizardState>) => void;
}) {
  const { state, errors, apiErrors, onChange } = props;
  const fieldError = (k: keyof WizardState) => errors[k] ?? apiErrors[k];
  return (
    <section>
      <StepHeading title="Professional information" subtitle="This is the headline people see first. Required: your title." />
      <div className="space-y-4">
        <Input
          label="Professional title"
          icon={<User size={15} />}
          placeholder="Senior Product Designer"
          value={state.title}
          onChange={(e) => onChange({ title: e.target.value })}
          error={fieldError("title")}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Company / Organisation"
            icon={<Building2 size={15} />}
            placeholder="Lumen Studio"
            value={state.company}
            onChange={(e) => onChange({ company: e.target.value })}
            error={fieldError("company")}
          />
          <Input
            label="Website"
            type="url"
            placeholder="https://yoursite.com"
            value={state.website}
            onChange={(e) => onChange({ website: e.target.value })}
            error={fieldError("website")}
            hint="Personal or company site (optional)"
          />
        </div>
        <Textarea
          label="Short bio"
          rows={5}
          placeholder="A sentence or two about the work you do and who you help."
          value={state.bio}
          onChange={(e) => onChange({ bio: e.target.value })}
          error={fieldError("bio")}
        />
        <div className="flex justify-end">
          <span className={cn("text-xs tabular-nums text-ink-faint", state.bio.length > MAX_BIO && "text-danger")}>
            {state.bio.length}/{MAX_BIO}
          </span>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Step 4                                    */
/* -------------------------------------------------------------------------- */

function SkillsStep(props: {
  skills: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onDraftKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  onToggleSuggestion: (v: string) => void;
}) {
  const atMax = props.skills.length >= MAX_SKILLS;
  const remaining = SUGGESTED_SKILLS.filter((s) => !props.skills.includes(s));
  return (
    <section>
      <StepHeading title="Highlight your skills" subtitle={`Type a skill and press Enter. Add up to ${MAX_SKILLS}.`} />

      <div
        className="flex min-h-[52px] cursor-text flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-[var(--ring)]"
        onClick={() => document.getElementById("skill-input")?.focus()}
      >
        {props.skills.map((skill) => (
          <span
            key={skill}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft py-1 pl-3 pr-1.5 text-[13px] font-semibold text-accent anim-scale-in"
          >
            {skill}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); props.onRemove(skill); }}
              aria-label={`Remove ${skill}`}
              className="flex h-5 w-5 items-center justify-center rounded-full text-accent hover:bg-accent hover:text-white"
            >
              <X size={13} aria-hidden />
            </button>
          </span>
        ))}
        <input
          id="skill-input"
          className="min-w-[8rem] flex-1 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-ink-faint"
          placeholder={props.skills.length ? "Add another…" : "e.g. Product Design"}
          value={props.draft}
          disabled={atMax}
          onChange={(e) => props.onDraftChange(e.target.value)}
          onKeyDown={props.onDraftKeyDown}
          aria-label="Add a skill"
        />
        {!atMax && props.draft.trim() && (
          <Button size="sm" variant="soft" onClick={() => props.onAdd(props.draft)}>Add</Button>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-ink-faint">
        <span>{props.skills.length} selected</span>
        <span className={cn(atMax && "font-semibold text-warn")}>{atMax ? "Maximum reached" : `${MAX_SKILLS - props.skills.length} left`}</span>
      </div>

      <div className="mt-6">
        <p className="mb-3 text-sm font-semibold">Suggested skills</p>
        <div className="flex flex-wrap gap-2">
          {remaining.map((s) => (
            <CheckPill key={s} checked={false} onToggle={() => props.onToggleSuggestion(s)}>
              {s}
            </CheckPill>
          ))}
          {remaining.length === 0 && (
            <p className="text-sm text-ink-soft">You've added every suggestion — great coverage!</p>
          )}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Step 5                                    */
/* -------------------------------------------------------------------------- */

function InterestsStep(props: { selected: string[]; onToggle: (id: string) => void }) {
  return (
    <section>
      <StepHeading title="Pick your interests" subtitle="Choose topics you want in your feed. Pick as many as you like." />
      {props.selected.length > 0 && (
        <p className="mb-3 text-sm font-medium text-accent">
          <CheckCircle2 size={14} className="mr-1 inline" aria-hidden />
          {props.selected.length} selected
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {INTEREST_TOPICS.map((t) => {
          const active = props.selected.includes(t.id);
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={active}
              onClick={() => props.onToggle(t.id)}
              className={cn(
                "group relative flex flex-col items-start gap-3 rounded-2xl border p-4 text-left transition-all",
                active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2"
              )}
            >
              <span
                className={cn(
                  "absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border transition-all",
                  active ? "border-accent bg-accent text-white anim-scale-in" : "border-line-strong text-transparent"
                )}
                aria-hidden
              >
                <Check size={12} />
              </span>
              <span
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
                  active ? "bg-accent text-white" : "bg-canvas text-accent"
                )}
              >
                <Icon size={19} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-bold", active ? "text-accent" : "text-ink")}>{t.label}</span>
                <span className="mt-0.5 block text-xs text-ink-faint">{formatNumber(t.pros)} pros follow</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Step 6                                    */
/* -------------------------------------------------------------------------- */

function LocationStep(props: {
  country: string;
  location: string;
  apiErrors: Record<string, string>;
  countries: ReturnType<typeof useAsync<string[]>>;
  onChange: (p: Partial<WizardState>) => void;
}) {
  const { countries } = props;
  return (
    <section>
      <StepHeading title="Where you're based" subtitle="Add your country and city to show up in local discovery." />
      <div className="space-y-4">
        {countries.error ? (
          <ErrorState message={errorMessage(countries.error)} onRetry={countries.refetch} />
        ) : (
          <Select
            label="Country"
            placeholder={countries.loading ? "Loading countries…" : "Select a country"}
            value={props.country}
            disabled={countries.loading}
            onChange={(e) => props.onChange({ country: e.target.value })}
            error={props.apiErrors.country}
            options={(countries.data ?? []).map((c) => ({ value: c, label: c }))}
          />
        )}
        <Input
          label="City or region"
          icon={<MapPin size={15} />}
          placeholder="Lagos"
          value={props.location}
          onChange={(e) => props.onChange({ location: e.target.value })}
          error={props.apiErrors.location}
          hint="Shown as “City, Country” on your profile"
        />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Step 7                                    */
/* -------------------------------------------------------------------------- */

function FollowStep(props: {
  suggestions: ReturnType<typeof useAsync<Person[]>>;
  selected: number[];
  onToggle: (id: number) => void;
  onRefresh: () => void;
}) {
  const { suggestions } = props;
  return (
    <section>
      <StepHeading title="People to follow" subtitle="Follow a few professionals to shape your feed. Skip anytime." />

      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm text-ink-soft" aria-live="polite">
          {props.selected.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-accent">
              <CheckCircle2 size={15} aria-hidden /> {props.selected.length} selected
            </span>
          ) : (
            "Nothing selected yet"
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={props.onRefresh} disabled={suggestions.loading}>
          <Sparkles size={14} aria-hidden /> Refresh
        </Button>
      </div>

      {suggestions.loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="flex items-center gap-3 p-3.5">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-40" />
              </div>
            </Card>
          ))}
        </div>
      ) : suggestions.error ? (
        <ErrorState message={errorMessage(suggestions.error)} onRetry={suggestions.refetch} />
      ) : (suggestions.data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No suggestions right now"
          description="We couldn't find people to suggest yet. You can follow professionals later from Network."
          action={<Button variant="outline" onClick={props.onRefresh}>Try again</Button>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {suggestions.data!.map((p) => {
            const active = props.selected.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                onClick={() => props.onToggle(p.id)}
                className={cn(
                  "flex items-start gap-3 rounded-2xl border p-3.5 text-left transition-all",
                  active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong card-hover"
                )}
              >
                <Avatar name={fullName(p)} src={p.avatarUrl ? mediaUrl(p.avatarUrl) : undefined} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-bold">{fullName(p)}</span>
                    {p.verified && <VerifiedBadge color={p.verifiedColor} size={14} />}
                  </div>
                  <p className="truncate text-xs text-ink-soft">
                    {[p.title, p.company].filter(Boolean).join(" · ") || "Professional"}
                  </p>
                  {p.mutualConnections > 0 && (
                    <p className="mt-1 text-[11px] text-ink-faint">{p.mutualConnections} mutual connections</p>
                  )}
                </div>
                <span
                  className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-all",
                    active ? "border-accent bg-accent text-white anim-scale-in" : "border-line-strong text-transparent"
                  )}
                  aria-hidden
                >
                  <Check size={14} />
                </span>
              </button>
            );
          })}
        </div>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-faint">
        <Globe size={13} aria-hidden /> Businesses can be followed from the marketplace once they're verified.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Step 8                                    */
/* -------------------------------------------------------------------------- */

function SummaryRow({ label, children, onEdit }: { label: string; children: React.ReactNode; onEdit: () => void }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-bold uppercase tracking-wide text-ink-faint">{label}</span>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${label}`}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-accent hover:bg-accent-soft"
        >
          <Pencil size={12} aria-hidden /> Edit
        </button>
      </div>
      <div className="mt-2 text-sm text-ink">{children}</div>
    </Card>
  );
}

function FinishStep(props: {
  state: WizardState;
  strength: number;
  suggestedLabels: Record<string, string>;
  people: Person[];
  submitting: boolean;
  onEdit: (step: number) => void;
  onFinish: () => void;
  error: string;
}) {
  const { state, strength, suggestedLabels, people } = props;
  const chosenPeople = people.filter((p) => state.followUserIds.includes(p.id));
  const place = [state.location.trim(), state.country].filter(Boolean).join(", ");

  return (
    <section>
      <div className="mb-6 flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 text-center sm:flex-row sm:text-left lg:mb-8">
        <div className="anim-scale-in">
          <ProgressRing value={strength} size={84} stroke={8}>
            <span className="text-base font-extrabold tabular-nums">{strength}%</span>
          </ProgressRing>
        </div>
        <div className="min-w-0">
          <h1 className="flex items-center justify-center gap-2 text-lg font-extrabold sm:justify-start">
            <Sparkles size={18} className="text-accent" aria-hidden /> Profile strength
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            {strength >= 80
              ? "Excellent — you're ready to connect and post."
              : strength >= 50
              ? "Looking good. A few more details help you get discovered."
              : "Almost empty. Use Edit to fill in a couple of blocks before finishing."}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryRow label="Photo" onEdit={() => props.onEdit(1)}>
          {state.avatarUrl ? (
            <span className="inline-flex items-center gap-2">
              <Avatar name="You" src={mediaUrl(state.avatarUrl)} size="xs" /> Added
            </span>
          ) : (
            <Badge>Add one to stand out</Badge>
          )}
        </SummaryRow>

        <SummaryRow label="Profession" onEdit={() => props.onEdit(2)}>
          {state.title.trim() ? (
            <span>
              <span className="font-semibold">{state.title}</span>
              {state.company && <span className="text-ink-soft"> · {state.company}</span>}
              {state.website && <span className="mt-0.5 block truncate text-xs text-accent">{state.website}</span>}
            </span>
          ) : (
            <Badge tone="warn">Add your title</Badge>
          )}
        </SummaryRow>

        <SummaryRow label="Bio" onEdit={() => props.onEdit(2)}>
          {state.bio.trim() ? (
            <p className="line-clamp-3 text-ink-soft">{state.bio}</p>
          ) : (
            <span className="text-ink-faint">No bio yet</span>
          )}
        </SummaryRow>

        <SummaryRow label="Skills" onEdit={() => props.onEdit(3)}>
          {state.skills.length ? (
            <div className="flex flex-wrap gap-1.5">
              {state.skills.map((s) => (
                <span key={s} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium">{s}</span>
              ))}
            </div>
          ) : (
            <span className="text-ink-faint">None added</span>
          )}
        </SummaryRow>

        <SummaryRow label="Interests" onEdit={() => props.onEdit(4)}>
          {state.interests.length ? (
            <div className="flex flex-wrap gap-1.5">
              {state.interests.map((id) => (
                <span key={id} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent">
                  {suggestedLabels[id] ?? id}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-ink-faint">None selected</span>
          )}
        </SummaryRow>

        <SummaryRow label="Location" onEdit={() => props.onEdit(5)}>
          {place ? <span className="inline-flex items-center gap-1.5"><MapPin size={14} className="text-ink-faint" aria-hidden /> {place}</span> : <span className="text-ink-faint">Not set</span>}
        </SummaryRow>
      </div>

      <div className="mt-3">
        <SummaryRow label={`Network · ${chosenPeople.length} to follow`} onEdit={() => props.onEdit(6)}>
          {chosenPeople.length ? (
            <div className="flex flex-wrap items-center gap-2">
              {chosenPeople.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-1 pr-3 text-xs font-medium">
                  <Avatar name={fullName(p)} src={p.avatarUrl ? mediaUrl(p.avatarUrl) : undefined} size="xs" /> {fullName(p)}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-ink-faint">Nobody selected yet — follow a few from the previous step</span>
          )}
        </SummaryRow>
      </div>

      {props.error && (
        <div role="alert" className="mt-4 flex items-center gap-2 rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
          <X size={16} aria-hidden /> {props.error}
        </div>
      )}

      <div
        className="mt-6 rounded-2xl border border-line p-5 text-center anim-fade-up"
        style={{ background: "linear-gradient(140deg, var(--surface), var(--canvas))" }}
      >
        <span className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent anim-pop">
          <PartyPopper size={22} aria-hidden />
        </span>
        <p className="text-sm font-semibold">You're one tap away from your feed.</p>
        <Button size="lg" fullWidth className="mt-4" onClick={props.onFinish} loading={props.submitting} disabled={props.submitting}>
          {props.submitting ? "Finishing…" : "Finish & enter Professionalist"}
          {!props.submitting && <ArrowRight size={18} aria-hidden />}
        </Button>
      </div>
    </section>
  );
}
