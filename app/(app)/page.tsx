import { FloatScreen } from "@/components/float/FloatScreen";

/* The home screen is now the number.
 *
 * It has to be THIS route rather than a nicer-looking one, because an
 * installed PWA remembers the URL it was installed with. Changing
 * manifest.start_url would only move the icon for people who install it
 * again; moving the screen to `/` moves it for the icon already on the
 * phone.
 *
 * v1's home is still here, at /classic, with the ledger, the donut and the
 * month plan intact. Nothing has been deleted — this app spent a long while
 * learning things about the user's data that are worth not throwing away.
 */

export default function HomePage() {
  return <FloatScreen />;
}
