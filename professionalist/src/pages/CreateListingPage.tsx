import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  ImagePlus,
  LayoutGrid,
  MapPin,
  Package,
  Pencil,
  Plus,
  Store,
  Tag,
  Trash2,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import { ListingCard } from "@/components/cards";
import { CategoryIcon } from "@/pages/MarketplacePage";
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  ProgressBar,
  SegmentedControl,
  Select,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { marketplaceApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import type { Category, Listing } from "@/services/types";
import { cn, formatPrice, fullName } from "@/lib/utils";

const MAX_IMAGES = 8;
const MAX_TAGS = 8;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 2000;

type Kind = "product" | "service";
type DetailRow = { id: string; label: string; value: string };

interface Draft {
  categoryId: number | null;
  kind: Kind;
  images: string[];
  title: string;
  description: string;
  tags: string[];
  price: string;
  priceType: Listing["priceType"];
  currency: string;
  location: string;
  availability: Listing["availability"];
  condition: Listing["condition"];
  details: DetailRow[];
}

const EMPTY_DRAFT: Draft = {
  categoryId: null,
  kind: "product",
  images: [],
  title: "",
  description: "",
  price: "",
  priceType: "fixed",
  currency: "USD",
  tags: [],
  location: "",
  availability: "available",
  condition: "new",
  details: [{ id: "seed", label: "", value: "" }],
};

const STEPS: { id: string; label: string; hint: string; icon: typeof LayoutGrid }[] = [
  { id: "category", label: "Category", hint: "What kind of listing is this?", icon: LayoutGrid },
  { id: "photos", label: "Photos", hint: `Up to ${MAX_IMAGES} images — the first one is your cover`, icon: ImagePlus },
  { id: "information", label: "Information", hint: "Title, description and search tags", icon: Tag },
  { id: "price", label: "Price", hint: "How much, and in which currency", icon: Wallet },
  { id: "location", label: "Location", hint: "Where it is and whether it’s in stock", icon: MapPin },
  { id: "condition", label: "Condition & details", hint: "The specs buyers always ask about", icon: Package },
  { id: "preview", label: "Preview", hint: "See the card before anyone else does", icon: Eye },
  { id: "publish", label: "Publish", hint: "Put it in front of professionals", icon: Check },
];

const PRICE_TYPES: { value: Listing["priceType"]; label: string }[] = [
  { value: "fixed", label: "Fixed" },
  { value: "hourly", label: "Hourly" },
  { value: "starting_at", label: "From" },
  { value: "negotiable", label: "Negotiable" },
  { value: "free", label: "Free" },
];

const CURRENCIES = [
  { value: "USD", label: "USD — US Dollar" },
  { value: "NGN", label: "NGN — Naira" },
  { value: "GHS", label: "GHS — Cedi" },
  { value: "KES", label: "KES — Shilling" },
  { value: "ZAR", label: "ZAR — Rand" },
  { value: "EUR", label: "EUR — Euro" },
  { value: "GBP", label: "GBP — Pound" },
];

const CONDITIONS: { value: string; label: string }[] = [
  { value: "new", label: "New" },
  { value: "like_new", label: "Like new" },
  { value: "used", label: "Used" },
  { value: "n/a", label: "Not applicable" },
];

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* --------------------------------- validation ------------------------------- */

function validateStep(step: number, d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  if (step === 0) {
    if (!d.categoryId) e.categoryId = "Pick the category your listing belongs to.";
  } else if (step === 1) {
    if (d.images.length === 0) e.images = "Add at least one photo — listings with images get far more views.";
  } else if (step === 2) {
    if (d.title.trim().length < 6) e.title = "Give it a clear title (at least 6 characters).";
    else if (d.title.trim().length > TITLE_MAX) e.title = `Keep the title under ${TITLE_MAX} characters.`;
    if (d.description.trim().length < 20) e.description = "Describe what the buyer gets (at least 20 characters).";
    else if (d.description.trim().length > DESCRIPTION_MAX) e.description = `The description is over the ${DESCRIPTION_MAX} character limit.`;
  } else if (step === 3) {
    if (d.priceType !== "free") {
      const n = Number(d.price);
      if (d.price.trim() === "") e.price = "Enter a price, or choose “Free”.";
      else if (!Number.isFinite(n) || n <= 0) e.price = "Price must be a number greater than 0.";
      else if (n > 100_000_000) e.price = "That price looks too large.";
    }
  } else if (step === 4) {
    if (d.location.trim().length < 2) e.location = "Add a city or area so nearby buyers can find you.";
  } else if (step === 5) {
    if (d.kind === "product" && d.condition === "n/a") e.condition = "Products need a condition — new, like new or used.";
    for (const row of d.details) {
      const label = row.label.trim();
      const value = row.value.trim();
      if (label && !value) {
        e.details = "Every detail row needs a value — or remove the row.";
        break;
      }
      if (!label && value) {
        e.details = "Every detail row needs a label — or remove the row.";
        break;
      }
    }
  }
  return e;
}

/* ----------------------------------- page ----------------------------------- */

export default function CreateListingPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const editId = Number(searchParams.get("edit")) || null;

  const categoriesAsync = useAsync(() => marketplaceApi.categories(), []);
  const existing = useAsync(
    () => (editId ? marketplaceApi.listing(editId) : Promise.resolve<Listing | null>(null)),
    [editId]
  );

  const [draft, setDraft] = useState<Draft>(() => ({ ...EMPTY_DRAFT, location: user?.profile.location ?? "" }));
  const [prefilled, setPrefilled] = useState(!editId);
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discarding, setDiscarding] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [tagText, setTagText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /* prefill the wizard when editing an existing listing */
  useEffect(() => {
    const l = existing.data;
    if (!l || prefilled) return;
    setDraft({
      categoryId: l.category?.id ?? null,
      kind: l.kind === "service" ? "service" : "product",
      images: [...l.images],
      title: l.title,
      description: l.description,
      tags: [...l.tags],
      price: String(l.price),
      priceType: l.priceType,
      currency: l.currency,
      location: l.location,
      availability: l.availability,
      condition: l.condition,
      details: l.details.length ? l.details.map((x) => ({ id: uid(), label: x.label, value: x.value })) : [{ id: uid(), label: "", value: "" }],
    });
    setPrefilled(true);
  }, [existing.data, existing.loading, prefilled]);

  /* draft lives in memory only; this is the "kept in this tab" indicator */
  const serialized = JSON.stringify(draft);
  useEffect(() => {
    const t = window.setTimeout(() => setSavedAt(new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })), 600);
    return () => window.clearTimeout(t);
  }, [serialized]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  };

  const goto = (next: number) => {
    setErrors({});
    setStep(next);
    setMaxStep((m) => Math.max(m, next));
    window.requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const goNext = () => {
    const found = validateStep(step, draft);
    if (Object.keys(found).length) {
      setErrors(found);
      toast.error("A couple of fields need attention", STEPS[step].label);
      return;
    }
    goto(Math.min(STEPS.length - 1, step + 1));
  };

  /* --------------------------------- images --------------------------------- */
  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    const room = MAX_IMAGES - draft.images.length;
    if (room <= 0) {
      toast.error(`You can attach up to ${MAX_IMAGES} photos`, "Remove one to swap it out.");
      return;
    }
    const chosen = list.slice(0, room);
    setUploading(true);
    try {
      const res = await marketplaceApi.uploadImages(chosen);
      const urls = (res.urls as unknown as (string | { url?: string })[])
        .map((entry) => (typeof entry === "string" ? entry : (entry?.url ?? "")))
        .filter(Boolean);
      if (!urls.length) throw new Error("The server accepted the upload but returned no files.");
      set("images", [...draft.images, ...urls]);
      toast.success(urls.length === 1 ? "Photo added" : `${urls.length} photos added`);
      if (list.length > room) toast.info("Some files were skipped", `Only ${room} more ${room === 1 ? "photo fits" : "photos fit"}.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const moveImage = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= draft.images.length) return;
    const next = [...draft.images];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    set("images", next);
  };

  /* ---------------------------------- tags ---------------------------------- */
  const addTag = (raw: string) => {
    const value = raw.trim().replace(/^#+/, "").toLowerCase();
    setTagText("");
    if (!value) return;
    if (draft.tags.includes(value)) return;
    if (draft.tags.length >= MAX_TAGS) {
      toast.error(`Up to ${MAX_TAGS} tags`, "Remove one to add another.");
      return;
    }
    if (value.length > 24) {
      toast.error("Keep tags under 24 characters");
      return;
    }
    set("tags", [...draft.tags, value]);
  };

  const cleanDetails = useMemo(
    () => draft.details.map((d) => ({ label: d.label.trim(), value: d.value.trim() })).filter((d) => d.label && d.value),
    [draft.details]
  );

  /* --------------------------------- publish -------------------------------- */
  const publish = async () => {
    for (let i = 0; i <= 5; i++) {
      const found = validateStep(i, draft);
      if (Object.keys(found).length) {
        setStep(i);
        setErrors(found);
        toast.error(`${STEPS[i].label} needs attention before publishing`);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
    }
    if (!draft.categoryId) return;
    setPublishing(true);
    const payload = {
      title: draft.title.trim(),
      description: draft.description.trim(),
      kind: draft.kind,
      categoryId: draft.categoryId,
      images: draft.images,
      tags: draft.tags,
      price: draft.priceType === "free" ? 0 : Number(draft.price) || 0,
      priceType: draft.priceType,
      currency: draft.currency,
      condition: draft.condition,
      availability: draft.availability,
      location: draft.location.trim(),
      details: cleanDetails,
    };
    try {
      const saved = editId ? await marketplaceApi.updateListing(editId, payload) : await marketplaceApi.createListing(payload);
      toast.success(editId ? "Listing updated" : "Your listing is live", `“${saved.title}” is now in the marketplace.`);
      navigate(`/marketplace/${saved.id}`, { replace: true });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPublishing(false);
    }
  };

  const category = categoriesAsync.data?.find((c) => c.id === draft.categoryId) ?? null;
  const pricePreview = formatPrice(draft.priceType === "free" ? 0 : Number(draft.price) || 0, draft.priceType, draft.currency);
  const isLast = step === STEPS.length - 1;

  if (editId && !prefilled && existing.loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-3 pt-2 sm:px-0">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-36 anim-fade-up sm:px-0">
      {/* --------------------------------- header -------------------------------- */}
      <header className="flex flex-wrap items-start justify-between gap-3 pt-1">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-extrabold sm:text-2xl">
            <Store size={21} className="text-accent" aria-hidden />
            {editId ? "Edit listing" : "Create a listing"}
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            {editId
              ? "Update anything — changes go live as soon as you save."
              : "Eight short steps. Nothing is published until you hit Publish."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-[11px] font-semibold text-ink-faint sm:inline" aria-live="polite">
            {savedAt ? `Draft kept in this tab · ${savedAt}` : "Draft held in memory"}
          </span>
          <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-soft" onClick={() => setDiscarding(true)}>
            Discard
          </Button>
        </div>
      </header>

      {/* -------------------------------- progress ------------------------------- */}
      <div className="mt-4 space-y-2.5">
        <div className="flex items-center justify-between gap-3 text-xs font-semibold text-ink-soft">
          <span>
            Step {step + 1} of {STEPS.length} · {STEPS[step].label}
          </span>
          <span className="tabular-nums">{Math.round(((step + 1) / STEPS.length) * 100)}%</span>
        </div>
        <ProgressBar value={((step + 1) / STEPS.length) * 100} />
        <nav aria-label="Wizard steps" className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 hide-scrollbar sm:mx-0 sm:px-0">
          {STEPS.map((s, i) => {
            const done = i < step;
            const reachable = i <= maxStep;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => reachable && goto(i)}
                disabled={!reachable}
                aria-current={i === step ? "step" : undefined}
                title={reachable ? s.hint : "Complete the earlier steps first"}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors",
                  i === step
                    ? "border-accent bg-accent-soft text-accent"
                    : reachable
                      ? "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink"
                      : "cursor-not-allowed border-line bg-surface text-ink-faint opacity-60"
                )}
              >
                <span
                  className={cn(
                    "grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-bold",
                    i === step ? "bg-accent text-accent-ink" : done ? "bg-success text-white" : "bg-surface-2 text-ink-soft"
                  )}
                  aria-hidden
                >
                  {done ? <Check size={11} /> : i + 1}
                </span>
                {s.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* ---------------------------------- step --------------------------------- */}
      <div ref={panelRef} className="mt-4 scroll-mt-20">
        <Card className="p-4 sm:p-5">
          <div key={step} className="anim-fade-up">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent" aria-hidden>
                {(() => {
                  const Icon = STEPS[step].icon;
                  return <Icon size={19} />;
                })()}
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-bold sm:text-lg">{STEPS[step].label}</h2>
                <p className="text-xs text-ink-soft">{STEPS[step].hint}</p>
              </div>
            </div>

            {Object.keys(errors).length > 0 && (
              <p role="alert" className="mb-4 rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-semibold text-danger">
                {Object.values(errors)[0]}
              </p>
            )}

            <StepBody
              step={step}
              draft={draft}
              errors={errors}
              set={set}
              category={category}
              categories={categoriesAsync.data ?? []}
              categoriesLoading={categoriesAsync.loading}
              categoriesError={categoriesAsync.error ? errorMessage(categoriesAsync.error) : null}
              onRetryCategories={categoriesAsync.refetch}
              uploading={uploading}
              onPickFiles={() => fileRef.current?.click()}
              onFiles={(files) => void addFiles(files)}
              onMove={moveImage}
              onRemoveImage={(i) => set("images", draft.images.filter((_, j) => j !== i))}
              tagText={tagText}
              setTagText={setTagText}
              addTag={addTag}
              removeTag={(t) => set("tags", draft.tags.filter((x) => x !== t))}
              details={draft.details}
              setDetails={(rows) => set("details", rows)}
              onGoto={goto}
            />
          </div>
        </Card>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(e.target.files);
        }}
      />

      {/* -------------------------------- action bar ------------------------------ */}
      <div className="fixed inset-x-0 bottom-[3.5rem] z-30 px-3 md:sticky md:bottom-4 md:px-0">
        <div className="mx-auto max-w-3xl">
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-line bg-surface/95 p-3 shadow-pop backdrop-blur safe-bottom md:mt-0 pr-[4.25rem] md:pr-3">
            {step > 0 ? (
              <Button variant="outline" className="shrink-0" onClick={() => goto(Math.max(0, step - 1))}>
                <ArrowLeft size={16} aria-hidden />
                Back
              </Button>
            ) : (
              <Button variant="ghost" className="shrink-0" onClick={() => setDiscarding(true)}>
                Cancel
              </Button>
            )}
            <p className="mx-3 hidden min-w-0 flex-1 truncate text-xs text-ink-faint sm:block">
              {STEPS[step].label} · {pricePreview}
            </p>
            {isLast ? (
              <Button className="ml-auto shrink-0 sm:ml-0" onClick={() => void publish()} loading={publishing}>
                <Check size={16} aria-hidden />
                {editId ? "Save changes" : "Publish listing"}
              </Button>
            ) : (
              <Button className="ml-auto shrink-0 sm:ml-0" onClick={goNext}>
                Next
                <ArrowRight size={16} aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={discarding}
        onClose={() => setDiscarding(false)}
        title={editId ? "Discard your changes?" : "Discard this draft?"}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDiscarding(false)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDiscarding(false);
                navigate(editId ? `/marketplace/${editId}` : "/marketplace");
              }}
            >
              Discard
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          {editId
            ? "Your edits aren’t saved to the listing yet. Leaving now throws them away."
            : "This draft only exists in this browser tab — leaving now discards it, and there’s nothing to recover."}
        </p>
      </Modal>
    </div>
  );
}

/* -------------------------------- step bodies ------------------------------- */

interface StepProps {
  step: number;
  draft: Draft;
  errors: Record<string, string>;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  category: Category | null;
  categories: Category[];
  categoriesLoading: boolean;
  categoriesError: string | null;
  onRetryCategories: () => void;
  uploading: boolean;
  onPickFiles: () => void;
  onFiles: (files: FileList) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemoveImage: (index: number) => void;
  tagText: string;
  setTagText: (value: string) => void;
  addTag: (raw: string) => void;
  removeTag: (tag: string) => void;
  details: DetailRow[];
  setDetails: (rows: DetailRow[]) => void;
  onGoto: (step: number) => void;
}

function StepBody(props: StepProps) {
  const { step } = props;
  if (step === 0) return <CategoryStep {...props} />;
  if (step === 1) return <PhotosStep {...props} />;
  if (step === 2) return <InformationStep {...props} />;
  if (step === 3) return <PriceStep {...props} />;
  if (step === 4) return <LocationStep {...props} />;
  if (step === 5) return <ConditionStep {...props} />;
  if (step === 6) return <PreviewStep {...props} />;
  return <ReviewStep {...props} />;
}

function CategoryStep({ categories, categoriesLoading, categoriesError, onRetryCategories, draft, set, errors }: StepProps) {
  return (
    <div className="space-y-5">
      <div>
        <span className="mb-1.5 block text-[13px] font-semibold">Listing type</span>
        <SegmentedControl
          options={[
            { value: "product", label: "Product" },
            { value: "service", label: "Service" },
          ]}
          value={draft.kind}
          onChange={(v) => set("kind", v as Kind)}
        />
        <p className="mt-1.5 text-xs text-ink-faint">
          {draft.kind === "service"
            ? "Services are priced hourly or “from” a starting price, and skip the condition step."
            : "Products are physical items a buyer can inspect locally."}
        </p>
      </div>

      <div>
        <span className="mb-1.5 block text-[13px] font-semibold">Category</span>
        {categoriesLoading && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[64px] rounded-xl" />
            ))}
          </div>
        )}

        {categoriesError && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-danger-soft px-3.5 py-3 text-sm">
            <span className="font-semibold text-danger">{categoriesError}</span>
            <Button size="sm" variant="outline" onClick={onRetryCategories}>
              Try again
            </Button>
          </div>
        )}

        {!categoriesLoading && categories.length === 0 && !categoriesError && (
          <p className="rounded-xl border border-dashed border-line-strong px-3.5 py-4 text-center text-sm text-ink-soft">
            No categories came back from the server — reload the page to try again.
          </p>
        )}

        {!categoriesLoading && categories.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {categories.map((c) => {
              const active = draft.categoryId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => set("categoryId", c.id)}
                  aria-pressed={active}
                  className={cn(
                    "flex min-h-[64px] items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all",
                    active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2"
                  )}
                >
                  <CategoryIcon category={c} size={18} className="shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold">{c.name}</span>
                    <span className="block text-[11px] text-ink-faint">{c.count} listed</span>
                  </span>
                  {active && <Check size={15} className="ml-auto shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>
        )}

        {errors.categoryId && (
          <p className="mt-2 text-xs font-semibold text-danger" role="alert">
            {errors.categoryId}
          </p>
        )}
      </div>
    </div>
  );
}

function PhotosStep({ draft, uploading, onPickFiles, onFiles, onMove, onRemoveImage, errors }: StepProps) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
        }}
        className={cn(
          "rounded-2xl border-2 border-dashed p-6 text-center transition-colors",
          dragOver ? "border-accent bg-accent-soft" : "border-line-strong bg-surface-2/40"
        )}
      >
        <span className="mx-auto mb-2 grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent" aria-hidden>
          <Upload size={19} className={cn(uploading && "animate-pulse")} />
        </span>
        <p className="text-sm font-bold">{uploading ? "Uploading your photos…" : "Add up to 8 photos"}</p>
        <p className="mx-auto mt-0.5 max-w-sm text-xs text-ink-soft">
          Drag and drop, or browse. JPG, PNG, WEBP or GIF up to 5MB each. The first photo becomes your cover.
        </p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onPickFiles} loading={uploading}>
          <ImagePlus size={14} aria-hidden />
          Browse photos
        </Button>
      </div>

      {errors.images && (
        <p className="text-xs font-semibold text-danger" role="alert">
          {errors.images}
        </p>
      )}

      {draft.images.length > 0 && (
        <>
          <p className="text-xs font-semibold text-ink-soft">
            {draft.images.length} of {MAX_IMAGES} photos · use the arrows to reorder
          </p>
          <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {draft.images.map((src, i) => (
              <li key={`${src}-${i}`} className="relative overflow-hidden rounded-xl border border-line bg-surface-2">
                <img src={mediaUrl(src)} alt={`Your photo ${i + 1} of ${draft.images.length}`} className="aspect-square w-full object-cover" loading="lazy" />
                {i === 0 && (
                  <span className="absolute left-1.5 top-1.5">
                    <Badge tone="accent">Cover</Badge>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveImage(i)}
                  aria-label={`Remove photo ${i + 1}`}
                  className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white transition-colors hover:bg-danger"
                >
                  <X size={13} />
                </button>
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1.5 pt-7">
                  <button
                    type="button"
                    onClick={() => onMove(i, -1)}
                    disabled={i === 0}
                    aria-label={`Move photo ${i + 1} earlier`}
                    className="grid h-7 w-7 place-items-center rounded-full bg-surface/90 text-ink transition-opacity disabled:opacity-35"
                  >
                    <ArrowLeft size={13} />
                  </button>
                  <span className="text-[11px] font-bold text-white tabular-nums">{i + 1}</span>
                  <button
                    type="button"
                    onClick={() => onMove(i, 1)}
                    disabled={i === draft.images.length - 1}
                    aria-label={`Move photo ${i + 1} later`}
                    className="grid h-7 w-7 place-items-center rounded-full bg-surface/90 text-ink transition-opacity disabled:opacity-35"
                  >
                    <ArrowRight size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function InformationStep({ draft, set, errors, tagText, setTagText, addTag, removeTag }: StepProps) {
  return (
    <div className="space-y-4">
      <Input
        label="Title"
        required
        maxLength={TITLE_MAX}
        placeholder={draft.kind === "service" ? "e.g. Brand identity system for startups" : "e.g. MacBook Pro 14” M3, 18GB RAM"}
        value={draft.title}
        onChange={(e) => set("title", e.target.value)}
        error={errors.title}
        hint={`${draft.title.trim().length}/${TITLE_MAX} characters — be specific, this is what search matches first`}
      />

      <div>
        <Textarea
          label="Description"
          rows={6}
          required
          maxLength={DESCRIPTION_MAX}
          placeholder="What exactly does the buyer get? Condition, inclusions, turnaround, pickup or delivery, payment terms…"
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          error={errors.description}
        />
        <p className={cn("mt-1 text-xs", draft.description.length > DESCRIPTION_MAX - 100 ? "text-warn" : "text-ink-faint")}>
          {draft.description.length}/{DESCRIPTION_MAX} characters
        </p>
      </div>

      <div>
        <label htmlFor="tag-input" className="mb-1.5 block text-[13px] font-semibold">
          Tags <span className="font-normal text-ink-faint">(press Enter to add)</span>
        </label>
        <div className="flex gap-2">
          <Input
            id="tag-input"
            placeholder="laptop, design, lagos…"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagText);
              }
            }}
            onBlur={() => {
              if (tagText.trim()) addTag(tagText);
            }}
          />
          <Button variant="outline" className="shrink-0" onClick={() => addTag(tagText)}>
            <Plus size={16} aria-hidden />
            Add
          </Button>
        </div>
        {draft.tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {draft.tags.map((t) => (
              <span key={t} className="anim-scale-in inline-flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-3 pr-1.5 text-[13px] font-semibold text-ink-soft">
                #{t}
                <button type="button" onClick={() => removeTag(t)} aria-label={`Remove tag ${t}`} className="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-surface hover:text-danger">
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-xs text-ink-faint">
          {draft.tags.length}/{MAX_TAGS} tags. They power search and “similar listings”.
        </p>
      </div>
    </div>
  );
}

function PriceStep({ draft, set, errors }: StepProps) {
  return (
    <div className="space-y-5">
      <div>
        <span className="mb-1.5 block text-[13px] font-semibold">How is it priced?</span>
        <div className="max-w-full overflow-x-auto hide-scrollbar pb-1">
          <SegmentedControl options={PRICE_TYPES} value={draft.priceType} onChange={(v) => set("priceType", v as Listing["priceType"])} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label={draft.priceType === "free" ? "Price (not used for free listings)" : draft.priceType === "hourly" ? "Hourly rate" : "Price"}
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          disabled={draft.priceType === "free"}
          placeholder="0"
          value={draft.price}
          onChange={(e) => set("price", e.target.value)}
          error={errors.price}
          hint={draft.priceType === "starting_at" ? "Buyers see “From …”." : draft.priceType === "negotiable" ? "Buyers see the price marked negotiable." : undefined}
        />
        <Select label="Currency" value={draft.currency} onChange={(e) => set("currency", e.target.value)} options={CURRENCIES} />
      </div>

      <div className="rounded-xl border border-line bg-surface-2/50 px-3.5 py-3">
        <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">Buyers will see</p>
        <p className="mt-1 text-lg font-black">{formatPrice(draft.priceType === "free" ? 0 : Number(draft.price) || 0, draft.priceType, draft.currency)}</p>
      </div>
    </div>
  );
}

function LocationStep({ draft, set, errors }: StepProps) {
  return (
    <div className="space-y-5">
      <Input
        label="Location"
        required
        icon={<MapPin size={15} aria-hidden />}
        placeholder="Lagos, Nigeria"
        value={draft.location}
        onChange={(e) => set("location", e.target.value)}
        error={errors.location}
        hint="City or area is enough — buyers filter by it."
      />
      <div>
        <span className="mb-1.5 block text-[13px] font-semibold">Availability</span>
        <SegmentedControl
          options={[
            { value: "available", label: "Available" },
            { value: "limited", label: "Limited" },
            { value: "sold_out", label: "Sold out" },
          ]}
          value={draft.availability}
          onChange={(v) => set("availability", v as Listing["availability"])}
        />
        <p className="mt-1.5 text-xs text-ink-soft">
          {draft.availability === "available"
            ? "Listed as ready to buy or book."
            : draft.availability === "limited"
              ? "Shows a “Limited stock” badge on your card."
              : "Sold-out cards stay visible but are greyed out with a “Sold out” overlay."}
        </p>
      </div>
    </div>
  );
}

function ConditionStep({ draft, set, setDetails, errors }: StepProps) {
  return (
    <div className="space-y-6">
      <div className="sm:max-w-xs">
        <Select
          label="Condition"
          value={draft.condition}
          onChange={(e) => set("condition", e.target.value as Listing["condition"])}
          options={CONDITIONS}
          error={errors.condition}
        />
        <p className="mt-1.5 text-xs text-ink-faint">
          {draft.kind === "service" ? "Services are usually “Not applicable”." : "Buyers filter products by condition."}
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold">Extra details</span>
          <Button size="sm" variant="outline" onClick={() => setDetails([...draft.details, { id: uid(), label: "", value: "" }])}>
            <Plus size={14} aria-hidden />
            Add row
          </Button>
        </div>
        <p className="mt-1 text-xs text-ink-faint">Shown as a spec table on your listing — brand, dimensions, turnaround, warranty, inclusions.</p>
        {errors.details && (
          <p className="mt-2 text-xs font-semibold text-danger" role="alert">
            {errors.details}
          </p>
        )}
        {draft.details.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {draft.details.map((row, i) => (
              <li key={row.id} className="flex items-start gap-2">
                <div className="grid flex-1 grid-cols-2 gap-2">
                  <Input
                    aria-label={`Detail ${i + 1} label`}
                    placeholder="Label"
                    value={row.label}
                    onChange={(e) => setDetails(draft.details.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
                  />
                  <Input
                    aria-label={`Detail ${i + 1} value`}
                    placeholder="Value"
                    value={row.value}
                    onChange={(e) => setDetails(draft.details.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setDetails(draft.details.filter((_, j) => j !== i))}
                  aria-label={`Remove detail row ${i + 1}`}
                  className="mt-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-danger-soft hover:text-danger"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-line-strong px-3.5 py-4 text-center text-sm text-ink-soft">
            No detail rows yet — add one to show a spec table on your listing.
          </p>
        )}
      </div>
    </div>
  );
}

function PreviewStep({ draft, category, errors, onGoto }: StepProps) {
  const listing = usePreviewListing(draft, category);
  const rows: { label: string; value: string; step: number }[] = [
    { label: "Category", value: category?.name ?? "—", step: 0 },
    { label: "Type", value: draft.kind, step: 0 },
    { label: "Photos", value: `${draft.images.length} attached`, step: 1 },
    { label: "Title", value: draft.title.trim() || "—", step: 2 },
    { label: "Tags", value: draft.tags.length ? draft.tags.map((t) => `#${t}`).join(" ") : "none", step: 2 },
    { label: "Price", value: formatPrice(draft.priceType === "free" ? 0 : Number(draft.price) || 0, draft.priceType, draft.currency), step: 3 },
    { label: "Location", value: draft.location.trim() || "—", step: 4 },
    { label: "Availability", value: draft.availability.replace("_", " "), step: 4 },
    { label: "Condition", value: draft.condition.replace("_", " "), step: 5 },
    { label: "Details", value: `${draft.details.filter((d) => d.label && d.value).length} rows`, step: 5 },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">This is how your card appears in the marketplace grid. Tap a row to jump back and fix it.</p>
      <div className="pointer-events-none max-w-[280px] select-none" aria-label="Listing card preview (not interactive until published)">
        <ListingCard listing={listing} />
      </div>
      {Object.keys(errors).length > 0 && (
        <p className="text-xs font-semibold text-danger" role="alert">
          Something on an earlier step still needs fixing — use the buttons below.
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5">
            <span className="min-w-0">
              <span className="block text-[11px] font-bold uppercase tracking-wide text-ink-faint">{row.label}</span>
              <span className="block truncate text-sm font-semibold capitalize">{row.value}</span>
            </span>
            <button
              type="button"
              onClick={() => onGoto(row.step)}
              aria-label={`Edit ${row.label.toLowerCase()}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-bold text-accent transition-colors hover:bg-accent-soft"
            >
              <Pencil size={12} aria-hidden />
              Edit
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewStep({ draft, category, onGoto }: StepProps) {
  const listing = usePreviewListing(draft, category);
  const groups: { label: string; step: number }[] = [
    { label: "Category & type", step: 0 },
    { label: "Photos", step: 1 },
    { label: "Information", step: 2 },
    { label: "Price", step: 3 },
    { label: "Location & availability", step: 4 },
    { label: "Condition & details", step: 5 },
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-accent-soft px-4 py-3.5">
        <p className="text-sm font-bold text-accent">Ready when you are</p>
        <p className="mt-1 text-sm text-accent/90">
          Publishing makes this visible to professionals browsing the marketplace. You can pause, edit or delete it any time from its page.
        </p>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {groups.map((g) => (
          <li key={g.step} className="flex items-center justify-between gap-3 bg-surface px-3.5 py-3">
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{g.label}</span>
              <span className="block truncate text-xs text-ink-soft">{summariseGroup(draft, g.step, category?.name)}</span>
            </span>
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => onGoto(g.step)}>
              <Pencil size={13} aria-hidden />
              Change
            </Button>
          </li>
        ))}
      </ul>
      <div className="pointer-events-none max-w-[280px] select-none" aria-label="Final listing card preview">
        <ListingCard listing={listing} />
      </div>
    </div>
  );
}

function summariseGroup(draft: Draft, step: number, categoryName?: string): string {
  if (step === 0) return `${draft.kind} · ${categoryName ?? "no category"}`;
  if (step === 1) return `${draft.images.length} photo${draft.images.length === 1 ? "" : "s"}`;
  if (step === 2) return draft.title.trim() || "no title yet";
  if (step === 3) return formatPrice(draft.priceType === "free" ? 0 : Number(draft.price) || 0, draft.priceType, draft.currency);
  if (step === 4) return `${draft.location.trim() || "no location"} · ${draft.availability}`;
  return `${draft.condition} · ${draft.details.filter((d) => d.label && d.value).length} detail rows`;
}

/* --------------------------------- helpers --------------------------------- */

function usePreviewListing(draft: Draft, category: Category | null): Listing {
  const { user } = useAuth();
  return useMemo(
    () => ({
      id: 0,
      kind: draft.kind,
      category,
      title: draft.title.trim() || "Your listing title",
      description: draft.description.trim(),
      price: draft.priceType === "free" ? 0 : Number(draft.price) || 0,
      priceType: draft.priceType,
      currency: draft.currency,
      condition: draft.condition,
      availability: draft.availability,
      location: draft.location.trim() || "Add a location",
      images: draft.images,
      tags: draft.tags,
      views: 0,
      favoriteCount: 0,
      favorited: false,
      status: "active",
      seller: {
        userId: user?.id,
        name: user ? fullName(user) : "You",
        avatarUrl: user?.profile.avatarUrl ?? "",
        verified: user?.verified ?? false,
        rating: 0,
        reviews: 0,
        responseTime: "within a few hours",
        memberSince: "",
      },
      details: draft.details.map((d) => ({ label: d.label.trim(), value: d.value.trim() })).filter((d) => d.label && d.value),
      createdAt: new Date().toISOString(),
    }),
    [draft, category, user]
  );
}
