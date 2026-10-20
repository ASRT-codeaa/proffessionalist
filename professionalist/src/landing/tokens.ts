/**
 * tokens.ts — the Professionalist design tokens, measured from the deployed
 * stylesheet `dist/assets/index-D2clr9JG.css` (`:root` block + `.card` /
 * `shadow` utilities) and expressed as literal Tailwind arbitrary-value classes.
 *
 * These are written as complete, static class strings (never interpolated) so
 * the Tailwind compiler can see and emit every utility from source alone — the
 * landing subtree therefore needs no global `@theme` to exist and stays fully
 * self-contained. Values mirror the platinum-white / sky-blue system:
 *
 *   canvas   #f5f6f8   surface  #ffffff   surface-2 #eef0f4
 *   ink      #101828   ink-soft #667085    ink-faint #98a2b3
 *   line     #e4e7ec   line-strong #d0d5dd
 *   accent   #1e6fff   accent-hover #155ad0  accent-soft #e8f0ff
 *   success  #12805c   danger #c62f2f       ring #1e6fff73
 *   shadow-card 0 1px 2px #1018280d   shadow-pop 0 12px 32px -8px #1018282e
 *   font  "Inter", ui-sans-serif, system-ui, "Segoe UI", sans-serif
 */

/** Raw hex, for inline styles / SVG where a utility class is impractical. */
export const hex = {
  canvas: "#f5f6f8",
  surface: "#ffffff",
  surface2: "#eef0f4",
  ink: "#101828",
  inkSoft: "#667085",
  inkFaint: "#98a2b3",
  line: "#e4e7ec",
  lineStrong: "#d0d5dd",
  accent: "#1e6fff",
  accentHover: "#155ad0",
  accentSoft: "#e8f0ff",
  success: "#12805c",
  successSoft: "#e6f6ef",
  danger: "#c62f2f",
  ring: "#1e6fff73",
} as const;

/** Reusable, static utility-class fragments. Keys map to the token names above. */
export const t = {
  // surfaces
  canvas: "bg-[#f5f6f8]",
  surface: "bg-[#ffffff]",
  surface2: "bg-[#eef0f4]",
  // text
  ink: "text-[#101828]",
  inkSoft: "text-[#667085]",
  inkFaint: "text-[#98a2b3]",
  accent: "text-[#1e6fff]",
  accentHover: "hover:text-[#155ad0]",
  success: "text-[#12805c]",
  danger: "text-[#c62f2f]",
  // lines
  line: "border-[#e4e7ec]",
  lineStrong: "border-[#d0d5dd]",
  // accent surfaces
  accentSoft: "bg-[#e8f0ff]",
  // shadows (match dist --shadow-card / --shadow-pop)
  shadowCard: "shadow-[0_1px_2px_#1018280d]",
  shadowPop: "shadow-[0_12px_32px_-8px_#1018282e]",
  shadowPopHover: "hover:shadow-[0_12px_32px_-8px_#1018282e]",
  // focus ring — visible, offset, sky-blue
  focus:
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1e6fff73] focus-visible:ring-offset-2 focus-visible:ring-offset-[#ffffff]",
} as const;

/** Tiny classnames joiner (keeps the subtree free of an external util import). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
