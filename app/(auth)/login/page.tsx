"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isDemo } from "@/lib/demo/isDemo";
import { AppLogo } from "@/components/ui/AppLogo";

const CALLBACK_FAILED =
  "That sign-in link couldn't be completed. Ask for a new one, or use a password.";

export default function LoginPage() {
  const router = useRouter();
  // Demo mode has no auth — go straight to the dashboard.
  useEffect(() => {
    if (isDemo) router.replace("/");
  }, [router]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"link" | "password">("link");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* Rescue a sign-in that arrived at the wrong door.
   *
   * Two ways that happens, both seen for real:
   *
   *   - the code lands HERE instead of /auth/callback, because Supabase falls
   *     back to the Site URL when emailRedirectTo isn't in the allowed
   *     redirects, and the proxy then rewrites the path to /login while keeping
   *     the query. The code is perfectly good; nothing was reading it. Hand it
   *     to the callback rather than showing a login form on top of it.
   *   - the session arrives in the URL FRAGMENT as tokens, which is what an
   *     admin-generated link does: there is no PKCE verifier behind it, so
   *     there is no code to exchange. Fragments never reach the server, so the
   *     route handler cannot help — it has to be done here.
   *
   * Both used to look identical to the user: the login form, again, forever. */
  useEffect(() => {
    if (isDemo) return;

    const code = new URLSearchParams(window.location.search).get("code");
    if (code) {
      window.location.replace(`/auth/callback?code=${encodeURIComponent(code)}`);
      return;
    }

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    if (access_token && refresh_token) {
      setLoading(true);
      createClient()
        .auth.setSession({ access_token, refresh_token })
        .then(({ error }) => {
          if (error) {
            setError(error.message);
            setLoading(false);
          } else {
            window.location.replace("/");
          }
        });
      return;
    }

    if (new URLSearchParams(window.location.search).get("error")) {
      setError(CALLBACK_FAILED);
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();

    // A password is the door that doesn't depend on email being deliverable.
    // The built-in mail service allows two messages an hour, which is enough
    // to lock yourself out of your own finances by installing the app twice.
    if (mode === "password") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (error) setError(error.message);
      else window.location.replace("/");
      return;
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${location.origin}/auth/callback`,
        // Single-user app: never create a new account from a login attempt.
        // Only an already-existing user (you) can receive a magic link.
        shouldCreateUser: false,
      },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "var(--color-canvas)" }}
    >
      <div
        className="w-full max-w-sm rounded-[16px] p-8 border"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-hairline)",
        }}
      >
        {/* Logo / wordmark */}
        <div className="mb-8 text-center">
          <div className="inline-flex w-14 h-14 rounded-2xl mb-4 overflow-hidden">
            <AppLogo className="w-full h-full" />
          </div>
          <h1
            className="font-figure text-2xl font-bold"
            style={{ color: "var(--color-text)" }}
          >
            Float
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--color-muted)" }}>
            Your personal budget, simplified.
          </p>
        </div>

        {sent ? (
          <div className="text-center space-y-3">
            <div
              className="text-4xl"
              role="img"
              aria-label="Email sent"
            >
              ✉️
            </div>
            <p className="font-medium" style={{ color: "var(--color-text)" }}>
              Check your email
            </p>
            <p className="text-sm" style={{ color: "var(--color-muted)" }}>
              We sent a magic link to <strong>{email}</strong>. Click it to sign
              in.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium mb-1.5"
                style={{ color: "var(--color-muted)" }}
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-4 py-3 rounded-xl text-sm outline-none border transition-colors focus:border-[#2563EB]"
                style={{
                  background: "var(--color-elevated)",
                  color: "var(--color-text)",
                  borderColor: "var(--color-hairline)",
                }}
              />
            </div>

            {mode === "password" && (
              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium mb-1.5"
                  style={{ color: "var(--color-muted)" }}
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl text-sm outline-none border transition-colors"
                  style={{
                    background: "var(--color-elevated)",
                    color: "var(--color-text)",
                    borderColor: "var(--color-hairline)",
                  }}
                />
              </div>
            )}

            {error && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !email || (mode === "password" && !password)}
              className="w-full py-3 px-4 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
              style={{ background: "var(--color-primary)" }}
            >
              {loading
                ? mode === "password"
                  ? "Signing in…"
                  : "Sending…"
                : mode === "password"
                  ? "Sign in"
                  : "Send magic link"}
            </button>

            {/* The email cap is two an hour, so this is not a nicety */}
            <button
              type="button"
              onClick={() => {
                setMode((m) => (m === "link" ? "password" : "link"));
                setError(null);
              }}
              className="w-full text-xs underline"
              style={{ color: "var(--color-muted)" }}
            >
              {mode === "link" ? "Use a password instead" : "Email me a link instead"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
