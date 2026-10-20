import { cn } from "@/lib/utils";

const MARK = "/brand/logo-mark.png";
const MARK_DARK = "/brand/logo-mark-dark.png";

export function LogoSymbol({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <span
      role="img"
      aria-label="Professionalist"
      className={cn("inline-block shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <img src={MARK} alt="" width={size} height={size} draggable={false} className="h-full w-full object-contain dark:hidden" />
      <img src={MARK_DARK} alt="" width={size} height={size} draggable={false} className="hidden h-full w-full object-contain dark:block" />
    </span>
  );
}

export function Logo({
  size = 34,
  wordmark = true,
  className,
}: {
  size?: number;
  wordmark?: boolean;
  className?: string;
}) {
  if (!wordmark) return <LogoSymbol size={size} className={className} />;
  return (
    <span className={cn("inline-flex items-center gap-2.5 select-none", className)}>
      <LogoSymbol size={size} />
      <span className="font-extrabold tracking-tight leading-none text-ink" style={{ fontSize: size * 0.6 }}>
        Professionalist
      </span>
    </span>
  );
}
