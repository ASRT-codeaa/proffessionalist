import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/landing/Button";
import { brand, navLinks, authLinks } from "@/landing/content";
import { cx, t } from "@/landing/tokens";

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  // Close on Escape and on outside click while the mobile menu is open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    function onPointer(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        !toggleRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-[#e4e7ec] bg-[#ffffff]/85 backdrop-blur-md">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6 lg:px-8"
      >
        <Link
          to="/"
          aria-label={`${brand.name} home`}
          className={cx("inline-flex items-center gap-2.5 rounded-xl", t.focus)}
        >
          <img
            src={brand.logo}
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 rounded-lg object-contain"
          />
          <span className={cx("text-[17px] font-extrabold tracking-tight", t.ink)}>
            {brand.name}
          </span>
        </Link>

        {/* Desktop nav */}
        <ul className="ml-2 hidden items-center gap-1 md:flex">
          {navLinks.map((l) => (
            <li key={l.to}>
              <Link
                to={l.to}
                className={cx(
                  "inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold",
                  t.inkSoft,
                  "hover:bg-[#eef0f4] hover:text-[#101828]",
                  t.focus,
                )}
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="ml-auto hidden items-center gap-2 md:flex">
          <Button to={authLinks.signIn.to} variant="ghost">
            {authLinks.signIn.label}
          </Button>
          <Button to={authLinks.register.to} variant="primary">
            {authLinks.register.label}
          </Button>
        </div>

        {/* Mobile toggle */}
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls="landing-mobile-menu"
          onClick={() => setOpen((v) => !v)}
          className={cx(
            "ml-auto inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[#e4e7ec]",
            t.ink,
            "bg-[#ffffff] hover:bg-[#eef0f4]",
            t.focus,
            "md:hidden",
          )}
        >
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
          {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
      </nav>

      {/* Mobile menu */}
      {open ? (
        <div
          id="landing-mobile-menu"
          ref={panelRef}
          className="border-t border-[#e4e7ec] bg-[#ffffff] md:hidden"
        >
          <ul className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 sm:px-6">
            {navLinks.map((l) => (
              <li key={l.to}>
                <Link
                  to={l.to}
                  onClick={() => setOpen(false)}
                  className={cx(
                    "flex min-h-11 items-center rounded-xl px-3 text-[15px] font-semibold",
                    t.ink,
                    "hover:bg-[#eef0f4]",
                    t.focus,
                  )}
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button
                to={authLinks.signIn.to}
                variant="secondary"
                className="w-full"
                ariaLabel={authLinks.signIn.label}
              >
                {authLinks.signIn.label}
              </Button>
              <Button
                to={authLinks.register.to}
                variant="primary"
                className="w-full"
                ariaLabel={authLinks.register.label}
              >
                {authLinks.register.label}
              </Button>
            </li>
          </ul>
        </div>
      ) : null}
    </header>
  );
}
