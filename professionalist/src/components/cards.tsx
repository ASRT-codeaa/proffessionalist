import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Briefcase,
  CalendarClock,
  CheckCircle2,
  Circle,
  Heart,
  MapPin,
  MessageSquare,
  Share2,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { Avatar, Badge, Button, Card, OnlineDot, VerifiedBadge } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { errorMessage } from "@/hooks/useAsync";
import { marketplaceApi, messagingApi, networkApi, opportunitiesApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import type { Business, Listing, Opportunity, Person, Task } from "@/services/types";
import { cn, dueLabel, formatNumber, formatPrice } from "@/lib/utils";

/* --------------------------------- shared ---------------------------------- */

function ShareButton({ label }: { label: string }) {
  const toast = useToast();
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(`${location.origin}/marketplace`);
        toast.success(`${label} link copied`);
      }}
      aria-label={`Share ${label}`}
      className="rounded-full bg-surface/90 p-2 text-ink-soft shadow-sm backdrop-blur transition-colors hover:text-accent"
    >
      <Share2 size={15} />
    </button>
  );
}

export function StarRating({ value, count }: { value: number; count?: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-soft">
      <Star size={13} className="fill-warn text-warn" aria-hidden />
      {value.toFixed(1)}
      {count !== undefined && <span className="font-normal text-ink-faint">({formatNumber(count)})</span>}
    </span>
  );
}

export function useFollowToggle(target: { userId?: number; businessId?: number; following: boolean }, onChange?: () => void) {
  const [following, setFollowing] = useState(target.following);
  const toast = useToast();
  const toggle = async () => {
    const next = !following;
    setFollowing(next);
    try {
      if (next) await networkApi.follow(target);
      else await networkApi.unfollow(target);
      onChange?.();
    } catch (e) {
      setFollowing(!next);
      toast.error(errorMessage(e));
    }
  };
  return [following, toggle] as const;
}

/* -------------------------------- Listing ---------------------------------- */

