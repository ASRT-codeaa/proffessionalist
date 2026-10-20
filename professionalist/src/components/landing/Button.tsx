import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx, t } from "@/landing/tokens";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold tracking-tight " +
  "transition-colors duration-150 ease-out no-underline " +
  "min-h-[44px] px-5 text-[15px] " +
  t.focus;

const variants: Record<Variant, string> = {
  primary: cx(
    "bg-[#1e6fff] text-[#ffffff] shadow-[0_1px_2px_#1018280d] hover:bg-[#155ad0] active:bg-[#155ad0]",
  ),
  secondary: cx(
    "border border-[#d0d5dd] bg-[#ffffff] text-[#101828] hover:bg-[#eef0f4] hover:border-[#98a2b3]",
  ),
  ghost: cx("bg-transparent text-[#101828] hover:bg-[#eef0f4]"),
};

const sizes: Record<Size, string> = {
  md: "min-h-[44px] px-5 text-[15px]",
  lg: "min-h-[52px] px-6 text-base",
};

export type ButtonProps = {
  to: string;
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
};

/** Internal-link call to action. Everything on the page routes in-app. */
export function Button({
  to,
  variant = "primary",
  size = "md",
  children,
  className,
  ariaLabel,
}: ButtonProps) {
  return (
    <Link
      to={to}
      aria-label={ariaLabel}
      className={cx(base, variants[variant], sizes[size], className)}
    >
      {children}
    </Link>
  );
}
