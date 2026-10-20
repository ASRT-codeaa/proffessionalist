# Landing Page — design rationale & mount

The `/` landing page is a self-contained React + TS + Tailwind v4 subtree:
`src/pages/LandingPage.tsx`, `src/components/landing/**`, and `src/landing/**`.
It imports nothing from `src/services`, `src/context`, or `src/components/ui` —
it renders entirely from authored editorial content in `src/landing/content.ts`
and design tokens in `src/landing/tokens.ts`.

## Design tokens (measured, not invented)

Every value below is read directly from the deployed stylesheet
`dist/assets/index-D2clr9JG.css` (`:root` block + `.card`/shadow utilities). They
are applied as literal Tailwind arbitrary-value classes so the subtree needs no
global `@theme` and drops into the app cleanly.

| Token        | dist value | Used as |
|--------------|------------|---------|
| canvas       | `#f5f6f8`  | page background (`bg-[#f5f6f8]`) |
| surface      | `#ffffff`  | cards, header |
| surface-2    | `#eef0f4`  | neutral fills, hovers |
| ink          | `#101828`  | primary text |
| ink-soft     | `#667085`  | body copy |
| ink-faint    | `#98a2b3`  | meta / muted |
| line         | `#e4e7ec`  | 1px borders |
| line-strong  | `#d0d5dd`  | secondary button border |
| accent       | `#1e6fff`  | sky-blue accent |
| accent-hover | `#155ad0`  | accent hover |
| accent-soft  | `#e8f0ff`  | accent tint chips/icon plates |
| success      | `#12805c`  | (reserved) |
| ring         | `#1e6fff73`| `focus-visible` ring |
| shadow-card  | `0 1px 2px #1018280d` | card elevation |
| shadow-pop   | `0 12px 32px -8px #1018282e` | raised preview / closing card |
| font         | `"Inter", ui-sans-serif, system-ui, "Segoe UI", sans-serif` | body |

Radii use Tailwind's scale, which matches dist (`rounded-2xl` = 1rem, `rounded-3xl`
= 1.5rem). Motion is a single restrained `fade-up` (`src/landing/landing.css`)
driven by `<Reveal>` via IntersectionObserver; under
`prefers-reduced-motion: reduce` the CSS forces the base state visible and
`animation: none` — the animations degrade to nothing.

## Accessibility & responsiveness

- Semantic landmarks: `<header>` nav, `<main>` with per-section `aria-labelledby`, `<footer>`; a "Skip to content" link.
- Touch targets are `min-h-[44px]`; every interactive element has a visible `focus-visible` ring.
- The hero product preview is a `<figure>` with a `sr-only` `figcaption` describing it as a sample; the sample cards themselves are `aria-hidden` (clearly labelled "Preview · sample content").
- Layout is fluid from 360px up; the root sets `overflow-x-clip` and columns use `min-w-0`, so there is no horizontal overflow at any width.

## Section list

1. Header — brand mark (`/brand/logo-mark.png`), links to real destinations (`/videos`, `/marketplace`, `/opportunities`), Sign in + Create your profile. Mobile menu closes on Escape (returns focus to the toggle), outside click, and has `aria-expanded`.
2. Hero — editorial headline + subhead, two primary CTAs (`/register`, `/login`), and the static product preview (feed card, video card, listing card, profile header).
3. Positioning — "one professional identity" (3 pillars).
4. Feature sections — video discovery (`/videos`), jobs & companies (`/opportunities`), marketplace (`/marketplace`), networking/feed/notifications.
5. Trust & safety — real server-side controls only: rate limiting, account lockout, audit logging, role permissions (feature-inventory §1, §14). An explicit note states reporting/support/paid-promotion backends are not claimed.
6. Closing CTA — `Create your profile` / `Sign in`.
7. Footer — brand blurb + real destinations + copyright.

No AI-assistant, advertising/campaign, or support-ticket capabilities are claimed
(feature-inventory flags those backends as absent), and there are no fabricated
user counts or statistics.

## Mount

Lazy-imported by the application router for the `/` route (default export, no props):

```ts
const LandingPage = lazy(() => import("@/pages/LandingPage"));
```

## Verify (both pass)

- `npx tsc -p tsconfig.landing.json --noEmit` → exit 0.
- `npx vite build --config vite.landing.config.ts` → builds to `/workspaces/cf-run/out/landing-preview` (outside the repo, so `.gitignore` never sees it).
