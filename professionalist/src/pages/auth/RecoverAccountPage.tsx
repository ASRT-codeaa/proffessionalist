import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Fingerprint, LifeBuoy, MailCheck, ScanFace, ShieldCheck, UserRoundSearch } from "lucide-react";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { Button, Card, Input } from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { authApi } from "@/services/api";
import { ApiError } from "@/services/http";
import { errorMessage } from "@/hooks/useAsync";

const STEPS = [
  {
    icon: Fingerprint,
    title: "Tell us the email on the account",
    text: "We match it against the profile, username and listing history we hold for you.",
  },
  {
    icon: UserRoundSearch,
    title: "Prove ownership",
    text: "Our trust team asks for two things only you would know: recent listing titles, the phone on file or your first login country.",
  },
  {
    icon: ScanFace,
    title: "We hand the account back",
    text: "Once verified you get a one-time recovery link, pick a new password and every older session is signed out.",
  },
];

export default function RecoverAccountPage() {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    document.title = "Recover your account — Professionalist";
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    setFieldErrors({});
    try {
      const res = await authApi.recoverAccount(email.trim());
      setResultMessage(res.message);
      setSubmitted(true);
      toast.success("Recovery request received", "A trust specialist will follow up shortly.");
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={submitted ? "Recovery request received" : "Recover your account"}
      subtitle={
        submitted
          ? "We've logged your request. Here's exactly what happens next."
          : "For lost access you can't fix yourself: a changed email, a suspended sign-in or a hijacked profile."
      }
      footer={
        <>
          Just need a new password?{" "}
          <Link to="/forgot-password" className="font-semibold text-accent hover:underline">
            Use the reset link flow
          </Link>
        </>
      }
    >
      {submitted ? (
        <div className="space-y-4 anim-fade-up">
          <Card className="p-6 text-center" role="status">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-success-soft text-success">
              <ShieldCheck size={26} aria-hidden />
            </span>
            <h2 className="mt-4 text-base font-bold">We have your request for</h2>
            <p className="mt-1 break-all text-sm font-semibold text-accent">{email.trim()}</p>
            <p className="mx-auto mt-3 max-w-sm text-sm text-ink-soft">
              {resultMessage || "A trust specialist will review your account and contact you with the next step."}
            </p>
          </Card>

          <Card className="p-4">
            <ol className="space-y-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{s.title}</span>
                    <span className="block text-[13px] text-ink-soft">{s.text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>

          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="outline" onClick={() => setSubmitted(false)}>
              Send another request
            </Button>
            <Link to="/support" className="sm:order-first sm:col-span-2">
              <Button variant="soft" fullWidth>
                <LifeBuoy size={15} /> Open the support desk
              </Button>
            </Link>
          </div>

          <p className="text-center text-xs text-ink-faint">
            Keep an eye on the inbox above — recovery messages come from Professionalist only and never ask for your
            password by reply.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <Card className="p-4">
            <h2 className="text-[13px] font-bold">When to use this instead of a password reset</h2>
            <ul className="mt-2 space-y-1.5 text-[13px] text-ink-soft">
              {[
                "You no longer control the email address on the profile.",
                "Your profile was suspended or an admin locked sign-ins.",
                "Someone else changed your password or your listings.",
              ].map((line) => (
                <li key={line} className="flex gap-2">
                  <MailCheck size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
          </Card>

          <form onSubmit={submit} className="space-y-4" noValidate>
            <Input
              label="Email on the account"
              type="email"
              autoComplete="email"
              icon={<MailCheck size={15} />}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              hint="Use any address that has ever been attached to the profile — it helps us match you faster."
              placeholder="you@company.com"
              required
            />

            {formError && (
              <Card className="border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
                {formError}
              </Card>
            )}

            <Button type="submit" size="lg" fullWidth loading={busy}>
              Start account recovery <ArrowRight size={16} />
            </Button>
          </form>

          <p className="text-xs text-ink-faint">
            Recovery requests are handled by a person, not a bot. Never share a code sent to your phone or email with
            anyone, including anyone claiming to work here.
          </p>
        </div>
      )}
    </AuthLayout>
  );
}
