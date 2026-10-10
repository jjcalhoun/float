import { HomeScreen } from "@/components/home/HomeScreen";

/* v1's home, kept whole.
 *
 * The donut, the ledger, the month plan and the review queue still work and
 * still know things about this account that v2 does not model yet. Keeping
 * the route costs nothing and means the rewrite never has to be finished in
 * one go to be usable.
 */

export default function ClassicPage() {
  return <HomeScreen />;
}
