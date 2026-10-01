import { useMemo } from 'react';
import type { EcgParams as SimEcg } from '@/sim/types';

/**
 * Static 12-lead ECG rendered from the *simulated* ECG parameters at
 * acquisition (rate, rhythm, intervals, territory ST deviation, T/U waves).
 * Lead morphology uses simple per-lead projections; it is illustrative, not
 * a vector-cardiographic model.
 */
const LEADS: { id: string; qrsPol: number; rAmp: number; sAmp: number; st: 'inf' | 'ant' | 'lat' | 'avr' | 'none'; pPol: number }[] = [
  { id: 'I', qrsPol: 1, rAmp: 0.8, sAmp: 0.1, st: 'lat', pPol: 1 },
  { id: 'II', qrsPol: 1, rAmp: 1.1, sAmp: 0.15, st: 'inf', pPol: 1 },
  { id: 'III', qrsPol: 1, rAmp: 0.6, sAmp: 0.2, st: 'inf', pPol: 0.6 },
  { id: 'aVR', qrsPol: -1, rAmp: 0.2, sAmp: 0.8, st: 'avr', pPol: -1 },
  { id: 'aVL', qrsPol: 1, rAmp: 0.5, sAmp: 0.2, st: 'lat', pPol: 0.5 },
  { id: 'aVF', qrsPol: 1, rAmp: 0.85, sAmp: 0.1, st: 'inf', pPol: 0.8 },
  { id: 'V1', qrsPol: -1, rAmp: 0.25, sAmp: 1.1, st: 'ant', pPol: 0.5 },
  { id: 'V2', qrsPol: -1, rAmp: 0.45, sAmp: 1.3, st: 'ant', pPol: 0.6 },
  { id: 'V3', qrsPol: 1, rAmp: 0.8, sAmp: 0.8, st: 'ant', pPol: 0.8 },
  { id: 'V4', qrsPol: 1, rAmp: 1.3, sAmp: 0.5, st: 'ant', pPol: 0.9 },
  { id: 'V5', qrsPol: 1, rAmp: 1.4, sAmp: 0.2, st: 'lat', pPol: 1 },
  { id: 'V6', qrsPol: 1, rAmp: 1.1, sAmp: 0.1, st: 'lat', pPol: 1 },
];

const g = (t: number, mu: number, s: number) => Math.exp(-((t - mu) ** 2) / (2 * s * s));

function leadTrace(lead: (typeof LEADS)[number], ecg: SimEcg, rhythm: string, rate: number, seconds: number, fs = 250): number[] {
  const out: number[] = [];
  const rr = rate > 5 ? 60 / rate : 99;
  const qrsW = ecg.qrsMs / 90;
  const st = lead.st === 'inf' ? ecg.stInferior : lead.st === 'ant' ? ecg.stAnterior : lead.st === 'lat' ? ecg.stLateral : lead.st === 'avr' ? -(ecg.stInferior + ecg.stLateral) / 3 + Math.max(0, -ecg.stAnterior) * 0.5 : 0;
  const qWave = (lead.st === 'inf' && ecg.qWaves.inferior) || (lead.st === 'ant' && ecg.qWaves.anterior) || (lead.st === 'lat' && ecg.qWaves.lateral);
  for (let i = 0; i < seconds * fs; i++) {
    const t = i / fs;
    let v = 0;
    if (rhythm === 'vfib') {
      v = 0.4 * ecg.vfAmplitude * (Math.sin(t * 29 + Math.sin(t * 1.3) * 2) + 0.6 * Math.sin(t * 41 + 1));
      out.push(v);
      continue;
    }
    if (rhythm === 'asystole') {
      out.push(0.02 * Math.sin(t * 2));
      continue;
    }
    if (rhythm === 'afib') v += 0.04 * Math.sin(t * 2 * Math.PI * 6.2) + 0.025 * Math.sin(t * 2 * Math.PI * 8.1 + 1);
    const irregular = rhythm === 'afib';
    const k = Math.floor(t / rr);
    const beatStart = irregular ? k * rr + rr * 0.25 * Math.sin(k * 2.39) : k * rr;
    const tb = t - beatStart - 0.2;
    if (rhythm === 'chb') {
      const pp = 60 / 80;
      const tp = (t % pp) - 0.05;
      v += 0.12 * lead.pPol * g(tp, 0, 0.02);
    } else if (ecg.pWave && rhythm !== 'afib' && rhythm !== 'vtach') v += 0.12 * lead.pPol * g(tb, -ecg.prMs / 1000 + 0.05, 0.022);
    if (ecg.qrsMs > 120 || rhythm === 'vtach' || rhythm === 'paced') {
      v += lead.qrsPol * (0.9 * g(tb, 0.04 * qrsW, 0.03 * qrsW) - 0.5 * g(tb, 0.11 * qrsW, 0.035 * qrsW));
      v += -lead.qrsPol * 0.3 * g(tb, 0.34, 0.07);
    } else {
      if (qWave) v -= 0.3 * g(tb, -0.02, 0.012);
      v += lead.rAmp * g(tb, 0, 0.0095 * qrsW) - lead.sAmp * g(tb, 0.025 * qrsW, 0.01 * qrsW) - 0.06 * g(tb, -0.022, 0.007);
      const qt = (ecg.qtcMs / 1000) * Math.sqrt(Math.min(1.6, rr));
      const stMv = st / 10;
      if (tb > 0.05 && tb < qt * 0.75) v += stMv * Math.min(1, (tb - 0.05) / 0.03);
      const tAmp = (lead.id === 'aVR' ? -0.2 : lead.id === 'V1' ? 0.05 : 0.28) * ecg.tWave;
      v += (tAmp + stMv * 0.5) * g(tb, qt * 0.72, ecg.tWave > 1.6 ? 0.035 : 0.055);
      if (ecg.uWave > 0.2) v += 0.07 * ecg.uWave * g(tb, qt * 0.72 + 0.16, 0.04);
    }
    out.push(v);
  }
  return out;
}

