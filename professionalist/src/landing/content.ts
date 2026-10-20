/**
 * content.ts — editorial copy and presentation-only sample data for the landing
 * page. Kept separate from components so the marketing text and the (fake, but
 * plausible) preview content are obviously authored copy, not live feature state.
 *
 * Truthfulness rules enforced here:
 *  - Only destinations that actually exist are linked: /videos, /marketplace,
 *    /opportunities, /login, /register (see docs/feature-inventory.md §2).
 *  - No AI assistant, advertising/campaign, or support-ticket capabilities are
 *    claimed — the inventory flags those backends as absent.
 *  - No fabricated user counts, growth charts or "10,000+ users" statistics.
 *  - Trust & safety items are real, server-side controls (rate limiting, account
 *    lockout, audit logging, role permissions) — see inventory §1 and §14.
 *  - Every "preview" sample is labelled presentation-only in the UI.
 */

import type { LucideIcon } from "lucide-react";
import {
  BadgeCheck,
  Briefcase,
  ClipboardList,
  Compass,
  Images,
  Lock,
  MessagesSquare,
  PlaySquare,
  ShieldCheck,
  ShoppingBag,
  UserRoundSearch,
  Users,
} from "lucide-react";

export const brand = {
  name: "Professionalist",
  tagline: "Where professional people, ideas and opportunities connect.",
  /** Brand mark served from /brand (see index.html / dist/brand). */
  logo: "/brand/logo-mark.png",
  logoDark: "/brand/logo-mark-dark.png",
  wordmark: "/brand/logo-full.png",
  ogCover: "/brand/og-cover.png",
  favicon: "/brand/favicon-48.png",
} as const;

export type NavLink = { label: string; to: string };

/** Header destinations — only routes that exist in the shipped app. */
export const navLinks: NavLink[] = [
  { label: "Videos", to: "/videos" },
  { label: "Marketplace", to: "/marketplace" },
  { label: "Opportunities", to: "/opportunities" },
];

export const authLinks = {
  signIn: { label: "Sign in", to: "/login" },
  register: { label: "Create your profile", to: "/register" },
} as const;

/* -------------------------------------------------------------------------- */
/* Hero                                                                        */
/* -------------------------------------------------------------------------- */

export const hero = {
  eyebrow: "A professional network, built for work",
  headline: "Your work deserves a network that keeps up with it.",
  subhead:
    "Professionalist brings your profile, feed, vertical video, marketplace and job " +
    "opportunities into one calm, focused place — so the people, buyers and roles that " +
    "fit your work can actually find you.",
  primaryCta: { label: "Create your profile", to: "/register" },
  secondaryCta: { label: "Sign in", to: "/login" },
  previewAlt:
    "Illustrative preview of the Professionalist interface: a feed post, a vertical " +
    "video card, a marketplace listing and a professional profile header. Sample " +
    "content only — not a live view.",
} as const;

/* -------------------------------------------------------------------------- */
/* Positioning — "what the platform is"                                        */
/* -------------------------------------------------------------------------- */

