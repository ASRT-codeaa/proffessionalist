import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock, Search, X } from "lucide-react";
import { searchApi } from "@/services/api";
import { useDebounced } from "@/hooks/useAsync";
import { Avatar, VerifiedBadge } from "@/components/ui";
import { cn, fullName } from "@/lib/utils";
import type { Business, Person } from "@/services/types";

interface Suggestions {
  people: Person[];
  businesses: Business[];
  hashtags: string[];
  recent: string[];
}

export function GlobalSearch({ className, compact }: { className?: string; compact?: boolean }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sug, setSug] = useState<Suggestions | null>(null);
  const debounced = useDebounced(q, 220);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!debounced.trim()) {
      searchApi
        .suggestions("")
        .then((s) => !cancelled && setSug(s))
        .catch(() => !cancelled && setSug(null));
      return () => {
        cancelled = true;
      };
    }
    searchApi
      .suggestions(debounced)
      .then((s) => !cancelled && setSug(s))
      .catch(() => !cancelled && setSug(null));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    setQ("");
    navigate(path);
  };

  const submit = () => {
    if (!q.trim()) return;
    go(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  const showPanel = open;

  return (
    <div ref={boxRef} className={cn("relative", className)}>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-label="Search Professionalist"
          placeholder={compact ? "Search" : "Search people, businesses, products…"}
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="h-10 w-full rounded-xl border border-line bg-surface-2 pl-9 pr-8 text-sm placeholder:text-ink-faint focus:bg-surface focus:border-accent focus:ring-2 focus:ring-[var(--ring)] focus:outline-none transition-colors"
        />
        {q && (
          <button
            onClick={() => setQ("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {showPanel && (
        <div className="absolute top-full mt-1.5 left-0 right-0 z-50 bg-surface border border-line rounded-xl shadow-pop overflow-hidden anim-scale-in origin-top max-h-[70vh] overflow-y-auto">
          {sug && sug.recent.length > 0 && !q && (
            <Section title="Recent searches">
              {sug.recent.map((r) => (
                <button key={r} onClick={() => go(`/search?q=${encodeURIComponent(r)}`)} className="flex w-full items-center gap-2.5 px-4 py-2 text-sm hover:bg-surface-2 text-left">
                  <Clock size={14} className="text-ink-faint" aria-hidden />
                  {r}
                </button>
              ))}
            </Section>
          )}
          {sug && sug.people.length > 0 && (
            <Section title="People">
              {sug.people.map((p) => (
                <button key={p.id} onClick={() => go(`/profile/${p.username}`)} className="flex w-full items-center gap-2.5 px-4 py-2 hover:bg-surface-2 text-left">
                  <Avatar name={fullName(p)} src={p.avatarUrl} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold flex items-center gap-1">
                      {fullName(p)} {p.verified && <VerifiedBadge color={p.verifiedColor} size={13} />}
                    </span>
                    <span className="block truncate text-xs text-ink-soft">{p.title}</span>
                  </span>
                </button>
              ))}
            </Section>
          )}
          {sug && sug.businesses.length > 0 && (
            <Section title="Businesses">
              {sug.businesses.map((b) => (
                <button key={b.id} onClick={() => go(`/business/${b.slug}`)} className="flex w-full items-center gap-2.5 px-4 py-2 hover:bg-surface-2 text-left">
                  <Avatar name={b.name} src={b.logoUrl} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold flex items-center gap-1">
                      {b.name} {b.verified && <VerifiedBadge size={13} />}
                    </span>
                    <span className="block truncate text-xs text-ink-soft">{b.industry}</span>
                  </span>
                </button>
              ))}
            </Section>
          )}
          {sug && sug.hashtags.length > 0 && (
            <Section title="Trending topics">
              {sug.hashtags.map((h) => (
                <button key={h} onClick={() => go(`/search?q=${encodeURIComponent(h)}`)} className="flex w-full items-center gap-2.5 px-4 py-2 text-sm hover:bg-surface-2 text-left font-medium text-accent">
                  # {h.replace(/^#/, "")}
                </button>
              ))}
            </Section>
          )}
          {q && sug && !sug.people.length && !sug.businesses.length && !sug.hashtags.length && (
            <p className="px-4 py-6 text-center text-sm text-ink-soft">
              No instant matches. Press Enter to search everything.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-1.5 border-b border-line last:border-0">
      <p className="px-4 py-1 text-[11px] font-bold uppercase tracking-wider text-ink-faint">{title}</p>
      {children}
    </div>
  );
}
