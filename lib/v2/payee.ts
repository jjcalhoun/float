/* Turning a bank's description into a payee you can count.
 *
 * Banks append a reference to every transaction, and it is different every
 * time. Your child support reads:
 *
 *   Zelle Transfer to Sarah Brinkman Jpm99cyjirem
 *   Zelle Transfer to Sarah Brinkman Jpm99cxnhaep
 *   Zelle Transfer to Sarah Brinkman Jpm99cw5x8du
 *
 * Eighteen payments, eighteen distinct strings, and therefore — to anything
 * that groups on the raw text — eighteen one-off transfers rather than the
 * largest recurring obligation in the account. Stripping that trailing token
 * is the difference between seeing it and not.
 *
 * Deliberately conservative. Over-stripping merges things that are genuinely
 * different, which is worse than missing a series: a missed series shows up
 * as everyday spending, where you can still see it, while a wrongly merged
 * one invents an obligation that was never there.
 */

/** A reference token: long, and mixes letters with digits. "Jpm99cyjirem"
 *  qualifies; "Walmart" does not, and neither does "2024". */
const isReference = (tok: string) =>
  tok.length >= 6 && /[a-z]/.test(tok) && /\d/.test(tok);

/** A trailing store or account number: "#1", "4371". Four digits or more, or
 *  anything prefixed with #. Short bare numbers are left alone — "Chase 5"
 *  might be part of the name. */
const isTrailingNumber = (tok: string) =>
  /^#\d+$/.test(tok) || /^\d{4,}$/.test(tok);

export function normalisePayee(raw: string | null | undefined): string {
  if (!raw) return "";
  let toks = raw.toLowerCase().replace(/\s+/g, " ").trim().split(" ");

  // Only ever from the END, and at most twice: "… Check #1" and "… Jpm99x"
  // are each one token, but a few banks append both a date and a reference.
  for (let i = 0; i < 2 && toks.length > 1; i++) {
    const last = toks[toks.length - 1];
    if (isReference(last) || isTrailingNumber(last)) toks = toks.slice(0, -1);
    else break;
  }

  /* A web merchant bills under both its domain and its bare name — the same
     Philo subscription arrives four times as "Philo.com" and once as "Philo",
     which split a clean monthly series into a four and a one and lost it.
     The bank's description is not stable, so the TLD comes off. */
  return toks
    .map((t) => t.replace(/\.(com|net|org|io|co|app|tv)$/, ""))
    .join(" ")
    .replace(/[*#]+$/, "")
    .trim();
}

/** For display: the normalised form, with each word capitalised the way the
 *  bank sent it where possible. Falls back to the raw string's casing. */
export function displayPayee(raw: string | null | undefined): string {
  const norm = normalisePayee(raw);
  if (!norm || !raw) return norm;
  const words = raw.trim().split(/\s+/).slice(0, norm.split(" ").length);
  return words.join(" ");
}
