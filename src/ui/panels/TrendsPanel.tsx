import { useEffect, useMemo, useRef, useState } from 'react';
import { useCase, useUi } from '@/client/stores';
import { simClient } from '@/client/simClient';
import type { HistoryPayload } from '@/sim/engine/snapshot';
import type { HistorySample } from '@/sim/engine/state';
import { DRUG_MAP } from '@/sim/pharmacology/drugs';
import { concentrationUnit } from '@/sim/pharmacology/pkpd';
import { formatClock } from '@/sim/core/math';
import { Section } from '../common';

/** Categorical slots (validated reference palette) in fixed order; light / dark steps. */
const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

interface Metric {
  key: keyof HistorySample;
  label: string;
  unit: string;
  digits: number;
}

const METRICS: Metric[] = [
  { key: 'hr', label: 'Heart rate', unit: '/min', digits: 0 },
  { key: 'map', label: 'Mean arterial pressure', unit: 'mmHg', digits: 0 },
  { key: 'spo2', label: 'SaO₂', unit: '%', digits: 0 },
  { key: 'rr', label: 'Respiratory rate', unit: '/min', digits: 0 },
  { key: 'paco2', label: 'PaCO₂', unit: 'mmHg', digits: 0 },
  { key: 'lactate', label: 'Lactate', unit: 'mmol/L', digits: 1 },
  { key: 'glucose', label: 'Glucose', unit: 'mmol/L', digits: 1 },
  { key: 'k', label: 'Potassium', unit: 'mmol/L', digits: 1 },
  { key: 'temp', label: 'Core temperature', unit: '°C', digits: 1 },
  { key: 'bv', label: 'Blood volume', unit: 'mL', digits: 0 },
];

export function TrendsPanel() {
  const showTruth = useUi((s) => s.showTruth);
  const theme = useUi((s) => s.theme);
  const t = useCase((s) => s.snapshot?.t ?? 0);
  const [hist, setHist] = useState<HistoryPayload | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => simClient().history().then((h) => alive && setHist(h)).catch(() => undefined);
    void pull();
    const id = setInterval(pull, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const colors = SERIES[theme];
  const drugIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of hist?.drugHistory ?? []) for (const k of Object.keys(s.cp)) ids.add(k);
    return [...ids];
  }, [hist]);

  if (!hist) return <p className="p-4 text-[12.5px] text-ink-3">Loading trends…</p>;
  return (
    <div>
      <Section title="Drug effect-site concentrations" action={<span className="text-[11px] text-ink-3">Ce drives the effect; Cp is plasma</span>}>
        {drugIds.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">Give a drug to see its concentration–time course (absorption, distribution, elimination and effect-site lag).</p>
        ) : (
          <div className="flex flex-col gap-3">
            {drugIds.slice(0, 6).map((id, i) => (
              <LineChart
                key={id}
                title={DRUG_MAP[id]?.name ?? id}
                unit={DRUG_MAP[id] ? concentrationUnit(DRUG_MAP[id]!) : ''}
                color={colors[i % colors.length]!}
                points={hist.drugHistory.map((s) => ({ t: s.t, v: s.ce[id] ?? 0, v2: s.cp[id] ?? 0 }))}
                secondaryLabel="Cp"
                digits={2}
                now={t}
              />
            ))}
          </div>
        )}
      </Section>
      <Section title={showTruth ? 'Physiology trends (true values)' : 'Physiology trends'} action={!showTruth ? <span className="text-[11px] text-ink-3">Instructor view shows unmonitored values</span> : null}>
        <div className="grid grid-cols-1 gap-3">
          {METRICS.filter((m) => showTruth || ['hr', 'map', 'spo2', 'rr', 'temp'].includes(m.key)).map((m) => (
            <LineChart key={m.key} title={m.label} unit={m.unit} color={colors[0]!} points={hist.samples.map((s) => ({ t: s.t, v: Number(s[m.key]) }))} digits={m.digits} now={t} />
          ))}
        </div>
      </Section>
    </div>
  );
}

