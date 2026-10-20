import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  BadgeCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Clock,
  Eye,
  Flag,
  Heart,
  ImageOff,
  MapPin,
  MessageSquare,
  Pencil,
  Play,
  Pause,
  Share2,
  ShieldAlert,
  Store,
  Trash2,
} from "lucide-react";
import { ListingCard, StarRating } from "@/components/cards";
import { CategoryIcon } from "@/pages/MarketplacePage";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Select,
  Skeleton,
  SkeletonCard,
  Textarea,
  VerifiedBadge,
} from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { marketplaceApi, messagingApi, searchApi } from "@/services/api";
import { ApiError, mediaUrl } from "@/services/http";
import type { Business, Listing, Seller } from "@/services/types";
import { cn, formatNumber, formatPrice, timeAgo } from "@/lib/utils";

const AVAILABILITY_TONE = { available: "success", limited: "warn", sold_out: "danger" } as const;
const AVAILABILITY_LABEL = { available: "Available", limited: "Limited stock", sold_out: "Sold out" } as const;

const REPORT_REASONS = [
  { value: "spam", label: "Spam or misleading" },
  { value: "scam", label: "Suspected scam or fraud" },
  { value: "prohibited", label: "Prohibited or unsafe item" },
  { value: "wrong_category", label: "Listed in the wrong category" },
  { value: "offensive", label: "Offensive content" },
  { value: "other", label: "Something else" },
];