export const positioning = {
  heading: "One profile. Every kind of professional moment.",
  body:
    "Most networks make you choose between being seen, being hired, and being paid. " +
    "Professionalist is a single professional identity that carries through all of it — " +
    "the posts you write, the videos people discover, the listings you sell, and the " +
    "roles you apply to all attach to the same verified profile.",
  pillars: [
    {
      icon: BadgeCheck,
      title: "A profile that means something",
      body: "Skills, experience and a headline travel with every post, listing and message — so context is never lost between surfaces.",
    },
    {
      icon: Compass,
      title: "Discovery that points at work",
      body: "Vertical video, a searchable marketplace and an opportunities feed put your work in front of people who came here to do business.",
    },
    {
      icon: Users,
      title: "A graph around real work",
      body: "Connections you control, follows without noise, and people you can find by skill — not by popularity.",
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Feature sections (alternating preview)                                      */
/* -------------------------------------------------------------------------- */

export type FeatureSection = {
  id: string;
  icon: LucideIcon;
  kicker: string;
  heading: string;
  body: string;
  bullets: string[];
  link: { label: string; to: string } | null;
  preview: "video" | "jobs" | "marketplace" | "network";
};

export const featureSections: FeatureSection[] = [
  {
    id: "video",
    icon: PlaySquare,
    kicker: "Vertical video discovery",
    heading: "Show the work, not just the job title",
    body:
      "A dedicated /videos surface for short, vertical professional video — demos, " +
      "explainers and portfolio pieces people scroll, react to and follow up on.",
    bullets: [
      "Full-height, swipeable discovery tuned for professional content",
      "Every clip links back to the creator's profile",
      "Built for showing craft a text post can't carry",
    ],
    link: { label: "See what discovery feels like — /videos", to: "/videos" },
    preview: "video",
  },
  {
    id: "jobs",
    icon: Briefcase,
    kicker: "Jobs & companies",
    heading: "Opportunities with a face you can check",
    body:
      "The /opportunities feed lists roles from real company profiles. Open a company, " +
      "read its reviews and listings, and apply — the employer and the role are the same " +
      "trusted identity.",
    bullets: [
      "Browse jobs and freelance opportunities in one place",
      "Company profiles carry reviews, listings and openings",
      "Apply from the role straight into your network context",
    ],
    link: { label: "Browse opportunities — /opportunities", to: "/opportunities" },
    preview: "jobs",
  },
  {
    id: "marketplace",
    icon: ShoppingBag,
    kicker: "Marketplace",
    heading: "Buy and sell where the profile already is",
    body:
      "List products, services and business opportunities with price, condition and " +
      "location. Interested buyers contact the seller directly through messaging — no " +
      "detour off the platform.",
    bullets: [
      "Listings with images, price and availability",
      "Contact the seller in a message thread with the listing attached",
      "Search and filter the marketplace by what you actually need",
    ],
    link: { label: "Explore the marketplace — /marketplace", to: "/marketplace" },
    preview: "marketplace",
  },
  {
    id: "network",
    icon: MessagesSquare,
    kicker: "Feed, networking & notifications",
    heading: "Stay in the loop you chose",
    body:
      "A personalized feed of the people and businesses you follow, direct messaging, and " +
      "notifications that mark the moments worth your attention — connections, applications " +
      "and replies, not noise.",
    bullets: [
      "A feed built from the connections and follows you control",
      "Messaging for conversations, quotes and follow-ups",
      "Notifications keep unread activity visible and clearable",
    ],
    link: null,
    preview: "network",
  },
];

/* -------------------------------------------------------------------------- */
/* Trust & safety — real, server-side controls (inventory §1, §14)             */
/* -------------------------------------------------------------------------- */

export const trust = {
  heading: "Security you can hold us to",
  body:
    "The controls below run on the server, not in the browser. They are part of how the " +
    "API already behaves — described exactly as implemented.",
  items: [
    {
      icon: ShieldCheck,
      title: "Rate limiting",
      body: "Requests are throttled by IP, by authenticated user, and specifically on the authentication endpoints — so automated abuse is slowed at the edge before it reaches your account.",
    },
    {
      icon: Lock,
      title: "Account lockout",
      body: "Repeated failed sign-in attempts count against a per-account budget and temporarily lock the account. It is the real brute-force defence, enforced server-side.",
    },
    {
      icon: ClipboardList,
      title: "Audit logging",
      body: "Security-relevant actions are written to audit logs that staff can review — a record of what happened, to whom, and when.",
    },
    {
      icon: UserRoundSearch,
      title: "Role permissions",
      body: "Staff and admin capabilities are gated by explicit role checks on the server. Moderation, verification and user management are reachable only by accounts that hold the matching role.",
    },
  ],
  note: "Email verification, password reset and server-tracked sessions are also live. Reporting, support tickets and paid promotions are not part of this landing page because those backends are still being completed.",
};

/* -------------------------------------------------------------------------- */
/* Closing CTA                                                                 */
/* -------------------------------------------------------------------------- */

export const closingCta = {
  heading: "Start with the profile. The rest follows.",
  body:
    "Create one professional identity and it travels everywhere on Professionalist — " +
    "your feed, your videos, your listings and your applications. It takes a few minutes " +
    "to begin.",
  primary: { label: "Create your profile", to: "/register" },
  secondary: { label: "Sign in", to: "/login" },
} as const;

/* -------------------------------------------------------------------------- */
/* Footer — only real destinations + brand blurb. No fake legal pages linked   */
/* -------------------------------------------------------------------------- */

export const footer = {
  blurb: brand.tagline,
  columns: [
    {
      title: "Explore",
      links: [
        { label: "Videos", to: "/videos" },
        { label: "Marketplace", to: "/marketplace" },
        { label: "Opportunities", to: "/opportunities" },
      ],
    },
    {
      title: "Account",
      links: [
        { label: "Sign in", to: "/login" },
        { label: "Create your profile", to: "/register" },
      ],
    },
  ] as Array<{ title: string; links: NavLink[] }>,
} as const;

/* -------------------------------------------------------------------------- */
/* Presentation-only sample content for the product previews.                  */
/* These are authored illustrations, not live data. Components label them       */
/* clearly as a preview.                                                        */
/* -------------------------------------------------------------------------- */

export const previewSample = {
  profile: {
    name: "Amara Okafor",
    handle: "@amara.designs",
    headline: "Senior Product Designer · Lumen Studio",
    initials: "AO",
    verified: true,
    skills: ["Design systems", "Figma", "Prototyping"],
  },
  feed: {
    author: "Amara Okafor",
    initials: "AO",
    meta: "Senior Product Designer · Lumen Studio · 2h",
    body:
      "Shipped a refresh of our booking flow this week. The biggest win was cutting the " +
      "confirmation step from five taps to two — prototype in the replies if you want to poke at it.",
    hashtags: ["#productdesign", "#ux"],
    likes: "sample",
  },
  video: {
    title: "Studio tour: how we prototype motion",
    author: "@amara.designs",
    ratio: "9 / 16",
    glyph: Images,
  },
  listing: {
    title: "Design-system audit & handoff kit",
    price: "$480",
    conditionLabel: "Service",
    location: "Remote · replies within a day",
    seller: "Lumen Studio",
  },
  jobs: [
    {
      role: "Product Designer, Payments",
      company: "Northwind",
      place: "Remote · Europe",
      type: "Full-time",
    },
    {
      role: "Frontend Engineer",
      company: "Cobalt Labs",
      place: "Hybrid · Lisbon",
      type: "Contract",
    },
  ],
  connection: {
    name: "Devin Park",
    headline: "Staff Engineer · Cobalt Labs",
    initials: "DP",
  },
  notification: {
    text: "Northwind viewed your application",
    when: "sample",
  },
} as const;

/** Explicit, visible label used on every preview card so nothing reads as live. */
export const previewLabel = "Preview · sample content" as const;
