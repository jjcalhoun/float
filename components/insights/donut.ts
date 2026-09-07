/* Geometry for the home-screen donut.
 *
 * Split out from the component because the interesting parts are arithmetic,
 * not markup: how 360° is shared out between categories, and how a wedge is
 * drawn once it can be any size at all.
 *
 * Going from a half-circle to a full one introduced two shapes the arc code
 * never had to draw:
 *
 *   - a wedge wider than 180°, which needs the SVG large-arc flag set. On a
 *     half-circle nothing could exceed 180°, so the flag was hardcoded to 0
 *     and no one noticed. With a full circle the "free" remainder is over 180°
 *     the moment less than half the month's income is committed — the common
 *     case early in a month.
 *   - a wedge of the whole 360°, where the start and end points coincide and
 *     an arc between them is undefined. That one degenerates to nothing
 *     rendered at all, so it's drawn as a plain annulus instead.
 */

export interface DonutGeometry {
  cx: number;
  cy: number;
  /** centre-line radius of the ring */
  rc: number;
  /** ring thickness */
  th: number;
  /** corner rounding, in user units */
  corner: number;
}

export interface Arc {
  /** high (counter-clockwise) edge, in degrees */
  aH: number;
  /** low edge, in degrees */
  aL: number;
  /** midpoint, for icon and tooltip placement */
  mid: number;
  /** width in degrees, BEFORE the inter-wedge gap is taken out */
  span: number;
}

const DEG = 180 / Math.PI;

export const point = (g: DonutGeometry, r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [g.cx + r * Math.cos(a), g.cy - r * Math.sin(a)];
};