export default function ListingPage() {
  const { id } = useParams();
  const listingId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();

  const { data: listing, loading, error, refetch, setData } = useAsync(
    () => marketplaceApi.listing(listingId),
    [listingId]
  );
  const related = useAsync(
    () => (Number.isFinite(listingId) ? marketplaceApi.related(listingId) : Promise.resolve([] as Listing[])),
    [listingId]
  );

  /* --------------------------------- not found -------------------------------- */
  const notFound = error instanceof ApiError && (error.code === "not_found" || error.status === 404);

  useEffect(() => {
    const previous = document.title;
    if (listing) document.title = `${listing.title} · Professionalist Marketplace`;
    return () => {
      document.title = previous;
    };
  }, [listing]);

  /* ------------------------------ save / favorite ----------------------------- */
  const [favorited, setFavorited] = useState(false);
  const [favoriteCount, setFavoriteCount] = useState(0);
  useEffect(() => {
    if (!listing) return;
    setFavorited(listing.favorited);
    setFavoriteCount(listing.favoriteCount);
  }, [listing?.favorited, listing?.favoriteCount]);

  const toggleFavorite = async () => {
    if (!listing) return;
    const next = !favorited;
    setFavorited(next);
    setFavoriteCount((c) => c + (next ? 1 : -1));
    try {
      const r = await marketplaceApi.favorite(listing.id);
      setFavorited(r.favorited);
      setFavoriteCount(r.favoriteCount);
      toast.success(r.favorited ? "Saved to your listings" : "Removed from saved");
    } catch (e) {
      setFavorited(!next);
      setFavoriteCount((c) => c + (next ? -1 : 1));
      toast.error(errorMessage(e));
    }
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      toast.success("Link copied", url);
    } catch {
      toast.error("Couldn’t copy the link", "Your browser blocked clipboard access.");
    }
  };

  /* --------------------------------- seller ---------------------------------- */
  const sellerLookup = useAsync(async () => {
    const seller = listing?.seller;
    if (!seller) return null;
    const results = await searchApi.global(seller.name, "all");
    if (seller.userId) {
      const person = results.people.find((p) => p.id === seller.userId);
      return person ? { href: `/profile/${person.username}`, label: "View profile", business: null as Business | null } : null;
    }
    if (seller.businessId) {
      const biz = results.businesses.find((b) => b.id === seller.businessId);
      return biz ? { href: `/business/${biz.slug}`, label: "View business", business: biz } : null;
    }
    return null;
    // Re-resolve only when a different listing (or its seller) is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.id, listing?.seller?.userId, listing?.seller?.businessId]);

  const [contactOpen, setContactOpen] = useState(false);
  const [messaging, setMessaging] = useState(false);

  const messageSeller = async () => {
    if (!listing) return;
    const seller = listing.seller;
    setMessaging(true);
    try {
      if (seller.userId) {
        const conversation = await messagingApi.start(seller.userId, `Hi ${seller.name}, is “${listing.title}” still available?`);
        navigate(`/messages/${conversation.id}`);
        return;
      }
      const teamUser = sellerLookup.data?.business?.team.find((t) => t.userId)?.userId;
      if (teamUser) {
        const conversation = await messagingApi.start(teamUser, `Hi ${seller.name}, is “${listing.title}” still available?`);
        navigate(`/messages/${conversation.id}`);
        return;
      }
      if (seller.businessId) toast.info("No message channel for this business", "Use their published contact details instead.");
      setContactOpen(true);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setMessaging(false);
    }
  };

  /* --------------------------------- owner ----------------------------------- */
  const isOwner = Boolean(user && (listing?.seller.userId === user.id || user.role === "admin"));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const setStatus = async (status: Listing["status"]) => {
    if (!listing) return;
    setStatusBusy(true);
    try {
      const updated = await marketplaceApi.updateListing(listing.id, { status });
      setData(updated);
      toast.success(status === "paused" ? "Listing paused" : "Listing live again");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setStatusBusy(false);
    }
  };

  const removeListing = async () => {
    if (!listing) return;
    setStatusBusy(true);
    try {
      await marketplaceApi.deleteListing(listing.id);
      toast.success("Listing deleted");
      navigate("/marketplace");
    } catch (e) {
      toast.error(errorMessage(e));
      setStatusBusy(false);
    }
  };

  /* -------------------------------- rendering -------------------------------- */
  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-xl px-3 pt-6 sm:px-0">
        <Card className="anim-fade-up">
          <ErrorState message={error?.message ?? "This listing no longer exists. It may have been sold or removed."} />
          <div className="flex flex-wrap justify-center gap-2 pb-6">
            <Button onClick={() => navigate("/marketplace")}>
              <Store size={16} aria-hidden />
              Back to marketplace
            </Button>
            <Button variant="outline" onClick={refetch} loading={loading}>
              Try again
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (loading && !listing) {
    return (
      <div className="space-y-4 px-3 sm:px-0">
        <Skeleton className="h-5 w-40" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <Skeleton className="aspect-[4/3] w-full rounded-2xl" />
            <Card className="space-y-3 p-4">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-24 w-full" />
            </Card>
          </div>
          <Card className="space-y-3 p-4">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-10 w-full rounded-xl" />
          </Card>
        </div>
      </div>
    );
  }

  if (error && !listing) {
    return (
      <Card>
        <ErrorState message={errorMessage(error)} onRetry={refetch} />
      </Card>
    );
  }

  if (!listing) return null;

  const images = listing.images.map((src) => mediaUrl(src));
  const price = formatPrice(listing.price, listing.priceType, listing.currency);
  return (
    <div className="w-full space-y-4 px-3 pb-4 anim-fade-up sm:px-0">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
        <Link to="/marketplace" className="inline-flex items-center gap-1.5 rounded-lg px-1 py-1 font-semibold hover:text-accent">
          <ArrowLeft size={14} aria-hidden />
          Marketplace
        </Link>
        {listing.category && (
          <>
            <span aria-hidden>/</span>
            <Link to={`/marketplace?categoryId=${listing.category.id}`} className="inline-flex min-w-0 items-center gap-1 rounded-lg px-1 py-1 font-semibold hover:text-accent">
              <CategoryIcon category={listing.category} size={12} />
              <span className="truncate">{listing.category.name}</span>
            </Link>
          </>
        )}
      </nav>

      {listing.status !== "active" && (
        <div className={cn("flex flex-wrap items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold", listing.status === "paused" ? "bg-warn-soft text-warn" : "bg-surface-2 text-ink-soft")}>
          <CircleSlash size={16} aria-hidden />
          This listing is {listing.status}. It isn’t visible in search results.
          {listing.status === "paused" && (
            <Button size="sm" variant="outline" className="ml-auto" loading={statusBusy} onClick={() => void setStatus("active")}>
              <Play size={14} aria-hidden />
              Resume
            </Button>
          )}
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ------------------------------ left column ----------------------------- */}
        <div className="min-w-0 space-y-4">
          <Card className="overflow-hidden p-0">
            <Gallery images={images} title={listing.title} />
          </Card>

          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={listing.kind === "service" ? "accent" : "neutral"}>{listing.kind}</Badge>
              <Badge tone={AVAILABILITY_TONE[listing.availability]}>{AVAILABILITY_LABEL[listing.availability]}</Badge>
              {listing.condition !== "n/a" && <Badge>{listing.condition.replace("_", " ")}</Badge>}
            </div>
            <h1 className="mt-2.5 text-xl font-extrabold leading-snug sm:text-2xl">{listing.title}</h1>
            <p className="mt-1 text-2xl font-black tracking-tight sm:text-[26px]">{price}</p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-soft">
              <span className="flex items-center gap-1.5">
                <MapPin size={13} aria-hidden />
                {listing.location}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock size={13} aria-hidden />
                Posted {postedWhen(listing.createdAt)}
              </span>
              <span className="flex items-center gap-1.5">
                <Eye size={13} aria-hidden />
                {formatNumber(listing.views)} views
              </span>
              <span className="flex items-center gap-1.5">
                <Heart size={13} aria-hidden />
                {formatNumber(favoriteCount)} saved
              </span>
            </div>

            <hr className="my-4 border-line" />

            <h2 className="text-sm font-bold">Description</h2>
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
              {listing.description || "The seller hasn’t added a description yet."}
            </p>

            {listing.details.length > 0 && (
              <>
                <h2 className="mt-5 text-sm font-bold">Details</h2>
                <dl className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {listing.details.map((d) => (
                    <div key={`${d.label}-${d.value}`} className="grid grid-cols-2 gap-3 px-3.5 py-2.5 text-sm odd:bg-surface-2/40">
                      <dt className="text-ink-soft">{d.label}</dt>
                      <dd className="min-w-0 break-words font-semibold">{d.value || "—"}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            {listing.tags.length > 0 && (
              <div className="mt-5">
                <h2 className="text-sm font-bold">Tags</h2>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {listing.tags.map((t) => (
                    <Link
                      key={t}
                      to={`/marketplace?q=${encodeURIComponent(t)}`}
                      className="rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] font-semibold text-ink-soft transition-colors hover:border-accent hover:text-accent"
                    >
                      #{t}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <section aria-label="Related listings" className="space-y-3">
            <h2 className="text-base font-bold sm:text-lg">Similar listings</h2>
            {related.loading && (
              <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <SkeletonCard key={i} height="h-28 sm:h-32" />
                ))}
              </div>
            )}
            {related.error && !related.loading && <ErrorState message={errorMessage(related.error)} onRetry={related.refetch} />}
            {!related.loading && related.data && related.data.length === 0 && (
              <Card>
                <EmptyState icon={<Store />} title="Nothing similar yet" description="No other listings in this category right now." action={<Button variant="outline" onClick={() => navigate("/marketplace")}>Browse marketplace</Button>} />
              </Card>
            )}
            {!related.loading && related.data && related.data.length > 0 && (
              <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3">
                {related.data.map((r) => (
                  <ListingCard key={r.id} listing={r} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* ------------------------------ right column ---------------------------- */}
        <div className="space-y-4 lg:sticky lg:top-20">
          <SellerPanel seller={listing.seller} link={sellerLookup.data} />

          <Card className="space-y-2 p-4">
            <Button fullWidth loading={messaging} onClick={() => void messageSeller()}>
              <MessageSquare size={16} aria-hidden />
              {listing.seller.businessId ? "Contact business" : "Message seller"}
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => void toggleFavorite()} aria-pressed={favorited} className={cn(favorited && "border-danger text-danger")}>
                <Heart size={15} className={cn(favorited && "fill-current")} aria-hidden />
                {favorited ? "Saved" : "Save"}
              </Button>
              <Button variant="outline" onClick={() => void share()}>
                <Share2 size={15} aria-hidden />
                Share
              </Button>
            </div>
            <ReportButton
              onSubmit={(reason, notes) =>
                toast.success("Report submitted for review", `${reason}${notes ? ` — ${notes.length > 44 ? `${notes.slice(0, 44)}…` : notes}` : ""}`)
              }
            />
          </Card>

          {isOwner && (
            <Card className="space-y-2.5 p-4" aria-label="Listing owner controls">
              <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                <BadgeCheck size={13} aria-hidden /> Your listing
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="soft" size="sm" onClick={() => navigate(`/create-listing?edit=${listing.id}`)}>
                  <Pencil size={14} aria-hidden />
                  Edit
                </Button>
                <Button variant="outline" size="sm" loading={statusBusy} onClick={() => void setStatus(listing.status === "paused" ? "active" : "paused")}>
                  {listing.status === "paused" ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
                  {listing.status === "paused" ? "Resume" : "Pause"}
                </Button>
              </div>
              <Button variant="ghost" size="sm" fullWidth className="text-danger hover:bg-danger-soft" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} aria-hidden />
                Delete listing
              </Button>
            </Card>
          )}

          <div className="rounded-2xl border border-line bg-surface-2/50 p-3.5 text-xs text-ink-soft">
            <p className="flex items-center gap-1.5 font-bold text-ink">
              <ShieldAlert size={14} className="text-warn" aria-hidden />
              Stay safe
            </p>
            <p className="mt-1.5 leading-relaxed">Meet in a public place, inspect high-value items before paying, and keep conversations inside Professionalist messages.</p>
          </div>
        </div>
      </div>

      {isOwner && (
        <Modal
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title="Delete this listing?"
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
              <Button variant="danger" loading={statusBusy} onClick={() => void removeListing()}>
                <Trash2 size={15} aria-hidden />
                Delete listing
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-soft">
            “{listing.title}” will stop appearing in the marketplace and its {formatNumber(listing.favoriteCount)} saves will be lost. This can’t be undone.
          </p>
        </Modal>
      )}

      <ContactBusinessModal
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        seller={listing.seller}
        business={sellerLookup.data?.business ?? null}
        pageHref={sellerLookup.data?.href}
      />
    </div>
  );
}

/* ---------------------------------- gallery --------------------------------- */

function Gallery({ images, title }: { images: string[]; title: string }) {
  const [index, setIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const many = images.length > 1;

  const goTo = (i: number) => {
    const el = trackRef.current;
    if (!el || images.length === 0) return;
    const clamped = Math.min(images.length - 1, Math.max(0, i));
    el.scrollTo({ left: clamped * el.clientWidth, behavior: "smooth" });
    setIndex(clamped);
  };

  if (images.length === 0) {
    return (
      <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 bg-surface-2 text-ink-faint sm:aspect-[16/10]">
        <ImageOff size={28} aria-hidden />
        <p className="text-sm font-semibold">No photos on this listing</p>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label={`Photos of ${title}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); goTo(index + 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); goTo(index - 1); }
        else if (e.key === "Home") { e.preventDefault(); goTo(0); }
        else if (e.key === "End") { e.preventDefault(); goTo(images.length - 1); }
      }}
      className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <div className="relative">
        <div
          ref={trackRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.clientWidth === 0) return;
            const next = Math.round(el.scrollLeft / el.clientWidth);
            if (next !== index) setIndex(next);
          }}
          className="flex snap-x snap-mandatory overflow-x-auto hide-scrollbar"
        >
          {images.map((src, i) => (
            <img
              key={`${src}-${i}`}
              src={src}
              alt={`${title} — photo ${i + 1} of ${images.length}`}
              loading={i === 0 ? "eager" : "lazy"}
              className="aspect-[4/3] w-full shrink-0 snap-center bg-surface-2 object-cover sm:aspect-[16/10]"
            />
          ))}
        </div>

        {many && (
          <>
            <GalleryArrow dir="prev" disabled={index === 0} onClick={() => goTo(index - 1)} />
            <GalleryArrow dir="next" disabled={index === images.length - 1} onClick={() => goTo(index + 1)} />
            <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-bold text-white tabular-nums backdrop-blur">
              {index + 1} / {images.length}
            </span>
          </>
        )}
      </div>

      {many && (
        <ul className="flex gap-2 overflow-x-auto p-3 hide-scrollbar">
          {images.map((src, i) => (
            <li key={`thumb-${src}-${i}`}>
              <button
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Show photo ${i + 1} of ${images.length}`}
                aria-current={i === index}
                className={cn(
                  "block h-14 w-20 overflow-hidden rounded-lg border-2 transition-all sm:h-16 sm:w-24",
                  i === index ? "border-accent" : "border-transparent opacity-70 hover:opacity-100"
                )}
              >
                <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GalleryArrow({ dir, disabled, onClick }: { dir: "prev" | "next"; disabled: boolean; onClick: () => void }) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "prev" ? "Previous photo" : "Next photo"}
      className={cn(
        "absolute top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-surface/90 text-ink shadow-pop backdrop-blur transition-opacity hover:bg-surface disabled:opacity-0",
        dir === "prev" ? "left-3" : "right-3"
      )}
    >
      <Icon size={18} aria-hidden />
    </button>
  );
}

/* -------------------------------- seller card ------------------------------- */

function SellerPanel({
  seller,
  link,
}: {
  seller: Seller;
  link: { href: string; label: string } | null | undefined;
}) {
  const hasRating = seller.rating > 0;
  return (
    <Card className="p-4">
      <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint">{seller.businessId ? "Sold by" : "Seller"}</p>
      <div className="flex items-center gap-3">
        <Avatar name={seller.name} src={seller.avatarUrl} size="lg" />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <span className="truncate">{seller.name}</span>
            {seller.verified && <VerifiedBadge />}
          </p>
          <div className="mt-0.5">
            {hasRating ? <StarRating value={seller.rating} count={seller.reviews || undefined} /> : <span className="text-xs text-ink-faint">No reviews yet</span>}
          </div>
        </div>
      </div>
      <dl className="mt-3.5 space-y-2 border-t border-line pt-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-ink-soft">Response time</dt>
          <dd className="font-semibold text-success">{seller.responseTime}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="flex items-center gap-1.5 text-ink-soft">
            <CalendarDays size={12} aria-hidden /> Member since
          </dt>
          <dd className="font-semibold">{formatMemberSince(seller.memberSince)}</dd>
        </div>
      </dl>
      {link ? (
        <Link
          to={link.href}
          title={seller.businessId ? "Open their business page" : "Open their profile"}
          className="mt-3.5 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface text-sm font-semibold transition-colors hover:bg-surface-2"
        >
          {seller.businessId ? <Store size={15} aria-hidden /> : <BadgeCheck size={15} aria-hidden />}
          {link.label}
        </Link>
      ) : (
        <p className="mt-3.5 text-center text-xs text-ink-faint">{seller.userId ? "Profile unavailable" : "Business page unavailable"}</p>
      )}
    </Card>
  );
}

/** timeAgo returns "3h" style deltas or an absolute date for older posts — only the former needs "ago". */
function postedWhen(iso: string): string {
  const rel = timeAgo(iso);
  if (!rel) return "recently";
  return /^\d+(s|m|h|d|w)$/.test(rel) ? `${rel} ago` : rel;
}

function formatMemberSince(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/* --------------------------------- report ----------------------------------- */

function ReportButton({ onSubmit }: { onSubmit: (reason: string, notes: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ reason?: string; notes?: string }>({});

  const submit = () => {
    const next: { reason?: string; notes?: string } = {};
    if (!reason) next.reason = "Choose a reason so we know what to look at.";
    if (reason === "other" && notes.trim().length < 10) next.notes = "Add at least 10 characters so our team can act.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const label = REPORT_REASONS.find((r) => r.value === reason)?.label ?? reason;
    onSubmit(label, notes.trim());
    setOpen(false);
    setReason("");
    setNotes("");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger"
      >
        <Flag size={14} aria-hidden />
        Report listing
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Report this listing"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={submit}>
              <Flag size={15} aria-hidden />
              Submit report
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-soft">Reports go to the trust team. Sellers are never shown who reported them.</p>
          <Select
            label="Reason"
            placeholder="Select a reason"
            value={reason}
            onChange={(e) => { setReason(e.target.value); setErrors((p) => ({ ...p, reason: undefined })); }}
            options={REPORT_REASONS}
            error={errors.reason}
          />
          <div>
            <label htmlFor="report-notes" className="mb-1.5 block text-[13px] font-semibold">
              What happened? <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <Textarea
              id="report-notes"
              rows={3}
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setErrors((p) => ({ ...p, notes: undefined })); }}
              placeholder="Tell us anything else that helps…"
              error={errors.notes}
            />
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ----------------------------- contact business ------------------------------ */

function ContactBusinessModal({
  open,
  onClose,
  seller,
  business,
  pageHref,
}: {
  open: boolean;
  onClose: () => void;
  seller: Seller;
  business: Business | null;
  pageHref?: string;
}) {
  const [copied, setCopied] = useState("");
  const toast = useToast();

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Couldn’t copy automatically", value);
    }
  };

  const rows = [
    business?.email ? { label: "Email", value: business.email } : null,
    business?.phone ? { label: "Phone", value: business.phone } : null,
    business?.website ? { label: "Website", value: business.website } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Contact ${seller.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {pageHref && (
            <Link
              to={pageHref}
              onClick={onClose}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-accent-soft px-4 text-sm font-semibold text-accent transition-colors hover:opacity-85"
            >
              <Store size={15} aria-hidden />
              Open business page
            </Link>
          )}
        </>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">
          We couldn’t open a message thread for {seller.name} — their business details aren’t published yet. Try their business page, or check back shortly.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5">
              <span className="min-w-0">
                <span className="block text-[11px] font-bold uppercase tracking-wide text-ink-faint">{r.label}</span>
                <span className="block truncate text-sm font-semibold">{r.value}</span>
              </span>
              <Button size="sm" variant="outline" onClick={() => void copy(r.value, r.label)}>
                {copied === r.label ? "Copied" : "Copy"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
