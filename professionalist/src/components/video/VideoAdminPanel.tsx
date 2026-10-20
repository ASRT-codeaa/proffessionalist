import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Rss,
  ShieldCheck,
  Wand2,
  X,
} from "lucide-react";
import type {
  AdminVideoRow,
  DiscoveryOutcome,
  DiscoveryRunResult,
  VideoRankingKey,
  VideoSource,
} from "@/services/videos";
import {
  adminAddSource,
  adminApprove,
  adminIndex,
  adminPutRankConfig,
  adminRankConfig,
  adminRemove,
  adminReprocess,
  adminRunDiscovery,
  adminSources,
  VIDEO_LIMITS,
  type VideoProvider,
} from "@/services/videos";
import { VideoApiError } from "@/services/videoHttp";
import { videoApp } from "@/services/videoApp";
import { VideoEmptyState } from "./VideoEmptyState";
import { VideoStateBadge } from "./VideoStateBadge";
import { formatDuration } from "./videoFormat";

/**
 * Staff-only operations surface for /api/videos/admin/* — the moderation queue,
 * the six ranking weights, discovery sources, and the manual discovery run
 * (the pipeline's only trigger; there is no cron).
 *
 * Deny-by-default: every call is the real endpoint. A non-staff viewer gets the
 * documented 401/403 and this page says so plainly instead of pretending to work.
 */

const ADMIN_STATES = ["pending", "approved", "removed", "all"] as const;
type AdminState = (typeof ADMIN_STATES)[number];

const RANKING_KEYS: VideoRankingKey[] = [
  "interest_relevance",
  "watch_completion",
  "engagement",
  "followed_creators",
  "quality_freshness",
  "diversity_discovery",
];

const OUTCOME_TONE: Record<DiscoveryOutcome, string> = {
  indexed: "bg-success-soft text-success",
  duplicate: "bg-warn-soft text-warn",
  provider_denied: "bg-danger-soft text-danger",
  scheme_denied: "bg-danger-soft text-danger",
  robots_denied: "bg-danger-soft text-danger",
  rejected: "bg-danger-soft text-danger",
};

