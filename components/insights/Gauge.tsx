"use client";

import { useState } from "react";
import { fmt0 } from "@/lib/format";
import { allocate, point, wedgePath, type Arc, type DonutGeometry } from "./donut";

export interface GaugePetal {
  key: string;
  label: string;
  color: string;
  icon: string;
  actual: number; // spent this month
  budget: number; // budgeted amount
  avg3: number; // 3-month average
  breakdown?: { label: string; value: number }[]; // optional detail (e.g. per-loan)
  dim?: boolean; // committed but not yet paid — rendered translucent
}

interface Props {
  petals: GaugePetal[];
  income: number; // expected income — the circle's full scale
  /** The ledger's free-to-spend. When given, the neutral wedge IS this number
   *  rather than a leftover. Omit it and the ring falls back to deriving (fine
   *  for a past month, where the centre reads "Net" and makes no such claim). */
  free?: number;
  /** Money the ledger counted as gone that no wedge claims, ENUMERATED — see
   *  lib/commitments/unaccountedItems.ts. Sized from the actual rows, never
   *  from a subtraction, so the wedge and the sheet behind it cannot disagree. */
  unaccounted?: number;
  center?: { label: string; value: string; sub?: string }; // readout override
  onPetalClick?: (key: string) => void;
  onCenterClick?: () => void; // e.g. open the ledger breakdown
  onUnaccountedClick?: () => void;
}

/* Budget donut. The whole circle is expected income; each wedge is a category,
   and what's left over — the neutral wedge — is the month's float. Hover or tap
   a wedge for actual-vs-budget and the 3-month average.
   It was a half-circle until the categories outgrew it: 180° left every wedge
   thin enough that most were colour-only, with no room for an icon. The full
   turn is the same information with twice the arc to spend on it.
   The geometry lives in ./donut.ts. */
const VB = 360;
const G: DonutGeometry = { cx: VB / 2, cy: VB / 2, rc: 140, th: 46, corner: 10 };
const GAP = 3.5;
const MIN_ICON_DEG = 13; // below this a wedge is colour-only (no icon)
const MIN_SPAN = 5; // smallest wedge, in degrees — keeps it tappable + rounded

const Ri = G.rc - G.th / 2;
const REMAIN_COLOR = "#9A938A";
/* Deliberately drab: this wedge is a question, not a category. */
const UNACCOUNTED_COLOR = "#6B7280";

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

/** Tooltips are placed just inside the ring, toward the centre, so they stay
 *  in frame however far round the circle their wedge sits — outside the ring
 *  there is no margin left in any direction. A wedge in the top half hangs its
 *  tooltip downward from that point; one in the bottom half hangs it up. */
const inTopHalf = (deg: number) => {
  const a = ((deg % 360) + 360) % 360;
  return a < 180;
};

function Tooltip({ mid, children }: { mid: number; children: React.ReactNode }) {
  const down = inTopHalf(mid);
  const [x, y] = point(G, Ri - 8, mid);
  return (
    <div
      className={`absolute z-10 -translate-x-1/2 ${down ? "" : "-translate-y-full"} rounded-[10px] px-3 py-2 pointer-events-none shadow-lg`}
      style={{
        left: pct(x, VB),
        top: pct(y, VB),
        background: "var(--color-elevated)",
        border: "1px solid var(--color-hairline)",
        minWidth: 150,
        maxWidth: 220,
      }}
    >
      {children}
    </div>
  );
}

