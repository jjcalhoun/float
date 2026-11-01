import { HomeScreen } from "@/components/home/HomeScreen";
import { MonthPlanPrompt } from "@/components/plan/MonthPlanPrompt";

/* v1's home, kept whole.
 *
 * The donut, the ledger, the month plan and the review queue still work and
 * still know things about this account that v2 does not model yet. Keeping
 * the route costs nothing and means the rewrite never has to be finished in
 * one go to be usable.
 *
 * The month-plan prompt is mounted HERE rather than in the app layout. In
 * the layout it opened itself over whichever screen you happened to be on —
 * including Float, which has no month plan and no use for one. A prompt to
 * confirm this month's plan makes sense when you are looking at the plan.
 */

export default function ClassicPage() {
  return (
    <>
      <MonthPlanPrompt />
      <HomeScreen />
    </>
  );
}
