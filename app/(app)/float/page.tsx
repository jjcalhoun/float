import { redirect } from "next/navigation";

/* The number moved to `/`, so the icon already on the phone opens to it.
   This redirect is for links and bookmarks made while it lived here. */

export default function FloatRedirect() {
  redirect("/");
}
