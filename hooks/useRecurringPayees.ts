"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

/* The user's verdict on each merchant. See 0020_recurring_payees.sql.
 *
 * The detector proposes and this decides. Nothing counts as a fixed cost
 * until it is 'fixed' here, which is what stops three tidy grocery runs
 * becoming an obligation — and what lets the detector be generous, since a
 * suggestion nobody ticks costs nothing. */

const supabase = createClient();

export type Decision = "fixed" | "dismissed";

export interface RecurringPayee {
  payee_key: string;
  decision: Decision;
  noted_amount: number | null;
  noted_cadence: string | null;
  /** replaces the detected amount; null keeps inferring */
  override_amount: number | null;
}

export function useRecurringPayees() {
  return useQuery({
    queryKey: ["recurring_payees"],
    queryFn: async (): Promise<Record<string, RecurringPayee>> => {
      const { data, error } = await supabase.from("recurring_payees").select("*");
      if (error) throw error;
      return Object.fromEntries(((data ?? []) as RecurringPayee[]).map((r) => [r.payee_key, r]));
    },
  });
}

export function useSetRecurringPayee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      payee_key: string;
      /** null clears the decision, putting the merchant back among suggestions */
      decision: Decision | null;
      noted_amount?: number;
      noted_cadence?: string;
      override_amount?: number | null;
    }) => {
      const { data: auth } = await supabase.auth.getUser();
      const user_id = auth.user?.id;
      if (!user_id) throw new Error("not signed in");

      if (input.decision === null) {
        const { error } = await supabase
          .from("recurring_payees")
          .delete()
          .eq("user_id", user_id)
          .eq("payee_key", input.payee_key);
        if (error) throw error;
        return;
      }

      const { error } = await supabase.from("recurring_payees").upsert(
        {
          user_id,
          payee_key: input.payee_key,
          decision: input.decision,
          noted_amount: input.noted_amount ?? null,
          noted_cadence: input.noted_cadence ?? null,
          ...(input.override_amount === undefined
            ? {}
            : { override_amount: input.override_amount }),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,payee_key" },
      );
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring_payees"] }),
  });
}
