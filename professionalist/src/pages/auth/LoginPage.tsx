import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { Button, Card, Input } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { ApiError } from "@/services/http";
import { errorMessage } from "@/hooks/useAsync";

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // ?next= is what the guards (and the video bridge) put in the URL on a full page load;
  // location.state.from is the in-app equivalent. Only in-app paths are honored.
  const nextParam = new URLSearchParams(location.search).get("next");
  const redirectTarget =
    (location.state as { from?: string } | null)?.from ??
    (nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : null) ??
    (user?.profile.onboardingDone ? "/home" : "/onboarding");

  if (user) return <Navigate to={redirectTarget} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    setFieldErrors({});
    try {
      await login({ email: email.trim(), password });
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to pick up where you left off."
      footer={
        <>
          New to Professionalist?{" "}
          <Link to="/register" className="font-semibold text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          icon={<Mail size={15} />}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          placeholder="you@company.com"
          required
        />
        <div className="relative">
          <Input
            label="Password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            icon={<Lock size={15} />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.password}
            placeholder="Your password"
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
        </div>

        <div className="flex items-center justify-between">
          <Link to="/forgot-password" className="text-sm font-semibold text-accent hover:underline">
            Forgot password?
          </Link>
        </div>

        {formError && (
          <Card className="border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
            {formError}
          </Card>
        )}

        <Button type="submit" size="lg" fullWidth loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
