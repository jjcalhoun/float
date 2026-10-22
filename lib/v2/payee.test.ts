import { describe, it, expect } from "vitest";
import { normalisePayee, displayPayee, aliasMap } from "./payee";

/* Every string here is real, taken from the Chase feed. */

describe("the Zelle problem", () => {
  const real = [
    "Zelle Transfer to Sarah Brinkman Jpm99cyjirem",
    "Zelle Transfer to Sarah Brinkman Jpm99cxnhaep",
    "Zelle Transfer to Sarah Brinkman Jpm99cw5x8du",
    "Zelle Transfer to Sarah Brinkman Jpm99cuwyxzc",
    "Zelle Transfer to Sarah Brinkman Jpm99ct0xra0",
  ];

  it("collapses eighteen unique strings into one payee", () => {
    // without this the largest recurring obligation in the account reads as
    // eighteen separate one-off transfers
    const got = new Set(real.map(normalisePayee));
    expect([...got]).toEqual(["zelle transfer to sarah brinkman"]);
  });
});

describe("what it strips", () => {
  it("a trailing reference — long, letters and digits mixed", () => {
    expect(normalisePayee("Some Merchant Jpm99cyjirem")).toBe("some merchant");
  });

  it("a trailing check or store number", () => {
    expect(normalisePayee("Online Deposit Check #1")).toBe("online deposit check");
    expect(normalisePayee("Online Transfer to Savings 4371")).toBe("online transfer to savings");
  });

  it("at most two tokens, so a name is never eaten whole", () => {
    expect(normalisePayee("A1b2c3 D4e5f6 G7h8i9")).toBe("a1b2c3");
  });
});

describe("what it must leave alone", () => {
  it("ordinary merchants", () => {
    expect(normalisePayee("Sam's Club")).toBe("sam's club");
    expect(normalisePayee("Citizens Bank Mortgage Payment")).toBe("citizens bank mortgage payment");
    expect(normalisePayee("Jimmy John's")).toBe("jimmy john's");
  });

  it("a name whose last word is a short number", () => {
    // over-stripping invents obligations; under-stripping only misses one
    expect(normalisePayee("Store 5")).toBe("store 5");
  });

  it("words that are merely long", () => {
    expect(normalisePayee("Department of Education")).toBe("department of education");
    expect(normalisePayee("Hoosier Heights Bloomi")).toBe("hoosier heights bloomi");
  });

  it("a year", () => {
    expect(normalisePayee("Taxes 2024")).toBe("taxes");
  });

  it("never strips the only word there is", () => {
    expect(normalisePayee("Jpm99cyjirem")).toBe("jpm99cyjirem");
  });

  it("empty input", () => {
    expect(normalisePayee(null)).toBe("");
    expect(normalisePayee("")).toBe("");
  });
});

describe("displayPayee", () => {
  it("keeps the bank's casing for the part it kept", () => {
    expect(displayPayee("Zelle Transfer to Sarah Brinkman Jpm99cyjirem")).toBe(
      "Zelle Transfer to Sarah Brinkman",
    );
    expect(displayPayee("Sam's Club")).toBe("Sam's Club");
  });
});

describe("a merchant that bills under two names", () => {
  it("treats Philo and Philo.com as one payee", () => {
    // four rows as "Philo.com" and one as "Philo" split a clean monthly
    // subscription into a four and a one, and it was lost
    expect(normalisePayee("Philo.com")).toBe(normalisePayee("Philo"));
  });

  it("strips the usual suffixes", () => {
    expect(normalisePayee("Link.com")).toBe("link");
    expect(normalisePayee("Something.io")).toBe("something");
  });

  it("leaves a dot that is not a TLD alone", () => {
    expect(normalisePayee("St. Mary's")).toBe("st. mary's");
  });
});

describe("one bill posted under two names", () => {
  /* Real: Chase prefixes some ACH debits with their originator, so the same
     Smithville internet bill arrives twice under different descriptions —
     and was duly offered twice, so it ended up both kept and dismissed. */
  const smithville = [
    { key: normalisePayee("Smithville Tele Bill"), amount: 74.99 },
    { key: normalisePayee("Certificate of Origin Smithville"), amount: 74.99 },
  ];

  it("merges the ACH-prefixed name into the real one", () => {
    const m = aliasMap(smithville);
    expect(m.get("certificate of origin smithville")).toBe("smithville tele bill");
  });

  it("keeps the more specific name — it says what the bill IS", () => {
    const m = aliasMap(smithville);
    expect(m.has("smithville tele bill")).toBe(false);
  });

  it("merges the mortgage, whose amount drifts with escrow", () => {
    const m = aliasMap([
      { key: normalisePayee("Citizens Bank Mortgage Payment"), amount: 571.71 },
      { key: normalisePayee("Certificate of Origin Citizens"), amount: 583.57 },
    ]);
    expect(m.get("certificate of origin citizens")).toBe("citizens bank mortgage payment");
  });

  it("will NOT merge on the name alone", () => {
    // "Target" is a subset of "Target Optical", and they are not the same shop
    const m = aliasMap([
      { key: "target", amount: 48 },
      { key: "target optical", amount: 310 },
    ]);
    expect(m.size).toBe(0);
  });

  it("will NOT merge on the amount alone", () => {
    // every $9.99 subscription would collapse into one
    const m = aliasMap([
      { key: "netflix", amount: 9.99 },
      { key: "spotify", amount: 9.99 },
    ]);
    expect(m.size).toBe(0);
  });

  it("collapses a three-way split to one name", () => {
    const m = aliasMap([
      { key: "acme", amount: 50 },
      { key: "acme utility", amount: 50 },
      { key: "acme utility co of indiana", amount: 50 },
    ]);
    expect(m.get("acme")).toBe("acme utility co of indiana");
    expect(m.get("acme utility")).toBe("acme utility co of indiana");
  });
});

