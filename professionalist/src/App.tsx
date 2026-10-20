import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { AppShell } from "@/components/shell/AppShell";
import { ErrorState, Skeleton } from "@/components/ui";
import { networkApi, safetyApi } from "@/services/api";
import { tokenStore } from "@/services/http";
import { configureVideoApp } from "@/services/videoApp";

const LandingPage = lazy(() => import("@/pages/LandingPage"));
const VideosPage = lazy(() => import("@/pages/VideosPage"));
const CreateVideoPage = lazy(() => import("@/pages/CreateVideoPage"));
const VideoInterestsPage = lazy(() => import("@/pages/VideoInterestsPage"));
const VideoAdminPanel = lazy(() =>
  import("@/components/video/VideoAdminPanel").then((m) => ({ default: m.VideoAdminPanel })),
);
const LoginPage = lazy(() => import("@/pages/auth/LoginPage"));
const RegisterPage = lazy(() => import("@/pages/auth/RegisterPage"));
const ForgotPasswordPage = lazy(() => import("@/pages/auth/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("@/pages/auth/ResetPasswordPage"));
const VerifyEmailPage = lazy(() => import("@/pages/auth/VerifyEmailPage"));
const RecoverAccountPage = lazy(() => import("@/pages/auth/RecoverAccountPage"));
const OnboardingPage = lazy(() => import("@/pages/OnboardingPage"));
const HomePage = lazy(() => import("@/pages/HomePage"));
const NetworkPage = lazy(() => import("@/pages/NetworkPage"));
const DiscoverPage = lazy(() => import("@/pages/DiscoverPage"));
const MarketplacePage = lazy(() => import("@/pages/MarketplacePage"));
const ListingPage = lazy(() => import("@/pages/ListingPage"));
const CreateListingPage = lazy(() => import("@/pages/CreateListingPage"));
const ProfilePage = lazy(() => import("@/pages/ProfilePage"));
const EditProfilePage = lazy(() => import("@/pages/EditProfilePage"));
const BusinessPage = lazy(() => import("@/pages/BusinessPage"));
const MessagesPage = lazy(() => import("@/pages/MessagesPage"));
const NotificationsPage = lazy(() => import("@/pages/NotificationsPage"));
const ProgressPage = lazy(() => import("@/pages/ProgressPage"));
const TasksPage = lazy(() => import("@/pages/TasksPage"));
const OpportunitiesPage = lazy(() => import("@/pages/OpportunitiesPage"));
const SavedPage = lazy(() => import("@/pages/SavedPage"));
const AdvertisingPage = lazy(() => import("@/pages/AdvertisingPage"));
const AssistantPage = lazy(() => import("@/pages/AssistantPage"));
const SupportPage = lazy(() => import("@/pages/SupportPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const SearchPage = lazy(() => import("@/pages/SearchPage"));
const AdminPage = lazy(() => import("@/pages/AdminPage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));

function PageFallback() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pt-20">
      <Skeleton className="h-10 w-1/3" />
      <Skeleton className="h-64 rounded-2xl" />
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

function ConnectivityNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-md px-4 pt-24">
      <div className="card">
        <ErrorState message={message} onRetry={onRetry} />
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, booting, bootError, retryBoot } = useAuth();
  const location = useLocation();
  if (booting) return <PageFallback />;
  if (!user) {
    // A signed-in user whose token is still valid shouldn't be dumped at the login screen because the API blipped.
    if (bootError) return <ConnectivityNotice message={bootError} onRetry={() => void retryBoot()} />;
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, booting, bootError, retryBoot } = useAuth();
  const { pathname } = useLocation();
  if (booting) return <PageFallback />;
  if (!user) {
    if (bootError) return <ConnectivityNotice message={bootError} onRetry={() => void retryBoot()} />;
    return <Navigate to="/login" replace state={{ from: pathname }} />;
  }
  if (user.role !== "admin") return <Navigate to="/home" replace />;
  return <>{children}</>;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [pathname]);
  return null;
}

/** Injects the real session/shell into the video subtree's app bridge (services/videoApp.ts). */
function VideoAppBridgeInstaller() {
  const { user } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    configureVideoApp({
      getSession: () => ({
        userId: user?.id ?? null,
        displayName: user ? `${user.firstName} ${user.lastName}`.trim() || user.username : null,
        isAuthenticated: user !== null,
        hasToken: tokenStore.access !== null,
      }),
      requireLogin: (returnTo) =>
        navigate(`/login?next=${encodeURIComponent(returnTo || "/videos")}`, { replace: true }),
      toggleFollow: async (userId, follow) =>
        follow ? await networkApi.follow({ userId }) : await networkApi.unfollow({ userId }),
      /* the platform's real block write; the video page follows up with a server mute so the
         menu state and the feeds agree.  reportVideo stays unwired: no user-facing reports
         endpoint exists on either stack, and the stub's error toast says exactly that. */
      blockUser: async (userId) => {
        await safetyApi.block(userId);
      },
    });
  }, [user, navigate]);
  return null;
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <ScrollToTop />
      <VideoAppBridgeInstaller />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/recover-account" element={<RecoverAccountPage />} />

        <Route
          path="/onboarding"
          element={
            <RequireAuth>
              <OnboardingPage />
            </RequireAuth>
          }
        />

        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/home" element={<HomePage />} />
          <Route path="/network" element={<NetworkPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/marketplace" element={<MarketplacePage />} />
          <Route path="/marketplace/:id" element={<ListingPage />} />
          <Route path="/create-listing" element={<CreateListingPage />} />
          <Route path="/profile/:username" element={<ProfilePage />} />
          <Route path="/profile/edit" element={<EditProfilePage />} />
          <Route path="/business/:slug" element={<BusinessPage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/messages/:id" element={<MessagesPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/opportunities" element={<OpportunitiesPage />} />
          <Route path="/saved" element={<SavedPage />} />
          <Route path="/advertising" element={<AdvertisingPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/videos" element={<VideosPage />} />
          <Route path="/videos/create" element={<CreateVideoPage />} />
          <Route path="/videos/interests" element={<VideoInterestsPage />} />
        </Route>

        <Route
          path="/videos/admin"
          element={
            <RequireAdmin>
              <VideoAdminPanel />
            </RequireAdmin>
          }
        />

        <Route
          path="/admin/*"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
