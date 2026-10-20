import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/services/http";

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  refetch: () => void;
  setData: (updater: T | ((prev: T | null) => T)) => void;
}

/** Data-fetching hook with loading/error/refetch and stale-response protection. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const runId = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    fnRef.current()
      .then((d) => {
        if (runId.current === id) setData(d);
      })
      .catch((e) => {
        if (runId.current === id) setError(e as ApiError);
      })
      .finally(() => {
        if (runId.current === id) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const update = useCallback((updater: T | ((prev: T | null) => T)) => {
    setData((prev) => (typeof updater === "function" ? (updater as (p: T | null) => T)(prev) : updater));
  }, []);

  return { data, error, loading, refetch: () => setTick((t) => t + 1), setData: update };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network_error") return "Cannot reach the server. Check your connection and try again.";
    if (e.code === "timeout") return "The server took too long to respond. Please try again.";
    if (e.code === "rate_limited") return "Too many requests — please wait a moment.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
