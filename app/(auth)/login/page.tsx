"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isDemo } from "@/lib/demo/isDemo";
import { AppLogo } from "@/components/ui/AppLogo";

export default function LoginPage() {
  const router = useRouter();
  // Demo mode has no auth — go straight to the dashboard.
  useEffect(() => {
    if (isDemo) router.replace("/");
  }, [router]);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();
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

            {error && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !email}
              className="w-full py-3 px-4 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
              style={{ background: "var(--color-primary)" }}
            >
              {loading ? "Sending…" : "Send magic link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
