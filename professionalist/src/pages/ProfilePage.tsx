import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  Award,
  BadgeCheck,
  Briefcase,
  Building2,
  Copy,
  Flag,
  Flame,
  Globe,
  GraduationCap,
  Images,
  Link2,
  Lock,
  Mail,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  PenLine,
  Phone,
  Plus,
  ShoppingBag,
  Sparkles,
  Star,
  Store,
  Trophy,
  UserPlus,
  Users,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  Dropdown,
  EmptyState,
  ErrorState,
  MenuItem,
  Modal,
  ProgressBar,
  Skeleton,
  Tabs,
  Textarea,
  VerifiedBadge,
} from "@/components/ui";
import { ListingCard, PersonCard, StarRating, useFollowToggle } from "@/components/cards";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { messagingApi, networkApi, postsApi, supportApi, usersApi } from "@/services/api";
import { ApiError, mediaUrl } from "@/services/http";
import type { ExperienceItem, ProgressData, Review } from "@/services/types";
import { cn, formatNumber, timeAgo } from "@/lib/utils";

/* --------------------------------- helpers -------------------------------- */

const ACHIEVEMENT_ICONS: Record<string, LucideIcon> = {
  PenLine,
  Users,
  Store,
  Flame,
  GraduationCap,
  Award,
  Trophy,
};

/** Anchors exposed by EditProfilePage, used for "quick add" jumps. */
const SUGGESTION_ANCHORS: { match: RegExp; anchor: string }[] = [
  { match: /cover|banner|photo|avatar/i, anchor: "photos" },
  { match: /bio|headline|title|summary/i, anchor: "story" },
  { match: /skill/i, anchor: "skills" },
  { match: /certif/i, anchor: "certifications" },
  { match: /portfolio|work|project/i, anchor: "portfolio" },
  { match: /experience|job/i, anchor: "experience" },
  { match: /educat|degree|school/i, anchor: "education" },
];

function anchorForSuggestion(text: string): string {
  return SUGGESTION_ANCHORS.find((s) => s.match.test(text))?.anchor ?? "story";
}

