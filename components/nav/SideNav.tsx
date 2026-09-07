"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppLogo } from "@/components/ui/AppLogo";

const TABS = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/activity", label: "Activity", icon: "grid_view" },
  { href: "/debt", label: "Debt", icon: "payments" },
  { href: "/profile", label: "Profile", icon: "person" },
] as const;

/* Left sidebar for wide (desktop) screens — hidden below lg, where the bottom
   nav takes over. Same destinations as the bottom nav. */
export function SideNav() {
  const pathname = usePathname();

  return (
    <nav
      className="hidden lg:flex lg:flex-col shrink-0 w-60 sticky top-0 h-screen px-3 py-6 gap-1"
      style={{ background: "var(--color-surface)", borderRight: "1px solid var(--color-hairline)" }}
    >
      <div className="flex items-center gap-2.5 px-3 mb-6">
        <span className="w-8 h-8 rounded-xl overflow-hidden inline-block">
          <AppLogo className="w-full h-full" />
        </span>
        <span className="font-figure text-lg font-bold" style={{ color: "var(--color-text)" }}>
          Float
        </span>
      </div>

      {TABS.map((tab) => {
        const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors"
            style={{
              background: active ? "var(--color-elevated)" : "transparent",
              color: active ? "var(--color-primary)" : "var(--color-muted)",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{
                fontSize: 22,
                fontVariationSettings: active ? "'FILL' 1, 'wght' 600" : "'FILL' 0, 'wght' 400",
              }}
            >
              {tab.icon}
            </span>
            <span className="text-sm font-medium">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
