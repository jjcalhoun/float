"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

/* "This is the same bill as that one." See 0026_payee_aliases.sql.
 *
 * The automatic name matching handles the shapes it can see — one name
 * inside another, the same words under a routing prefix. It will never
 * handle all of them: a bank can rename a payee to something sharing no
 * words at all, and then a kept bill silently stops being counted and the
 * number goes UP with nothing saying why.
 *
 * This is the assertion that fixes that, and it beats every automatic rule.
 */

const supabase = createClient();

export interface PayeeAlias {
  payee_key: string;
  canonical_key: string;
}

/** payee key → the key it should be counted under */
export function usePayeeAliases() {
  return useQuery({
    queryKey: ["payee_aliases"],
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from("payee_aliases")
        .select("payee_key, canonical_key");
      if (error) throw error;
      return Object.fromEntries(
        ((data ?? []) as PayeeAlias[]).map((r) => [r.payee_key, r.canonical_key]),
      );
    },
  });
}

export function useSetPayeeAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      payee_key: string;
      /** null unlinks, putting the merchant back on its own */
      canonical_key: string | null;
    }) => {
      const { data: auth } = await supabase.auth.getUser();
      const user_id = auth.user?.id;
      if (!user_id) throw new Error("not signed in");

      if (input.canonical_key === null) {
        const { error } = await supabase
          .from("payee_aliases")
          .delete()
          .eq("user_id", user_id)
          .eq("payee_key", input.payee_key);
        if (error) throw error;
        return;
      }

      /* A name cannot be its own alias — the database rejects it too, but
         failing here keeps the error legible rather than a constraint
         violation surfacing in the UI. */
      if (input.canonical_key === input.payee_key) {
        throw new Error("a payee cannot be linked to itself");
      }

      const { error } = await supabase.from("payee_aliases").upsert(
        { user_id, payee_key: input.payee_key, canonical_key: input.canonical_key },
        { onConflict: "user_id,payee_key" },
      );
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payee_aliases"] }),
  });
}