function hostOf(url: string): string {
  try {
    return new URL(url, window.location.origin).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function avgRating(reviews: Review[]): number {
  if (!reviews.length) return 0;
  return Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10;
}

function useCopy() {
  const toast = useToast();
  return (value: string, label: string) => {
    if (!value) return;
    if (!navigator.clipboard) {
      toast.error("Clipboard unavailable", "Copy manually: " + value);
      return;
    }
    void navigator.clipboard.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Could not copy", String(value))
    );
  };
}

/* ------------------------------ small sections ----------------------------- */

function SectionCard({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("p-4 sm:p-5 anim-fade-up", className)}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Row({ icon, title, subtitle, meta, description }: { icon: React.ReactNode; title: string; subtitle?: string; meta?: string; description?: string }) {
  return (
    <li className="flex gap-3.5 border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0">
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold break-words">{title}</p>
        {subtitle && <p className="text-sm text-ink-soft break-words">{subtitle}</p>}
        {meta && <p className="mt-0.5 text-xs text-ink-faint tabular-nums">{meta}</p>}
        {description && <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-ink-soft">{description}</p>}
      </div>
    </li>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-[13px] text-ink-soft">
      <strong className="text-sm font-extrabold text-ink tabular-nums">{formatNumber(value)}</strong> {label}
    </span>
  );
}

function ReviewRow({ review }: { review: Review }) {
  const name = `${review.author.firstName} ${review.author.lastName}`;
  return (
    <li className="border-t border-line py-4 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-3">
        <Avatar name={name} src={mediaUrl(review.author.avatarUrl)} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to={`/profile/${review.author.username}`} className="text-sm font-bold hover:underline">
              {name}
            </Link>
            {review.author.verified && <VerifiedBadge color={review.author.verifiedColor} size={13} />}
            <span className="text-xs text-ink-faint">{timeAgo(review.createdAt)}</span>
          </div>
          <span className="mt-1 flex items-center gap-0.5" aria-label={`${review.rating} out of 5 stars`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star key={n} size={13} className={cn(n <= review.rating ? "fill-warn text-warn" : "text-line-strong")} aria-hidden />
            ))}
          </span>
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap break-words">{review.text}</p>
        </div>
      </div>
    </li>
  );
}

function ContactRows({ items }: { items: { label: string; value: string; href?: string; icon: React.ReactNode }[] }) {
  const copy = useCopy();
  const visible = items.filter((i) => i.value);
  if (!visible.length) return <p className="text-sm text-ink-soft">No contact details shared yet.</p>;
  return (
    <ul className="space-y-3">
      {visible.map((i) => (
        <li key={i.label} className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft" aria-hidden>
            {i.icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">{i.label}</p>
            {i.href ? (
              <a
                href={i.href}
                target={i.href.startsWith("http") ? "_blank" : undefined}
                rel="noreferrer"
                className="block text-sm font-semibold break-words text-accent hover:underline"
              >
                {i.value}
              </a>
            ) : (
              <p className="text-sm font-semibold break-words">{i.value}</p>
            )}
          </div>
          <button
            onClick={() => copy(i.value, i.label)}
            aria-label={`Copy ${i.label.toLowerCase()}`}
            className="shrink-0 rounded-lg p-2.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-accent"
          >
            <Copy size={15} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------- skeleton --------------------------------- */

function ProfileSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading profile">
      <Card className="overflow-hidden p-0">
        <Skeleton className="h-32 w-full rounded-none sm:h-44 md:h-52" />
        <div className="space-y-3 p-4 sm:p-6">
          <Skeleton className="-mt-14 h-20 w-20 rounded-full sm:-mt-16 sm:h-28 sm:w-28" />
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-3.5 w-72" />
          <Skeleton className="h-3.5 w-40" />
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-10 w-28 rounded-xl" />
            <Skeleton className="h-10 w-28 rounded-xl" />
            <Skeleton className="h-10 w-24 rounded-xl" />
          </div>
        </div>
      </Card>
      <Card className="p-2">
        <Skeleton className="h-10 w-full rounded-xl" />
      </Card>
      <Card className="space-y-4 p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </Card>
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */

type SectionId =
  | "about"
  | "experience"
  | "education"
  | "skills"
  | "services"
  | "products"
  | "portfolio"
  | "posts"
  | "reviews"
  | "achievements"
  | "certifications"
  | "contact";

const POSTS_PER_PAGE = 5;

export default function ProfilePage() {
  const { username = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const copy = useCopy();

  const [tab, setTab] = useState<SectionId>("about");
  const [pages, setPages] = useState(1);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [preview, setPreview] = useState<{ title: string; description: string; imageUrl: string; url: string } | null>(null);

  const profileQ = useAsync(() => usersApi.byUsername(username), [username]);
  const person = profileQ.data?.person;
  const isOwner = !!user && !!person && person.id === user.id;

  const progressQ = useAsync<ProgressData | null>(
    () => (isOwner ? usersApi.progress() : Promise.resolve(null)),
    [isOwner]
  );
  const postsQ = useAsync(() => postsApi.byAuthor(username, { page: 1, pageSize: POSTS_PER_PAGE * pages }), [username, pages]);
  const peopleQ = useAsync(() => networkApi.suggestions({ pageSize: 3 }), []);

  const [connStatus, setConnStatus] = useState(person?.connectionStatus ?? "none");
  useEffect(() => {
    setConnStatus(person?.connectionStatus ?? "none");
  }, [person?.connectionStatus]);

  const [following, toggleFollow] = useFollowToggle({ userId: person?.id, following: person?.following ?? false });

  useEffect(() => {
    if (!person) return;
    const name = `${person.firstName} ${person.lastName}`;
    document.title = person.title ? `${name} — ${person.title} | Professionalist` : `${name} | Professionalist`;
  }, [person]);

  const data = profileQ.data;
  const notFound = data === null && profileQ.error instanceof ApiError && profileQ.error.status === 404;

  /* ------------------------------ relationship ----------------------------- */

  const respondToRequest = async (): Promise<boolean> => {
    if (!person) return false;
    const rows = await networkApi.requests();
    const found = rows.find((r) => r.id === person.id);
    if (!found) return false;
    await networkApi.acceptRequest(found.requestId);
    setConnStatus("connected");
    return true;
  };

  const connect = async () => {
    if (!person) return;
    if (connStatus === "connected") {
      const prev = connStatus;
      setConnStatus("none");
      try {
        await networkApi.removeConnection(person.id);
        toast.success("Connection removed");
      } catch (e) {
        setConnStatus(prev);
        toast.error(errorMessage(e));
      }
      return;
    }
    if (connStatus === "pending_in") {
      try {
        const ok = await respondToRequest();
        toast.success(ok ? "You are now connected" : "Request no longer available");
      } catch (e) {
        toast.error(errorMessage(e));
      }
      return;
    }
    const prev = connStatus;
    setConnStatus("pending_out");
    try {
      const r = await networkApi.connect(person.id);
      setConnStatus(r.status === "accepted" || r.status === "connected" ? "connected" : "pending_out");
      toast.success(r.status === "accepted" ? "You are now connected" : "Invitation sent");
    } catch (e) {
      setConnStatus(prev);
      toast.error(errorMessage(e));
    }
  };

  const message = async () => {
    if (!person) return;
    try {
      const c = await messagingApi.start(person.id);
      navigate(`/messages/${c.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const submitReport = async () => {
    if (!person) return;
    const text = reportText.trim();
    if (text.length < 10) {
      toast.error("Tell us a bit more", "Please write at least 10 characters.");
      return;
    }
    setReportBusy(true);
    try {
      await supportApi.create({
        subject: `Report profile @${person.username}`,
        category: "Report",
        text: `${text}\n\nReported profile: ${window.location.origin}/profile/${person.username}`,
      });
      setReportOpen(false);
      setReportText("");
      toast.success("Report submitted", "Our trust team reviews reports within 24 hours.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setReportBusy(false);
    }
  };

  /* --------------------------------- render -------------------------------- */

  if (profileQ.loading && !data) return <ProfileSkeleton />;

  if (notFound) {
    return (
      <Card className="p-4 sm:p-6">
        <ErrorState message="This profile doesn't exist or has been set to private." onRetry={profileQ.refetch} />
        <div className="flex justify-center gap-2 pb-2">
          <Button variant="outline" onClick={() => navigate("/home")}>
            Back to feed
          </Button>
          <Button onClick={() => navigate("/discover")}>Find professionals</Button>
        </div>
      </Card>
    );
  }

  if (!data || !person) {
    return (
      <Card className="p-4 sm:p-6">
        <ErrorState message={errorMessage(profileQ.error)} onRetry={profileQ.refetch} />
      </Card>
    );
  }

  const profile = data.profile;
  const { stats, reviews, services, products } = data;
  const name = `${person.firstName} ${person.lastName}`;
  const progress = progressQ.data;

  const sections = [
    { id: "about", label: "About", count: undefined },
    { id: "experience", label: "Experience", count: profile.experience.length },
    { id: "education", label: "Education", count: profile.education.length },
    { id: "skills", label: "Skills", count: profile.skills.length },
    { id: "services", label: "Services", count: services.length },
    { id: "products", label: "Products", count: products.length },
    { id: "portfolio", label: "Portfolio", count: profile.portfolio.length },
    { id: "posts", label: "Posts", count: stats.posts },
    { id: "reviews", label: "Reviews", count: reviews.length },
    { id: "achievements", label: "Achievements", count: isOwner ? progress?.achievements.length : undefined },
    { id: "certifications", label: "Certifications", count: profile.certifications.length },
    { id: "contact", label: "Contact", count: undefined },
  ];

  /** Empty state that adapts to owner vs visitor. */
  const empty = (title: string, description: string, anchor?: string, addLabel = "Add") => (
    <EmptyState
      icon={<Sparkles />}
      title={title}
      description={isOwner ? description : `No ${title.toLowerCase()} to show on this profile yet.`}
      action={
        isOwner && anchor ? (
          <Button size="sm" onClick={() => navigate(`/profile/edit#${anchor}`)}>
            <Plus size={15} /> {addLabel}
          </Button>
        ) : undefined
      }
    />
  );

  const experienceList = (
    <SectionCard
      title="Experience"
      action={
        isOwner ? (
          <Button size="sm" variant="soft" onClick={() => navigate("/profile/edit#experience")}>
            <Plus size={14} /> Add
          </Button>
        ) : undefined
      }
    >
      {profile.experience.length ? (
        <ul>
          {profile.experience.map((e: ExperienceItem) => (
            <Row
              key={e.id}
              icon={<Briefcase size={18} />}
              title={e.role}
              subtitle={[e.company, e.location].filter(Boolean).join(" · ")}
              meta={`${e.start || "—"} — ${e.end || "Present"}`}
              description={e.description}
            />
          ))}
        </ul>
      ) : (
        empty("Experience", "Add your current and past roles so buyers can judge your seniority.", "experience", "Add experience")
      )}
    </SectionCard>
  );

  const educationList = (
    <SectionCard
      title="Education"
      action={
        isOwner ? (
          <Button size="sm" variant="soft" onClick={() => navigate("/profile/edit#education")}>
            <Plus size={14} /> Add
          </Button>
        ) : undefined
      }
    >
      {profile.education.length ? (
        <ul>
          {profile.education.map((e) => (
            <Row
              key={e.id}
              icon={<GraduationCap size={18} />}
              title={e.school}
              subtitle={[e.degree, e.field].filter(Boolean).join(" · ")}
              meta={`${e.start || "—"} — ${e.end || "—"}`}
            />
          ))}
        </ul>
      ) : (
        empty("Education", "Degrees, diplomas and schools help people trust you.", "education", "Add education")
      )}
    </SectionCard>
  );

  const certificationsList = (
    <SectionCard
      title="Certifications"
      action={
        isOwner ? (
          <Button size="sm" variant="soft" onClick={() => navigate("/profile/edit#certifications")}>
            <Plus size={14} /> Add
          </Button>
        ) : undefined
      }
    >
      {profile.certifications.length ? (
        <ul>
          {profile.certifications.map((c) => (
            <Row key={c.id} icon={<BadgeCheck size={18} />} title={c.name} subtitle={c.issuer} meta={c.year} />
          ))}
        </ul>
      ) : (
        empty("Certifications", "Add credentials — they are one of the fastest ways to raise trust.", "certifications", "Add certification")
      )}
    </SectionCard>
  );

  const aboutSection = (
    <div className="space-y-4">
      <SectionCard
        title="About"
        action={
          isOwner ? (
            <Button size="sm" variant="ghost" onClick={() => navigate("/profile/edit#story")}>
              <PenLine size={14} /> Edit
            </Button>
          ) : undefined
        }
      >
        {profile.bio ? (
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">{profile.bio}</p>
        ) : (
          empty("Bio", "Write a short story about the work you do and who you do it best for.", "story", "Write bio")
        )}
        {profile.skills.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line pt-4">
            {profile.skills.map((s) => (
              <Chip key={s}>{s}</Chip>
            ))}
          </div>
        )}
      </SectionCard>
      {experienceList}
      {profile.category && (
        <Card className="flex flex-wrap items-center gap-2 p-4 anim-fade-up">
          <Building2 size={16} className="text-ink-soft" aria-hidden />
          <span className="text-sm text-ink-soft">Professional category</span>
          <Badge tone="accent">{profile.category}</Badge>
          {profile.country && (
            <>
              <span className="ml-auto text-sm text-ink-soft">Based in</span>
              <Badge>{profile.country}</Badge>
            </>
          )}
        </Card>
      )}
    </div>
  );

  const skillsSection = (
    <div className="space-y-4">
      <SectionCard
        title="Skills"
        action={
          isOwner ? (
            <Button size="sm" variant="soft" onClick={() => navigate("/profile/edit#skills")}>
              <Plus size={14} /> Add
            </Button>
          ) : undefined
        }
      >
        {profile.skills.length ? (
          <ul className="flex flex-wrap gap-2">
            {profile.skills.map((s) => {
              const endorsement = progress?.skills.find((k) => k.name === s);
              return (
                <li key={s}>
                  <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2/70 px-3.5 py-2 text-[13px] font-semibold">
                    {s}
                    {endorsement && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
                        <Award size={11} aria-hidden /> {endorsement.endorsements}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          empty("Skills", "List at least three skills so the right buyers and partners can find you.", "skills", "Add skills")
        )}
      </SectionCard>
      <SectionCard title="Interests">
        {profile.interests.length ? (
          <div className="flex flex-wrap gap-1.5">
            {profile.interests.map((i) => (
              <Badge key={i}>{i}</Badge>
            ))}
          </div>
        ) : (
          empty("Interests", "Interests sharpen your feed and recommendations.", "skills", "Add interests")
        )}
      </SectionCard>
    </div>
  );

  const listingsSection = (rows: typeof services, title: string, kind: "service" | "product") => (
    <SectionCard
      title={title}
      action={
        isOwner ? (
          <Button size="sm" variant="soft" onClick={() => navigate("/create-listing")}>
            <Plus size={14} /> Create {kind}
          </Button>
        ) : undefined
      }
    >
      {rows.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={kind === "service" ? <Sparkles /> : <ShoppingBag />}
          title={title}
          description={
            isOwner
              ? `Nothing published here yet. Create a ${kind} and it appears on your profile instantly.`
              : `This professional has not published any ${kind}s yet.`
          }
          action={isOwner ? <Button size="sm" onClick={() => navigate("/create-listing")}>Create {kind}</Button> : undefined}
        />
      )}
    </SectionCard>
  );

  const portfolioSection = (
    <SectionCard
      title="Portfolio"
      action={
        isOwner ? (
          <Button size="sm" variant="soft" onClick={() => navigate("/profile/edit#portfolio")}>
            <Plus size={14} /> Add
          </Button>
        ) : undefined
      }
    >
      {profile.portfolio.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {profile.portfolio.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setPreview({ title: p.title, description: p.description, imageUrl: p.imageUrl, url: p.url })}
                className="group relative block aspect-[4/3] w-full overflow-hidden rounded-xl border border-line text-left transition-shadow hover:shadow-pop"
                aria-label={`Open ${p.title}`}
              >
                {p.imageUrl ? (
                  <img
                    src={mediaUrl(p.imageUrl)}
                    alt={p.title}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.05]"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-surface-2 text-ink-faint">
                    <Images size={22} aria-hidden />
                  </span>
                )}
                <span className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/75 via-black/25 to-transparent p-2.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <span className="text-[13px] font-bold leading-snug text-white line-clamp-2">{p.title}</span>
                  {p.description && <span className="mt-0.5 text-[11px] text-white/80 line-clamp-1">{p.description}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        empty("Portfolio", "Show two or three pieces of real work — it converts visitors into clients.", "portfolio", "Add work")
      )}
    </SectionCard>
  );

  const postsSection = (
    <div className="space-y-4">
      {postsQ.loading && <PostCardSkeleton />}
      {!postsQ.loading && postsQ.error && (
        <Card>
          <ErrorState message={errorMessage(postsQ.error)} onRetry={postsQ.refetch} />
        </Card>
      )}
      {!postsQ.loading && postsQ.data && postsQ.data.items.length === 0 && (
        <Card>
          <EmptyState
            icon={<PenLine />}
            title="No posts yet"
            description={isOwner ? "Your first update is how people see you are active." : `${person.firstName} has not posted publicly yet.`}
            action={isOwner ? <Button size="sm" onClick={() => navigate("/home?compose=1")}>Create a post</Button> : undefined}
          />
        </Card>
      )}
      {!postsQ.loading &&
        postsQ.data?.items.map((p) => <PostCard key={p.id} post={p} onChanged={postsQ.refetch} />)}
      {!postsQ.loading && postsQ.data?.hasMore && (
        <div className="flex justify-center pt-1">
          <Button variant="outline" onClick={() => setPages((n) => n + 1)} loading={postsQ.loading}>
            Load more posts
          </Button>
        </div>
      )}
    </div>
  );

  const reviewsSection = (
    <SectionCard title="Reviews">
      {reviews.length ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-surface-2/70 p-3.5">
            <span className="text-3xl font-extrabold tabular-nums">{avgRating(reviews).toFixed(1)}</span>
            <div>
              <StarRating value={avgRating(reviews)} count={reviews.length} />
              <p className="text-xs text-ink-faint">from verified buyers and collaborators</p>
            </div>
          </div>
          <ul>
            {reviews.map((r) => (
              <ReviewRow key={r.id} review={r} />
            ))}
          </ul>
        </>
      ) : (
        empty("Reviews", "Ask past clients to review your work — it doubles inquiry response rates.", undefined)
      )}
    </SectionCard>
  );

  const achievementsSection = (
    <SectionCard title="Achievements" action={<Link to="/progress" className="text-xs font-semibold text-accent hover:underline">Progress hub</Link>}>
      {isOwner ? (
        progressQ.loading && !progress ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        ) : progressQ.error ? (
          <ErrorState message={errorMessage(progressQ.error)} onRetry={progressQ.refetch} />
        ) : progress && progress.achievements.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {progress.achievements.map((a) => {
              const Icon = ACHIEVEMENT_ICONS[a.icon] ?? Trophy;
              const earned = !!a.earnedAt;
              return (
                <li
                  key={a.key}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3.5",
                    earned ? "border-accent/35 bg-accent-soft/60" : "border-dashed border-line bg-surface-2/50"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                      earned ? "bg-accent text-accent-ink" : "bg-surface text-ink-faint"
                    )}
                    aria-hidden
                  >
                    {earned ? <Icon size={18} /> : <Lock size={16} />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold">{a.title}</p>
                    <p className="mt-0.5 text-xs text-ink-soft">{a.description}</p>
                    <p className={cn("mt-1 flex items-center gap-1 text-[11px] font-semibold", earned ? "text-accent" : "text-ink-faint")}>
                      {earned ? <Trophy size={11} aria-hidden /> : <Lock size={11} aria-hidden />}
                      {earned ? `Earned ${timeAgo(a.earnedAt)} ago` : "Locked — keep going"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          empty("Achievements", "Earn badges by posting, connecting and selling.", undefined)
        )
      ) : (
        <EmptyState
          icon={<Lock />}
          title="Achievements are private"
          description="Professionalists only share their badge case on their own progress hub."
          action={
            <Button size="sm" variant="outline" onClick={() => navigate("/progress")}>
              View my achievements
            </Button>
          }
        />
      )}
    </SectionCard>
  );

  const contactSection = (
    <div className="space-y-4">
      <SectionCard title="Contact">
        <ContactRows
          items={[
            { label: "Website", value: profile.website, href: profile.website, icon: <Globe size={16} /> },
            { label: "Phone", value: profile.phone, href: profile.phone ? `tel:${profile.phone.replace(/\s+/g, "")}` : undefined, icon: <Phone size={16} /> },
            { label: "Location", value: profile.location, icon: <MapPin size={16} /> },
            { label: "Username", value: `@${person.username}`, icon: <Link2 size={16} /> },
            ...(isOwner && user ? [{ label: "Email", value: user.email, href: `mailto:${user.email}`, icon: <Mail size={16} /> }] : []),
          ]}
        />
      </SectionCard>
      <SectionCard title="Prefer to talk?">
        <div className="flex flex-wrap gap-2">
          {!isOwner && (
            <Button variant="outline" onClick={() => void message()}>
              <MessageSquare size={16} /> Message {person.firstName}
            </Button>
          )}
          <Button variant="ghost" onClick={() => copy(`${window.location.origin}/profile/${person.username}`, "Profile link")}>
            <Link2 size={16} /> Copy profile link
          </Button>
        </div>
      </SectionCard>
    </div>
  );

  const section = () => {
    switch (tab) {
      case "experience":
        return experienceList;
      case "education":
        return educationList;
      case "certifications":
        return certificationsList;
      case "skills":
        return skillsSection;
      case "services":
        return listingsSection(services, "Services offered", "service");
      case "products":
        return listingsSection(products, "Products for sale", "product");
      case "portfolio":
        return portfolioSection;
      case "posts":
        return postsSection;
      case "reviews":
        return reviewsSection;
      case "achievements":
        return achievementsSection;
      case "contact":
        return contactSection;
      default:
        return aboutSection;
    }
  };

  const connectLabel =
    connStatus === "connected" ? "Connected" : connStatus === "pending_out" ? "Pending" : connStatus === "pending_in" ? "Accept request" : "Connect";

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden p-0 anim-fade-up">
        <div className="h-32 overflow-hidden bg-surface-2 sm:h-44 md:h-52">
          {profile.coverUrl ? (
            <img src={mediaUrl(profile.coverUrl)} alt={`${name} cover`} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-[#0B5CD8] via-[#1668E3] to-[#22C0FF]" aria-hidden />
          )}
        </div>

        <div className="px-4 pb-5 sm:px-6">
          <Avatar name={name} src={mediaUrl(profile.avatarUrl)} size="2xl" ring className="-mt-12 shadow-pop sm:-mt-16" />

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="text-xl font-extrabold break-words sm:text-2xl">{name}</h1>
            {person.verified && <VerifiedBadge color={person.verifiedColor} size={18} />}
            {profile.category && <Badge tone="neutral" className="ml-1">{profile.category}</Badge>}
          </div>

          <p className="mt-1 text-[15px] text-ink-soft break-words">{profile.title || `@${person.username}`}</p>

          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-ink-soft">
            {profile.company && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Building2 size={14} aria-hidden /> <span className="break-words">{profile.company}</span>
              </span>
            )}
            {profile.location && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <MapPin size={14} aria-hidden /> <span className="break-words">{profile.location}</span>
              </span>
            )}
            {profile.website && (
              <a
                href={profile.website}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-accent hover:underline"
              >
                <Globe size={14} aria-hidden /> <span className="max-w-[220px] truncate">{hostOf(profile.website)}</span>
              </a>
            )}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
            <Stat value={stats.posts} label="posts" />
            <Stat value={stats.followers} label="followers" />
            <Stat value={stats.connections} label="connections" />
            {person.mutualConnections > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft">
                <Users size={14} aria-hidden /> {person.mutualConnections} mutual
              </span>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {isOwner ? (
              <>
                <Button onClick={() => navigate("/profile/edit")}>
                  <PenLine size={16} /> Edit profile
                </Button>
                <Button variant="outline" onClick={() => navigate("/create-listing")}>
                  <Store size={16} /> Create listing
                </Button>
                <Button variant="ghost" onClick={() => copy(`${window.location.origin}/profile/${person.username}`, "Profile link")}>
                  <Copy size={16} /> Copy link
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant={connStatus === "connected" ? "outline" : connStatus === "none" ? "primary" : "soft"}
                  onClick={() => void connect()}
                >
                  {connStatus === "connected" ? <Users size={16} aria-hidden /> : <UserPlus size={16} aria-hidden />}
                  {connectLabel}
                </Button>
                <Button variant={following ? "outline" : "soft"} onClick={toggleFollow} aria-pressed={following}>
                  {following ? "Following" : "Follow"}
                </Button>
                <Button variant="outline" onClick={() => void message()}>
                  <MessageSquare size={16} /> Message
                </Button>
                <Dropdown
                  trigger={({ toggle }) => (
                    <button
                      onClick={toggle}
                      aria-label="More profile options"
                      className="flex h-10 w-10 items-center justify-center rounded-xl border border-line-strong bg-surface text-ink-soft transition-colors hover:bg-surface-2"
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem
                        icon={<Link2 size={16} />}
                        onClick={() => {
                          copy(`${window.location.origin}/profile/${person.username}`, "Profile link");
                          close();
                        }}
                      >
                        Copy profile link
                      </MenuItem>
                      <MenuItem
                        icon={<Flag size={16} />}
                        danger
                        onClick={() => {
                          setReportOpen(true);
                          close();
                        }}
                      >
                        Report profile
                      </MenuItem>
                    </>
                  )}
                </Dropdown>
              </>
            )}
          </div>

          {isOwner && progress && (
            <div className="mt-5 rounded-xl border border-line bg-surface-2/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold">Profile {progress.profileCompletion}% complete</p>
                <Button size="sm" variant="ghost" onClick={() => navigate("/profile/edit")}>
                  Improve profile
                </Button>
              </div>
              <ProgressBar value={progress.profileCompletion} showLabel className="mt-3" tone={progress.profileCompletion >= 80 ? "success" : "accent"} />
              {progress.profileSuggestions.length > 0 && (
                <ul className="mt-3.5 space-y-2">
                  {progress.profileSuggestions.slice(0, 3).map((s) => (
                    <li key={s} className="flex items-center gap-2.5">
                      <Sparkles size={15} className="shrink-0 text-accent" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{s}</span>
                      <Button size="sm" variant="outline" onClick={() => navigate(`/profile/edit#${anchorForSuggestion(s)}`)}>
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Card className="sticky top-14 z-30 px-1.5 py-1 sm:top-16 sm:px-2">
            <Tabs items={sections} value={tab} onChange={(id) => setTab(id as SectionId)} className="border-b-0" />
          </Card>
          <div key={tab} className="anim-fade-up">
            {section()}
          </div>
        </div>

        <aside className="hidden min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100dvh-6.5rem)] lg:overflow-y-auto lg:pb-2 hide-scrollbar" aria-label="Profile extras">
          <section className="card p-4">
            <h2 className="mb-3 text-sm font-bold">Contact info</h2>
            <ContactRows
              items={[
                { label: "Website", value: profile.website, href: profile.website, icon: <Globe size={16} /> },
                { label: "Phone", value: profile.phone, icon: <Phone size={16} /> },
                { label: "Location", value: profile.location, icon: <MapPin size={16} /> },
                { label: "Username", value: `@${person.username}`, icon: <Link2 size={16} /> },
                ...(isOwner && user ? [{ label: "Email", value: user.email, href: `mailto:${user.email}`, icon: <Mail size={16} /> }] : []),
              ]}
            />
          </section>

          {person.openTo && person.openTo.length > 0 && (
            <section className="card p-4">
              <h2 className="mb-3 text-sm font-bold">Open to</h2>
              <ul className="flex flex-wrap gap-1.5">
                {person.openTo.map((o) => (
                  <li key={o}>
                    <Badge tone="success">{o}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card p-4" aria-label="Similar professionals">
            <h2 className="mb-3 text-sm font-bold">Similar professionals</h2>
            {peopleQ.loading && (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-28 rounded-2xl" />
                ))}
              </div>
            )}
            {peopleQ.error && !peopleQ.loading && <ErrorState message={errorMessage(peopleQ.error)} onRetry={peopleQ.refetch} />}
            {peopleQ.data && peopleQ.data.length === 0 && <p className="text-sm text-ink-soft">No similar people to suggest right now.</p>}
            {peopleQ.data && (
              <div className="space-y-3">
                {peopleQ.data
                  .filter((p) => p.id !== person.id)
                  .slice(0, 3)
                  .map((p) => (
                    <PersonCard key={p.id} person={p} />
                  ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <Modal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title={`Report @${person.username}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReportOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void submitReport()} loading={reportBusy} disabled={reportText.trim().length < 10}>
              Submit report
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-soft">
          Tell our trust team what is wrong with this profile. Reports are confidential and the profile is never shown to {person.firstName}.
        </p>
        <Textarea
          label="Reason"
          rows={4}
          value={reportText}
          onChange={(e) => setReportText(e.target.value)}
          placeholder="Misleading listings, impersonation, spam…"
          error={reportText.length > 0 && reportText.trim().length < 10 ? "Please write at least 10 characters" : undefined}
        />
      </Modal>

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.title} size="lg">
        {preview && (
          <div className="space-y-3">
            {preview.imageUrl ? (
              <img src={mediaUrl(preview.imageUrl)} alt={preview.title} className="w-full rounded-xl border border-line object-cover" />
            ) : (
              <div className="flex h-48 items-center justify-center rounded-xl bg-surface-2 text-ink-faint">
                <Images size={26} aria-hidden />
              </div>
            )}
            {preview.description && <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{preview.description}</p>}
            {preview.url && /^https?:/i.test(preview.url) && (
              <a href={preview.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
                <Globe size={15} aria-hidden /> Open project link
              </a>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
