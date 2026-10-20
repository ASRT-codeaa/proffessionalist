import { Link } from "react-router-dom";
import { brand, footer } from "@/landing/content";
import { cx, t } from "@/landing/tokens";

export function LandingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-[#e4e7ec] bg-[#f5f6f8]">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-xs">
            <Link
              to="/"
              aria-label={`${brand.name} home`}
              className={cx("inline-flex items-center gap-2.5 rounded-xl", t.focus)}
            >
              <img
                src={brand.logo}
                alt=""
                width={26}
                height={26}
                className="h-6 w-6 rounded-lg object-contain"
              />
              <span className={cx("text-base font-extrabold tracking-tight", t.ink)}>
                {brand.name}
              </span>
            </Link>
            <p className={cx("mt-3 text-sm leading-relaxed", t.inkSoft)}>{footer.blurb}</p>
          </div>

          <nav aria-label="Footer" className="flex flex-wrap gap-x-12 gap-y-8">
            {footer.columns.map((col) => (
              <div key={col.title}>
                <h3 className={cx("text-xs font-semibold uppercase tracking-[0.12em]", t.inkFaint)}>
                  {col.title}
                </h3>
                <ul className="mt-3 space-y-2">
                  {col.links.map((l) => (
                    <li key={l.to}>
                      <Link
                        to={l.to}
                        className={cx(
                          "inline-flex min-h-11 items-center rounded-lg text-sm font-medium",
                          t.ink,
                          "hover:text-[#155ad0]",
                          t.focus,
                        )}
                      >
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className={cx("mt-10 border-t border-[#e4e7ec] pt-6 text-[13px]", t.inkFaint)}>
          <p>© {year} {brand.name}. {brand.tagline}</p>
        </div>
      </div>
    </footer>
  );
}
