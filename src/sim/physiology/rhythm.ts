import { approach, clamp, ramp, smoothstep } from '../core/math';
import type { StepContext } from '../engine/state';
import type { Rhythm } from '../types';
import { RHYTHM_LABEL } from '../types';

/**
 * Cardiac rhythm model.
 *
 * Rhythm is an electrical state machine; mechanical output is computed by the
 * circulation from the ventricular rate and a rhythm-specific stroke volume
 * factor. Transitions are hazard-based (seeded RNG) and driven by simulated
 * substrate: myocardial ischaemia and energetic viability, potassium,
 * temperature, drugs (amiodarone, β-blockade, magnesium, calcium membrane
 * stabilisation). "PEA" is not a rhythm: it is an organised rhythm whose
 * computed output is too low to generate a pulse — it emerges from the
 * haemodynamics (tension pneumothorax, exsanguination, severe acidosis ...).
 */

export const ARREST_RHYTHMS: Rhythm[] = ['vfib', 'asystole'];
export const SHOCKABLE: Rhythm[] = ['vfib', 'vtach'];

export function isOrganised(r: Rhythm): boolean {
  return r !== 'vfib' && r !== 'asystole';
}

export interface RateResult {
  rate: number;
  svFactor: number;
  electricalOnly: boolean;
}

export function ventricularRate(ctx: StepContext): RateResult {
  const { phys, calib: c, ch, therapy, s } = ctx;
  const cv = phys.cv;
  const eB1 = ch.beta1 - c.eBeta1_0;
  const vagal = phys.neuro.parasympathetic * (1 - ch.muscarinicBlock);
  const viability = clamp(cv.myocardialViability / 0.45, 0.15, 1);
  if (cv.pauseRemaining > 0 && (cv.rhythm === 'sinus' || cv.rhythm === 'svt' || cv.rhythm === 'afib')) {
    return { rate: 0, svFactor: 0, electricalOnly: false };
  }
  switch (cv.rhythm) {
    case 'sinus':
      return { rate: cv.sinusRate, svFactor: 1, electricalOnly: false };
    case 'afib': {
      const rate = 150 * cv.avConduction * (1 + 0.8 * eB1) * Math.exp(-0.5 * (vagal - c.v0)) * viability;
      return { rate: clamp(rate, 35, 210), svFactor: 0.85, electricalOnly: false };
    }
    case 'svt': {
      const pathRate = Number(s.detectors['svtRate'] ?? 190);
      return { rate: pathRate * (0.9 + 0.1 * viability), svFactor: 1, electricalOnly: false };
    }
    case 'vtach': {
      const pathRate = Number(s.detectors['vtRate'] ?? 175);
      return { rate: pathRate, svFactor: 0.42, electricalOnly: false };
    }
    case 'chb':
      return { rate: clamp(36 * (1 + 0.35 * eB1) * viability, 18, 60), svFactor: 1.12, electricalOnly: false };
    case 'paced': {
      const capture = cv.ecg.pacingCapture && cv.myocardialViability > 0.25;
      return { rate: capture ? therapy.defib.pacing.rate : 0, svFactor: capture ? 0.85 : 0, electricalOnly: !capture };
    }
    case 'vfib':
    case 'asystole':
      return { rate: 0, svFactor: 0, electricalOnly: true };
  }
}

export function setRhythm(ctx: StepContext, next: Rhythm, reason?: string): void {
  const cv = ctx.phys.cv;
  if (cv.rhythm === next) return;
  const prev = cv.rhythm;
  cv.rhythm = next;
  cv.rhythmTime = 0;
  if (next === 'vfib') cv.ecg.vfAmplitude = 0.4 + 0.6 * cv.myocardialViability;
  const critical = next === 'vfib' || next === 'asystole' || next === 'vtach';
  const good = (prev === 'vfib' || prev === 'asystole' || prev === 'vtach' || prev === 'svt' || prev === 'chb') && (next === 'sinus' || next === 'paced');
  ctx.emit({
    kind: 'physiology',
    code: `rhythm.${next}`,
    message: `Rhythm change: ${RHYTHM_LABEL[prev]} → ${RHYTHM_LABEL[next]}${reason ? ` (${reason})` : ''}`,
    severity: critical ? 'critical' : good ? 'good' : 'warning',
    data: { from: prev, to: next },
  });
}

