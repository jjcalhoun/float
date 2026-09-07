import { describe, it, expect } from "vitest";
import { allocate, wedgePath, point, type DonutGeometry } from "./donut";

/* The arc became a donut, and 180° of extra circle brought two shapes the old
   code could not draw: a wedge wider than a half turn, and a wedge that is the
   whole ring. Both are ordinary states of this screen — the first happens
   whenever less than half the month's income is committed, the second on the
   very first day of a month with nothing recorded yet. */

const g: DonutGeometry = { cx: 180, cy: 180, rc: 140, th: 46, corner: 10 };

// SVG arc commands are "A rx ry rot large-arc sweep x y"; pull the flags back
// out so the tests can assert on them rather than on coordinate soup.
const arcFlags = (d: string) =>
  [...d.matchAll(/A\s+([\d.]+)\s+[\d.]+\s+0\s+([01])\s+([01])/g)].map((m) => ({
    r: Number(m[1]),
    large: m[2] === "1",
    sweep: m[3] === "1",
  }));

describe("wedgePath", () => {
  it("draws a small wedge the short way round", () => {
    const outer = arcFlags(wedgePath(g, 90, 40)).find((a) => a.r > 150)!;
    expect(outer.large).toBe(false);
  });

  it("sets the large-arc flag past a half turn", () => {
    // this is the regression: on the half-circle gauge the flag was hardcoded
    // to 0, and a remainder of 200° rendered as its own 160° complement
    const outer = arcFlags(wedgePath(g, 90, -110)).find((a) => a.r > 150)!;
    expect(outer.large).toBe(true);
  });

  it("draws the whole ring as an annulus, not a zero-width sliver", () => {
    // start and end coincide at 360°, so an arc between them is undefined
    const d = wedgePath(g, 90, -270);
    const radii = arcFlags(d).map((a) => a.r);
    expect(radii).toEqual([163, 163, 117, 117]); // outer out, inner back
    expect(d).not.toContain("NaN");
  });

  it("never emits NaN, at any span", () => {
    for (let span = 1; span <= 359; span++) {
      expect(wedgePath(g, 90, 90 - span)).not.toContain("NaN");
    }
  });
});

describe("allocate", () => {
  const items = (...sizes: number[]) => sizes.map((size, i) => ({ item: `p${i}`, size }));

  it("starts at twelve o'clock and runs clockwise", () => {
    const { wedges } = allocate(items(100), 400);
    expect(wedges[0].aH).toBeCloseTo(90 - 3.5 / 2);
    expect(wedges[0].aL).toBeLessThan(wedges[0].aH);
  });

  it("sizes a wedge to its share of income", () => {
    // a quarter of income, with the min-span floor added on top
    const { wedges } = allocate(items(1000), 4000, { minSpan: 0, gap: 0 });
    expect(wedges[0].span).toBeCloseTo(90);
  });

  it("leaves the rest of the circle as the remainder", () => {
    const { remainder, remainderValue } = allocate(items(1000), 4000, { minSpan: 0, gap: 0 });
    expect(remainder!.span).toBeCloseTo(270);
    expect(remainderValue).toBe(3000);
  });

  it("gives the whole circle to the remainder when nothing is spent", () => {
    // the first of the month: this used to be the case that drew nothing
    const { wedges, remainder } = allocate<string>([], 4000);
    expect(wedges).toEqual([]);
    expect(remainder!.span).toBeCloseTo(360);
    // no gap taken out — a notch in an otherwise unbroken ring reads as a bug
    expect(remainder!.aH - remainder!.aL).toBeCloseTo(360);
  });

  it("consumes the circle and drops the remainder when overspent", () => {
    const { wedges, remainder, remainderValue } = allocate(items(5000), 4000, { minSpan: 0, gap: 0 });
    expect(wedges[0].span).toBeCloseTo(360);
    expect(remainder).toBeNull();
    expect(remainderValue).toBe(0);
  });

  it("floors tiny categories so they stay tappable", () => {
    const { wedges } = allocate(items(4000, 1), 4000, { minSpan: 5, gap: 0 });
    expect(wedges[1].span).toBeGreaterThanOrEqual(5);
  });

  it("shrinks the floor rather than overflowing the circle", () => {
    // 100 categories at a 5° floor would want 500° of a 360° circle
    const { wedges } = allocate(items(...Array(100).fill(1)), 100_000, { minSpan: 5, gap: 0 });
    const total = wedges.reduce((s, w) => s + w.span, 0);
    expect(total).toBeLessThanOrEqual(360.001);
  });

  it("never lets wedges plus remainder exceed one turn", () => {
    const cases: number[][] = [[1000], [1000, 500, 250], [4000], [10, 10, 10, 10, 10]];
    for (const sizes of cases) {
      const a = allocate(items(...sizes), 4000, { gap: 0 });
      const used = a.wedges.reduce((s, w) => s + w.span, 0) + (a.remainder?.span ?? 0);
      expect(used).toBeLessThanOrEqual(360.001);
    }
  });
});

describe("point", () => {
  it("puts 90° at the top", () => {
    const [x, y] = point(g, 140, 90);
    expect(x).toBeCloseTo(180);
    expect(y).toBeCloseTo(40);
  });
});
