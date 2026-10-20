import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, CircleAlert, Eye, EyeOff, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { Button, Card, Input } from "@/components/ui";
import { useToast } from "@/context/ToastContext";
import { authApi } from "@/services/api";
import { ApiError } from "@/services/http";
import { errorMessage } from "@/hooks/useAsync";

function strengthOf(pw: string): { score: number; label: string } {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const score = Math.min(4, s);
  return { score, label: ["Too short", "Weak", "Fair", "Strong", "Excellent"][score] };
}

export default function ResetPasswordPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlToken = params.get("token") ?? "";

  const [token, setToken] = useState(urlToken);
  const [editingToken, setEditingToken] = useState(!urlToken);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [expired, setExpired] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    document.title = "Set a new password — Professionalist";
  }, []);

  const pw = strengthOf(password);
  const activeToken = token.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fields: Record<string, string> = {};
    if (!activeToken) fields.token = "Paste the reset code from your email.";
    if (password.length < 8) fields.password = "Use at least 8 characters.";
    if (confirm !== password) fields.confirm = "Both passwords must match.";
    setFieldErrors(fields);
    if (Object.keys(fields).length) {
      setFormError("Check the highlighted fields and try again.");
      return;
    }

    setBusy(true);
    setFormError("");
    setExpired(false);
    try {
      await authApi.resetPassword(activeToken, password);
      toast.success("Password updated", "Sign in with your new password.");
      navigate("/login", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      const message = errorMessage(err);
      const looksLikeTokenProblem =
        err instanceof ApiError && (err.status === 400 || err.code === "not_found") && /reset|token|link|expired|invalid/i.test(message);
      if (looksLikeTokenProblem) {
        setExpired(true);
        setFormError("");
      } else {
        setFormError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Set a new password"
      subtitle="Choose something you haven't used on Professionalist before."
      footer={
        <>
          Trouble with this link?{" "}
          <Link to="/forgot-password" className="font-semibold text-accent hover:underline">
            Send a fresh one
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {expired && (
          <Card className="border-danger/40 bg-danger-soft p-4 anim-fade-up" role="alert">
            <div className="flex gap-3">
              <CircleAlert size={20} className="mt-0.5 shrink-0 text-danger" aria-hidden />
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-danger">This reset link no longer works</h2>
                <p className="mt-1 text-sm text-ink-soft">
                  Reset codes expire quickly and are consumed on first use. Ask for a new link, or paste a code from a
                  more recent email.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => navigate("/forgot-password")}>
                    Request a new link
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setExpired(false);
                      setToken("");
                      setEditingToken(true);
                    }}
                  >
                    Enter a different code
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {!editingToken && (
          <Card className="flex items-center justify-between gap-3 p-3">
            <span className="flex min-w-0 items-center gap-2.5 text-sm">
              <KeyRound size={16} className="shrink-0 text-accent" aria-hidden />
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold">Reset code from your email link</span>
                <span className="block truncate font-mono text-xs text-ink-faint">{activeToken}</span>
              </span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setEditingToken(true)}>
              Change
            </Button>
          </Card>
        )}

        <form onSubmit={submit} className="space-y-4" noValidate>
          {editingToken && (
            <Input
              label="Reset code"
              autoComplete="off"
              icon={<KeyRound size={15} />}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              error={fieldErrors.token}
              hint="Paste the code exactly as it appears in the email, or open the link on this device."
              placeholder="e.g. 9f2c41be7a03"
              required
            />
          )}

          <div className="relative">
            <Input
              label="New password"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              icon={<Lock size={15} />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              placeholder="At least 8 characters"
              required
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide password" : "Show password"}
              className="absolute right-3 top-[34px] text-ink-faint hover:text-ink"
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            {password && (
              <div className="mt-2 flex items-center gap-2">
                <div
                  className="flex h-1 flex-1 gap-1"
                  role="meter"
                  aria-valuenow={pw.score}
                  aria-valuemin={0}
                  aria-valuemax={4}
                  aria-label="Password strength"
                >
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={
                        i < pw.score
                          ? pw.score <= 1
                            ? "flex-1 rounded-full bg-danger"
                            : pw.score === 2
                              ? "flex-1 rounded-full bg-warn"
                              : "flex-1 rounded-full bg-success"
                          : "flex-1 rounded-full bg-surface-2"
                      }
                    />
                  ))}
                </div>
                <span className="w-16 text-right text-xs font-semibold text-ink-soft">{pw.label}</span>
              </div>
            )}
          </div>

          <Input
            label="Confirm new password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            icon={<ShieldCheck size={15} />}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={fieldErrors.confirm}
            placeholder="Type it once more"
            required
          />

          {formError && (
            <Card className="border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
              {formError}
            </Card>
          )}

          <Button type="submit" size="lg" fullWidth loading={busy}>
            Update password <ArrowRight size={15} />
          </Button>
          <p className="text-center text-xs text-ink-faint">
            For your security, every other session is signed out after a password change.
          </p>
        </form>
      </div>
    </AuthLayout>
  );
}