export function Ecg12({ ecg, rhythm, rate }: { ecg: SimEcg; rhythm: string; rate: number }) {
  const W = 720;
  const H = 340;
  const cellW = W / 4;
  const cellH = 80;
  const traces = useMemo(() => LEADS.map((l) => leadTrace(l, ecg, rhythm, rate, 2.5)), [ecg, rhythm, rate]);
  const rhythmStrip = useMemo(() => leadTrace(LEADS[1]!, ecg, rhythm, rate, 10), [ecg, rhythm, rate]);
  const path = (data: number[], x0: number, y0: number, w: number, scale: number) =>
    data.map((v, i) => `${i === 0 ? 'M' : 'L'}${(x0 + (i / data.length) * w).toFixed(1)},${(y0 - v * scale).toFixed(1)}`).join('');
  const order = [
    [0, 3, 6, 9],
    [1, 4, 7, 10],
    [2, 5, 8, 11],
  ];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-[#e8b8b8] bg-[#fff6f4]" data-testid="ecg12">
      <defs>
        <pattern id="ecg-small" width="7.2" height="7.2" patternUnits="userSpaceOnUse">
          <path d="M7.2 0H0V7.2" fill="none" stroke="#f3c9c4" strokeWidth="0.4" />
        </pattern>
        <pattern id="ecg-big" width="36" height="36" patternUnits="userSpaceOnUse">
          <rect width="36" height="36" fill="url(#ecg-small)" />
          <path d="M36 0H0V36" fill="none" stroke="#eaa39c" strokeWidth="0.8" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#ecg-big)" />
      {order.map((row, r) =>
        row.map((li, c) => {
          const x0 = c * cellW;
          const y0 = 20 + r * cellH + cellH * 0.55;
          return (
            <g key={LEADS[li]!.id}>
              <text x={x0 + 4} y={20 + r * cellH + 12} fontSize="10" fill="#7a2a24" fontFamily="monospace">
                {LEADS[li]!.id}
              </text>
              <path d={path(traces[li]!, x0 + 2, y0, cellW - 4, 36)} fill="none" stroke="#1b1b1b" strokeWidth="1" />
            </g>
          );
        }),
      )}
      <text x={4} y={272} fontSize="10" fill="#7a2a24" fontFamily="monospace">
        II
      </text>
      <path d={path(rhythmStrip, 2, 305, W - 4, 32)} fill="none" stroke="#1b1b1b" strokeWidth="1" />
      <text x={W - 150} y={H - 6} fontSize="9" fill="#7a2a24" fontFamily="monospace">
        25 mm/s · 10 mm/mV · simulated
      </text>
    </svg>
  );
}
