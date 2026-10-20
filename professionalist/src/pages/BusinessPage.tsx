import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  BarChart3,
  Briefcase,
  Building2,
  Copy,
  ExternalLink,
  Flag,
  Globe,
  Link2,
  Mail,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Phone,
  ShoppingBag,
  Sparkles,
  Star,
  Store,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Dropdown,
  EmptyState,
  ErrorState,
  Input,
  MenuItem,
  Modal,
  Skeleton,
  Tabs,
  Textarea,
  VerifiedBadge,
} from "@/components/ui";
import { BusinessCard, ListingCard, StarRating, useFollowToggle } from "@/components/cards";
import { PostCard } from "@/components/PostCard";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { businessesApi, messagingApi, networkApi, postsApi, supportApi } from "@/services/api";
import { ApiError, mediaUrl } from "@/services/http";
import type { Business, Review } from "@/services/types";
import { cn, formatNumber, timeAgo } from "@/lib/utils";

/* --------------------------------- helpers -------------------------------- */

type SectionId = "about" | "posts" | "products" | "services" | "reviews" | "team" | "contact" | "analytics";

interface BusinessAnalytics {
  visitors: number;
  followers: number;
  engagement: number;
  revenue: number;
  trend: number[];
  topListings: { title: string; views: number }[];
}

const REVIEW_MAX = 500;

function hostOf(url: string): string {
  try {
    return new URL(url, window.location.origin).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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

function Stars({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} size={13} className={cn(n <= value ? "fill-warn text-warn" : "text-line-strong")} aria-hidden />
      ))}
    </span>
  );
}

/** 12-point visitor trend, drawn as a responsive inline SVG line + area. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <p className="text-xs text-ink-faint">Not enough data to chart yet.</p>;
  const w = 100;
  const h = 32;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const rising = values[values.length - 1] >= values[0];
  return (
    <figure className="mt-3">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="Visitor trend over the last 12 periods">
        <polyline points={`0,${h} ${pts.join(" ")} ${w},${h}`} fill="var(--accent-soft)" stroke="none" aria-hidden />
        <polyline points={pts.join(" ")} fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" aria-hidden />
      </svg>
      <figcaption className={cn("mt-1 flex items-center gap-1 text-[11px] font-semibold", rising ? "text-success" : "text-warn")}>
        <TrendingUp size={12} aria-hidden /> {rising ? "Trending up" : "Dip vs. previous"} · {formatNumber(values[values.length - 1])} latest
      </figcaption>
    </figure>
  );
}

function ContactRow({ icon, label, value, href }: { icon: React.ReactNode; label: string; value: string; href?: string }) {
  const copy = useCopy();
  if (!value) return null;
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="block text-sm font-semibold break-words text-accent hover:underline"
          >
            {value}
          </a>
        ) : (
          <p className="text-sm font-semibold break-words">{value}</p>
        )}
      </div>
      <button
        onClick={() => copy(value, label)}
        aria-label={`Copy ${label.toLowerCase()}`}
        className="shrink-0 rounded-lg p-2.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-accent"
      >
        <Copy size={15} />
      </button>
    </li>
  );
}

/* -------------------------------- skeleton -------------------------------- */

function BusinessSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading business">
      <Card className="overflow-hidden p-0">
        <Skeleton className="h-32 w-full rounded-none sm:h-44 md:h-52" />
        <div className="p-4 sm:p-6">
          <Skeleton className="-mt-12 h-20 w-20 rounded-2xl sm:-mt-14 sm:h-24 sm:w-24" />
          <Skeleton className="mt-3 h-5 w-56" />
          <Skeleton className="mt-2 h-3.5 w-72" />
          <Skeleton className="mt-2 h-3.5 w-40" />
          <div className="flex gap-2 pt-4">
            <Skeleton className="h-10 w-32 rounded-xl" />
            <Skeleton className="h-10 w-28 rounded-xl" />
            <Skeleton className="h-10 w-28 rounded-xl" />
          </div>
        </div>
      </Card>
      <Card className="p-2">
        <Skeleton className="h-10 w-full rounded-xl" />
      </Card>
      <Card className="space-y-4 p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </Card>
    </div>
  );
}

/* -------------------------------- analytics ------------------------------- */

