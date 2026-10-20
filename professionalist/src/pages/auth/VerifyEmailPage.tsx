import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, CircleAlert, MailCheck, MailWarning } from "lucide-react";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { Button, Card, Input, Skeleton } from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { authApi } from "@/services/api";
import { ApiError } from "@/services/http";
import { errorMessage } from "@/hooks/useAsync";

type Phase = "verifying" | "verified" | "invalid";

export default function VerifyEmailPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [phase, setPhase] = useState<Phase>(token ? "verifying" : "invalid");
  const [detail, setDetail] = useState("");
  const [resendEmail, setResendEmail] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendError, setResendError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const attempted = useRef(false);

  useEffect(() => {
    document.title = "Verify your email — Professionalist";
  }, []);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;
    authApi
      .verifyEmail(token)
      .then(() => {
        setPhase("verified");
        toast.success("Email verified", "Your profile is now discoverable.");
      })
      .catch((err: unknown) => {
        setDetail(errorMessage(err));
        setPhase("invalid");
        toast.error("Couldn't verify that link", errorMessage(err));
      });
    // Guarded by `attempted` so the call happens exactly once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const resend = async (e: React.FormEvent) => {
    e.preventDefault();
    setResendBusy(true);
    setResendError("");
    setFieldErrors({});
    try {
      await authApi.resendVerification(resendEmail.trim());
      setResendSent(true);
      toast.success("New link sent", `Check ${resendEmail.trim()} for a fresh verification link.`);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setResendError(errorMessage(err));
    } finally {
      setResendBusy(false);
    }
  };

  if (phase === "verifying") {
    return (
      <AuthLayout title="Verifying your email" subtitle="One moment while we confirm this address belongs to you.">
        <Card className="p-6 text-center anim-fade-up" role="status" aria-live="polite">
          <span className="relative mx-auto flex h-16 w-16 items-center justify-center">
            <span className="absolute inset-0 rounded-2xl bg-accent-soft animate-ping [animation-duration:2.2s]" aria-hidden />
            <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MailCheck size={28} aria-hidden />
            </span>
          </span>
          <h2 className="mt-5 text-base font-bold">Checking your verification code</h2>
          <p className="mx-auto mt-1.5 max-w-xs text-sm text-ink-soft">
            This happens instantly. Please stay on this page.
          </p>
          <div className="mx-auto mt-6 max-w-xs space-y-2 text-left">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </Card>
      </AuthLayout>
    );
  }

  if (phase === "verified") {
    return (
      <AuthLayout
        title="Email verified"
        subtitle="Thanks for confirming — this address is now attached to your Professionalist profile."
        footer={
          <>
            Wrong account?{" "}
            <Link to="/register" className="font-semibold text-accent hover:underline">
              Create a profile with the right email
            </Link>
          </>
        }
      >
        <div className="space-y-4 anim-fade-up">
          <Card className="p-6 text-center" role="status">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-success-soft text-success">
              <MailCheck size={28} aria-hidden />
            </span>
            <h2 className="mt-4 text-base font-bold">You're all set</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-ink-soft">
              Verified profiles rank higher in search, get more connection requests and can list in the marketplace.
            </p>
          </Card>
          <Button size="lg" fullWidth onClick={() => navigate("/login")}>
            Continue to sign in <ArrowRight size={16} />
          </Button>
          <div className="flex justify-center gap-4 text-sm text-ink-soft">
            <Link to="/onboarding" className="font-semibold text-accent hover:underline">
              Finish setup
            </Link>
            <Link to="/" className="font-semibold text-accent hover:underline">
              Back to home
            </Link>
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="We couldn't verify that link"
      subtitle="Verification codes expire after the first use. The good news is a new one takes seconds."
      footer={
        <>
          Already verified?{" "}
          <Link to="/login" className="font-semibold text-accent hover:underline">
            Go straight to sign in
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        <Card className="border-danger/40 bg-danger-soft p-4" role="alert">
          <div className="flex gap-3">
            <CircleAlert size={20} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-danger">Invalid or expired code</h2>
              <p className="mt-1 text-sm text-ink-soft">
                {detail || "This verification link is no longer valid. Request a fresh one below."}
              </p>
            </div>
          </div>
        </Card>

        {resendSent ? (
          <Card className="p-5 text-center anim-fade-up" role="status">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-success-soft text-success">
              <MailCheck size={24} aria-hidden />
            </span>
            <h2 className="mt-3 text-base font-bold">A new link is on the way</h2>
            <p className="mt-1 break-all text-sm text-ink-soft">{resendEmail.trim()}</p>
            <p className="mx-auto mt-2 max-w-xs text-sm text-ink-soft">
              Open the message on this device and tap the button to finish verifying.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Button variant="outline" onClick={() => setResendSent(false)}>
                Send to another email
              </Button>
              <Button onClick={() => navigate("/login")}>
                Continue to sign in <ArrowRight size={15} />
              </Button>
            </div>
          </Card>
        ) : (
          <form onSubmit={resend} className="space-y-4" noValidate>
            <Input
              label="Account email"
              type="email"
              autoComplete="email"
              icon={<MailWarning size={15} />}
              value={resendEmail}
              onChange={(e) => setResendEmail(e.target.value)}
              error={fieldErrors.email}
              hint="We'll send a new verification link and sign you out of nothing."
              placeholder="you@company.com"
              required
            />

            {resendError && (
              <Card className="border-danger/40 bg-danger-soft p-3 text-sm text-danger">{resendError}</Card>
            )}

            <Button type="submit" size="lg" fullWidth loading={resendBusy}>
              Send a new verification link
            </Button>
            <p className="text-center text-xs text-ink-faint">
              Still stuck? Our team can verify you manually from the support desk once you're signed in.
            </p>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
