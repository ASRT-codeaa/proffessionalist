/** Shared DTOs — the shape the VPS backend is expected to return. */

export interface AuthUser {
  id: number;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  role: "user" | "admin";
  verified: boolean;
  verifiedColor?: string;
  profile: Profile;
}

export interface Profile {
  userId: number;
  bio: string;
  title: string;
  company: string;
  website: string;
  phone: string;
  location: string;
  country: string;
  category: string;
  avatarUrl: string;
  coverUrl: string;
  skills: string[];
  interests: string[];
  experience: ExperienceItem[];
  education: EducationItem[];
  certifications: Certification[];
  portfolio: PortfolioItem[];
  onboardingDone: boolean;
  visibility: "public" | "connections" | "private";
}

export interface ExperienceItem {
  id: string;
  role: string;
  company: string;
  location?: string;
  start: string;
  end: string;
  description?: string;
}

export interface EducationItem {
  id: string;
  school: string;
  degree: string;
  field?: string;
  start: string;
  end: string;
}

export interface Certification {
  id: string;
  name: string;
  issuer: string;
  year: string;
}

export interface PortfolioItem {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl: string;
}

export interface Person {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  location: string;
  avatarUrl: string;
  verified: boolean;
  verifiedColor?: string;
  category: string;
  skills: string[];
  mutualConnections: number;
  connectionStatus: "none" | "pending_in" | "pending_out" | "connected";
  following: boolean;
  distance?: number;
  openTo?: string[];
}

export interface Business {
  id: number;
  slug: string;
  name: string;
  industry: string;
  category: string;
  tagline: string;
  description: string;
  website: string;
  email: string;
  phone: string;
  location: string;
  logoUrl: string;
  coverUrl: string;
  verified: boolean;
  followers: number;
  following: boolean;
  rating: number;
  reviewCount: number;
  listingCount: number;
  team: BusinessTeamMember[];
}

export interface BusinessTeamMember {
  userId: number;
  name: string;
  role: string;
  avatarUrl: string;
}

export interface MediaItem {
  url: string;
  type: "image" | "video" | "document";
  name?: string;
  size?: number;
}

export interface Poll {
  question: string;
  options: { id: number; label: string; votes: number }[];
  endsAt?: string;
  votedOption?: number | null;
}

export interface Post {
  id: number;
  author: Person | (Business & { authorType: "business" });
  authorType: "user" | "business";
  kind: "post" | "job" | "product" | "service" | "article";
  text: string;
  media: MediaItem[];
  linkUrl: string;
  linkTitle: string;
  poll: Poll | null;
  listing?: Listing;
  hashtags: string[];
  location: string;
  audience: "public" | "connections";
  commentsDisabled: boolean;
  scheduledAt: string | null;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  liked: boolean;
  likedReaction: string | null;
  saved: boolean;
  createdAt: string;
}

export interface Comment {
  id: number;
  postId: number;
  author: Person;
  text: string;
  likeCount: number;
  liked: boolean;
  createdAt: string;
}

export interface Category {
  id: number;
  slug: string;
  name: string;
  icon: string;
  count: number;
}

export interface Seller {
  userId?: number;
  businessId?: number;
  name: string;
  avatarUrl: string;
  verified: boolean;
  rating: number;
  reviews: number;
  responseTime: string;
  memberSince: string;
}

export interface Listing {
  id: number;
  kind: "product" | "service" | "job" | "business";
  category: Category | null;
  title: string;
  description: string;
  price: number;
  priceType: "fixed" | "hourly" | "starting_at" | "negotiable" | "free";
  currency: string;
  condition: "new" | "like_new" | "used" | "n/a";
  availability: "available" | "limited" | "sold_out";
  location: string;
  images: string[];
  tags: string[];
  views: number;
  favoriteCount: number;
  favorited: boolean;
  status: "active" | "paused" | "sold" | "removed";
  seller: Seller;
  details: { label: string; value: string }[];
  createdAt: string;
}

/** The backend keys conversations by UUID and messages by BIGINT. */
export type ConversationId = string | number;

export interface Conversation {
  id: ConversationId;
  subject: string;
  participant: Person;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  online: boolean;
}

export interface Message {
  id: number;
  conversationId: ConversationId;
  senderId: number;
  fromMe: boolean;
  text: string;
  mediaUrl: string;
  attachmentName: string;
  sharedListing?: Listing;
  sharedProfile?: Person;
  reaction: string;
  read: boolean;
  createdAt: string;
}

