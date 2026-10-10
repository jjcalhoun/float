"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Home", icon: "home" },
  /* v2, while it is being built: reachable without typing the URL. */
  { href: "/float", label: "Float", icon: "sailing" },
  { href: "/activity", label: "Activity", icon: "grid_view" },
  { href: "/debt", label: "Debt", icon: "payments" },
  { href: "/profile", label: "Profile", icon: "person" },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="lg:hidden fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] px-4 pb-safe"
      style={{
        background: "var(--color-surface)",
        borderTop: "1px solid var(--color-hairline)",
      }}
    >
      <div className="flex items-center justify-around h-16">
        {TABS.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="flex flex-col items-center gap-0.5 py-2 px-3 rounded-xl transition-colors"
              style={{ color: active ? "var(--color-primary)" : "var(--color-faint)" }}
            >
              <span
                className="material-symbols-outlined"
                style={{
                  fontSize: 24,
                  fontVariationSettings: active
                    ? "'FILL' 1, 'wght' 600"
                    : "'FILL' 0, 'wght' 400",
                }}
              >
                {tab.icon}
              </span>
              <span
                className="text-[10px] font-medium leading-none"
                style={{ color: active ? "var(--color-primary)" : "var(--color-faint)" }}
              >
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
