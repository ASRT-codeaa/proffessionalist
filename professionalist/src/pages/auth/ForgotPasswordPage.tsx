import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, KeyRound, LifeBuoy, MailCheck, PencilLine } from "lucide-react";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { Button, Card, Input } from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { authApi } from "@/services/api";
import { ApiError } from "@/services/http";
import { errorMessage } from "@/hooks/useAsync";

const HELP = [
  "The email can take up to a minute to arrive — check Promotions and Spam.",
  "Reset links expire after 60 minutes and can only be used once.",
  "Lost access to the inbox itself? Use account recovery instead.",
];

export default function ForgotPasswordPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    document.title = "Forgot password — Professionalist";
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    setFieldErrors({});
    try {
      await authApi.forgotPassword(email.trim());
      setSent(true);
      toast.success("Reset link sent", `We emailed ${email.trim()} a link to choose a new password.`);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setFormError("");
    try {
      await authApi.resendVerification(email.trim());
      toast.success("We sent another email", `Look for it in ${email.trim()}.`);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout
        title="Check your inbox"
        subtitle="The reset link is on its way. Follow it to choose a new password."
        footer={
          <>
            Remembered it?{" "}
            <Link to="/login" className="font-semibold text-accent hover:underline">
              Back to sign in
            </Link>
          </>
        }
      >
        <div className="space-y-4 anim-fade-up">
          <Card className="p-6 text-center" role="status">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-success-soft text-success">
              <MailCheck size={26} aria-hidden />
            </div>
            <h2 className="mt-4 text-base font-bold">Email sent to</h2>
            <p className="mt-1 break-all text-sm font-semibold text-accent">{email.trim()}</p>
            <p className="mt-2 text-sm text-ink-soft">
              If an account exists for that address, you will get a message with a button that opens a secure
              password reset page.
            </p>
          </Card>

          <Card className="p-4">
            <p className="text-[13px] font-bold">Nothing yet?</p>
            <ul className="mt-2 space-y-1.5 text-[13px] text-ink-soft">
              {HELP.map((h) => (
                <li key={h} className="flex gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                  {h}
                </li>
              ))}
            </ul>
          </Card>

          {formError && (
            <Card className="border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
              {formError}
            </Card>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="outline" onClick={() => void resend()} loading={busy} disabled={busy}>
              <MailCheck size={15} /> Resend email
            </Button>
            <Button onClick={() => navigate("/login")}>
              Return to sign in <ArrowRight size={15} />
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-sm text-ink-soft">
            <button
              type="button"
              onClick={() => {
                setSent(false);
                setFormError("");
              }}
              className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline"
            >
              <PencilLine size={14} /> Use a different email
            </button>
            <Link to="/reset-password" className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">
              <KeyRound size={14} /> I already have a reset code
            </Link>
            <Link to="/recover-account" className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline">
              <LifeBuoy size={14} /> Recover my account
            </Link>
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="Tell us the email on your account and we will send a one-time reset link."
      footer={
        <>
          Remembered it?{" "}
          <Link to="/login" className="font-semibold text-accent hover:underline">
            Back to sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          icon={<MailCheck size={15} />}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          placeholder="you@company.com"
          hint="We'll never show this address to anyone."
          required
        />

        {formError && (
          <Card className="border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
            {formError}
          </Card>
        )}

        <Button type="submit" size="lg" fullWidth loading={busy}>
          Send reset link
        </Button>

        <div className="space-y-1.5 text-center text-sm text-ink-soft">
          <p>
            Locked out of the email itself?{" "}
            <Link to="/recover-account" className="font-semibold text-accent hover:underline">
              Recover your account
            </Link>
          </p>
          <p>
            Need a hand?{" "}
            <Link to="/login" className="font-semibold text-accent hover:underline">
              Sign in a different way
            </Link>
          </p>
        </div>
      </form>
    </AuthLayout>
  );
}
