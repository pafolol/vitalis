import { approach, clamp, ramp } from '../core/math';
import type { StepContext } from '../engine/state';
import type { EndogenousTone } from '../pharmacology/pkpd';

/**
 * Autonomic nervous system.
 *
 * Sympathetic (S) and parasympathetic (V) outflow are driven by the arterial
 * baroreflex, cardiopulmonary (low-pressure) receptors, peripheral/central
 * chemoreflexes, pain, anxiety, hypoglycaemia and pathology inputs, and are
 * depressed by sedatives. Sympathetic outflow acts through the *same*
 * adrenergic receptor channels as drugs (endogenous agonist tone), so
 * β-blockers blunt endogenous tachycardia and catecholamine infusions add to it.
 */

/**
 * Endogenous agonist tone at adrenergic receptors: neuronal noradrenaline
 * (sympathetic outflow) plus circulating adrenal adrenaline (released by
 * hypoglycaemia, severe stress). Adrenal output is baroreflex-independent.
 */
export function endogenousTones(sympathetic: number, adrenal = 0): EndogenousTone[] {
  return [
    { channel: 'alpha1', u: 0.6 * sympathetic + 0.15 * adrenal, emax: 1, gamma: 1.3 },
    { channel: 'beta1', u: 0.9 * sympathetic + 0.8 * adrenal, emax: 1, gamma: 1.2 },
    { channel: 'beta2', u: 0.5 * sympathetic + 1.2 * adrenal, emax: 1, gamma: 1.1 },
  ];
}

/** Adrenal medullary adrenaline output 0..1 (hypoglycaemia counter-regulation, extreme stress). */
export function adrenalOutput(glucose: number, sympathetic: number, pain: number): number {
  const hypo = glucose >= 3.8 ? 0 : Math.min(1, (3.8 - glucose) / 1.8);
  const stress = Math.max(0, (sympathetic - 0.6) / 0.4) * 0.5 + Math.max(0, (pain - 6) / 4) * 0.2;
  return Math.min(1, Math.max(hypo, stress));
}

/** Activation produced by endogenous tone alone (used for calibration baselines). */
export function endogenousActivation(u: number, gamma: number): number {
  if (u <= 0) return 0;
  const r = Math.pow(u, gamma);
  return r / (1 + r);
}

export function stepAutonomic(ctx: StepContext): void {
  const { phys, calib: c, mods, dt, chU } = ctx;
  const { cv, resp, chem, neuro, thermo } = phys;

  // Arousal/distress (central command) withdraws vagal tone and slightly resets the baroreflex, so pain,
  // fear and air hunger produce tachycardia rather than being buffered away by the reflex.
  const stress = clamp(0.06 * neuro.pain + 0.4 * neuro.anxiety + 0.09 * neuro.dyspnea + 0.5 * neuro.withdrawal, 0, 1.2);
  // (a small reset: it tolerates a modest stress-related rise but does not amplify the response to hypotension)
  const eRaw = (cv.map - c.map0) / c.map0;
  const eBaro = clamp(eRaw > 0 ? Math.max(0, eRaw - 0.03 * stress) : eRaw, -1, 1);
  let sT = c.s0 - 2.0 * eBaro;
  sT += clamp(0.06 * (c.rap0 - cv.rap), -0.1, 0.25);
  sT += 0.35 * ramp(60, 35, resp.pao2) + 0.2 * ramp(50, 85, resp.paco2) + 0.15 * ramp(7.25, 6.95, chem.ph);
  sT += 0.035 * neuro.pain + 0.15 * neuro.anxiety + 0.3 * ramp(2, 8, neuro.dyspnea);
  sT += 0.5 * ramp(3.6, 2.2, chem.glucose);
  sT += 0.15 * ramp(36, 33, thermo.core) * (thermo.core > 30 ? 1 : 0);
  sT += 0.5 * neuro.withdrawal + (neuro.seizure ? 0.35 : 0);
  sT += mods.sympatheticAdd;
  // ketamine is sympathomimetic (central and via catecholamine reuptake inhibition)
  sT += 0.25 * clamp(chU.nmda / (0.5 + chU.nmda), 0, 1);
  const depression = clamp(neuro.sedation * 0.35 + neuro.brainInjury * 0.85, 0, 0.95);
  sT = clamp(sT * (1 - depression), 0.02, 1);

  // Baroreflex and arousal-driven vagal withdrawal are not additive: the stronger withdrawal prevails
  let vT = Math.min(c.v0 + 1.6 * eBaro, c.v0 - 0.4 * stress);
  vT -= 0.25 * ramp(60, 35, resp.pao2);
  vT += 0.25 * neuro.nausea;
  vT -= 0.15 * neuro.anxiety;
  vT = clamp(vT, 0, 1);

  neuro.sympathetic = approach(neuro.sympathetic, sT, sT > neuro.sympathetic ? 3 : 8, dt);
  neuro.parasympathetic = approach(neuro.parasympathetic, vT, 1.5, dt);
}