export function ListingCard({ listing, className }: { listing: Listing; className?: string }) {
  const toast = useToast();
  const [favorited, setFavorited] = useState(listing.favorited);
  const [count, setCount] = useState(listing.favoriteCount);

  const fav = async () => {
    const next = !favorited;
    setFavorited(next);
    setCount((c) => c + (next ? 1 : -1));
    try {
      const r = await marketplaceApi.favorite(listing.id);
      setFavorited(r.favorited);
      setCount(r.favoriteCount);
    } catch (e) {
      setFavorited(!next);
      setCount((c) => c + (next ? -1 : 1));
      toast.error(errorMessage(e));
    }
  };

  return (
    <Card hover={false} className={cn("group overflow-hidden anim-fade-up", className)}>
      <Link to={`/marketplace/${listing.id}`} className="relative block aspect-[4/3] overflow-hidden bg-surface-2">
        {listing.images[0] ? (
          <img
            src={mediaUrl(listing.images[0])}
            alt={listing.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-ink-faint">No image</span>
        )}
        <span className="absolute left-2.5 top-2.5">
          <Badge tone={listing.kind === "service" ? "accent" : "neutral"}>{listing.kind}</Badge>
        </span>
        {listing.availability === "sold_out" && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-sm font-bold uppercase tracking-wide text-white">
            Sold out
          </span>
        )}
      </Link>
      <div className="p-3">
        <p className="text-base font-extrabold">{formatPrice(listing.price, listing.priceType, listing.currency)}</p>
        <Link to={`/marketplace/${listing.id}`} className="mt-0.5 block truncate text-sm font-semibold hover:text-accent">
          {listing.title}
        </Link>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
            <Avatar name={listing.seller.name} src={listing.seller.avatarUrl} size="xs" />
            <span className="truncate">{listing.seller.name}</span>
            {listing.seller.verified && <VerifiedBadge size={12} />}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-ink-faint">
            <MapPin size={11} /> {listing.location}
          </span>
        </div>
        <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2.5">
          <span className="flex items-center gap-2 text-xs text-ink-soft">
            <StarRating value={listing.seller.rating} count={listing.seller.reviews} />
            {listing.condition !== "n/a" && <Badge>{listing.condition.replace("_", " ")}</Badge>}
          </span>
          <span className="flex items-center gap-1">
            <button
              onClick={() => void fav()}
              aria-pressed={favorited}
              aria-label={favorited ? "Remove from saved" : "Save listing"}
              className={cn("rounded-full p-1.5 transition-colors hover:bg-surface-2", favorited ? "text-danger" : "text-ink-faint")}
            >
              <Heart size={16} className={cn(favorited && "fill-current")} />
            </button>
            {count > 0 && <span className="text-[11px] tabular-nums text-ink-faint">{formatNumber(count)}</span>}
            <ShareButton label="Listing" />
          </span>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------- Person ---------------------------------- */

export function PersonCard({ person, onChanged }: { person: Person; onChanged?: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [status, setStatus] = useState(person.connectionStatus);
  const [following, toggleFollow] = useFollowToggle({ userId: person.id, following: person.following });
  const name = `${person.firstName} ${person.lastName}`;
  const me = user?.id === person.id;

  const connect = async () => {
    if (status === "pending_out") return;
    const next = status === "connected" ? "none" : "pending_out";
    const prev = status;
    setStatus(next);
    try {
      if (prev === "connected") await networkApi.removeConnection(person.id);
      else await networkApi.connect(person.id);
      onChanged?.();
    } catch (e) {
      setStatus(prev);
      toast.error(errorMessage(e));
    }
  };

  const message = async () => {
    try {
      const c = await messagingApi.start(person.id);
      navigate(`/messages/${c.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Card className="flex flex-col items-center p-4 text-center anim-fade-up">
      <Link to={`/profile/${person.username}`} className="relative">
        <Avatar name={name} src={person.avatarUrl} size="xl" />
        {person.openTo?.length && <OnlineDot className="absolute bottom-1 right-1" />}
      </Link>
      <Link to={`/profile/${person.username}`} className="mt-3 flex items-center gap-1.5 text-sm font-bold hover:underline">
        {name}
        {person.verified && <VerifiedBadge color={person.verifiedColor} />}
      </Link>
      <p className="mt-0.5 line-clamp-2 text-xs text-ink-soft">{person.title}</p>
      <p className="text-xs text-ink-faint">{person.company}</p>
      <p className="mt-1.5 flex items-center gap-1 text-xs text-ink-faint">
        <MapPin size={11} /> {person.location || "Remote"}
      </p>
      {person.mutualConnections > 0 && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-faint">
          <Users size={11} /> {person.mutualConnections} mutual
        </p>
      )}
      {person.skills.length > 0 && (
        <div className="mt-2.5 flex flex-wrap justify-center gap-1.5">
          {person.skills.slice(0, 3).map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
        </div>
      )}
      {!me && (
        <div className="mt-3.5 grid w-full grid-cols-2 gap-2">
          <Button size="sm" variant={status === "connected" ? "outline" : status === "pending_out" ? "soft" : "primary"} onClick={() => void connect()}>
            {status === "connected" ? "Connected" : status === "pending_out" ? "Pending" : "Connect"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void message()}>
            <MessageSquare size={14} /> Message
          </Button>
          <button
            onClick={toggleFollow}
            className="col-span-2 text-xs font-semibold text-accent hover:underline"
          >
            {following ? "Unfollow" : "Follow"}
          </button>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------- Business --------------------------------- */

export function BusinessCard({ business, onChanged }: { business: Business; onChanged?: () => void }) {
  const [following, toggleFollow] = useFollowToggle({ businessId: business.id, following: business.following }, onChanged);
  return (
    <Card className="overflow-hidden anim-fade-up">
      <div
        className="h-20 bg-cover bg-center"
        style={{ backgroundImage: business.coverUrl ? `url("${mediaUrl(business.coverUrl)}")` : "linear-gradient(120deg,#0B5CD8,#22C0FF)" }}
        aria-hidden
      />
      <div className="px-4 pb-4">
        <Link to={`/business/${business.slug}`} className="-mt-8 inline-block rounded-2xl bg-surface p-1 shadow-sm">
          <Avatar name={business.name} src={mediaUrl(business.logoUrl)} size="lg" />
        </Link>
        <div className="mt-2 flex items-center gap-1.5">
          <Link to={`/business/${business.slug}`} className="truncate text-sm font-bold hover:underline">
            {business.name}
          </Link>
          {business.verified && <VerifiedBadge />}
        </div>
        <p className="line-clamp-2 text-xs text-ink-soft">{business.tagline}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
          <span className="flex items-center gap-1"><Briefcase size={11} /> {business.industry}</span>
          <span className="flex items-center gap-1"><MapPin size={11} /> {business.location}</span>
          <StarRating value={business.rating} count={business.reviewCount} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant={following ? "outline" : "primary"} fullWidth onClick={toggleFollow}>
            {following ? "Following" : "Follow"} · {formatNumber(business.followers)}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------- Opportunity ------------------------------- */

export function OpportunityCard({ opportunity, onChanged }: { opportunity: Opportunity; onChanged?: () => void }) {
  const toast = useToast();
  const [applied, setApplied] = useState(opportunity.applied);
  const apply = async () => {
    if (applied) return;
    setApplied(true);
    try {
      await opportunitiesApi.apply(opportunity.id);
      onChanged?.();
      toast.success("Application sent");
    } catch (e) {
      setApplied(false);
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card hover className="flex gap-3.5 p-4 anim-fade-up">
      <Avatar name={opportunity.organization} src={opportunity.organizationLogo} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold">{opportunity.title}</h3>
          <Badge tone="accent">{opportunity.kind}</Badge>
          {opportunity.remote && <Badge tone="success">Remote</Badge>}
        </div>
        <p className="text-xs text-ink-soft">{opportunity.organization}</p>
        <p className="mt-1.5 line-clamp-2 text-sm text-ink-soft">{opportunity.description}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
          <span className="flex items-center gap-1"><MapPin size={11} /> {opportunity.location}</span>
          {opportunity.compensation && <span className="font-semibold text-success">{opportunity.compensation}</span>}
          {opportunity.deadline && (
            <span className="flex items-center gap-1">
              <CalendarClock size={11} /> Apply by {new Date(opportunity.deadline).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0 self-center">
        <Button size="sm" variant={applied ? "outline" : "primary"} onClick={() => void apply()}>
          {applied ? "Applied" : "Apply"}
        </Button>
      </div>
    </Card>
  );
}

/* ---------------------------------- Task ----------------------------------- */

const PRIORITY_TONE = { low: "neutral", medium: "warn", high: "danger" } as const;

export function TaskCard({
  task,
  onToggle,
  onEdit,
  onDelete,
}: {
  task: Task;
  onToggle: (task: Task) => void;
  onEdit?: (task: Task) => void;
  onDelete?: (task: Task) => void;
}) {
  const done = task.status === "done";
  const overdue = !done && task.dueDate ? new Date(task.dueDate).getTime() < Date.now() : false;
  return (
    <Card className={cn("flex items-start gap-3 p-3.5 anim-fade-up", done && "opacity-65")}>
      <button
        onClick={() => onToggle(task)}
        aria-pressed={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        className={cn("mt-0.5 rounded-full p-0.5 transition-colors", done ? "text-success" : "text-ink-faint hover:text-accent")}
      >
        {done ? <CheckCircle2 size={22} /> : <Circle size={22} />}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-semibold", done && "line-through")}>{task.title}</p>
        {task.description && <p className="mt-0.5 line-clamp-2 text-xs text-ink-soft">{task.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
          <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
          {task.category && <Badge>{task.category}</Badge>}
          {task.dueDate && (
            <span className={cn("flex items-center gap-1 font-semibold", overdue && !done && "text-danger")}>
              <CalendarClock size={11} />
              {overdue && !done ? "Overdue · " : ""}
              {dueLabel(task.dueDate)}
            </span>
          )}
          {task.assignee && (
            <span className="flex items-center gap-1">
              <Avatar name={`${task.assignee.firstName} ${task.assignee.lastName}`} src={task.assignee.avatarUrl} size="xs" />
              {task.assignee.firstName}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {onEdit && (
          <Button size="sm" variant="ghost" onClick={() => onEdit(task)}>
            Edit
          </Button>
        )}
        {onDelete && (
          <button onClick={() => onDelete(task)} aria-label={`Delete ${task.title}`} className="rounded-lg p-2 text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger">
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </Card>
  );
}
