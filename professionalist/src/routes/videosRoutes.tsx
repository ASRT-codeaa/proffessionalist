import type { RouteObject } from "react-router-dom";
import { Clapperboard, PlusCircle, Sparkles, type LucideIcon } from "lucide-react";

/**
 * videosRoutes.ts — the single additive file the app imports.
 *
 * It exports (a) the route objects for the video pages, (b) the "More" menu entries, and
 * (c) the Discover tile. See src/README-VIDEO-UI.md for the exact one-line merge at each
 * integration point. Every route is lazy so it stays its own chunk, matching how the
 * deployed bundle splits HomePage / DiscoverPage / SettingsPage / …
 */

export const VIDEOS_PATH = "/videos";
export const CREATE_VIDEO_PATH = "/videos/create";
export const VIDEO_INTERESTS_PATH = "/videos/interests";
export const VIDEO_ADMIN_PATH = "/videos/admin";

export const videosRoutes: RouteObject[] = [
  {
    path: VIDEOS_PATH,
    lazy: () => import("@/pages/VideosPage").then((m) => ({ Component: m.default })),
  },
  {
    path: CREATE_VIDEO_PATH,
    lazy: () => import("@/pages/CreateVideoPage").then((m) => ({ Component: m.default })),
  },
  {
    path: VIDEO_INTERESTS_PATH,
    lazy: () => import("@/pages/VideoInterestsPage").then((m) => ({ Component: m.default })),
  },
  {
    // Staff-only; the page itself shows the documented 401/403 for everyone else.
    path: VIDEO_ADMIN_PATH,
    lazy: () => import("@/components/video/VideoAdminPanel").then((m) => ({ Component: m.VideoAdminPanel })),
  },
];

export interface VideoNavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

/** Drop these into the sidebar / "More" sheet next to Saved, Progress, Tasks, … */
export const videoNavEntries: VideoNavEntry[] = [
  {
    to: VIDEOS_PATH,
    label: "Videos",
    icon: Clapperboard,
    description: "Vertical video feed — For You, Following, Trending",
  },
  {
    to: CREATE_VIDEO_PATH,
    label: "Add a video",
    icon: PlusCircle,
    description: "Upload or link a clip; it goes to review first",
  },
  {
    to: VIDEO_INTERESTS_PATH,
    label: "Video interests",
    icon: Sparkles,
    description: "Pick the topics that shape your For You tab",
  },
];

export interface VideoDiscoverTile {
  to: string;
  title: string;
  blurb: string;
  icon: LucideIcon;
}

/** One tile for the Discover grid (it uses the same grid-cols-2 / @md:grid-cols-3 rhythm). */
export const videoDiscoverTile: VideoDiscoverTile = {
  to: VIDEOS_PATH,
  title: "Videos",
  blurb: "Short vertical clips from the people you follow and the topics you pick.",
  icon: Clapperboard,
};

/**
 * The app's existing 404 page handles unknown paths; these three are added before it so a
 * direct URL / refresh on /videos keeps working (dist/_redirects already rewrites /* to
 * /index.html, and the assets Worker does the same).
 */
export default videosRoutes;