function LineChart({ title, unit, color, points, digits, now, secondaryLabel }: { title: string; unit: string; color: string; points: { t: number; v: number; v2?: number }[]; digits: number; now: number; secondaryLabel?: string }) {
  const W = 360;
  const H = 96;
  const pad = { l: 38, r: 8, t: 8, b: 18 };
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const t0 = points[0]!.t;
  const t1 = Math.max(points[points.length - 1]!.t, t0 + 60);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p.v, p.v2 ?? p.v);
    hi = Math.max(hi, p.v, p.v2 ?? p.v);
  }
  // Minimum visible span so tiny fluctuations are not magnified and tick labels stay distinct
  const minSpan = Math.max(Math.abs(hi) * 0.04, digits === 0 ? 6 : digits === 1 ? 0.6 : 1e-3);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    hi = mid + minSpan / 2;
    lo = mid - minSpan / 2;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const x = (tt: number) => pad.l + ((tt - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const d2 = points[0]!.v2 !== undefined ? points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v2!).toFixed(1)}`).join('') : null;
  const last = points[points.length - 1]!;
  const hp = hover != null ? points[hover] : null;
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(digits));
  void now;
  return (
    <figure className="m-0">
      <figcaption className="mb-0.5 flex items-baseline justify-between text-[12px]">
        <span className="font-medium text-ink">{title}</span>
        <span className="font-mono tabular text-ink-2">
          {fmt(last.v)} <span className="text-[10.5px] text-ink-3">{unit}</span>
        </span>
      </figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          const tx = t0 + (((e.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r) * (t1 - t0);
          let best = 0;
          for (let i = 0; i < points.length; i++) if (Math.abs(points[i]!.t - tx) < Math.abs(points[best]!.t - tx)) best = i;
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${title} over time`}
      >
        {[lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1].map((gv) => (
          <g key={gv}>
            <line x1={pad.l} x2={W - pad.r} y1={y(gv)} y2={y(gv)} stroke="var(--line)" strokeWidth={1} />
            <text x={pad.l - 4} y={y(gv) + 3} textAnchor="end" fontSize="9" fill="var(--ink-3)" fontFamily="var(--font-mono)">
              {fmt(gv)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 4} fontSize="9" fill="var(--ink-3)" fontFamily="var(--font-mono)">
          {formatClock(t0)}
        </text>
        <text x={W - pad.r} y={H - 4} textAnchor="end" fontSize="9" fill="var(--ink-3)" fontFamily="var(--font-mono)">
          {formatClock(t1)}
        </text>
        {d2 && <path d={d2} fill="none" stroke={color} strokeWidth={1.2} strokeDasharray="3 3" opacity={0.6} />}
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={pad.t} y2={H - pad.b} stroke="var(--ink-3)" strokeWidth={1} />
            <circle cx={x(hp.t)} cy={y(hp.v)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
            <g transform={`translate(${Math.min(x(hp.t) + 6, W - 120)},${pad.t + 2})`}>
              <rect width={114} height={d2 ? 30 : 18} rx={4} fill="var(--surface-3)" stroke="var(--line-strong)" />
              <text x={6} y={12} fontSize="10" fill="var(--ink)" fontFamily="var(--font-mono)">
                {formatClock(hp.t)} · {fmt(hp.v)} {d2 ? 'Ce' : ''}
              </text>
              {d2 && hp.v2 !== undefined && (
                <text x={6} y={25} fontSize="10" fill="var(--ink-2)" fontFamily="var(--font-mono)">
                  {secondaryLabel} {fmt(hp.v2)}
                </text>
              )}
            </g>
          </g>
        )}
      </svg>
      {d2 && (
        <div className="flex gap-3 text-[10.5px] text-ink-3">
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-4" style={{ background: color }} /> Effect site (Ce)
          </span>
          <span className="flex items-center gap-1">
            <span className="h-0 w-4 border-t border-dashed" style={{ borderColor: color }} /> Plasma (Cp)
          </span>
        </div>
      )}
    </figure>
  );
}
