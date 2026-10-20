import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ShieldCheck, Sparkles, TrendingUp } from "lucide-react";
import { Logo } from "@/components/Logo";

const HIGHLIGHTS = [
  { icon: Sparkles, text: "Build a professional profile that actually gets read" },
  { icon: TrendingUp, text: "Buy, sell and promote in a curated marketplace" },
  { icon: ShieldCheck, text: "Verified people and businesses, no noise" },
];

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-ink p-12 text-canvas lg:flex">
        <div
          className="absolute inset-0 opacity-90"
          style={{ background: "linear-gradient(140deg,#04123f 0%,#0b5cd8 55%,#22c0ff 100%)" }}
          aria-hidden
        />
        <div className="relative">
          <Link to="/" className="inline-flex rounded-2xl bg-white/95 p-2">
            <Logo size={34} wordmark={false} />
          </Link>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-extrabold leading-tight tracking-tight">
            Where professional people, ideas and opportunities connect.
          </h2>
          <ul className="mt-8 space-y-3.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h.text} className="flex items-start gap-3 text-[15px] text-white/90">
                <h.icon size={19} className="mt-0.5 shrink-0" aria-hidden />
                {h.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative flex items-center gap-2 text-xs text-white/70">
          <CheckCircle2 size={14} /> Trusted by professionals in 18 countries
        </p>
      </aside>

      <main className="flex flex-col items-center justify-center px-5 py-10 sm:px-8">
        <Link to="/" className="mb-8 lg:hidden">
          <Logo size={38} />
        </Link>
        <div className={wide ? "w-full max-w-xl" : "w-full max-w-md"}>
          <header className="mb-7">
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-[28px]">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-ink-soft">{subtitle}</p>}
          </header>
          {children}
          {footer && <div className="mt-6 text-center text-sm text-ink-soft">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