describe("the same payee with a routing prefix", () => {
  /* The real pair, from the account: the Ellettsville water bill arrived as
     "Ellettsville Uti" in September and "Certificate of Origin Ellettsville
     Uti" in October. Once the plumbing words come off, both are
     {ellettsville, uti} — identical, not a subset — so isSubset rejected
     them, and the amounts ($101.24 against $81.25) would have rejected them
     too. The easiest case was the one case this could not see. */
  const A = normalisePayee("Ellettsville Uti");
  const B = normalisePayee("Certificate of Origin Ellettsville Uti");

  it("merges despite the amounts being nowhere near each other", () => {
    const m = aliasMap([{ key: A, amount: 101.24 }, { key: B, amount: 81.25 }]);
    expect(m.get(B)).toBe(A);
  });

  it("keeps the name with less of the bank in it", () => {
    const m = aliasMap([{ key: B, amount: 81.25 }, { key: A, amount: 101.24 }]);
    expect(m.get(B)).toBe(A);
    expect(m.has(A)).toBe(false);
  });

  it("does not need the amounts at all when the words match", () => {
    /* A utility bill is $101 one month and $81 the next, and that is
       precisely when a name change matters most. Requiring agreement here
       would make the rule useless exactly where it is needed. */
    const m = aliasMap([{ key: A, amount: 20 }, { key: B, amount: 900 }]);
    expect(m.get(B)).toBe(A);
  });

  it("still will not merge two different shops that share a word", () => {
    /* "Target" sits inside "Target Optical" as a strict subset, which is a
       different relationship and still has to clear the amount test. */
    const t = normalisePayee("Target");
    const o = normalisePayee("Target Optical");
    expect(aliasMap([{ key: t, amount: 40 }, { key: o, amount: 310 }]).size).toBe(0);
  });

  it("leaves the Smithville subset case working as before", () => {
    const s1 = normalisePayee("Smithville Tele Bill");
    const s2 = normalisePayee("Certificate of Origin Smithville");
    expect(aliasMap([{ key: s1, amount: 74.99 }, { key: s2, amount: 74.99 }]).get(s2)).toBe(s1);
  });

  it("does not map a key to itself or make a cycle", () => {
    const m = aliasMap([{ key: A, amount: 100 }, { key: B, amount: 100 }]);
    for (const [from, to] of m) expect(from).not.toBe(to);
  });
});

describe("a link you asserted yourself", () => {
  /* The automatic rules read one name inside another, or the same words
     under a routing prefix. A bank can rename "Ellettsville Uti" to "Town
     of Ellettsville", which shares nothing — and then a kept bill silently
     stops being counted and the number goes UP. */
  const OLD = normalisePayee("Ellettsville Uti");
  const NEW = normalisePayee("Town of Ellettsville");

  it("merges names with nothing whatever in common", () => {
    const auto = aliasMap([{ key: OLD, amount: 101 }, { key: NEW, amount: 81 }]);
    expect(auto.size).toBe(0); // no resemblance to find

    const m = aliasMap(
      [{ key: OLD, amount: 101 }, { key: NEW, amount: 81 }],
      undefined,
      { [NEW]: OLD },
    );
    expect(m.get(NEW)).toBe(OLD);
  });

  it("needs no agreement on the amounts", () => {
    const m = aliasMap([{ key: OLD, amount: 5 }, { key: NEW, amount: 5000 }], undefined, {
      [NEW]: OLD,
    });
    expect(m.get(NEW)).toBe(OLD);
  });

  it("works for a name that is not in this batch at all", () => {
    /* A bill that has not been charged inside the window still has to keep
       its link, or the link evaporates in any view narrow enough not to
       include it. */
    const m = aliasMap([{ key: OLD, amount: 101 }], undefined, { [NEW]: OLD });
    expect(m.get(NEW)).toBe(OLD);
  });

  it("overrides an automatic match that disagrees", () => {
    /* Target was folded into Target Optical by resemblance; saying
       otherwise has to win. */
    const t = normalisePayee("Target");
    const o = normalisePayee("Target Optical");
    const elsewhere = normalisePayee("Some Other Bill");
    const m = aliasMap(
      [{ key: t, amount: 100 }, { key: o, amount: 100 }],
      undefined,
      { [t]: elsewhere },
    );
    expect(m.get(t)).toBe(elsewhere);
  });

  it("collapses a chain so everything lands in one place", () => {
    const a = "aaa", b = "bbb", c = "ccc";
    const m = aliasMap([], undefined, { [a]: b, [b]: c });
    expect(m.get(a)).toBe(c);
    expect(m.get(b)).toBe(c);
  });

  it("ignores a self-link rather than looping", () => {
    const m = aliasMap([{ key: OLD, amount: 1 }], undefined, { [OLD]: OLD });
    expect(m.has(OLD)).toBe(false);
  });
});
