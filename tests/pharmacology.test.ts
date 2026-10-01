import { describe, expect, it } from 'vitest';
import { administerBolus, computeChannels, createPharmState, plasmaConcentration, stepPharm } from '../src/sim/pharmacology/pkpd';
import { DRUGS, getDrug } from '../src/sim/pharmacology/drugs';
import type { PkContext } from '../src/sim/pharmacology/types';

const ctx = (over: Partial<PkContext> = {}): PkContext => ({
  weightKg: 70,
  ageYears: 40,
  renalFactor: 1,
  hepaticFunction: 1,
  hepaticFlowFactor: 1,
  peripheralPerfusion: 1,
  temperatureC: 37,
  airflowFactor: 1,
  ...over,
});

function simulate(drugId: string, amount: number, route: Parameters<typeof administerBolus>[3], minutes: number, c = ctx()) {
  const s = createPharmState();
  administerBolus(s, drugId, amount, route, 0, c);
  const cp: number[] = [];
  const ce: number[] = [];
  for (let i = 0; i < minutes * 60 * 10; i++) {
    stepPharm(s, 0.1, c, {}, i * 0.1);
    if (i % 600 === 0) {
      const inst = s.drugs[drugId];
      cp.push(inst ? plasmaConcentration(inst, c.weightKg) : 0);
      ce.push(inst?.ce ?? 0);
    }
  }
  return { cp, ce, s };
}

describe('pharmacokinetics', () => {
  it('epinephrine IV has a half-life of a few minutes', () => {
    const { cp } = simulate('epinephrine', 1000, 'IV', 12);
    const ratio = cp[6]! / cp[3]!; // 3 minutes apart
    const halfLife = (3 * Math.log(2)) / -Math.log(ratio);
    expect(halfLife).toBeGreaterThan(1.5);
    expect(halfLife).toBeLessThan(4);
  });

  it('IM absorption peaks later and lower than IV, and slows with poor perfusion', () => {
    const iv = simulate('epinephrine', 500, 'IV', 20).cp;
    const im = simulate('epinephrine', 500, 'IM', 20).cp;
    const imShock = simulate('epinephrine', 500, 'IM', 20, ctx({ peripheralPerfusion: 0.25 })).cp;
    const peakIdx = (a: number[]) => a.indexOf(Math.max(...a));
    expect(peakIdx(im)).toBeGreaterThan(peakIdx(iv));
    expect(Math.max(...im)).toBeLessThan(Math.max(...iv));
    expect(Math.max(...imShock)).toBeLessThan(Math.max(...im) * 0.7);
  });

  it('effect-site concentration lags plasma (hysteresis) for slow-equilibrating drugs', () => {
    const { cp, ce } = simulate('morphine', 10000, 'IV', 30);
    expect(cp[1]!).toBeGreaterThan(ce[1]!);
    const cePeak = ce.indexOf(Math.max(...ce));
    expect(cePeak).toBeGreaterThanOrEqual(8);
  });

  it('renal impairment increases exposure to renally cleared drugs', () => {
    const normal = simulate('vancomycin', 1_500_000, 'IV', 720).cp;
    const impaired = simulate('vancomycin', 1_500_000, 'IV', 720, ctx({ renalFactor: 0.2 })).cp;
    expect(impaired[impaired.length - 1]!).toBeGreaterThan(normal[normal.length - 1]! * 2);
  });

  it('adenosine is cleared within a minute', () => {
    const { cp } = simulate('adenosine', 12000, 'IV', 2);
    expect(cp[1]! / Math.max(cp[0]!, 1e-9)).toBeLessThan(0.05);
  });

  it('every orderable drug with PK has sane parameters', () => {
    for (const d of DRUGS) {
      if (!d.pk) continue;
      expect(d.pk.v1, d.id).toBeGreaterThan(0);
      expect(d.pk.cl, d.id).toBeGreaterThan(0);
      expect(d.pk.ke0, d.id).toBeGreaterThan(0);
      expect(d.pk.renalFraction + d.pk.hepaticFraction, d.id).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe('pharmacodynamics', () => {
  it('higher opioid dose → greater μ activation', () => {
    const lo = simulate('fentanyl', 50, 'IV', 5).s;
    const hi = simulate('fentanyl', 200, 'IV', 5).s;
    const aLo = computeChannels(lo, 70, [], 1).mu;
    const aHi = computeChannels(hi, 70, [], 1).mu;
    expect(aHi).toBeGreaterThan(aLo);
  });

  it('naloxone competitively reduces μ drive; tolerance raises EC50', () => {
    const c = ctx();
    const s = createPharmState();
    administerBolus(s, 'fentanyl', 150, 'IV', 0, c);
    for (let i = 0; i < 1800; i++) stepPharm(s, 0.1, c, {}, i * 0.1);
    const before = computeChannels(s, 70, [], 1);
    const uBefore = s.channelU.mu;
    const tolerant = computeChannels(s, 70, [], 4).mu;
    administerBolus(s, 'naloxone', 400, 'IV', 180, c);
    for (let i = 0; i < 1200; i++) stepPharm(s, 0.1, c, {}, 180 + i * 0.1);
    computeChannels(s, 70, [], 1);
    expect(s.channelU.mu).toBeLessThan(uBefore * 0.5);
    expect(tolerant).toBeLessThan(before.mu);
  });

  it('β1-blocker blunts endogenous sympathetic β1 tone', () => {
    const c = ctx();
    const s = createPharmState();
    const tone = [{ channel: 'beta1' as const, u: 0.9, emax: 1, gamma: 1.2 }];
    const without = computeChannels(s, 70, tone, 1).beta1;
    administerBolus(s, 'metoprolol', 5000, 'IV', 0, c);
    for (let i = 0; i < 3000; i++) stepPharm(s, 0.1, c, {}, i * 0.1);
    const withBlock = computeChannels(s, 70, tone, 1).beta1;
    expect(withBlock).toBeLessThan(without);
  });

  it('epinephrine is β-predominant at low concentrations and α-predominant at high', () => {
    const c = ctx();
    const low = createPharmState();
    administerBolus(low, 'epinephrine', 60, 'IV', 0, c);
    for (let i = 0; i < 300; i++) stepPharm(low, 0.1, c, {}, i * 0.1);
    const l = computeChannels(low, 70, [], 1);
    const high = createPharmState();
    administerBolus(high, 'epinephrine', 1000, 'IV', 0, c);
    for (let i = 0; i < 300; i++) stepPharm(high, 0.1, c, {}, i * 0.1);
    const h = computeChannels(high, 70, [], 1);
    expect(l.beta2).toBeGreaterThan(l.alpha1);
    expect(h.alpha1).toBeGreaterThan(0.8);
    void getDrug;
  });
});
