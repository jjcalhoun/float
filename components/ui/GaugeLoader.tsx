"use client";

/* A small on-brand loader: the donut's ring, with segments pulsing in sequence
   while data loads. Follows the hero from a half-circle to a full one — a
   half-arc spinner ahead of a round chart read as a different component. */

const SIZE = 108;
const C = SIZE / 2;
const R = 42;
const TH = 13;
const GAP = 8; // degrees
const COLORS = ["#3B82F6", "#EAB308", "#22C55E", "#14B8A6", "#A78BFA"];

const pt = (deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [C + R * Math.cos(a), C - R * Math.sin(a)];
};
const f = (p: [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

export function GaugeLoader({ label = "Loading…" }: { label?: string }) {
  const n = COLORS.length;
  const span = 360 / n;
  const segs = COLORS.map((color, i) => {
    const aH = 90 - i * span - GAP / 2;
    const aL = 90 - (i + 1) * span + GAP / 2;
    // each segment is 72° — comfortably under the half turn where the
    // large-arc flag would have to be set
    return { color, d: `M ${f(pt(aH))} A ${R} ${R} 0 0 1 ${f(pt(aL))}`, delay: i * 0.12 };
  });

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {segs.map((s, i) => (
          <path
            key={i}
            d={s.d}
            fill="none"
            stroke={s.color}
            strokeWidth={TH}
            strokeLinecap="round"
            className="petal-pulse"
            style={{ animationDelay: `${s.delay}s` }}
          />
        ))}
      </svg>
      <p className="text-sm" style={{ color: "var(--color-muted)" }}>
        {label}
      </p>
    </div>
  );
}
