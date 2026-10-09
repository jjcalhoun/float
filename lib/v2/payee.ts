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

/* One bill, two names.
 *
 * Chase posts some ACH debits with an originator prefix, so the same
 * Smithville internet bill arrives as both:
 *
 *   Smithville Tele Bill
 *   Certificate of Origin Smithville
 *
 * and the same mortgage as both "Citizens Bank Mortgage Payment" and
 * "Certificate of Origin Citizens". Each half then looks like a thin,
 * low-confidence series instead of one solid one — and worse, you are asked
 * to judge the same obligation twice, which is how a bill ends up both kept
 * and dismissed at once.
 *
 * Stripping the prefix is not enough: that leaves "smithville" against
 * "smithville tele bill", still two keys. So names are merged when one is a
 * token-subset of the other AND the amounts agree. Both conditions matter —
 * the subset alone would merge "Target" into "Target Optical", and the
 * amounts alone would merge every $9.99 subscription you own.
 */

/** Words that identify a transaction's plumbing rather than its payee. */
const GENERIC = new Set([
  "certificate", "origin", "of", "payment", "bill", "ach", "autopay", "the",
  "to", "from", "inc", "llc", "co",
]);

const distinctive = (key: string) =>
  new Set(key.split(" ").filter((t) => t.length > 1 && !GENERIC.has(t)));

const isSubset = (a: Set<string>, b: Set<string>) =>
  a.size > 0 && a.size < b.size && [...a].every((t) => b.has(t));

export interface AliasInput {
  key: string;
  /** typical amount at this payee, unsigned */
  amount: number;
}

/** key → the key it should be counted under. Keys with no alias are absent.
 *
 *  The more specific name wins, because "Smithville Tele Bill" tells you what
 *  the bill is and "Certificate of Origin Smithville" tells you how the bank
 *  routed it. */
export function aliasMap(payees: AliasInput[], amountTolerance = 0.05): Map<string, string> {
  const toks = new Map(payees.map((p) => [p.key, distinctive(p.key)]));
  const out = new Map<string, string>();

  for (const a of payees) {
    for (const b of payees) {
      if (a.key === b.key) continue;
      if (!isSubset(toks.get(a.key)!, toks.get(b.key)!)) continue;
      const scale = Math.max(a.amount, b.amount);
      if (scale <= 0 || Math.abs(a.amount - b.amount) / scale > amountTolerance) continue;
      out.set(a.key, b.key);
      break;
    }
  }

  // a → b → c collapses to a → c, so a three-way split lands in one place.
  for (const [from] of out) {
    const seen = new Set([from]);
    let to = out.get(from)!;
    while (out.has(to) && !seen.has(to)) {
      seen.add(to);
      to = out.get(to)!;
    }
    out.set(from, to);
  }

  return out;
}
