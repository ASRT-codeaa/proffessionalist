/**
 * THE endpoint map — the complete HTTP contract with the Professionalist VPS
 * backend lives here and nowhere else. When the backend's routes differ,
 * adjust them in this one file; pages and components never reference paths.
 */
import type { ConversationId } from "./types";

export const EP = {
  auth: {
    register: "/api/auth/register",
    login: "/api/auth/login",
    logout: "/api/auth/logout",
    refresh: "/api/auth/refresh",
    me: "/api/auth/me",
    forgotPassword: "/api/auth/forgot-password",
    resetPassword: "/api/auth/reset-password",
    verifyEmail: "/api/auth/verify-email",
    resendVerification: "/api/auth/resend-verification",
    recoverAccount: "/api/auth/recover-account",
  },
  onboarding: {
    save: "/api/onboarding",
    uploadAvatar: "/api/onboarding/avatar",
  },
  users: {
    byUsername: (username: string) => `/api/users/${encodeURIComponent(username)}`,
    updateProfile: "/api/users/me/profile",
    uploadAvatar: "/api/users/me/avatar",
    uploadCover: "/api/users/me/cover",
    progress: "/api/users/me/progress",
    goals: "/api/users/me/goals",
    goal: (id: number) => `/api/users/me/goals/${id}`,
  },
  network: {
    overview: "/api/network/overview",
    connections: "/api/network/connections",
    requests: "/api/network/requests",
    request: (id: number) => `/api/network/requests/${id}`,
    respond: (id: number) => `/api/network/requests/${id}/respond`,
    suggestions: "/api/network/suggestions",
    connect: "/api/network/connect",
    removeConnection: (id: number) => `/api/network/connections/${id}`,
    following: "/api/network/following",
    followers: "/api/network/followers",
    follow: "/api/network/follow",
    unfollow: "/api/network/unfollow",
  },
  safety: {
    mutes: "/api/mutes",
    mute: (id: number) => `/api/mutes/${id}`,
    /* GET is the Worker's safety read; POST/DELETE are platform.js's long-standing writes */
    blocks: "/api/blocks",
    block: (id: number) => `/api/blocks/${id}`,
  },
  posts: {
    feed: "/api/posts/feed",
    /* The legacy platform route lists every visible post as raw snake_case rows;
       the admin console uses it because the SPA feed route is user-scoped. */
    all: "/api/posts",
    create: "/api/posts",
    byId: (id: number) => `/api/posts/${id}`,
    update: (id: number) => `/api/posts/${id}`,
    delete: (id: number) => `/api/posts/${id}`,
    byAuthor: (username: string) => `/api/posts/author/${encodeURIComponent(username)}`,
    like: (id: number) => `/api/posts/${id}/like`,
    vote: (id: number) => `/api/posts/${id}/poll`,
    comments: (id: number) => `/api/posts/${id}/comments`,
    comment: (id: number) => `/api/posts/comments/${id}`,
    share: (id: number) => `/api/posts/${id}/share`,
    save: (id: number) => `/api/posts/${id}/save`,
    uploadMedia: "/api/posts/media",
  },
  /* Marketplace, businesses and opportunities are served by the SPA routers,
     whose rows are already the camelCase shapes the pages read. */
  marketplace: {
    home: "/api/marketplace/home",
    listings: "/api/marketplace/listings",
    listing: (id: number) => `/api/marketplace/listings/${id}`,
    createListing: "/api/marketplace/listings",
    updateListing: (id: number) => `/api/marketplace/listings/${id}`,
    deleteListing: (id: number) => `/api/marketplace/listings/${id}`,
    myListings: "/api/marketplace/my-listings",
    categories: "/api/marketplace/categories",
    /* The admin console wants every row in one call, which only the legacy
       platform list route answers, and it maps the snake_case rows itself. */
    legacyListings: "/api/marketplace",
    favorite: (id: number) => `/api/marketplace/listings/${id}/favorite`,
    related: (id: number) => `/api/marketplace/listings/${id}/related`,
    uploadImages: "/api/marketplace/images",
  },
  businesses: {
    bySlug: (slug: string) => `/api/businesses/${encodeURIComponent(slug)}`,
    create: "/api/businesses",
    update: (id: number) => `/api/businesses/${id}`,
    manage: "/api/businesses/manage",
    /* The admin console wants the whole company table, which only the legacy
       platform route gives, and it maps those snake_case rows itself. */
    legacyCompanies: "/api/companies",
    analytics: (id: number) => `/api/businesses/${id}/analytics`,
    employees: (id: number) => `/api/businesses/${id}/employees`,
    reviews: (id: number) => `/api/businesses/${id}/reviews`,
  },
  /* Conversations are keyed by UUID and messages by BIGINT; reactions, search
     and unread counts live on these routes. */
  messaging: {
    conversations: "/api/messages/conversations",
    conversation: (id: ConversationId) => `/api/messages/conversations/${encodeURIComponent(String(id))}`,
    start: "/api/messages/conversations",
    send: (id: ConversationId) => `/api/messages/conversations/${encodeURIComponent(String(id))}/messages`,
    markRead: (id: ConversationId) => `/api/messages/conversations/${encodeURIComponent(String(id))}/read`,
    message: (id: number) => `/api/messages/messages/${id}`,
    react: (id: number) => `/api/messages/messages/${id}/reaction`,
    search: "/api/messages/search",
    upload: "/api/messages/upload",
  },
  notifications: {
    list: "/api/notifications",
    unreadCount: "/api/notifications/unread-count",
    markRead: (id: number) => `/api/notifications/${id}/read`,
    markAllRead: "/api/notifications/read-all",
  },
  tasks: {
    list: "/api/tasks",
    create: "/api/tasks",
    update: (id: number) => `/api/tasks/${id}`,
    delete: (id: number) => `/api/tasks/${id}`,
    toggle: (id: number) => `/api/tasks/${id}/toggle`,
  },
  settings: {
    root: "/api/settings",
    password: "/api/settings/password",
    session: (id: string) => `/api/settings/sessions/${encodeURIComponent(id)}`,
  },
  opportunities: {
    list: "/api/opportunities",
    apply: (id: number) => `/api/opportunities/${id}/apply`,
  },
  saved: {
    list: "/api/saved",
    remove: (id: number) => `/api/saved/${id}`,
  },
  advertising: {
    campaigns: "/api/ads/campaigns",
    campaign: (id: number) => `/api/ads/campaigns/${id}`,
    create: "/api/ads/campaigns",
    update: (id: number) => `/api/ads/campaigns/${id}`,
  },
  ai: {
    conversations: "/api/ai/conversations",
    conversation: (id: number) => `/api/ai/conversations/${id}`,
    send: "/api/ai/messages",
    suggestions: "/api/ai/suggestions",
  },
  support: {
    tickets: "/api/support/tickets",
    ticket: (id: number) => `/api/support/tickets/${id}`,
    reply: (id: number) => `/api/support/tickets/${id}/reply`,
    availability: "/api/support/availability",
  },
  search: {
    global: "/api/search",
    suggestions: "/api/search/suggestions",
    recent: "/api/search/recent",
  },
  /* Only the user list and its status patch exist on the deployed admin router;
     the dashboard tiles are composed from the public list routes in api.ts. */
  admin: {
    users: "/api/admin/users",
    /* Posts the verb the console offers (suspend, verify, delete…) plus an
       optional badge colour, so verification and role changes share one route. */
    userAction: (id: number) => `/api/admin/users/${id}/action`,
    businesses: "/api/admin/businesses",
    verifyBusiness: (id: number) => `/api/admin/businesses/${id}/verify`,
    reports: "/api/admin/reports",
    reportAction: (id: number) => `/api/admin/reports/${id}/action`,
    transactions: "/api/admin/transactions",
    tickets: "/api/admin/tickets",
    ads: "/api/admin/ads",
  },
  misc: {
    countries: "/api/meta/countries",
    professionalCategories: "/api/meta/categories",
    trends: "/api/meta/trends",
  },
} as const;
