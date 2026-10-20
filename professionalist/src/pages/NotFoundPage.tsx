import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Compass, Home, Search, Sparkles, Store } from "lucide-react";
import { LogoSymbol } from "@/components/Logo";
import { Button, Card } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";

const GUEST_LINKS = [
  { to: "/marketplace", label: "Marketplace", icon: Store },
  { to: "/network", label: "Networking", icon: Compass },
  { to: "/opportunities", label: "Opportunities", icon: Sparkles },
];

export default function NotFoundPage() {
  const { user } = useAuth();
  const location = useLocation();

  useEffect(() => {
    document.title = "Page not found — Professionalist";
  }, []);

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-5 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-accent-soft blur-3xl"
      />
      <div className="relative w-full max-w-lg text-center anim-fade-up">
        <div className="flex justify-center">
          <LogoSymbol size={52} />
        </div>

        <p
          className="mt-6 bg-clip-text text-6xl font-extrabold leading-none tracking-tight text-transparent sm:text-7xl"
          style={{ background: "linear-gradient(135deg, var(--accent) 0%, #22c0ff 100%)" }}
        >
          404
        </p>

        <h1 className="mt-4 text-xl font-extrabold tracking-tight sm:text-2xl">
          {user ? "That page isn't here" : "This link leads nowhere"}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-ink-soft">
          The address{" "}
          <span className="break-all font-mono text-[13px] font-semibold text-ink">{location.pathname}</span> doesn't
          match anything on Professionalist. It may have been renamed, the listing may have sold, or the link was
          mistyped.
        </p>

        <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          {user ? (
            <>
              <Link to="/home" className="min-h-11">
                <Button size="lg" fullWidth>
                  <Home size={17} /> Back to feed
                </Button>
              </Link>
              <Link to="/search" className="min-h-11">
                <Button size="lg" variant="outline" fullWidth>
                  <Search size={17} /> Search Professionalist
                </Button>
              </Link>
            </>
          ) : (
            <>
              <Link to="/" className="min-h-11">
                <Button size="lg" fullWidth>
                  <Home size={17} /> Go to landing
                </Button>
              </Link>
              <Link to="/search" className="min-h-11">
                <Button size="lg" variant="outline" fullWidth>
                  <Search size={17} /> Search Professionalist
                </Button>
              </Link>
            </>
          )}
        </div>

        <Card className="mt-7 p-4">
          <p className="text-[13px] font-bold">Popular places</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {GUEST_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
              >
                <l.icon size={14} aria-hidden />
                {l.label}
              </Link>
            ))}
            {user ? (
              <Link
                to="/create-listing"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-accent bg-accent-soft px-3.5 text-[13px] font-semibold text-accent transition-opacity hover:opacity-85"
              >
                <Store size={14} aria-hidden />
                Sell something
              </Link>
            ) : (
              <Link
                to="/register"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-accent bg-accent-soft px-3.5 text-[13px] font-semibold text-accent transition-opacity hover:opacity-85"
              >
                <Sparkles size={14} aria-hidden />
                Create a free account
              </Link>
            )}
          </div>
        </Card>

        <p className="mt-5 text-xs text-ink-faint">
          Broken link on our side?{" "}
          {user ? (
            <Link to="/support" className="font-semibold text-accent hover:underline">
              Tell the support team
            </Link>
          ) : (
            <Link to="/login" className="font-semibold text-accent hover:underline">
              Sign in and report it
            </Link>
          )}
          .
        </p>
      </div>
    </div>
  );
}
