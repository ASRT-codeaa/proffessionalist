import { http } from "./http";
import { EP } from "./endpoints";
import type {
  AdminBusinessRow,
  AdminReportRow,
  AdminStats,
  AdminTransactionRow,
  AdminUserRow,
  AiConversation,
  AppNotification,
  AuthUser,
  Business,
  BusinessTeamMember,
  Campaign,
  Category,
  Comment,
  ConnectionFilters,
  Conversation,
  ConversationId,
  FeedFilters,
  Listing,
  MarketplaceFilters,
  MediaItem,
  Message,
  Opportunity,
  Paginated,
  Person,
  Post,
  ProgressData,
  Review,
  SavedItem,
  SearchResults,
  SettingsData,
  SupportTicket,
  Task,
} from "./types";

export interface LoginPayload {
  email: string;
  password: string;
}

export interface RegisterPayload {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  username: string;
  country: string;
  category: string;
  accountType: "individual" | "company";
  company?: string;
  jobTitle?: string;
  website?: string;
}

export const authApi = {
  register: (p: RegisterPayload) => http.post<{ user: AuthUser; token: string; refreshToken: string }>(EP.auth.register, p, { auth: false }),
  login: (p: LoginPayload) => http.post<{ user: AuthUser; token: string; refreshToken: string }>(EP.auth.login, p, { auth: false }),
  me: () => http.get<AuthUser>(EP.auth.me),
  logout: () => http.post<void>(EP.auth.logout, {}, { retryOnNetworkError: false }),
  forgotPassword: (email: string) => http.post<{ message: string }>(EP.auth.forgotPassword, { email }, { auth: false }),
  resetPassword: (token: string, password: string) => http.post<void>(EP.auth.resetPassword, { token, password }, { auth: false }),
  verifyEmail: (token: string) => http.post<void>(EP.auth.verifyEmail, { token }, { auth: false }),
  resendVerification: (email: string) => http.post<void>(EP.auth.resendVerification, { email }, { auth: false }),
  recoverAccount: (email: string) => http.post<{ message: string }>(EP.auth.recoverAccount, { email }, { auth: false }),
};

export interface OnboardingPayload {
  avatarUrl?: string;
  coverUrl?: string;
  title?: string;
  company?: string;
  bio?: string;
  skills?: string[];
  interests?: string[];
  location?: string;
  country?: string;
  followUserIds?: number[];
  followBusinessIds?: number[];
  onboardingDone?: boolean;
}

export const onboardingApi = {
  save: (p: OnboardingPayload) => http.put<AuthUser>(EP.onboarding.save, p),
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.upload<{ url: string }>(EP.onboarding.uploadAvatar, form);
  },
};

export const usersApi = {
  byUsername: (username: string) =>
    http.get<{ person: Person; profile: AuthUser["profile"]; stats: { posts: number; followers: number; connections: number }; reviews: Review[]; services: Listing[]; products: Listing[] }>(
      EP.users.byUsername(username)
    ),
  updateProfile: (patch: Partial<AuthUser["profile"]> & { firstName?: string; lastName?: string; email?: string; username?: string }) =>
    http.patch<AuthUser>(EP.users.updateProfile, patch),
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.upload<{ url: string }>(EP.users.uploadAvatar, form);
  },
  uploadCover: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.upload<{ url: string }>(EP.users.uploadCover, form);
  },
  progress: () => http.get<ProgressData>(EP.users.progress),
  setGoals: (goals: { id?: number; title: string; target: number; metric?: string; dueDate?: string | null }[]) =>
    http.put<{ id: number }[]>(EP.users.goals, { goals }),
  deleteGoal: (id: number) => http.del<void>(EP.users.goal(id)),
};

export const networkApi = {
  overview: () => http.get<{ requests: (Person & { requestId: number })[]; suggestions: Person[]; invitations: number }>(EP.network.overview),
  connections: (query?: ConnectionFilters) => http.get<Paginated<Person>>(EP.network.connections, query),
  requests: () => http.get<(Person & { requestId: number })[]>(EP.network.requests),
  acceptRequest: (id: number) => http.post<{ connected: true }>(EP.network.respond(id), { action: "accept" }),
  declineRequest: (id: number) => http.post<{ connected: false }>(EP.network.respond(id), { action: "decline" }),
  suggestions: (query?: ConnectionFilters) => http.get<Person[]>(EP.network.suggestions, query),
  connect: (userId: number) => http.post<{ requestId: number; status: string }>(EP.network.connect, { userId }),
  removeConnection: (userId: number) => http.del<void>(EP.network.removeConnection(userId)),
  following: () => http.get<{ people: Person[]; businesses: Business[] }>(EP.network.following),
  followers: () => http.get<Person[]>(EP.network.followers),
  follow: (target: { userId?: number; businessId?: number }) => http.post<{ following: true }>(EP.network.follow, target),
  unfollow: (target: { userId?: number; businessId?: number }) => http.post<{ following: false }>(EP.network.unfollow, target),
};

