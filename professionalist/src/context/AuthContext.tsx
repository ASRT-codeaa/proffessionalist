import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { authApi, setSelfId, type LoginPayload, type RegisterPayload } from "@/services/api";
import { ApiError, onSessionExpired, tokenStore } from "@/services/http";
import { subscribeSessionExpired as onVideoSessionExpired } from "@/services/videoHttp";
import { errorMessage } from "@/hooks/useAsync";
import { useToast } from "@/context/ToastContext";
import type { AuthUser } from "@/services/types";

interface AuthContextValue {
  user: AuthUser | null;
  booting: boolean;
  /** Set when the session lookup failed for a reason other than a rejected credential. */
  bootError: string | null;
  login: (p: LoginPayload) => Promise<AuthUser>;
  register: (p: RegisterPayload) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: (u: AuthUser | null) => void;
  refreshUser: () => Promise<void>;
  retryBoot: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const mounted = useRef(true);
  const lastExpiredToast = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setSelfId(user?.id ?? null);
  }, [user]);

  const boot = useCallback(async () => {
    if (!tokenStore.access) {
      if (mounted.current) setBooting(false);
      return;
    }
    setBootError(null);
    try {
      const me = await authApi.me();
      if (mounted.current) setUser(me);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      // Only a rejected credential ends the session; a timeout or unreachable server doesn't.
      if (status === 401 || status === 403) tokenStore.clear();
      else if (mounted.current) setBootError(errorMessage(e));
    } finally {
      if (mounted.current) setBooting(false);
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const { toast: pushToast } = useToast();

  useEffect(() => {
    // Both transports can end the session: services/http.ts for the app's own calls,
    // services/videoHttp.ts for the video feed's (it refreshes tokens independently).
    // Both paths can reach this handler for one expiry, hence the dedupe window.
    const expired = () => {
      setUser(null);
      setBootError(null);
      if (Date.now() - lastExpiredToast.current < 1500) return;
      lastExpiredToast.current = Date.now();
      pushToast({ title: "Your session has expired", description: "Sign in again to continue.", variant: "warning" });
    };
    const offApp = onSessionExpired(expired);
    const offVideo = onVideoSessionExpired(expired);
    return () => {
      offApp();
      offVideo();
    };
  }, [pushToast]);

  const login = useCallback(async (p: LoginPayload) => {
    const res = await authApi.login(p);
    tokenStore.set(res.token, res.refreshToken);
    setBootError(null);
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(async (p: RegisterPayload) => {
    const res = await authApi.register(p);
    tokenStore.set(res.token, res.refreshToken);
    setBootError(null);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* best effort */
    }
    tokenStore.clear();
    setBootError(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!tokenStore.access) return;
    try {
      const me = await authApi.me();
      setUser(me);
    } catch {
      /* keep current */
    }
  }, []);

  const retryBoot = useCallback(async () => {
    setBooting(true);
    await boot();
  }, [boot]);

  const value = useMemo(
    () => ({ user, booting, bootError, login, register, logout, setUser, refreshUser, retryBoot }),
    [user, booting, bootError, login, register, logout, refreshUser, retryBoot]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