export function Gauge({
  petals,
  income,
  free,
  unaccounted: unaccountedValue,
  center,
  onPetalClick,
  onCenterClick,
  onUnaccountedClick,
}: Props) {
  const [active, setActive] = useState<string | null>(null);

  // Wedges are sized by actual spend (or the committed amount for dimmed
  // not-yet-paid segments, which sort after the solid ones).
  const sized = petals
    .map((p) => ({ item: p, size: Math.max(0, p.actual) }))
    .filter((p) => p.size > 0)
    .sort((a, b) => (a.item.dim === b.item.dim ? b.size - a.size : a.item.dim ? 1 : -1));

  const totalActual = sized.filter((p) => !p.item.dim).reduce((s, p) => s + p.size, 0);
  const petalTotal = sized.reduce((s, p) => s + p.size, 0);

  /* Money the ledger counted as gone that no wedge claims.
   *
   * This was derived — income, less the wedges, less free-to-spend — and that
   * was wrong twice over. It labelled the wedge "not in a category" without
   * knowing whether anything was uncategorised, and it disagreed with the
   * sheet behind it: $579 on the wedge against $0 of actual rows, because a
   * subtraction absorbs every difference between the ledger and the ring, not
   * just the ones this label describes.
   *
   * So it is the enumerated total now, and nothing else. When the wedges plus
   * free don't fill the circle, the rest simply isn't drawn: an untinted arc
   * says "unaccounted for" honestly, where a labelled wedge asserted a reason
   * it had no evidence for. */
  const gap = Math.max(0, unaccountedValue ?? 0);
  const ringItems =
    gap > 0
      ? [
          ...sized,
          {
            item: {
              key: "__unaccounted",
              label: "Not in a category",
              color: UNACCOUNTED_COLOR,
              icon: "help",
              actual: gap,
              budget: 0,
              avg3: 0,
            } as GaugePetal,
            size: gap,
          },
        ]
      : sized;

  /* The circle's scale.
   *
   * Not income, once free-to-spend is authoritative. The ring's wedges and the
   * ledger's free-to-spend are computed from different sides of the same
   * month, and on real data they do not always sum to income — there is a
   * residue neither this component nor the sheet behind it can name. Scaling
   * to income drew that residue as a wedge and gave it a label it had not
   * earned.
   *
   * Scaling to what we can actually account for keeps every wedge real and the
   * neutral one exactly equal to free-to-spend, at the cost of the ring being
   * a proportional breakdown rather than a strict fraction of income. The
   * centre still carries the authoritative "of $X expected". */
  const scale = free === undefined ? income : petalTotal + gap + Math.max(0, free);

  const { wedges, remainder, remainderValue } = allocate(ringItems, scale, {
    start: 90,
    gap: GAP,
    minSpan: MIN_SPAN,
  });
  const denom = Math.max(income, petalTotal, 1);
  // The tooltip states the ledger's figure when we have it. Deriving it is a
  // fallback, and it was the whole bug: a derived leftover wearing the
  // centre's label.
  const freeValue = free === undefined ? remainderValue : free;

  const activePetal = wedges.find((w) => w.item.key === active);

  const hit = (arc: Arc, key: string, onClick?: () => void) => (
    <path
      d={wedgePath(G, arc.aH, arc.aL)}
      fill="transparent"
      fillRule="evenodd"
      style={{
        pointerEvents: "all",
        cursor: onClick ? "pointer" : "default",
        touchAction: "manipulation",
      }}
      onMouseEnter={() => setActive(key)}
      onMouseLeave={() => setActive((k) => (k === key ? null : k))}
      onClick={() => {
        setActive(key);
        onClick?.();
      }}
    />
  );

  return (
    <div className="relative w-full">
      <svg width="100%" viewBox={`0 0 ${VB} ${VB}`} style={{ display: "block" }}>
        {/* baseline track, just inside the ring */}
        <circle
          cx={G.cx}
          cy={G.cy}
          r={Ri - 5}
          fill="none"
          stroke="var(--color-hairline)"
          strokeWidth={2.5}
        />
        {wedges.map((w) => (
          <g key={w.item.key}>
            {/* solid wedge (dimmed while committed-but-unpaid) */}
            <path
              d={wedgePath(G, w.aH, w.aL)}
              fill={w.item.color}
              fillRule="evenodd"
              opacity={w.item.dim ? 0.38 : 1}
            />
            {active === w.item.key && (
              <path
                d={wedgePath(G, w.aH, w.aL)}
                fill="none"
                fillRule="evenodd"
                stroke="#fff"
                strokeOpacity={0.5}
                strokeWidth={1.5}
              />
            )}
            {/* transparent hit target on top — reliable tap/click across devices */}
            {hit(w, w.item.key, () =>
              w.item.key === "__unaccounted"
                ? onUnaccountedClick?.()
                : onPetalClick?.(w.item.key),
            )}
          </g>
        ))}
        {/* neutral remainder — the month's float */}
        {remainder && (
          <g>
            <path
              d={wedgePath(G, remainder.aH, remainder.aL)}
              fill={REMAIN_COLOR}
              fillRule="evenodd"
              opacity={0.5}
            />
            {active === "__remain" && (
              <path
                d={wedgePath(G, remainder.aH, remainder.aL)}
                fill="none"
                fillRule="evenodd"
                stroke="#fff"
                strokeOpacity={0.5}
                strokeWidth={1.5}
              />
            )}
            {hit(remainder, "__remain")}
          </g>
        )}
      </svg>

      {/* icons — only where the wedge is wide enough. Positioned, never
          rotated, so they read upright all the way round. */}
      {wedges.map((w) =>
        w.span >= MIN_ICON_DEG ? (
          <span
            key={`ic-${w.item.key}`}
            className="material-symbols-outlined absolute pointer-events-none"
            style={{
              left: pct(point(G, G.rc, w.mid)[0], VB),
              top: pct(point(G, G.rc, w.mid)[1], VB),
              transform: "translate(-50%, -50%)",
              fontSize: 22,
              color: "#fff",
            }}
          >
            {w.item.icon}
          </span>
        ) : null,
      )}

      {/* centre readout — wedge taps pass through; only the text block itself
          becomes a hit target when the centre is actionable */}
      <div className="absolute inset-0 flex items-center justify-center text-center pointer-events-none">
        <div
          className={`inline-block ${onCenterClick ? "pointer-events-auto cursor-pointer active:opacity-70" : ""}`}
          onClick={onCenterClick}
          role={onCenterClick ? "button" : undefined}
        >
          <p className="text-xs" style={{ color: "var(--color-muted)" }}>
            {center?.label ?? "Spent"}
          </p>
          <p className="font-figure text-[34px] font-bold leading-tight" style={{ color: "var(--color-text)" }}>
            {center?.value ?? fmt0(totalActual)}
          </p>
          <p className="text-xs" style={{ color: "var(--color-faint)" }}>
            {center?.sub ?? `of ${fmt0(income)} income`}
          </p>
        </div>
      </div>

      {activePetal && (
        <Tooltip mid={activePetal.mid}>
          <p className="text-xs font-semibold mb-0.5" style={{ color: "var(--color-text)" }}>
            {activePetal.item.label}
          </p>
          {activePetal.item.key === "__unaccounted" ? (
            <p className="text-[11px]" style={{ color: "var(--color-muted)" }}>
              {fmt0(activePetal.item.actual)} counted as spent, but no category
              claims it
            </p>
          ) : activePetal.item.dim ? (
            <p className="text-[11px]" style={{ color: "var(--color-muted)" }}>
              {fmt0(activePetal.item.actual)} upcoming — not paid yet
            </p>
          ) : (
            <>
              <p className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                {fmt0(activePetal.item.actual)} of {fmt0(activePetal.item.budget)} budget
              </p>
              <p className="text-[11px]" style={{ color: "var(--color-faint)" }}>
                3-mo avg {fmt0(activePetal.item.avg3)}
              </p>
            </>
          )}
          {activePetal.item.breakdown && activePetal.item.breakdown.length > 0 && (
            <div className="mt-1 pt-1 space-y-0.5" style={{ borderTop: "1px solid var(--color-hairline)" }}>
              {activePetal.item.breakdown.map((b) => (
                <p key={b.label} className="text-[11px] flex justify-between gap-3" style={{ color: "var(--color-muted)" }}>
                  <span className="truncate">{b.label}</span>
                  <span className="font-figure shrink-0" style={{ color: "var(--color-text)" }}>
                    {fmt0(b.value)}
                  </span>
                </p>
              ))}
            </div>
          )}
        </Tooltip>
      )}

      {active === "__remain" && remainder && (
        <Tooltip mid={remainder.mid}>
          <p className="text-xs font-semibold mb-0.5" style={{ color: "var(--color-text)" }}>
            {center?.label ?? "Remaining"}
          </p>
          <p className="text-[11px]" style={{ color: "var(--color-muted)" }}>
            {fmt0(freeValue)} of {fmt0(income)} — not spent or committed
          </p>
        </Tooltip>
      )}
    </div>
  );
}