/** Marks pathology-driven arrhythmias as terminated (e.g. after cardioversion). */
export function terminatePathologicRhythm(ctx: StepContext, rhythm: Rhythm): void {
  for (const p of ctx.s.pathologies) {
    if (p.type === 'arrhythmia' && (p.params as { kind: string }).kind === rhythm && !p.resolved) {
      p.state['terminated'] = true;
      p.state['terminatedAt'] = ctx.t;
    }
  }
}

function membraneStabilisation(ctx: StepContext): number {
  // Calcium raises the threshold for hyperkalaemic arrhythmia
  return clamp((ctx.phys.chem.ica - 1.15) / 0.5, 0, 0.8);
}

export function stepRhythm(ctx: StepContext): void {
  const { phys, mods, rng, dt, ch, therapy } = ctx;
  const { cv, chem, thermo } = phys;
  cv.rhythmTime += dt;
  if (cv.pauseRemaining > 0) cv.pauseRemaining = Math.max(0, cv.pauseRemaining - dt);

  const k = chem.k;
  const stab = membraneStabilisation(ctx);
  const hyperK = Math.pow(ramp(6.5, 9.5, k), 1.5) * (1 - stab);
  const hypoK = Math.pow(ramp(2.8, 1.8, k), 1.5);
  const mgProtect = clamp((chem.mg - 0.9) / 1.2, 0, 0.5);
  const betaBlock = clamp(1 - ch.beta1 / Math.max(0.05, ctx.calib.eBeta1_0 + 0.01), 0, 1) * 0.3;
  const amio = ch.amiodarone;
  const maxIsch = Math.max(cv.territoryIschemia.lad, cv.territoryIschemia.lcx, cv.territoryIschemia.rca, cv.globalIschemia);

  // Adenosine: transient AV block — terminates AV-node-dependent re-entry, brief pause.
  // The outcome is decided once per bolus, at the peak effect-site concentration.
  const aden = ch.adenosine;
  const peak = Number(ctx.s.detectors['adenosinePeak'] ?? 0);
  const evaluated = ctx.s.detectors['adenosineEvaluated'] === true;
  if (aden > 0.3) ctx.s.detectors['adenosinePeak'] = Math.max(peak, aden);
  const pastPeak = peak > 0.3 && aden < peak * 0.92;
  if (pastPeak && !evaluated) {
    ctx.s.detectors['adenosineEvaluated'] = true;
    if (peak >= 0.45) {
      if (cv.rhythm === 'svt') {
        const p = clamp((peak - 0.45) / 0.45, 0, 1) * 0.95;
        if (rng.arrhythmia.chance(p)) {
          terminatePathologicRhythm(ctx, 'svt');
          cv.pauseRemaining = 2 + 4 * peak;
          setRhythm(ctx, 'sinus', 'adenosine');
        } else {
          cv.pauseRemaining = 1.5 * peak;
          ctx.emit({ kind: 'physiology', code: 'adenosine.transient', message: 'Transient AV block after adenosine — SVT resumed', severity: 'notice' });
        }
      } else if (cv.rhythm === 'sinus' || cv.rhythm === 'afib') {
        cv.pauseRemaining = cv.rhythm === 'sinus' ? 2 + 3 * peak : 3 + 3 * peak;
        ctx.emit({
          kind: 'physiology',
          code: 'adenosine.block',
          message: cv.rhythm === 'afib' ? 'Adenosine: transient AV block unmasks fibrillatory waves; AF persists' : 'Adenosine: transient sinus pause/AV block',
          severity: 'notice',
        });
      }
    }
  }
  if (aden < 0.05 && peak > 0) {
    ctx.s.detectors['adenosinePeak'] = 0;
    ctx.s.detectors['adenosineEvaluated'] = false;
  }

  // Pathology-forced rhythms (SVT/AF/CHB/VT circuits) unless arrested
  const forced = mods.forcedRhythm;
  if (forced && isOrganised(cv.rhythm) && cv.rhythm !== forced && cv.rhythm !== 'paced') {
    setRhythm(ctx, forced);
  } else if (!forced && (cv.rhythm === 'svt' || cv.rhythm === 'chb' || cv.rhythm === 'vtach' || (cv.rhythm === 'afib' && ctx.s.detectors['afibPathology']))) {
    setRhythm(ctx, 'sinus', 'arrhythmia terminated');
  }

  // Pacing
  const pacing = therapy.defib.pacing;
  const threshold = ctx.patient.baseline.pacingThresholdmA * (1 + 0.5 * ramp(6.5, 8.5, k));
  const canPace = pacing.on && therapy.defib.padsOn;
  cv.ecg.pacingCapture = canPace && pacing.mA >= threshold;
  if (canPace && cv.rhythm !== 'paced' && cv.rhythm !== 'vfib' && cv.rhythm !== 'vtach') {
    const intrinsic = cv.rhythm === 'asystole' ? 0 : cv.rhythm === 'chb' ? 36 : cv.hr;
    if (pacing.rate > intrinsic) {
      cv.underlyingRhythm = cv.rhythm;
      setRhythm(ctx, 'paced', cv.ecg.pacingCapture ? 'electrical capture' : 'pacing spikes without capture');
    }
  } else if (!canPace && cv.rhythm === 'paced') {
    setRhythm(ctx, cv.underlyingRhythm === 'paced' ? 'sinus' : cv.underlyingRhythm, 'pacing stopped');
  }

  // Hazards (stochastic transitions are not sampled during the pre-arrival period so the
  // patient arrives in the state the scenario author composed; deterministic deterioration still occurs)
  if (ctx.preroll) return;
  const organisedPerfusing = cv.rhythm === 'sinus' || cv.rhythm === 'afib' || cv.rhythm === 'svt' || cv.rhythm === 'chb' || cv.rhythm === 'paced';
  if (organisedPerfusing) {
    let vf = mods.vfHazard;
    vf += 0.006 * maxIsch * maxIsch;
    vf += 0.08 * hyperK + 0.03 * hypoK;
    vf += 0.25 * ramp(28.5, 24, thermo.core);
    vf += 0.25 * ramp(0.35, 0.1, cv.myocardialViability);
    vf *= (1 - 0.6 * amio) * (1 - betaBlock) * (1 - mgProtect);
    if (rng.arrhythmia.hazard(vf, dt)) {
      setRhythm(ctx, 'vfib', hyperK > 0.3 ? 'hyperkalaemia' : maxIsch > 0.5 ? 'ischaemia' : 'electrical instability');
    } else {
      let asys = mods.asystoleHazard + 0.8 * ramp(0.22, 0.04, cv.myocardialViability) + 0.5 * ramp(8.2, 10, k) * (1 - stab);
      if (cv.rhythm === 'chb') asys += 0.002;
      if (rng.arrhythmia.hazard(asys, dt)) setRhythm(ctx, 'asystole', 'myocardial failure');
    }
  } else if (cv.rhythm === 'vtach') {
    const degenerate = cv.pulsePresent ? 0.04 : 0.35;
    if (rng.arrhythmia.hazard(degenerate * (1 - 0.5 * amio), dt)) setRhythm(ctx, 'vfib', 'VT degenerated');
    else if (rng.arrhythmia.hazard(0.5 * amio, dt)) {
      terminatePathologicRhythm(ctx, 'vtach');
      setRhythm(ctx, 'sinus', 'chemical cardioversion');
    }
  } else if (cv.rhythm === 'vfib') {
    cv.ecg.vfAmplitude = approach(cv.ecg.vfAmplitude, 0.12 + 0.88 * cv.myocardialViability, 30, dt);
    if (rng.arrhythmia.hazard(0.6 * ramp(0.12, 0.02, cv.myocardialViability), dt)) setRhythm(ctx, 'asystole', 'fine VF degenerated');
  } else if (cv.rhythm === 'asystole') {
    // Return of organised electrical activity needs myocardial energy + perfusion pressure (CPR + vasopressor)
    const cprOk = therapy.cpr.active && therapy.cpr.quality > 0.4;
    const reversible = hyperK < 0.3 && phys.resp.pao2 > 45 && thermo.core > 30;
    const p = (cprOk ? 1 : 0.05) * (reversible ? 1 : 0.1) * 0.35 * smoothstep(0.25, 0.7, cv.myocardialViability) * (0.3 + 0.7 * ch.alpha1);
    if (rng.arrhythmia.hazard(p, dt)) setRhythm(ctx, 'sinus', 'organised electrical activity returned');
  }
}