/**
 * The safety surface.  Mutes are server-side and one-way (they hide a creator from YOUR feeds —
 * home and videos — without touching follows or telling the creator).  Blocks reuse the
 * platform's existing POST/DELETE /api/blocks/:userId writes, which also tear down follows;
 * GET /api/blocks is the Worker-side read that makes an Unblock list possible.
 */
export interface SafetyPerson { id: number; username: string; name: string; avatarUrl: string }

export const safetyApi = {
  mutes: () => http.get<{ items: SafetyPerson[] }>(EP.safety.mutes),
  mute: (userId: number) => http.post<{ muted: true; userId: number }>(EP.safety.mute(userId), {}),
  unmute: (userId: number) => http.del<{ muted: false; userId: number }>(EP.safety.mute(userId)),
  blocks: () => http.get<{ items: SafetyPerson[] }>(EP.safety.blocks),
  block: (userId: number) => http.post<{ blocked: true }>(EP.safety.block(userId), {}),
  unblock: (userId: number) => http.del<{ blocked: false }>(EP.safety.block(userId)),
};

export interface CreatePostPayload {
  text: string;
  kind?: Post["kind"];
  media?: { url: string; type: "image" | "video" | "document"; name?: string }[];
  linkUrl?: string;
  poll?: { question: string; options: string[] } | null;
  listingId?: number;
  audience?: "public" | "connections";
  location?: string;
  hashtags?: string[];
  commentsDisabled?: boolean;
  scheduledAt?: string | null;
}

export const postsApi = {
  feed: (query?: FeedFilters) => http.get<Paginated<Post>>(EP.posts.feed, query),
  create: (p: CreatePostPayload) => http.post<Post>(EP.posts.create, p),
  byId: (id: number) => http.get<Post>(EP.posts.byId(id)),
  delete: (id: number) => http.del<void>(EP.posts.delete(id)),
  byAuthor: (username: string, query?: FeedFilters) => http.get<Paginated<Post>>(EP.posts.byAuthor(username), query),
  like: (id: number, reaction?: string) => http.post<{ liked: boolean; likeCount: number; reaction: string | null }>(EP.posts.like(id), { reaction }),
  votePoll: (id: number, optionId: number) => http.post<{ poll: Post["poll"] }>(EP.posts.vote(id), { optionId }).then((r) => r.poll),
  comments: (postId: number) => http.get<Comment[]>(EP.posts.comments(postId)),
  addComment: (postId: number, text: string) => http.post<Comment>(EP.posts.comments(postId), { text }),
  deleteComment: (id: number) => http.del<void>(EP.posts.comment(id)),
  share: (id: number, note?: string) => http.post<{ shareCount: number }>(EP.posts.share(id), { note }),
  save: (id: number, collection?: string) => http.post<{ saved: boolean }>(EP.posts.save(id), { collection }),
  uploadMedia: (files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    return http.upload<{ urls: { url: string; type: "image" | "video" | "document"; name: string }[] }>(EP.posts.uploadMedia, form);
  },
};

/* --------------------------------------------------------------------------
 * Legacy platform rows
 *
 * The admin console wants whole tables in one call, and only the backend's
 * original platform router answers that — with raw snake_case rows and fewer
 * filters than the SPA contract. These helpers translate between the two.
 * What the server cannot filter on is filtered over the fetched window here,
 * so `total` describes that window rather than the whole table.
 * ------------------------------------------------------------------------ */

type Row = Record<string, unknown>;

const asNum = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const asText = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const asBool = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";
const LEGACY_WINDOW = 100;

/** Set from AuthContext so ownership and "from me" can be resolved client-side.
 *  Persisted because deep links run data calls before the session lookup returns. */
const SELF_KEY = "professionalist:selfId";
let selfId = Number(localStorage.getItem(SELF_KEY)) || 0;
export function setSelfId(value: number | null) {
  selfId = value ?? 0;
  try {
    if (selfId) localStorage.setItem(SELF_KEY, String(selfId));
    else localStorage.removeItem(SELF_KEY);
  } catch {
    /* storage unavailable */
  }
}

