import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BottomNav } from "@/components/nav/BottomNav";
import { SideNav } from "@/components/nav/SideNav";
import { HousekeepingRunner } from "@/components/housekeeping/HousekeepingRunner";

const demo = process.env.NEXT_PUBLIC_DEMO === "1";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!demo) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      redirect("/login");
    }
  }

  return (
    <div className="min-h-screen lg:flex" style={{ background: "var(--color-canvas)" }}>
      {demo && (
        <div
          className="fixed top-0 inset-x-0 z-[60] text-center text-[11px] font-semibold py-1 text-white"
          style={{ background: "var(--color-primary)" }}
        >
          Demo — fictional data, resets daily
        </div>
      )}
      <HousekeepingRunner />
      {/* The month-plan prompt used to live here, which meant v1's "confirm
          your November plan" sheet opened itself over the Float screen on the
          first of the month. It is a v1 behaviour and belongs with v1, so it
          is mounted on /classic instead — still there if you go back, and not
          interrupting an app that has no month plan. */}
      {/* Desktop: sidebar; mobile: bottom nav (below) */}
      <SideNav />
      <main className="flex-1 min-w-0">
        <div className="relative mx-auto w-full max-w-[430px] lg:max-w-4xl xl:max-w-5xl 2xl:max-w-6xl min-h-screen pt-safe lg:px-6">
          <div className="pb-28 lg:pb-10">{children}</div>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