export interface ShockOutcome {
  message: string;
  severity: 'info' | 'notice' | 'warning' | 'critical' | 'good';
}

/** Deliver a defibrillation / cardioversion shock. */
export function deliverShock(ctx: StepContext, energyJ: number, sync: boolean): ShockOutcome {
  const { phys, rng, ch } = ctx;
  const cv = phys.cv;
  const r = cv.rhythm;
  const energyFactor = clamp(0.55 + (energyJ / 200) * 0.35, 0.2, 0.95);
  const conscious = phys.neuro.consciousness > 0.45 && phys.neuro.sedation < 0.5;
  if (conscious) {
    ctx.s.detectors['procPain'] = 10;
    ctx.emit({ kind: 'patient', code: 'patient.shockPain', message: 'The patient cries out — shock delivered while conscious and unsedated', severity: 'warning' });
  }

  if (r === 'vfib' || (r === 'vtach' && !sync)) {
    const viability = smoothstep(0.08, 0.65, cv.myocardialViability);
    const k = phys.chem.k;
    let p = energyFactor * viability * (1 + 0.15 * ch.amiodarone);
    if (phys.thermo.core < 30) p *= 0.3;
    if (k > 7) p *= 0.5 + 0.5 * clamp((phys.chem.ica - 1.15) / 0.5, 0, 1);
    if (phys.chem.ph < 7.05) p *= 0.8;
    if (rng.defib.chance(clamp(p, 0, 0.95))) {
      terminatePathologicRhythm(ctx, 'vtach');
      const next: Rhythm = cv.myocardialViability > 0.25 ? 'sinus' : 'asystole';
      cv.stunning = Math.max(cv.stunning, 0.35);
      setRhythm(ctx, next, 'defibrillation');
      return {
        message: next === 'sinus' ? `Shock ${energyJ} J: VF terminated — organised rhythm on monitor. Check for a pulse.` : `Shock ${energyJ} J: VF terminated into asystole.`,
        severity: next === 'sinus' ? 'good' : 'warning',
      };
    }
    return { message: `Shock ${energyJ} J delivered — ${r === 'vfib' ? 'VF' : 'VT'} persists.`, severity: 'warning' };
  }

  if (sync && (r === 'svt' || r === 'afib' || r === 'vtach')) {
    const base = r === 'svt' ? 0.92 : r === 'vtach' ? 0.88 : 0.72;
    const needed = r === 'svt' ? 50 : r === 'vtach' ? 100 : 120;
    const p = base * clamp(energyJ / needed, 0.3, 1) * (0.5 + 0.5 * smoothstep(0.2, 0.6, cv.myocardialViability));
    if (rng.defib.chance(p)) {
      terminatePathologicRhythm(ctx, r);
      if (r === 'afib') ctx.s.detectors['afibPathology'] = false;
      setRhythm(ctx, 'sinus', 'synchronised cardioversion');
      return { message: `Synchronised shock ${energyJ} J: converted to sinus rhythm.`, severity: 'good' };
    }
    return { message: `Synchronised shock ${energyJ} J delivered — rhythm unchanged.`, severity: 'notice' };
  }

  if (!sync && (r === 'sinus' || r === 'svt' || r === 'afib' || r === 'chb' || r === 'paced')) {
    if (rng.defib.chance(0.25)) {
      setRhythm(ctx, 'vfib', 'unsynchronised shock on T wave');
      return { message: `Unsynchronised ${energyJ} J shock on an organised rhythm induced ventricular fibrillation.`, severity: 'critical' };
    }
    return { message: `Unsynchronised ${energyJ} J shock delivered on an organised rhythm — no benefit (not a shockable rhythm).`, severity: 'warning' };
  }

  if (r === 'asystole') {
    return { message: `Shock ${energyJ} J delivered into asystole — no effect. Asystole is not a shockable rhythm.`, severity: 'warning' };
  }
  return { message: `Shock ${energyJ} J delivered — no rhythm change.`, severity: 'notice' };
}
