import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Building2, Eye, EyeOff, Lock, Mail, User } from "lucide-react";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { Button, Card, Input, Select } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { errorMessage, useAsync, useDebounced } from "@/hooks/useAsync";
import { ApiError } from "@/services/http";
import { metaApi } from "@/services/api";

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

export default function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const meta = useAsync(
    () => Promise.all([metaApi.countries(), metaApi.professionalCategories()]),
    []
  );
  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", password: "", username: "",
    country: "", category: "", company: "", jobTitle: "", website: "",
    accountType: "individual" as "individual" | "company",
  });
  const [show, setShow] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const debouncedUsername = useDebounced(form.username, 400);
  const usernameHint = useMemo(() => {
    if (!debouncedUsername) return "3-20 characters: letters, numbers, dots, underscores.";
    if (!/^[a-z0-9_.]{3,20}$/i.test(debouncedUsername)) return "That username isn't valid yet.";
    return `Your profile will live at /profile/${debouncedUsername}`;
  }, [debouncedUsername]);

  const pw = strengthOf(form.password);

  if (user) return <Navigate to={user.profile.onboardingDone ? "/home" : "/onboarding"} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    setFieldErrors({});
    if (form.accountType === "company" && !form.company.trim()) {
      setBusy(false);
      setFieldErrors({ company: "Company name is required for a company account" });
      setFormError("Please enter your company name.");
      setAdvanced(true);
      return;
    }
    try {
      await register({
        ...form,
        email: form.email.trim(),
        username: form.username.trim(),
        company: form.company || undefined,
        jobTitle: form.jobTitle || undefined,
        website: form.website || undefined,
      });
      navigate("/onboarding", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Join a professional network built around real work, products and opportunities."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-semibold text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="sr-only">Account type</legend>
          {([
            { value: "individual", label: "Sign up as individual", hint: "For you and your work", Icon: User },
            { value: "company", label: "Sign up as company", hint: "For a business or brand", Icon: Building2 },
          ] as const).map(({ value, label, hint, Icon }) => {
            const active = form.accountType === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setForm((f) => ({ ...f, accountType: value }))}
                aria-pressed={active}
                className={
                  "flex flex-col items-start gap-1 rounded-2xl border p-3 text-left transition " +
                  (active
                    ? "border-accent bg-accent-soft ring-1 ring-accent"
                    : "border-line bg-surface hover:border-accent/50")
                }
              >
                <span className="flex items-center gap-2 font-semibold text-ink">
                  <Icon size={16} className={active ? "text-accent" : "text-ink-faint"} />
                  {label}
                </span>
                <span className="text-xs text-ink-soft">{hint}</span>
              </button>
            );
          })}
        </fieldset>

        {form.accountType === "company" ? (
          <Input
            label="Company name"
            icon={<Building2 size={15} />}
            value={form.company}
            onChange={set("company")}
            error={fieldErrors.company}
            placeholder="Lumen Studio"
            required
          />
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="First name" autoComplete="given-name" icon={<User size={15} />} value={form.firstName} onChange={set("firstName")} error={fieldErrors.firstName} placeholder="Amara" required />
          <Input label="Last name" autoComplete="family-name" value={form.lastName} onChange={set("lastName")} error={fieldErrors.lastName} placeholder="Okafor" required />
        </div>

        <Input label="Email" type="email" autoComplete="email" icon={<Mail size={15} />} value={form.email} onChange={set("email")} error={fieldErrors.email} placeholder="you@company.com" required />

        <div className="relative">
          <Input
            label="Password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            icon={<Lock size={15} />}
            value={form.password}
            onChange={set("password")}
            error={fieldErrors.password}
            placeholder="At least 8 characters"
            required
          />
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"} className="absolute right-3 top-[34px] text-ink-faint hover:text-ink">
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          {form.password && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex h-1 flex-1 gap-1" role="meter" aria-valuenow={pw.score} aria-valuemin={0} aria-valuemax={4} aria-label="Password strength">
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={
                      i < pw.score
                        ? pw.score <= 1 ? "flex-1 rounded-full bg-danger" : pw.score === 2 ? "flex-1 rounded-full bg-warn" : "flex-1 rounded-full bg-success"
                        : "flex-1 rounded-full bg-surface-2"
                    }
                  />
                ))}
              </div>
              <span className="w-16 text-right text-xs font-semibold text-ink-soft">{pw.label}</span>
            </div>
          )}
        </div>

        <Input label="Username" autoComplete="off" value={form.username} onChange={set("username")} error={fieldErrors.username} hint={usernameHint} placeholder="amaraokafor" required />

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Country"
            placeholder={meta.loading ? "Loading…" : "Select a country"}
            value={form.country}
            onChange={set("country")}
            error={fieldErrors.country}
            options={(meta.data?.[0] ?? []).map((c) => ({ value: c, label: c }))}
            required
          />
          <Select
            label="Professional category"
            placeholder={meta.loading ? "Loading…" : "Select a category"}
            value={form.category}
            onChange={set("category")}
            error={fieldErrors.category}
            options={(meta.data?.[1] ?? []).map((c) => ({ value: c, label: c }))}
            required
          />
        </div>

        <button type="button" onClick={() => setAdvanced((v) => !v)} className="text-sm font-semibold text-accent hover:underline">
          {advanced ? "− Hide" : "+ Add"} {form.accountType === "company" ? "website and your role (optional)" : "company, job title and website (optional)"}
        </button>

        {advanced && (
          <div className="grid gap-4 anim-fade-up sm:grid-cols-2">
            {form.accountType === "individual" && (
              <Input label="Company" icon={<Building2 size={15} />} value={form.company} onChange={set("company")} placeholder="Lumen Studio" />
            )}
            <Input label={form.accountType === "company" ? "Your role" : "Job title"} value={form.jobTitle} onChange={set("jobTitle")} placeholder="Senior Product Designer" />
            <Input label="Website" className="sm:col-span-2" value={form.website} onChange={set("website")} placeholder="https://yoursite.com" />
          </div>
        )}

        {formError && (
          <Card className="border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
            {formError}
          </Card>
        )}

        <Button type="submit" size="lg" fullWidth loading={busy}>
          Create account
        </Button>
        <p className="text-center text-xs text-ink-faint">
          By continuing you agree to our Terms and Privacy Policy.
        </p>
      </form>
    </AuthLayout>
  );
}