/** Owner-only performance panel. Module-level so its identity stays stable. */
function AnalyticsPanel({
  analytics,
  loading,
  error,
  onRetry,
  businessName,
}: {
  analytics: BusinessAnalytics | null;
  loading: boolean;
  error: ApiError | Error | null;
  onRetry: () => void;
  businessName: string;
}) {
  if (loading && !analytics) {
    return (
      <Card className="p-4 sm:p-5" aria-busy="true" aria-label="Loading analytics">
        <Skeleton className="h-5 w-44" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="mt-4 h-32 rounded-xl" />
      </Card>
    );
  }

  if (error && !analytics) {
    return (
      <Card className="p-4 sm:p-5">
        <ErrorState message={errorMessage(error)} onRetry={onRetry} />
      </Card>
    );
  }

  if (!analytics) {
    return (
      <Card>
        <EmptyState
          icon={<BarChart3 />}
          title="No analytics yet"
          description="Data appears once this page starts collecting visits, follows and sales."
          action={
            <Button size="sm" variant="outline" onClick={onRetry} loading={loading}>
              Try again
            </Button>
          }
        />
      </Card>
    );
  }

  const topMax = Math.max(1, ...analytics.topListings.map((l) => l.views));

  return (
    <Card className="p-4 anim-fade-up sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold">Business analytics</h2>
        <Button size="sm" variant="ghost" onClick={onRetry} loading={loading}>
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Visitors", value: formatNumber(analytics.visitors), icon: <Users size={16} />, hint: "last 30 days" },
          { label: "Followers", value: formatNumber(analytics.followers), icon: <TrendingUp size={16} />, hint: "all time" },
          { label: "Engagement", value: `${analytics.engagement}%`, icon: <Star size={16} />, hint: "of viewers acted" },
          { label: "Revenue", value: `$${formatNumber(analytics.revenue)}`, icon: <BarChart3 size={16} />, hint: "marketplace orders" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-line bg-surface-2/50 p-3.5">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">
              <span className="text-accent" aria-hidden>
                {c.icon}
              </span>
              {c.label}
            </span>
            <p className="mt-1.5 text-2xl font-extrabold tabular-nums">{c.value}</p>
            <p className="text-[11px] text-ink-faint">{c.hint}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-line p-4">
          <h3 className="text-sm font-bold">Visitor trend</h3>
          <Sparkline values={analytics.trend} />
        </div>
        <div className="rounded-xl border border-line p-4">
          <h3 className="text-sm font-bold">Top listings</h3>
          {analytics.topListings.length ? (
            <ul className="mt-3 space-y-2.5">
              {analytics.topListings.map((l) => (
                <li key={l.title}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] font-semibold">{l.title}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-soft">{formatNumber(l.views)}</span>
                  </div>
                  <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${(l.views / topMax) * 100}%` }}
                      aria-hidden
                    />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">Publish a listing to start collecting views.</p>
          )}
        </div>
      </div>

      <p className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-xs text-ink-faint">
        <BarChart3 size={13} aria-hidden /> Want more reach?{" "}
        <Link to="/advertising" className="font-semibold text-accent hover:underline">
          Run a campaign for {businessName}
        </Link>
      </p>
    </Card>
  );
}

/* ---------------------------------- page ---------------------------------- */

export default function BusinessPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const copy = useCopy();
  const { user } = useAuth();

  const [tab, setTab] = useState<SectionId>("about");
  const [manageOpen, setManageOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const dataQ = useAsync(() => businessesApi.bySlug(slug), [slug]);
  const manageQ = useAsync<Business[]>(() => businessesApi.manage().catch(() => []), []);

  const data = dataQ.data;
  const business = data?.business;
  const isOwner = !!business && !!manageQ.data?.some((b) => b.id === business.id);

  const employeesQ = useAsync(
    () => (business ? businessesApi.employees(business.id) : Promise.resolve([])),
    [business?.id]
  );
  const analyticsQ = useAsync<BusinessAnalytics | null>(
    () => (isOwner && business ? businessesApi.analytics(business.id) : Promise.resolve(null)),
    [isOwner, business?.id]
  );

  useEffect(() => {
    if (!business) return;
    document.title = business.industry ? `${business.name} — ${business.industry} | Professionalist` : `${business.name} | Professionalist`;
  }, [business]);

  const [following, toggleFollow] = useFollowToggle({ businessId: business?.id, following: business?.following ?? false }, dataQ.refetch);

  if (dataQ.loading && !data) return <BusinessSkeleton />;

  if (data === null && dataQ.error instanceof ApiError && dataQ.error.status === 404) {
    return (
      <Card className="p-4 sm:p-6">
        <ErrorState message="This business page doesn't exist or was removed." onRetry={dataQ.refetch} />
        <div className="flex justify-center gap-2 pb-2">
          <Button variant="outline" onClick={() => navigate("/marketplace")}>
            Browse the marketplace
          </Button>
          <Button onClick={() => navigate("/home")}>Back to feed</Button>
        </div>
      </Card>
    );
  }

  if (!data || !business) {
    return (
      <Card className="p-4 sm:p-6">
        <ErrorState message={errorMessage(dataQ.error)} onRetry={dataQ.refetch} />
      </Card>
    );
  }

  const { posts, products, services, reviews } = data;
  const team = employeesQ.data ?? business.team;
  const myReview = user ? reviews.find((r) => r.author.id === user.id) : undefined;
  const counts = [5, 4, 3, 2, 1].map((star) => ({ star, n: reviews.filter((r) => Math.round(r.rating) === star).length }));
  const maxCount = Math.max(1, ...counts.map((c) => c.n));
  /* Rating is derived from the visible reviews so an optimistic review lands immediately;
     `rating` is 0 for unrated pages, so never render a misleading "0.0". */
  const reviewCount = reviews.length || business.reviewCount;
  const avgRating = reviews.length ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : business.rating;
  const ratingLabel = reviewCount > 0 ? avgRating.toFixed(1) : "—";

  /* -------------------------------- actions -------------------------------- */

  /** Patch the review list in place so optimistic rows appear without a refetch round-trip. */
  const patchReviews = (fn: (rows: Review[]) => Review[]) => {
    if (!data) return;
    dataQ.setData((prev) => ({ ...(prev ?? data), reviews: fn(prev?.reviews ?? data.reviews) }));
  };

  const messageMember = async (userId: number, name: string) => {
    try {
      const c = await messagingApi.start(userId);
      navigate(`/messages/${c.id}`);
      toast.info("Conversation opened", `You are now chatting with ${name}.`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const openMessage = () => {
    if (!team.length) {
      toast.info("No contact person yet", "This business has not listed anyone to message.");
      return;
    }
    if (team.length === 1) {
      void messageMember(team[0].userId, team[0].name);
      return;
    }
    /* handled by the dropdown below */
  };

  const submitReport = async (reason: string) => {
    await supportApi.create({
      subject: `Report ${business.name}`,
      category: "Report",
      text: `${reason}\n\nReported page: ${window.location.origin}/business/${business.slug}`,
    });
    setReportOpen(false);
    toast.success("Report submitted", "Our trust team reviews reports within 24 hours.");
  };

  const tabs: { id: SectionId; label: string; count?: number }[] = [
    { id: "about", label: "About" },
    { id: "posts", label: "Posts", count: posts.length },
    { id: "products", label: "Products", count: products.length },
    { id: "services", label: "Services", count: services.length },
    { id: "reviews", label: "Reviews", count: reviews.length },
    { id: "team", label: "Team", count: team.length },
    ...(isOwner ? [{ id: "analytics" as SectionId, label: "Analytics" }] : []),
    { id: "contact", label: "Contact" },
  ];

  /* -------------------------------- sections ------------------------------- */

  const aboutSection = (
    <div className="space-y-4">
      <Card className="p-4 anim-fade-up sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold">About {business.name}</h2>
          {isOwner && (
            <Button size="sm" variant="ghost" onClick={() => setManageOpen(true)}>
              <Pencil size={14} /> Edit page
            </Button>
          )}
        </div>
        {business.tagline && <p className="text-[15px] font-semibold text-ink">{business.tagline}</p>}
        <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-ink-soft">
          {business.description || "This business has not written a description yet."}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-4">
          {[
            { label: "Industry", value: business.industry || "—" },
            { label: "Category", value: business.category || "—" },
            { label: "Location", value: business.location || "—" },
            { label: "Listings", value: formatNumber(business.listingCount) },
          ].map((row) => (
            <div key={row.label} className="min-w-0">
              <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">{row.label}</dt>
              <dd className="mt-0.5 truncate text-sm font-semibold">{row.value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {(products.length > 0 || services.length > 0) && (
        <Card className="p-4 anim-fade-up sm:p-5">
          <h2 className="mb-3 text-base font-bold">Featured on the marketplace</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...services, ...products].slice(0, 3).map((l) => (
              <ListingCard key={l.id} listing={l} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setTab("products")}>
              All products ({products.length})
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTab("services")}>
              All services ({services.length})
            </Button>
          </div>
        </Card>
      )}

      {reviews.length > 0 && (
        <Card className="p-4 anim-fade-up sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-3xl font-extrabold tabular-nums">{ratingLabel}</span>
              <div>
                <StarRating value={avgRating} count={reviewCount} />
                <p className="text-xs text-ink-faint">Rated by verified customers</p>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setTab("reviews")}>
              Read reviews
            </Button>
          </div>
        </Card>
      )}
    </div>
  );

  const postsSection = posts.length ? (
    <div className="space-y-4">
      {posts.map((p) => (
        <PostCard key={p.id} post={p} onChanged={dataQ.refetch} />
      ))}
    </div>
  ) : (
    <Card>
      <EmptyState
        icon={<Sparkles />}
        title="No posts yet"
        description={isOwner ? "Publish an update and it shows up here instantly." : `${business.name} has not posted publicly yet.`}
        action={isOwner ? <Button size="sm" onClick={() => navigate("/home?compose=1")}>Create a post</Button> : undefined}
      />
    </Card>
  );

  const listingsSection = (rows: typeof products, title: string, emptyHint: string) =>
    rows.length ? (
      <Card className="p-4 anim-fade-up sm:p-5">
        <h2 className="mb-3 text-base font-bold">{title}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </div>
      </Card>
    ) : (
      <Card>
        <EmptyState
          icon={title.includes("Product") ? <ShoppingBag /> : <Store />}
          title={title}
          description={isOwner ? emptyHint : `No ${title.toLowerCase()} published by this business yet.`}
          action={isOwner ? <Button size="sm" onClick={() => navigate("/create-listing")}>Create a listing</Button> : undefined}
        />
      </Card>
    );

  const reviewsSection = (
    <Card className="p-4 anim-fade-up sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-3xl font-extrabold tabular-nums">{ratingLabel}</span>
          <div>
            <StarRating value={avgRating} count={reviewCount} />
            <p className="text-xs text-ink-faint">{formatNumber(reviews.length)} written reviews</p>
          </div>
        </div>
        {!isOwner &&
          (myReview ? (
            <Badge tone="success">You reviewed this business</Badge>
          ) : (
            <Button size="sm" onClick={() => setReviewOpen(true)}>
              <Pencil size={14} /> Write a review
            </Button>
          ))}
      </div>

      {reviews.length > 0 && (
        <ul className="mb-5 space-y-2 rounded-xl bg-surface-2/60 p-3.5">
          {counts.map((c) => (
            <li key={c.star} className="flex items-center gap-2.5">
              <span className="flex w-10 shrink-0 items-center gap-1 text-xs font-semibold tabular-nums text-ink-soft">
                {c.star} <Star size={11} className="fill-warn text-warn" aria-hidden />
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${(c.n / maxCount) * 100}%` }} />
              </span>
              <span className="w-8 shrink-0 text-right text-xs tabular-nums text-ink-faint">{c.n}</span>
            </li>
          ))}
        </ul>
      )}

      {reviews.length ? (
        <ul>
          {reviews.map((r) => {
            const name = `${r.author.firstName} ${r.author.lastName}`;
            return (
              <li key={r.id} className="flex items-start gap-3 border-t border-line py-4 first:border-t-0 first:pt-0">
                <Avatar name={name} src={mediaUrl(r.author.avatarUrl)} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link to={`/profile/${r.author.username}`} className="text-sm font-bold hover:underline">
                      {name}
                    </Link>
                    {r.author.verified && <VerifiedBadge color={r.author.verifiedColor} size={13} />}
                    <span className="text-xs text-ink-faint">{timeAgo(r.createdAt)}</span>
                  </div>
                  <span className="mt-1 block">
                    <Stars value={r.rating} />
                  </span>
                  <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap break-words">{r.text}</p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          icon={<Star />}
          title="No reviews yet"
          description={isOwner ? "Ask a happy customer to share their experience." : "Be the first to review this business."}
          action={!isOwner ? <Button size="sm" onClick={() => setReviewOpen(true)}>Write a review</Button> : undefined}
        />
      )}
    </Card>
  );

  const teamSection = (
    <Card className="p-4 anim-fade-up sm:p-5">
      <h2 className="mb-3 text-base font-bold">Team</h2>
      {employeesQ.loading ? (
        <ul className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </ul>
      ) : employeesQ.error ? (
        <ErrorState message={errorMessage(employeesQ.error)} onRetry={employeesQ.refetch} />
      ) : team.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {team.map((m) => (
            <li key={`${m.userId}-${m.role}`} className="flex items-center gap-3 rounded-xl border border-line p-3.5">
              <Avatar name={m.name} src={mediaUrl(m.avatarUrl)} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{m.name}</p>
                <p className="truncate text-xs text-ink-soft">{m.role}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => void messageMember(m.userId, m.name)}>
                <MessageSquare size={14} /> Message
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={<Users />}
          title="Team not listed"
          description={isOwner ? "Add the people customers can talk to." : "This business has not published its team yet."}
          action={isOwner ? <Button size="sm" onClick={() => setManageOpen(true)}>Edit page</Button> : undefined}
        />
      )}
    </Card>
  );

  const analyticsSection = (
    <AnalyticsPanel
      analytics={analyticsQ.data}
      loading={analyticsQ.loading}
      error={analyticsQ.error}
      onRetry={analyticsQ.refetch}
      businessName={business.name}
    />
  );

  const contactSection = (
    <div className="space-y-4">
      <Card className="p-4 anim-fade-up sm:p-5">
        <h2 className="mb-3 text-base font-bold">Contact</h2>
        <ul className="space-y-3">
          <ContactRow icon={<Mail size={16} />} label="Email" value={business.email} href={business.email ? `mailto:${business.email}` : undefined} />
          <ContactRow icon={<Phone size={16} />} label="Phone" value={business.phone} href={business.phone ? `tel:${business.phone.replace(/\s+/g, "")}` : undefined} />
          <ContactRow icon={<Globe size={16} />} label="Website" value={business.website} href={business.website} />
          <ContactRow icon={<MapPin size={16} />} label="Location" value={business.location} />
          <ContactRow icon={<Briefcase size={16} />} label="Industry" value={business.industry} />
        </ul>
        {!business.email && !business.phone && !business.website && !business.location && (
          <p className="text-sm text-ink-soft">This business has not published contact details yet.</p>
        )}
      </Card>
      <Card className="p-4 anim-fade-up sm:p-5">
        <h2 className="mb-2 text-base font-bold">Talk to a person</h2>
        <p className="mb-3 text-[13px] text-ink-soft">Messages on Professionalist are tracked in one thread, with listings and profiles attached.</p>
        {team.length > 1 ? (
          <Dropdown
            align="left"
            trigger={({ toggle }) => (
              <Button variant="outline" onClick={toggle}>
                <MessageSquare size={16} /> Message the team
              </Button>
            )}
          >
            {(close) => (
              <>
                {team.map((m) => (
                  <MenuItem
                    key={`${m.userId}-${m.role}`}
                    icon={<Avatar name={m.name} src={mediaUrl(m.avatarUrl)} size="xs" />}
                    onClick={() => {
                      close();
                      void messageMember(m.userId, m.name);
                    }}
                  >
                    {m.name} · {m.role}
                  </MenuItem>
                ))}
              </>
            )}
          </Dropdown>
        ) : (
          <Button variant="outline" onClick={openMessage}>
            <MessageSquare size={16} /> Message
          </Button>
        )}
      </Card>
    </div>
  );

  const section = () => {
    switch (tab) {
      case "posts":
        return postsSection;
      case "products":
        return listingsSection(products, "Products", "List what you sell and it lands here.");
      case "services":
        return listingsSection(services, "Services", "Offer a service and it lands here.");
      case "reviews":
        return reviewsSection;
      case "team":
        return teamSection;
      case "analytics":
        return analyticsSection;
      case "contact":
        return contactSection;
      default:
        return aboutSection;
    }
  };

  return (
    <div className="space-y-4">
      {/* --------------------------------- header -------------------------------- */}
      <Card className="overflow-hidden p-0 anim-fade-up">
        <div className="h-32 overflow-hidden bg-surface-2 sm:h-44 md:h-52">
          {business.coverUrl ? (
            <img src={mediaUrl(business.coverUrl)} alt={`${business.name} cover`} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-[#0B5CD8] via-[#1668E3] to-[#22C0FF]" aria-hidden />
          )}
        </div>

        <div className="px-4 pb-5 sm:px-6">
          <div className="-mt-12 flex flex-wrap items-end justify-between gap-3 sm:-mt-14">
            <Avatar
              name={business.name}
              src={mediaUrl(business.logoUrl)}
              size="2xl"
              ring
              className="rounded-2xl! bg-surface p-1 shadow-pop [&_img]:rounded-2xl"
            />
            <p className="pb-1 text-xs text-ink-faint">{formatNumber(business.followers)} followers</p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="text-xl font-extrabold break-words sm:text-2xl">{business.name}</h1>
            {business.verified && <VerifiedBadge size={18} />}
            {business.category && <Badge tone="neutral">{business.category}</Badge>}
          </div>

          <p className="mt-1 text-[15px] text-ink-soft break-words">{business.tagline || business.industry}</p>

          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-ink-soft">
            {business.industry && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Building2 size={14} aria-hidden /> <span className="break-words">{business.industry}</span>
              </span>
            )}
            {business.location && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <MapPin size={14} aria-hidden /> <span className="break-words">{business.location}</span>
              </span>
            )}
            {business.reviewCount > 0 && <StarRating value={business.rating} count={business.reviewCount} />}
            {business.website && (
              <a
                href={business.website}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-accent hover:underline"
              >
                <Globe size={14} aria-hidden /> <span className="max-w-[220px] truncate">{hostOf(business.website)}</span>
                <ExternalLink size={12} aria-hidden />
              </a>
            )}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant={following ? "outline" : "primary"} onClick={toggleFollow} aria-pressed={following}>
              <Users size={16} /> {following ? "Following" : "Follow"} · {formatNumber(business.followers)}
            </Button>

            {team.length > 1 ? (
              <Dropdown
                align="left"
                trigger={({ toggle }) => (
                  <Button variant="outline" onClick={toggle}>
                    <MessageSquare size={16} /> Message
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    {team.map((m) => (
                      <MenuItem
                        key={`${m.userId}-${m.role}`}
                        icon={<Avatar name={m.name} src={mediaUrl(m.avatarUrl)} size="xs" />}
                        onClick={() => {
                          close();
                          void messageMember(m.userId, m.name);
                        }}
                      >
                        {m.name} · {m.role}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Dropdown>
            ) : (
              <Button variant="outline" onClick={openMessage}>
                <MessageSquare size={16} /> Message
              </Button>
            )}

            {business.website && (
              <a href={business.website} target="_blank" rel="noreferrer">
                <Button variant="ghost">
                  <Globe size={16} /> Visit website
                </Button>
              </a>
            )}

            {isOwner ? (
              <>
                <Button variant="secondary" onClick={() => setManageOpen(true)}>
                  <Pencil size={16} /> Manage
                </Button>
                <Button variant="soft" onClick={() => setTab("analytics")}>
                  <BarChart3 size={16} /> Business analytics
                </Button>
              </>
            ) : (
              <Dropdown
                trigger={({ toggle }) => (
                  <button
                    onClick={toggle}
                    aria-label="More business options"
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
                        copy(`${window.location.origin}/business/${business.slug}`, "Business link");
                        close();
                      }}
                    >
                      Copy business link
                    </MenuItem>
                    <MenuItem
                      icon={<ShoppingBag size={16} />}
                      onClick={() => {
                        setTab(products.length ? "products" : "services");
                        close();
                      }}
                    >
                      Browse listings
                    </MenuItem>
                    <MenuItem
                      icon={<Flag size={16} />}
                      danger
                      onClick={() => {
                        setReportOpen(true);
                        close();
                      }}
                    >
                      Report business
                    </MenuItem>
                  </>
                )}
              </Dropdown>
            )}
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Card className="sticky top-14 z-30 px-1.5 py-1 sm:top-16 sm:px-2">
            <Tabs items={tabs} value={tab} onChange={(id) => setTab(id as SectionId)} className="border-b-0" />
          </Card>

          <div key={tab} className="anim-fade-up">
            {section()}
          </div>
        </div>

        <aside className="hidden min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100dvh-6.5rem)] lg:overflow-y-auto lg:pb-2 hide-scrollbar" aria-label="Business details">
          <section className="card p-4">
            <h2 className="mb-3 text-sm font-bold">Details</h2>
            <ul className="space-y-2.5 text-[13px]">
              <li className="flex items-center justify-between gap-2">
                <span className="text-ink-soft">Followers</span>
                <strong className="tabular-nums">{formatNumber(business.followers)}</strong>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-ink-soft">Listings</span>
                <strong className="tabular-nums">{formatNumber(business.listingCount)}</strong>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-ink-soft">Reviews</span>
                <strong className="tabular-nums">{formatNumber(business.reviewCount)}</strong>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-ink-soft">Rating</span>
                <strong className="inline-flex items-center gap-1 tabular-nums">
                  <Star size={13} className="fill-warn text-warn" aria-hidden /> {ratingLabel}
                </strong>
              </li>
            </ul>
            <Button size="sm" variant="soft" fullWidth className="mt-3" onClick={toggleFollow} aria-pressed={following}>
              {following ? "Following" : "Follow"}
            </Button>
          </section>

          <section className="card p-4">
            <h2 className="mb-3 text-sm font-bold">Reach them</h2>
            <ul className="space-y-3">
              <ContactRow icon={<Mail size={16} />} label="Email" value={business.email} href={business.email ? `mailto:${business.email}` : undefined} />
              <ContactRow icon={<Phone size={16} />} label="Phone" value={business.phone} href={business.phone ? `tel:${business.phone.replace(/\s+/g, "")}` : undefined} />
              <ContactRow icon={<Globe size={16} />} label="Website" value={business.website} href={business.website} />
              <ContactRow icon={<MapPin size={16} />} label="Location" value={business.location} />
            </ul>
          </section>

          <section className="card p-4" aria-label="Businesses you follow">
            <h2 className="mb-3 text-sm font-bold">Businesses you follow</h2>
            <FollowingBusinesses excludeId={business.id} />
          </section>
        </aside>
      </div>

      <ManageModal open={manageOpen} business={business} onClose={() => setManageOpen(false)} onSaved={() => dataQ.refetch()} />

      <ReportModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        name={business.name}
        onSubmit={submitReport}
      />

      <ReviewModal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        businessId={business.id}
        businessName={business.name}
        mutate={patchReviews}
        onVerified={() => dataQ.refetch()}
      />
    </div>
  );
}

/* ------------------------------ sub-components ----------------------------- */

/**
 * Sidebar discovery panel. The API exposes no "similar businesses" endpoint, so this lists the
 * business pages the signed-in viewer already follows (the only non-owner business collection).
 */
function FollowingBusinesses({ excludeId }: { excludeId: number }) {
  const navigate = useNavigate();
  const q = useAsync(() => networkApi.following(), []);
  const rows = (q.data?.businesses ?? []).filter((b) => b.id !== excludeId);

  if (q.loading && !q.data) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading followed businesses">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
      </div>
    );
  }

  if (q.error && !q.data) {
    return <ErrorState message={errorMessage(q.error)} onRetry={q.refetch} />;
  }

  if (!rows.length) {
    return (
      <p className="text-[13px] text-ink-soft">
        You are not following any other business page yet.{" "}
        <button type="button" onClick={() => navigate("/marketplace")} className="font-semibold text-accent hover:underline">
          Browse the marketplace
        </button>
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {rows.slice(0, 3).map((b) => (
        <BusinessCard key={b.id} business={b} />
      ))}
    </div>
  );
}

function ManageModal({ open, business, onClose, onSaved }: { open: boolean; business: Business; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(business);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [photoBusy, setPhotoBusy] = useState<"logo" | "cover" | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setV(business);
      setErrors({});
      setPhotoBusy(null);
    }
  }, [open, business]);

  const set = (patch: Partial<Business>) => setV((x) => ({ ...x, ...patch }));

  /* no business-image endpoint exists, so media is uploaded through the post composer route */
  const upload = async (kind: "logo" | "cover", file?: File) => {
    if (!file) return;
    setPhotoBusy(kind);
    try {
      const r = await postsApi.uploadMedia([file]);
      const url = r.urls[0]?.url;
      if (!url) throw new Error("The upload returned no file.");
      set(kind === "logo" ? { logoUrl: url } : { coverUrl: url });
      toast.success(kind === "logo" ? "Logo ready" : "Cover ready", "Save changes to publish it.");
    } catch (err) {
      toast.error(kind === "logo" ? "Logo upload failed" : "Cover upload failed", errorMessage(err));
    } finally {
      setPhotoBusy(null);
    }
  };

  const save = async () => {
    const e: Record<string, string> = {};
    if (!v.name.trim()) e.name = "Name is required";
    if (v.website && !/^https?:\/\/.+\..+/i.test(v.website)) e.website = "Use a full URL starting with https://";
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) e.email = "Enter a valid email address";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await businessesApi.update(business.id, {
        name: v.name,
        tagline: v.tagline,
        description: v.description,
        industry: v.industry,
        category: v.category,
        website: v.website,
        email: v.email,
        phone: v.phone,
        location: v.location,
        logoUrl: v.logoUrl,
        coverUrl: v.coverUrl,
      });
      toast.success("Business page updated", "Your changes are live.");
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Manage business page"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Business name" value={v.name} onChange={(e) => set({ name: e.target.value })} error={errors.name} />
          <Input label="Location" value={v.location} onChange={(e) => set({ location: e.target.value })} />
          <Input label="Industry" value={v.industry} onChange={(e) => set({ industry: e.target.value })} />
          <Input label="Category" value={v.category} onChange={(e) => set({ category: e.target.value })} />
          <Input label="Website" value={v.website} onChange={(e) => set({ website: e.target.value })} error={errors.website} placeholder="https://example.com" />
          <Input label="Email" value={v.email} onChange={(e) => set({ email: e.target.value })} error={errors.email} />
          <Input label="Phone" value={v.phone} onChange={(e) => set({ phone: e.target.value })} />
        </div>
        <Textarea label="Short tagline" rows={2} maxLength={120} value={v.tagline} onChange={(e) => set({ tagline: e.target.value })} />
        <Textarea label="About" rows={5} value={v.description} onChange={(e) => set({ description: e.target.value })} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-[13px] font-semibold">Cover image</p>
            <div className="h-24 overflow-hidden rounded-xl border border-line bg-surface-2">
              {v.coverUrl ? (
                <img src={mediaUrl(v.coverUrl)} alt={`${v.name} cover preview`} className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-xs text-ink-faint">No cover yet</span>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              loading={photoBusy === "cover"}
              onClick={() => coverInput.current?.click()}
            >
              {v.coverUrl ? "Replace cover" : "Upload cover"}
            </Button>
            <input
              ref={coverInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label="Choose a cover image"
              onChange={(e) => {
                void upload("cover", e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-semibold">Logo</p>
            <div className="flex h-24 items-center gap-3 rounded-xl border border-line bg-surface-2 p-3">
              {v.logoUrl ? (
                <img src={mediaUrl(v.logoUrl)} alt={`${v.name} logo preview`} className="h-14 w-14 rounded-xl bg-surface object-cover" />
              ) : (
                <span className="text-xs text-ink-faint">No logo yet</span>
              )}
            </div>
            <Button size="sm" variant="outline" className="mt-2" loading={photoBusy === "logo"} onClick={() => logoInput.current?.click()}>
              {v.logoUrl ? "Replace logo" : "Upload logo"}
            </Button>
            <input
              ref={logoInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="sr-only"
              aria-label="Choose a logo image"
              onChange={(e) => {
                void upload("logo", e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <p className="text-xs text-ink-faint">Images up to 5 MB. Nothing goes live until you save.</p>
      </div>
    </Modal>
  );
}

function ReportModal({
  open,
  onClose,
  name,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setReason("");
      setError(undefined);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(reason.trim());
    } catch (e) {
      setError(errorMessage(e));
      toast.error("Report not sent", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Report ${name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 10} onClick={() => void submit()}>
            Submit report
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-soft">Tell our trust team what is wrong. Reports are confidential.</p>
      <Textarea
        label="Reason"
        rows={4}
        maxLength={600}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value.slice(0, 600));
          setError(undefined);
        }}
        placeholder="Misleading listings, fraud, impersonation…"
        error={error ?? (reason.length > 0 && reason.trim().length < 10 ? "Please write at least 10 characters" : undefined)}
      />
      <p className="mt-1 text-right text-xs tabular-nums text-ink-faint">{reason.length}/600</p>
      <button
        type="button"
        onClick={() => toast.info("Emergency?", "For immediate danger, contact your local authorities first.")}
        className="mt-2 text-xs font-semibold text-accent hover:underline"
      >
        When to contact authorities instead
      </button>
    </Modal>
  );
}

/** Write-a-review dialog. Inserts the review optimistically and reconciles with the server row. */
function ReviewModal({
  open,
  onClose,
  businessId,
  businessName,
  mutate,
  onVerified,
}: {
  open: boolean;
  onClose: () => void;
  businessId: number;
  businessName: string;
  mutate: (fn: (reviews: Review[]) => Review[]) => void;
  onVerified: () => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setRating(0);
      setText("");
      setError(undefined);
    }
  }, [open]);

  const submit = async () => {
    if (!user) return;
    if (rating < 1) {
      setError("Pick a star rating first.");
      return;
    }
    if (text.trim().length < 15) {
      setError("Write at least 15 characters so it is useful to others.");
      return;
    }
    setError(undefined);
    /* optimistic insert, reconciled with the server row */
    const temp: Review = {
      id: -Date.now(),
      author: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        title: user.profile.title,
        company: user.profile.company,
        location: user.profile.location,
        avatarUrl: user.profile.avatarUrl,
        verified: user.verified,
        verifiedColor: user.verifiedColor,
        category: user.profile.category,
        skills: user.profile.skills,
        mutualConnections: 0,
        connectionStatus: "connected",
        following: false,
      },
      rating,
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };
    mutate((reviews) => [temp, ...reviews]);
    setBusy(true);
    try {
      const created = await businessesApi.addReview(businessId, rating, text.trim());
      mutate((reviews) => reviews.map((r) => (r.id === temp.id ? created : r)));
      toast.success("Review published", `Thanks for reviewing ${businessName}.`);
      onVerified();
      onClose();
    } catch (e) {
      mutate((reviews) => reviews.filter((r) => r.id !== temp.id));
      setError(errorMessage(e));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Review ${businessName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy}>
            Publish review
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-semibold">Your rating</p>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setRating(n);
                  setError(undefined);
                }}
                aria-label={`${n} star${n > 1 ? "s" : ""}`}
                aria-pressed={rating === n}
                className="rounded-lg p-1.5 transition-transform hover:scale-110"
              >
                <Star size={26} className={cn(n <= rating ? "fill-warn text-warn" : "text-line-strong")} aria-hidden />
              </button>
            ))}
            {rating > 0 && <span className="ml-2 text-sm font-semibold text-ink-soft">{["", "Poor", "Fair", "Good", "Great", "Excellent"][rating]}</span>}
          </div>
        </div>
        <div>
          <Textarea
            label="Your experience"
            rows={5}
            maxLength={REVIEW_MAX}
            value={text}
            onChange={(e) => {
              setText(e.target.value.slice(0, REVIEW_MAX));
              setError(undefined);
            }}
            error={error}
            placeholder="What did you buy, how did it go, would you return?"
          />
          <p className="mt-1 text-right text-xs tabular-nums text-ink-faint">
            {text.length}/{REVIEW_MAX}
          </p>
        </div>
        <p className="text-xs text-ink-faint">Reviews are public and attributed to your Professionalist profile.</p>
      </div>
    </Modal>
  );
}