export interface AppNotification {
  id: number;
  category:
    | "connection"
    | "message"
    | "marketplace"
    | "mention"
    | "like"
    | "comment"
    | "business"
    | "task"
    | "system";
  actor: Person | null;
  text: string;
  href: string;
  read: boolean;
  createdAt: string;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  dueDate: string | null;
  priority: "low" | "medium" | "high";
  category: string;
  status: "todo" | "in_progress" | "done";
  assignee: Person | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Opportunity {
  id: number;
  title: string;
  kind: "job" | "freelance" | "partnership" | "business" | "event" | "project";
  organization: string;
  organizationLogo: string;
  location: string;
  remote: boolean;
  description: string;
  compensation: string;
  deadline: string | null;
  applied: boolean;
  createdAt: string;
}

export interface Campaign {
  id: number;
  name: string;
  objective: "awareness" | "traffic" | "engagement" | "leads" | "sales";
  audience: { industries: string[]; locations: string[]; ageRange: string; interests: string[] };
  budget: number;
  spend: number;
  startDate: string;
  endDate: string;
  format: "feed" | "marketplace" | "banner" | "sponsored_profile" | "sponsored_product";
  creativeUrl: string;
  creativeText: string;
  destination: string;
  status: "draft" | "active" | "paused" | "completed";
  metrics: {
    impressions: number;
    clicks: number;
    engagement: number;
    conversions: number;
  };
  daily: { date: string; impressions: number; clicks: number; conversions: number; spend: number }[];
}

export interface ProgressData {
  profileCompletion: number;
  profileSuggestions: string[];
  network: { growth: number; connections: number; followers: number; weeklyNew: number; trend: number[] };
  activity: { score: number; posts: number; engagement: number; trend: number[] };
  marketplace: { score: number; listings: number; sales: number; views: number; trend: number[] };
  skills: { name: string; endorsements: number }[];
  goals: { id: number; title: string; target: number; current: number; dueDate: string | null }[];
  achievements: { key: string; title: string; description: string; icon: string; earnedAt: string | null }[];
}

export interface AiConversation {
  id: number;
  title: string;
  updatedAt: string;
  messages: AiMessage[];
}

export interface AiMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface SupportTicket {
  id: number;
  subject: string;
  category: string;
  status: "open" | "pending" | "resolved";
  updatedAt: string;
  messages: { id: number; fromUser: boolean; text: string; attachmentUrl: string; createdAt: string }[];
}

export interface Review {
  id: number;
  author: Person;
  rating: number;
  text: string;
  createdAt: string;
}

export interface SavedItem {
  id: number;
  itemType: "post" | "product" | "person" | "business" | "service" | "opportunity";
  collection: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  href: string;
  savedAt: string;
}

export interface SearchResults {
  people: Person[];
  businesses: Business[];
  products: Listing[];
  posts: Post[];
  opportunities: Opportunity[];
}

export interface SettingsData {
  email: string;
  username: string;
  phone: string;
  theme: "light" | "dark" | "system";
  language: string;
  location: string;
  contentPreferences: string[];
  visibility: "public" | "connections" | "private";
  messagePermission: "everyone" | "connections";
  connectionPermission: "everyone" | "connections";
  activityVisible: boolean;
  pushNotifications: boolean;
  emailNotifications: boolean;
  notifyMessages: boolean;
  notifyMarketplace: boolean;
  notifyNetwork: boolean;
  twoFactorEnabled: boolean;
  sessions: { id: string; device: string; location: string; lastActive: string; current: boolean }[];
  loginHistory: { id: string; time: string; ip: string; device: string; success: boolean }[];
}

export interface AdminStats {
  totals: {
    users: number;
    activeUsers: number;
    businesses: number;
    products: number;
    posts: number;
    messages: number;
    reports: number;
    revenue: number;
  };
  userTrend: number[];
  revenueTrend: number[];
  signupsToday: number;
  topCategories: { name: string; count: number }[];
}

export interface AdminUserRow {
  id: number;
  name: string;
  email: string;
  username: string;
  role: string;
  verified: boolean;
  verifiedColor: string;
  suspended: boolean;
  joinedAt: string;
  posts: number;
}

export interface AdminBusinessRow {
  id: number;
  name: string;
  industry: string;
  owner: string;
  verified: boolean;
  listings: number;
  followers: number;
  createdAt: string;
}

export interface AdminReportRow {
  id: number;
  targetType: string;
  target: string;
  reporter: string;
  reason: string;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  createdAt: string;
}

export interface AdminTransactionRow {
  id: string;
  type: string;
  from: string;
  to: string;
  amount: number;
  status: "completed" | "pending" | "refunded";
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export type FeedFilters = {
  page?: number;
  pageSize?: number;
  sort?: "recent" | "popular";
  kind?: string;
  /** "following" narrows the timeline to authors the viewer follows. */
  scope?: "following" | "all";
}

export type MarketplaceFilters = {
  q?: string;
  categoryId?: number;
  kind?: string;
  minPrice?: number;
  maxPrice?: number;
  condition?: string;
  location?: string;
  sort?: "recent" | "price_asc" | "price_desc" | "popular";
  page?: number;
  pageSize?: number;
  near?: boolean;
  section?: "featured" | "recommended" | "nearby" | "new" | "popular";
}

export type ConnectionFilters = {
  industry?: string;
  profession?: string;
  location?: string;
  skill?: string;
  page?: number;
  pageSize?: number;
}