export function VideoAdminPanel() {
  const app = videoApp();
  const [state, setState] = useState<AdminState>("pending");
  const [rows, setRows] = useState<AdminVideoRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [rowMessage, setRowMessage] = useState<Record<number, string>>({});

  const load = useCallback(
    async (mode: "first" | "more") => {
      setStatus("loading");
      setError(null);
      try {
        const page = await adminIndex({ state, cursor: mode === "more" ? nextCursor : null, limit: VIDEO_LIMITS.maxPageSize });
        setRows((prev) => (mode === "more" ? [...prev, ...(page.items ?? [])] : page.items ?? []));
        setNextCursor(page.nextCursor ?? null);
        setTotal(page.total ?? null);
        setStatus("ready");
      } catch (err) {
        if (err instanceof VideoApiError && (err.status === 401 || err.status === 403)) {
          setStatus("denied");
          return;
        }
        setError(err instanceof VideoApiError ? err.message : "The moderation queue would not load.");
        setStatus("error");
      }
    },
    [state, nextCursor],
  );

  useEffect(() => {
    if (!app.getSession().isAuthenticated) {
      app.requireLogin("/videos/admin");
      return;
    }
    void load("first");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, state]);

  const act = useCallback(
    async (id: number, action: "approve" | "remove" | "reprocess") => {
      setBusyRow(id);
      setRowMessage((prev) => ({ ...prev, [id]: "" }));
      try {
        const result =
          action === "approve" ? await adminApprove(id) : action === "remove" ? await adminRemove(id) : await adminReprocess(id);
        const verb = action === "approve" ? "Approved" : action === "remove" ? "Removed" : "Reprocess queued";
        setRowMessage((prev) => ({ ...prev, [id]: `${verb}${result.changed === false ? " (already in that state)" : ""}.` }));
        if (action !== "reprocess") {
          setRows((prev) => prev.map((row) => (row.id === id ? { ...row, moderationState: result.moderationState } : row)));
        }
      } catch (err) {
        setRowMessage((prev) => ({
          ...prev,
          [id]: err instanceof VideoApiError ? err.message : "That action failed.",
        }));
      } finally {
        setBusyRow(null);
      }
    },
    [],
  );

  return (
    <div className="min-h-[100svh] bg-canvas">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-16 pt-4 sm:pt-6">
        <header className="flex items-center gap-2">
          <Link
            to="/videos"
            aria-label="Back to the video feed"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line bg-surface text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
              <ShieldCheck className="h-5 w-5 text-accent" aria-hidden />
              Video admin
            </h1>
            <p className="text-[13px] text-ink-soft">Moderation queue, ranking weights, and discovery. Staff only; every action is audited server-side.</p>
          </div>
        </header>

        {status === "denied" ? (
          <VideoEmptyState
            variant="error"
            title="Staff only"
            body="The server refused this page (401/403) — the admin surface is deny-by-default and your account is not a moderator."
          />
        ) : (
          <section className="card space-y-3 p-4" aria-labelledby="queue-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="queue-heading" className="text-[15px] font-extrabold text-ink">
                Moderation queue {total != null ? <span className="text-[12.5px] font-semibold text-ink-faint">· {total} video(s)</span> : null}
              </h2>
              <div className="flex items-center gap-1.5">
                <div role="radiogroup" aria-label="Filter by moderation state" className="flex rounded-xl bg-surface-2 p-1">
                  {ADMIN_STATES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={state === option}
                      onClick={() => setState(option)}
                      className={clsx(
                        "min-h-11 rounded-lg px-2.5 text-[12px] font-bold capitalize transition-colors",
                        state === option ? "bg-surface text-ink shadow-card" : "text-ink-soft hover:text-ink",
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => void load("first")}
                  disabled={status === "loading"}
                  aria-label="Reload queue"
                  className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-surface text-ink-soft transition-colors hover:bg-surface-2"
                >
                  <RefreshCw className={clsx("h-4 w-4", status === "loading" && "animate-spin motion-reduce:animate-none")} aria-hidden />
                </button>
              </div>
            </div>

            {status === "error" ? (
              <VideoEmptyState variant="error" body={error ?? undefined} action={{ label: "Retry", onClick: () => void load("first") }} />
            ) : rows.length === 0 && status !== "loading" ? (
              <VideoEmptyState variant="empty" title={`Nothing is “${state}”`} body="The queue filter returned no videos." />
            ) : (
              <ul className="space-y-2.5">
                {rows.map((row) => (
                  <li key={row.id} className="rounded-xl border border-line bg-surface-2/50 p-3">
                    <div className="flex items-start gap-3">
                      <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-surface-2">
                        {row.thumbnailUrl ? (
                          <img src={row.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="grid h-full w-full place-items-center text-[10px] text-ink-faint">no thumb</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-bold text-ink">{row.caption || row.canonicalUrl || `Video ${row.id}`}</p>
                        <p className="mt-0.5 text-[11.5px] text-ink-faint">
                          #{row.id} · {row.kind}/{row.provider} · {row.author.name || "unknown"} · {formatDuration(row.durationMs)}
                          {row.width ? ` · ${row.width}×${row.height}` : ""}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <VideoStateBadge state={row.moderationState} />
                          <span className="text-[11px] font-semibold text-ink-faint">availability: {row.availability}</span>
                        </div>
                        {rowMessage[row.id] ? <p className="mt-1 text-[12px] font-semibold text-accent">{rowMessage[row.id]}</p> : null}
                      </div>
                      <div className="flex shrink-0 flex-col gap-1">
                        {busyRow === row.id ? (
                          <Loader2 className="h-4 w-4 animate-spin text-accent motion-reduce:animate-none" aria-hidden />
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => void act(row.id, "approve")}
                              aria-label={`Approve video ${row.id}`}
                              className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-success px-2.5 text-[12px] font-bold text-white transition-opacity hover:opacity-90"
                            >
                              <Check className="h-4 w-4" aria-hidden /> Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => void act(row.id, "remove")}
                              aria-label={`Remove video ${row.id}`}
                              className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-danger px-2.5 text-[12px] font-bold text-white transition-opacity hover:opacity-90"
                            >
                              <X className="h-4 w-4" aria-hidden /> Remove
                            </button>
                            <button
                              type="button"
                              onClick={() => void act(row.id, "reprocess")}
                              aria-label={`Reprocess video ${row.id}`}
                              className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-line bg-surface px-2.5 text-[12px] font-bold text-ink transition-colors hover:bg-surface-2"
                            >
                              <RefreshCw className="h-4 w-4" aria-hidden /> Reprocess
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {nextCursor && status === "ready" ? (
              <button
                type="button"
                onClick={() => void load("more")}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Load more
              </button>
            ) : null}
          </section>
        )}

        {status !== "denied" ? <RankConfigCard /> : null}
        {status !== "denied" ? <SourcesAndDiscoveryCard /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RankConfigCard() {
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [updatedAt, setUpdatedAt] = useState<Record<string, string | null>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const config = await adminRankConfig();
      const next: Record<string, string> = {};
      const stamps: Record<string, string | null> = {};
      for (const item of config.items ?? []) {
        next[item.key] = String(item.weight);
        stamps[item.key] = item.updatedAt;
      }
      setWeights(next);
      setUpdatedAt(stamps);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof VideoApiError ? err.message : "The ranking weights would not load.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sum = useMemo(
    () => RANKING_KEYS.reduce((acc, key) => acc + (Number.parseFloat(weights[key] ?? "") || 0), 0),
    [weights],
  );
  const sumOk = Math.abs(sum - 1) <= 0.001;

  const save = async () => {
    setSaving(true);
    setSavedMessage(null);
    setError(null);
    try {
      const parsed = Object.fromEntries(RANKING_KEYS.map((key) => [key, Number.parseFloat(weights[key] ?? "") || 0])) as Record<
        VideoRankingKey,
        number
      >;
      const config = await adminPutRankConfig(parsed);
      const next: Record<string, string> = {};
      for (const item of config.items ?? []) next[item.key] = String(item.weight);
      setWeights(next);
      setSavedMessage("Saved — the next ranking run uses these weights.");
    } catch (err) {
      setError(err instanceof VideoApiError ? err.message : "Saving the weights failed.");
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") {
    return (
      <section className="card space-y-2 p-4" aria-label="Loading ranking weights" aria-busy>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-10 w-full rounded-xl" aria-hidden />
        ))}
      </section>
    );
  }

  return (
    <section className="card space-y-3 p-4" aria-labelledby="rank-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 id="rank-heading" className="text-[15px] font-extrabold text-ink">
          Ranking weights
        </h2>
        <span className={clsx("rounded-full px-2.5 py-1 text-[12px] font-bold", sumOk ? "bg-success-soft text-success" : "bg-warn-soft text-warn")}>
          Σ {sum.toFixed(3)} {sumOk ? "ok" : "must be 1.000 ±0.001"}
        </span>
      </div>
      <p className="text-[12px] text-ink-faint">All six features are required. The server refuses a set that does not sum to 1.0.</p>
      {status === "error" && Object.keys(weights).length === 0 ? (
        <div className="flex items-center gap-2">
          <p className="text-[12.5px] font-semibold text-danger">{error}</p>
          <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-1.5 text-[12.5px] font-bold text-accent hover:underline">
            <RefreshCw className="h-4 w-4" aria-hidden /> Retry
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {RANKING_KEYS.map((key) => (
            <li key={key} className="flex items-center gap-3">
              <label htmlFor={`weight-${key}`} className="min-w-0 flex-1 text-[13px] font-semibold capitalize text-ink">
                {key.replace(/_/g, " ")}
                {updatedAt[key] ? <span className="ml-1.5 text-[11px] font-normal text-ink-faint">set {updatedAt[key].slice(0, 10)}</span> : null}
              </label>
              <input
                id={`weight-${key}`}
                type="number"
                min={0}
                max={1}
                step={0.001}
                value={weights[key] ?? ""}
                onChange={(event) => setWeights((prev) => ({ ...prev, [key]: event.currentTarget.value }))}
                className="h-11 w-24 rounded-xl border border-line bg-surface px-2.5 text-right text-sm tabular-nums text-ink focus:border-accent focus:outline-none"
              />
            </li>
          ))}
        </ul>
      )}
      {error && Object.keys(weights).length > 0 ? (
        <p role="alert" className="flex items-center gap-1.5 text-[12.5px] font-semibold text-danger">
          <AlertTriangle className="h-4 w-4" aria-hidden /> {error}
        </p>
      ) : null}
      {savedMessage ? (
        <p role="status" className="flex items-center gap-1.5 text-[12.5px] font-semibold text-success">
          <Check className="h-4 w-4" aria-hidden /> {savedMessage}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || !sumOk || status === "error"}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-bold text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Wand2 className="h-4 w-4" aria-hidden />}
        {saving ? "Saving…" : "Save weights"}
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function SourcesAndDiscoveryCard() {
  const [sources, setSources] = useState<VideoSource[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"rss" | "sitemap" | "allowlist">("rss");
  const [urlValue, setUrlValue] = useState("");
  const [provider, setProvider] = useState<VideoProvider>("youtube");
  const [enabled, setEnabled] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [urls, setUrls] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DiscoveryRunResult | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const page = await adminSources();
      setSources(page.items ?? []);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof VideoApiError ? err.message : "The source list would not load.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const urlList = useMemo(
    () => urls.split(/\s+/).map((entry) => entry.trim()).filter(Boolean).slice(0, 50),
    [urls],
  );

  const addSource = async () => {
    setAdding(true);
    setAddMessage(null);
    try {
      const created = await adminAddSource({ kind, url: urlValue.trim(), provider, enabled });
      setSources((prev) => [...prev, created]);
      setUrlValue("");
      setAddMessage(`Added source ${created.id}.`);
    } catch (err) {
      setAddMessage(err instanceof VideoApiError ? err.message : "Adding the source failed.");
    } finally {
      setAdding(false);
    }
  };

  const runDiscovery = async () => {
    setRunning(true);
    setResult(null);
    try {
      setResult(await adminRunDiscovery({ urls: urlList }));
    } catch (err) {
      setError(err instanceof VideoApiError ? err.message : "The discovery run failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="card space-y-4 p-4" aria-labelledby="sources-heading">
      <h2 id="sources-heading" className="text-[15px] font-extrabold text-ink">
        Discovery sources & manual run
      </h2>

      {status === "error" && sources.length === 0 ? (
        <div className="flex items-center gap-2">
          <p className="text-[12.5px] font-semibold text-danger">{error}</p>
          <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-1.5 text-[12.5px] font-bold text-accent hover:underline">
            <RefreshCw className="h-4 w-4" aria-hidden /> Retry
          </button>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {status === "loading" ? (
            <li className="skeleton h-8 w-full rounded-lg" aria-hidden />
          ) : sources.length === 0 ? (
            <li className="text-[12.5px] text-ink-faint">No sources registered yet.</li>
          ) : (
            sources.map((source) => (
              <li key={source.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2/60 px-3 py-2 text-[12.5px]">
                <Rss className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                <span className="font-bold text-ink">{source.kind}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft">{source.url}</span>
                <span className="text-ink-faint">{source.provider}</span>
                <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-bold", source.enabled ? "bg-success-soft text-success" : "bg-surface-2 text-ink-faint")}>
                  {source.enabled ? "enabled" : "off"}
                </span>
                <span className="text-[11px] text-ink-faint">{source.robotsRespected ? "robots respected" : "robots ignored?!"}</span>
              </li>
            ))
          )}
        </ul>
      )}

      <div className="space-y-2 rounded-xl border border-line p-3">
        <p className="text-[13px] font-bold text-ink">Add a source</p>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Source kind"
            value={kind}
            onChange={(event) => setKind(event.currentTarget.value as typeof kind)}
            className="h-11 rounded-xl border border-line bg-surface px-2.5 text-[13px] text-ink"
          >
            <option value="rss">rss</option>
            <option value="sitemap">sitemap</option>
            <option value="allowlist">allowlist</option>
          </select>
          <select
            aria-label="Provider"
            value={provider}
            onChange={(event) => setProvider(event.currentTarget.value as VideoProvider)}
            className="h-11 rounded-xl border border-line bg-surface px-2.5 text-[13px] text-ink"
          >
            <option value="youtube">youtube</option>
            <option value="vimeo">vimeo</option>
            <option value="linkedin">linkedin</option>
            <option value="self">self</option>
          </select>
          <label className="inline-flex min-h-11 items-center gap-1.5 px-1 text-[12.5px] font-semibold text-ink">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} className="h-4 w-4" />
            enabled
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            type="url"
            value={urlValue}
            onChange={(event) => setUrlValue(event.currentTarget.value)}
            placeholder="https://example.com/feed.xml (https only)"
            aria-label="Source URL"
            className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void addSource()}
            disabled={adding || !urlValue.trim().startsWith("https://")}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-accent px-3.5 text-[13px] font-bold text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {adding ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
            Add source
          </button>
        </div>
        {addMessage ? <p className="text-[12px] font-semibold text-ink-soft">{addMessage}</p> : null}
      </div>

      <div className="space-y-2 rounded-xl border border-line p-3">
        <p className="text-[13px] font-bold text-ink">Run discovery now (≤ 50 URLs)</p>
        <p className="text-[12px] text-ink-faint">
          This endpoint is the pipeline's only trigger — nothing runs on a schedule. Each URL lands as indexed, duplicate, or a
          documented refusal.
        </p>
        <textarea
          value={urls}
          onChange={(event) => setUrls(event.currentTarget.value)}
          rows={3}
          aria-label="URLs to discover, whitespace separated"
          placeholder={"https://youtube.com/watch?v=…\nhttps://vimeo.com/…"}
          className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void runDiscovery()}
          disabled={running || urlList.length === 0}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-bold text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Wand2 className="h-4 w-4" aria-hidden />}
          Discover {urlList.length ? `${urlList.length} URL(s)` : ""}
        </button>
        {result ? <DiscoveryResultView result={result} /> : null}
      </div>
    </section>
  );
}

function DiscoveryResultView({ result }: { result: DiscoveryRunResult }) {
  return (
    <div className="anim-fade-up mt-2 space-y-1.5 rounded-xl bg-surface-2/70 p-3">
      <p className="text-[12.5px] font-bold text-ink">
        {result.processed} processed · {result.indexed.length} indexed · {result.duplicates} duplicate(s) · {result.refused} refused
      </p>
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {result.outcomes.map((row) => (
          <li key={`${row.url}-${row.outcome}`} className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <span className={clsx("rounded-full px-2 py-0.5 font-bold", OUTCOME_TONE[row.outcome as DiscoveryOutcome] ?? "bg-surface-2 text-ink-soft")}>
              {row.outcome}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{row.url}</span>
            {row.videoId != null ? <span className="text-ink-faint">#{row.videoId}</span> : null}
            {row.detail ? <span className="text-ink-faint">{row.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
