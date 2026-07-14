'use client';

// Lagani SVG radar (paritet 1.0 competenceRadar / Chart.js radar) — 4 serije preko
// mreže 0–5. Bez spoljne chart biblioteke (CSP artefakt-safe). null vrednost = 0.

export const RADAR_COLORS = {
  self: '#0ea5e9',
  peer: '#f59e0b',
  leader: '#8b5cf6',
  target: '#22c55e',
} as const;

export interface RadarSeries {
  label: string;
  color: string;
  data: (number | null)[];
}

export function Radar({ labels, datasets, max = 5 }: { labels: string[]; datasets: RadarSeries[]; max?: number }) {
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 46;
  const n = labels.length;
  if (n < 3) return <p className="py-6 text-center text-sm text-ink-secondary">Nedovoljno grupa za radar.</p>;

  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const point = (i: number, val: number) => {
    const rad = (Math.max(0, Math.min(max, val)) / max) * r;
    return [cx + rad * Math.cos(angle(i)), cy + rad * Math.sin(angle(i))] as const;
  };

  const rings = Array.from({ length: max }, (_, k) => k + 1);

  return (
    <div className="flex flex-col items-center gap-2">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Radar kompetencija">
        {/* mreža */}
        {rings.map((ring) => (
          <polygon
            key={ring}
            points={labels.map((_, i) => point(i, ring).join(',')).join(' ')}
            fill="none"
            stroke="var(--line)"
            strokeWidth={ring === max ? 1.2 : 0.6}
            opacity={0.7}
          />
        ))}
        {/* paoci + labele */}
        {labels.map((lab, i) => {
          const [ex, ey] = point(i, max);
          const [lx, ly] = point(i, max + 0.7);
          return (
            <g key={i}>
              <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="var(--line)" strokeWidth={0.6} opacity={0.7} />
              <text x={lx} y={ly} fontSize={9} fill="var(--ink-secondary)" textAnchor={lx > cx + 4 ? 'start' : lx < cx - 4 ? 'end' : 'middle'} dominantBaseline="middle">
                {lab.length > 16 ? lab.slice(0, 15) + '…' : lab}
              </text>
            </g>
          );
        })}
        {/* serije */}
        {datasets
          .filter((d) => d.data.some((v) => v != null))
          .map((d) => (
            <polygon
              key={d.label}
              points={labels.map((_, i) => point(i, Number(d.data[i] ?? 0)).join(',')).join(' ')}
              fill={d.color}
              fillOpacity={0.12}
              stroke={d.color}
              strokeWidth={1.6}
            />
          ))}
      </svg>
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-1">
        {datasets.map((d) => (
          <span key={d.label} className="flex items-center gap-1.5 text-2xs text-ink-secondary">
            <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}