const f = (p: [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

/** Filled rounded-corner wedge between two angles, across the ring thickness.
 *
 *  Angles are degrees counter-clockwise from east, and the wedge is drawn from
 *  aH down to aL. A span at or above 359.5° is treated as the whole ring. */
export function wedgePath(g: DonutGeometry, aH: number, aL: number): string {
  const Ri = g.rc - g.th / 2;
  const Ro = g.rc + g.th / 2;
  const span = aH - aL;

  // The whole ring: no corners to round and no arc endpoints to name, so draw
  // it as two half-circles out and two back — an annulus with an even-odd hole.
  if (span >= 359.5) {
    const o0 = point(g, Ro, 0);
    const o1 = point(g, Ro, 180);
    const i0 = point(g, Ri, 0);
    const i1 = point(g, Ri, 180);
    return (
      `M ${f(o0)} A ${Ro} ${Ro} 0 1 0 ${f(o1)} A ${Ro} ${Ro} 0 1 0 ${f(o0)} Z ` +
      `M ${f(i0)} A ${Ri} ${Ri} 0 1 1 ${f(i1)} A ${Ri} ${Ri} 0 1 1 ${f(i0)} Z`
    );
  }

  let rc = Math.min(g.corner, (span * Ro) / DEG / 2 - 1);
  if (rc < 1) rc = 1;
  const phiO = (rc / Ro) * DEG;
  const phiI = (rc / Ri) * DEG;

  // Set once the wedge is wider than a half turn — without it SVG picks the
  // short way round and the wedge renders inside out.
  const largeO = span - 2 * phiO > 180 ? 1 : 0;
  const largeI = span - 2 * phiI > 180 ? 1 : 0;

  const A = point(g, Ro, aH - phiO);
  const B = point(g, Ro, aL + phiO);
  const C = point(g, Ro - rc, aL);
  const D = point(g, Ri + rc, aL);
  const E = point(g, Ri, aL + phiI);
  const F = point(g, Ri, aH - phiI);
  const G = point(g, Ri + rc, aH);
  const H = point(g, Ro - rc, aH);
  return (
    `M ${f(A)} A ${Ro} ${Ro} 0 ${largeO} 1 ${f(B)} A ${rc} ${rc} 0 0 1 ${f(C)} ` +
    `L ${f(D)} A ${rc} ${rc} 0 0 1 ${f(E)} A ${Ri} ${Ri} 0 ${largeI} 0 ${f(F)} ` +
    `A ${rc} ${rc} 0 0 1 ${f(G)} L ${f(H)} A ${rc} ${rc} 0 0 1 ${f(A)} Z`
  );
}

/** What the wedges don't account for.
 *
 *  The ring used to derive its neutral wedge as `income − wedges`, and the
 *  centre read `freeToSpend` from the ledger. Those are not the same quantity
 *  and they disagreed by $910 on a real month — the ring said $1,276 free
 *  while the centre said $366, and the tooltip labelled the first one with the
 *  second one's name.
 *
 *  They differ because the wedges are not a partition of the month. The ledger
 *  splits it into commitments plus unlinked spend; the ring splits it into
 *  categorised splits, loan transfers and unpaid commitments. A paid
 *  commitment reaches the ring only if it left a categorised split or a loan
 *  transfer, and the card-spending toggle moves one side and not the other.
 *
 *  So the ring stops deriving. The neutral wedge IS free-to-spend, and this is
 *  the remainder that makes the circle close: money the ledger counted as gone
 *  that no category claimed. Showing it as its own wedge is the point — as a
 *  silent leftover it was inflating what looked spendable. */
export const unaccounted = (income: number, wedgeTotal: number, free: number): number =>
  Math.max(0, income - wedgeTotal - free);

export interface AllocateOptions {
  /** where the first wedge starts, in degrees. 90 = twelve o'clock */
  start?: number;
  /** degrees dropped between neighbouring wedges */
  gap?: number;
  /** smallest wedge, so a tiny category stays tappable and stays rounded */
  minSpan?: number;
}

export interface Allocation<T> {
  wedges: (Arc & { item: T })[];
  /** the unspent slice, or null when it is too thin to draw */
  remainder: Arc | null;
  remainderValue: number;
}

/** Share the full circle out between items, largest slice first.
 *
 *  `denom` is the whole circle's worth — expected income. Anything not taken
 *  by an item is the remainder, which is the number the home screen is really
 *  about: what's still free. When items exceed income the remainder vanishes
 *  and the circle is fully consumed, which is exactly the signal wanted. */
export function allocate<T>(
  items: { item: T; size: number }[],
  denom: number,
  opts: AllocateOptions = {},
): Allocation<T> {
  const start = opts.start ?? 90;
  const gap = opts.gap ?? 3.5;
  const n = items.length;

  // Every wedge gets a floor; the rest of the circle is shared proportionally.
  // The floor shrinks if there are so many items it would overflow the circle.
  const minSpan = n > 0 ? Math.min(opts.minSpan ?? 5, 300 / n) : 0;
  const flexible = Math.max(0, 360 - n * minSpan);

  const total = items.reduce((s, i) => s + i.size, 0);
  const scale = Math.max(denom, total, 1);

  let cursor = start;
  const wedges = items.map(({ item, size }) => {
    const span = minSpan + (size / scale) * flexible;
    const arc = {
      item,
      aH: cursor - gap / 2,
      aL: cursor - span + gap / 2,
      mid: cursor - span / 2,
      span,
    };
    cursor -= span;
    return arc;
  });

  const remainderSpan = Math.max(0, (scale - total) / scale) * flexible;
  const remainderValue = Math.max(0, scale - total);

  // With nothing else on the circle the remainder is the entire ring, and the
  // gap has nothing to separate it from — taking it out would leave a notch
  // floating in an otherwise unbroken ring.
  const whole = n === 0 && remainderSpan >= 359.5;

  return {
    wedges,
    remainder:
      remainderSpan > gap
        ? {
            aH: whole ? cursor : cursor - gap / 2,
            aL: whole ? cursor - 360 : cursor - remainderSpan + gap / 2,
            mid: cursor - remainderSpan / 2,
            span: remainderSpan,
          }
        : null,
    remainderValue,
  };
}
