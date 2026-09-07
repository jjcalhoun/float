import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 "Proxy" (formerly Middleware). Runs before every matched request.
 *
 * Its only job here is a best-effort refresh of the Supabase auth cookie so
 * sessions don't expire mid-use. The REAL authentication gate lives in
 * app/(app)/layout.tsx (a server component), which is the reliable place to
 * protect routes. Everything Supabase-related is wrapped in try/catch so that
 * a missing env var or a transient network hiccup can never 500 the whole site.
 */
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // Demo deployments have no auth at all — let everything through.
  if (process.env.NEXT_PUBLIC_DEMO === "1") return supabaseResponse;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // If keys aren't configured, just let the request through; the (app) layout
  // handles auth/redirects on its own.
  if (!url || !key) return supabaseResponse;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { pathname } = request.nextUrl;

    // Optimistic redirects (the layout enforces the real gate):
    if (!user && !pathname.startsWith("/login") && !pathname.startsWith("/auth")) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      // A sign-in code that landed on the wrong path goes to the callback, not
      // to the login form. Supabase falls back to the Site URL when
      // emailRedirectTo isn't in the allowed redirects, so the code arrives at
      // "/" carrying a perfectly valid grant; cloning the URL kept the query
      // and dropped the user on a login page that had no idea what to do with
      // it. From the outside that is an endless loop with no error anywhere.
      const code = loginUrl.searchParams.get("code");
      if (code) {
        loginUrl.pathname = "/auth/callback";
        return NextResponse.redirect(loginUrl);
      }
      // Otherwise carry nothing over — a stale query on the login form can
      // only confuse whatever reads it next.
      loginUrl.search = "";
      return NextResponse.redirect(loginUrl);
    }
    if (user && pathname === "/login") {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/";
      return NextResponse.redirect(homeUrl);
    }
  } catch {
    // Never let the proxy crash the site — fall through to the request.
    return supabaseResponse;
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icons|manifest.json|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
