import { describe, it, expect } from "vitest";
import { normalisePayee, displayPayee } from "./payee";

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