const LISTING_KINDS = ["fixed", "hourly", "starting_at", "negotiable", "free"] as const;
const CONDITIONS = ["new", "like_new", "used", "n/a"] as const;
const AVAILABILITY = ["available", "limited", "sold_out"] as const;
const LISTING_STATUS = ["active", "paused", "sold", "removed"] as const;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = asText(value);
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function page<T>(items: T[], page = 1, pageSize = 12): Paginated<T> {
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return { items: slice, total: items.length, page, pageSize, hasMore: start + slice.length < items.length };
}

function toListing(row: Row): Listing {
  const kind = asText(row.listing_type) === "service" ? "service" : "product";
  const images = (Array.isArray(row.images) ? row.images : []).map(asText).filter(Boolean);
  if (!images.length && row.media_url) images.push(asText(row.media_url));
  const categoryName = asText(row.category);

  return {
    id: asNum(row.id),
    kind,
    category: categoryName
      ? { id: asNum(row.category_id), slug: slugify(categoryName), name: categoryName, icon: "Package", count: 0 }
      : null,
    title: asText(row.title),
    description: asText(row.description),
    price: Number(row.price) || 0,
    priceType: pick(row.price_type, LISTING_KINDS, kind === "service" ? "hourly" : "fixed"),
    currency: asText(row.currency) || "USD",
    condition: pick(row.condition, CONDITIONS, kind === "service" ? "n/a" : "new"),
    availability: pick(row.availability, AVAILABILITY, "available"),
    location: asText(row.location),
    images,
    tags: (Array.isArray(row.tags) ? row.tags : []).map(asText).filter(Boolean),
    views: Number(row.views) || 0,
    favoriteCount: Number(row.favorite_count) || 0,
    favorited: false,
    status: pick(row.status === "closed" || row.status === "archived" ? "removed" : row.status, LISTING_STATUS, "active"),
    seller: {
      userId: asNum(row.seller_id),
      name: asText(row.seller_name) || asText(row.seller_username),
      avatarUrl: asText(row.seller_avatar),
      verified: false,
      rating: 0,
      reviews: 0,
      responseTime: "",
      memberSince: "",
    },
    details: [],
    createdAt: asText(row.created_at),
  };
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The admin console reads whole tables at once, so it keeps the legacy
 *  platform route that answers with raw snake_case rows. */
async function legacyListings(query: Record<string, string | number | undefined> = {}) {
  const res = await http.get<{ listings: Row[] }>(EP.marketplace.legacyListings, { limit: LEGACY_WINDOW, ...query });
  return res.listings ?? [];
}

export const marketplaceApi = {
  home: () =>
    http.get<{
      categories: Category[];
      featured: Listing[];
      recommended: Listing[];
      nearby: Listing[];
      new: Listing[];
      popular: Listing[];
    }>(EP.marketplace.home),
  listings: (query?: MarketplaceFilters) => http.get<Paginated<Listing>>(EP.marketplace.listings, query),
  listing: (id: number) => http.get<Listing>(EP.marketplace.listing(id)),
  createListing: (p: Partial<Listing> & { title: string; categoryId: number; kind: Listing["kind"] }) =>
    http.post<Listing>(EP.marketplace.createListing, p),
  updateListing: (id: number, p: Partial<Listing>) => http.patch<Listing>(EP.marketplace.updateListing(id), p),
  deleteListing: (id: number) => http.del<void>(EP.marketplace.deleteListing(id)),
  myListings: () => http.get<Listing[]>(EP.marketplace.myListings),
  categories: () => http.get<Category[]>(EP.marketplace.categories),
  favorite: (id: number) => http.post<{ favorited: boolean; favoriteCount: number }>(EP.marketplace.favorite(id), {}),
  uploadImages: async (files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    return http.upload<{ urls: string[] }>(EP.marketplace.uploadImages, form);
  },
  related: (id: number) => http.get<Listing[]>(EP.marketplace.related(id)),
};

async function legacyCompanies(search?: string) {
  const res = await http.get<{ companies: Row[] }>(EP.businesses.legacyCompanies, { search, limit: LEGACY_WINDOW });
  return res.companies ?? [];
}

export const businessesApi = {
  bySlug: (slug: string) =>
    http.get<{ business: Business; posts: Post[]; products: Listing[]; services: Listing[]; reviews: Review[] }>(
      EP.businesses.bySlug(slug)
    ),
  create: (p: Partial<Business> & { name: string }) => http.post<Business>(EP.businesses.create, p),
  update: (id: number, p: Partial<Business>) => http.patch<Business>(EP.businesses.update(id), p),
  manage: () => http.get<Business[]>(EP.businesses.manage),
  analytics: (id: number) =>
    http.get<{
      visitors: number;
      followers: number;
      engagement: number;
      revenue: number;
      trend: number[];
      topListings: { title: string; views: number }[];
    }>(EP.businesses.analytics(id)),
  employees: (id: number) => http.get<BusinessTeamMember[]>(EP.businesses.employees(id)),
  reviews: (id: number) => http.get<Review[]>(EP.businesses.reviews(id)),
  addReview: (id: number, rating: number, text: string) => http.post<Review>(EP.businesses.reviews(id), { rating, text }),
};

function splitName(value: string): { firstName: string; lastName: string } {
  const parts = value.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

function asPerson(row: Row): Person {
  const name = asText(row.name) || asText(row.username);
  const { firstName, lastName } = splitName(name);
  return {
    id: asNum(row.id),
    username: asText(row.username),
    firstName,
    lastName,
    title: asText(row.title) || asText(row.job_title) || asText(row.headline),
    company: asText(row.company) || asText(row.company_name),
    location: asText(row.location),
    avatarUrl: asText(row.avatar_url) || asText(row.avatarUrl),
    verified: asBool(row.verified),
    category: asText(row.category),
    skills: [],
    mutualConnections: 0,
    connectionStatus: "none",
    following: false,
  };
}



export const messagingApi = {
  conversations: (q?: string) => http.get<Conversation[]>(EP.messaging.conversations, { q }),
  start: (userId: number, firstMessage?: string) =>
    http.post<Conversation>(EP.messaging.start, { userId, firstMessage }),
  messages: (conversationId: ConversationId, before?: number) =>
    http.get<{ items: Message[]; hasMore: boolean }>(EP.messaging.conversation(conversationId), { before, pageSize: 30 }),
  send: (
    conversationId: ConversationId,
    p: { text?: string; mediaUrl?: string; attachmentName?: string; sharedListingId?: number; sharedProfileUserId?: number }
  ) => http.post<Message>(EP.messaging.send(conversationId), p),
  react: (messageId: number, reaction: string) =>
    http.post<{ reaction: string }>(EP.messaging.react(messageId), { reaction }),
  delete: (messageId: number) => http.del<void>(EP.messaging.message(messageId)),
  markRead: async (conversationId: ConversationId) => {
    await http.post(EP.messaging.markRead(conversationId), {});
  },
  search: (q?: string) =>
    http.get<{ messages: (Message & { conversation: Conversation })[] }>(EP.messaging.search, { q }),
  upload: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.upload<{ url: string; name: string; type: "image" | "document" }>(EP.messaging.upload, form);
  },
};

export const notificationsApi = {
  list: (query?: { category?: string; page?: number; pageSize?: number }) => http.get<Paginated<AppNotification>>(EP.notifications.list, query),
  unreadCount: () => http.get<{ count: number }>(EP.notifications.unreadCount),
  markRead: (id: number) => http.patch<void>(EP.notifications.markRead(id), {}),
  markAllRead: () => http.post<void>(EP.notifications.markAllRead, {}),
};

export const tasksApi = {
  list: (query?: { view?: "today" | "upcoming" | "completed" | "overdue" | "all" }) => http.get<Task[]>(EP.tasks.list, query),
  create: (p: Partial<Task> & { title: string }) => http.post<Task>(EP.tasks.create, p),
  update: (id: number, p: Partial<Task>) => http.patch<Task>(EP.tasks.update(id), p),
  delete: (id: number) => http.del<void>(EP.tasks.delete(id)),
  toggle: (id: number) => http.post<{ status: Task["status"]; completedAt: string | null }>(EP.tasks.toggle(id), {}),
};

export const opportunitiesApi = {
  list: (query?: { kind?: string; q?: string; location?: string; remote?: boolean; page?: number; pageSize?: number }) =>
    http.get<Paginated<Opportunity>>(EP.opportunities.list, query),
  apply: (id: number) => http.post<{ applied: boolean }>(EP.opportunities.apply(id), {}),
};

export const savedApi = {
  list: (query?: { type?: string; collection?: string }) =>
    http.get<{ items: SavedItem[]; collections: string[] }>(EP.saved.list, query),
  remove: (id: number) => http.del<void>(EP.saved.remove(id)),
};

export const adsApi = {
  campaigns: () => http.get<Campaign[]>(EP.advertising.campaigns),
  create: (p: Partial<Campaign> & { name: string }) => http.post<Campaign>(EP.advertising.create, p),
  update: (id: number, p: Partial<Campaign>) => http.patch<Campaign>(EP.advertising.campaign(id), p),
};

export const aiApi = {
  conversations: () => http.get<AiConversation[]>(EP.ai.conversations),
  conversation: (id: number) => http.get<AiConversation>(EP.ai.conversation(id)),
  send: (conversationId: number | null, text: string) =>
    http.post<{ conversationId: number; reply: AiConversation["messages"][number] }>(EP.ai.send, { conversationId, text }),
  suggestions: () => http.get<{ prompts: string[] }>(EP.ai.suggestions),
  deleteConversation: (id: number) => http.del<void>(EP.ai.conversation(id)),
};

export const supportApi = {
  tickets: () => http.get<SupportTicket[]>(EP.support.tickets),
  create: (p: { subject: string; category: string; text: string; attachmentUrl?: string }) => http.post<SupportTicket>(EP.support.tickets, p),
  reply: (id: number, text: string, attachmentUrl?: string) => http.post<SupportTicket>(EP.support.reply(id), { text, attachmentUrl }),
  availability: () => http.get<{ online: boolean; hours: string; avgResponse: string; agents: { name: string; avatarUrl: string; role: string }[] }>(
    EP.support.availability
  ),
};

export const searchApi = {
  global: (query: string, tab?: string) => http.get<SearchResults>(EP.search.global, { q: query, tab }),
  suggestions: (q: string) =>
    http.get<{ people: Person[]; businesses: Business[]; hashtags: string[]; recent: string[] }>(EP.search.suggestions, { q }),
  clearRecent: () => http.del<void>(EP.search.recent),
};

/* Preferences, the account fields, active sessions, the login log and password
 * changes all live on the backend's settings route now; ThemeContext keeps its
 * own copy of the theme in local storage and applies it. */
export const settingsApi = {
  get: () => http.get<SettingsData>(EP.settings.root),
  update: (patch: Partial<SettingsData>) => http.patch<SettingsData>(EP.settings.root, patch),
  changePassword: (current: string, next: string) => http.post<void>(EP.settings.password, { current, next }),
  revokeSession: (id: string) => http.del<void>(EP.settings.session(id)),
};

/* The admin console reads the whole table, so it goes through the legacy list
 * routes: /api/posts, /api/marketplace and /api/companies. Messages, reports,
 * transactions and ads have no list route at all, so those tiles stay at zero
 * rather than showing invented numbers. */

function mediaKind(url: string): MediaItem["type"] {
  return /\.(mp4|mov|webm|m4v|avi)(\?|$)/i.test(url) ? "video" : "image";
}

const POST_KINDS = ["post", "job", "product", "service", "article"] as const;

function toLegacyPost(row: Row): Post {
  const url = asText(row.media_url);
  const text = asText(row.content);
  return {
    id: asNum(row.id),
    author: asPerson({ ...row, id: asNum(row.user_id) }),
    authorType: "user",
    kind: pick(row.post_type, POST_KINDS, "post"),
    text,
    media: url ? [{ url, type: mediaKind(url), name: url.split("/").pop() ?? url }] : [],
    linkUrl: "",
    linkTitle: "",
    poll: null,
    hashtags: text.match(/#[\p{L}\d_]+/gu)?.map((t) => t.slice(1)) ?? [],
    location: asText(row.location),
    audience: asText(row.visibility) === "public" || !row.visibility ? "public" : "connections",
    commentsDisabled: false,
    scheduledAt: null,
    likeCount: Number(row.likes_count) || 0,
    commentCount: Number(row.comments_count) || 0,
    shareCount: Number(row.shares_count) || 0,
    liked: asBool(row.liked),
    likedReaction: null,
    saved: asBool(row.saved),
    createdAt: asText(row.created_at),
  };
}

/** Trailing n calendar months, oldest first, as "YYYY-MM". */
function recentMonths(n: number): string[] {
  const out: string[] = [];
  const cursor = new Date();
  cursor.setDate(1);
  for (let i = 0; i < n; i++) {
    out.unshift(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return out;
}

function monthOf(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function sameDay(value: string): boolean {
  const d = new Date(value);
  const now = new Date();
  return !Number.isNaN(d.getTime()) && d.toDateString() === now.toDateString();
}

async function legacyPosts(query?: { q?: string }): Promise<Post[]> {
  const res = await http.get<{ posts: Row[] }>(EP.posts.all, { limit: LEGACY_WINDOW });
  const needle = (query?.q ?? "").toLowerCase();
  return (res.posts ?? [])
    .map(toLegacyPost)
    .filter((p) => !needle || `${p.text} ${"username" in p.author ? p.author.username : p.author.name}`.toLowerCase().includes(needle));
}

export const adminApi = {
  stats: async (): Promise<AdminStats> => {
    const [usersRes, companies, listings, posts] = await Promise.all([
      http.get<{ users: Row[] }>(EP.admin.users),
      legacyCompanies(),
      legacyListings(),
      legacyPosts(),
    ]);
    const users = usersRes.users ?? [];
    const months = recentMonths(12);
    const signups = months.map((m) => users.filter((u) => monthOf(asText(u.created_at)) === m).length);
    const counted = new Map<string, number>();
    listings.map(toListing).forEach((l) => {
      const name = l.category?.name;
      if (name) counted.set(name, (counted.get(name) ?? 0) + 1);
    });

    return {
      totals: {
        users: users.length,
        activeUsers: users.filter((u) => asText(u.status) === "active").length,
        businesses: companies.length,
        products: listings.length,
        posts: posts.length,
        messages: 0,
        reports: 0,
        revenue: 0,
      },
      userTrend: signups,
      revenueTrend: months.map(() => 0),
      signupsToday: users.filter((u) => sameDay(asText(u.created_at))).length,
      topCategories: [...counted.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, count]) => ({ name, count })),
    };
  },
  users: async (query?: { q?: string; page?: number; pageSize?: number }) => {
    const res = await http.get<{ users: Row[] }>(EP.admin.users);
    const needle = (query?.q ?? "").toLowerCase();
    const rows: AdminUserRow[] = res.users
      .filter(u => !needle || [u.name, u.email, u.username].some(v => asText(v).toLowerCase().includes(needle)))
      .map(u => ({
        id: asNum(u.id),
        name: asText(u.name) || asText(u.username),
        email: asText(u.email),
        username: asText(u.username),
        role: asText(u.role),
        verified: asBool(u.verified),
        verifiedColor: asText(u.verified_badge),
        suspended: asText(u.status) !== "active",
        joinedAt: asText(u.created_at),
        posts: 0,
      }));
    return page(rows, query?.page ?? 1, query?.pageSize ?? 10);
  },
  userAction: async (
    id: number,
    action: "suspend" | "unsuspend" | "verify" | "unverify" | "delete",
    badge?: string
  ) => {
    await http.post(EP.admin.userAction(id), badge ? { action, badge } : { action });
    return { ok: true as const };
  },
  businesses: (query?: { q?: string }) =>
    http.get<AdminBusinessRow[]>(EP.admin.businesses, query?.q ? { q: query.q } : undefined),
  verifyBusiness: async (id: number, verified: boolean) => {
    await http.post<{ ok: true }>(EP.admin.verifyBusiness(id), { verified });
    return { ok: true as const };
  },
  listings: async (query?: { q?: string }) => {
    const rows = (await legacyListings()).map(toListing);
    const needle = (query?.q ?? "").toLowerCase();
    return needle ? rows.filter((l) => `${l.title} ${l.seller.name} ${l.category?.name ?? ""}`.toLowerCase().includes(needle)) : rows;
  },
  posts: async (query?: { q?: string }) => legacyPosts(query),
  reports: (query?: { status?: string }) => http.get<AdminReportRow[]>(EP.admin.reports, query),
  reportAction: (id: number, action: "resolve" | "dismiss" | "review") => http.post<{ ok: true }>(EP.admin.reportAction(id), { action }),
  transactions: () => http.get<AdminTransactionRow[]>(EP.admin.transactions),
  tickets: () => http.get<SupportTicket[]>(EP.admin.tickets),
  ads: () => http.get<Campaign[]>(EP.admin.ads),
};

export const metaApi = {
  countries: () => http.get<string[]>(EP.misc.countries),
  professionalCategories: () => http.get<string[]>(EP.misc.professionalCategories),
  trends: () => http.get<{ tag: string; posts: number }[]>(EP.misc.trends),
};
