import { clamp, ramp, smoothstep } from '../core/math';
import type { StepContext } from './state';
import type { Appearance, DerivedClinical } from './snapshot';

/**
 * Visible signs derived from simulated physiology — used by the 3D renderer
 * (skin shader), the examination module and the AI patient context.
 *
 * - Cyanosis appears when deoxygenated haemoglobin exceeds ≈5 g/dL
 *   (central: arterial; peripheral: also low flow/high extraction), so
 *   anaemic patients can be severely hypoxaemic without cyanosis.
 * - Pallor from low haemoglobin and α-mediated cutaneous vasoconstriction.
 * - Mottling from severe peripheral hypoperfusion.
 * - Diaphoresis from sympathetic activation/hypoglycaemia/fever defervescence.
 */
export function deriveAppearance(ctx: StepContext): Appearance {
  const { phys, mods, calib } = ctx;
  const { blood, resp, cv, neuro, infl } = phys;
  const deoxyArterial = blood.hb * (1 - resp.sao2);
  const deoxyPeripheral = blood.hb * (1 - resp.svo2 * 0.5 - resp.sao2 * 0.5);
  const cyanosisCentral = smoothstep(3.5, 7, deoxyArterial);
  const cyanosisPeripheral = clamp(Math.max(cyanosisCentral, smoothstep(4.5, 8, deoxyPeripheral) * (1 - cv.peripheralPerfusion * 0.5)), 0, 1);
  const anaemia = ramp(12, 6, blood.hb);
  const vasoconstriction = clamp(1 - cv.peripheralPerfusion, 0, 1);
  const pallor = clamp(0.6 * anaemia + 0.55 * vasoconstriction * (neuro.sympathetic > calib.s0 ? 1 : 0.6), 0, 1);
  const mottling = smoothstep(0.4, 0.12, cv.peripheralPerfusion) * (cv.pulsePresent ? 1 : 0.7);
  const diaphoresis = neuro.sweating;
  const bleedInst = ctx.s.pathologies.find((p) => p.type === 'hemorrhage' && !p.resolved);
  const bleedRate = Number(bleedInst?.state['currentRate'] ?? 0);
  const site = bleedInst ? String(bleedInst.params['site']) : null;
  const visibleSites = ['leftThigh', 'rightThigh', 'leftArm', 'rightArm', 'scalp'];
  const accessory = clamp((resp.workOfBreathing - 1.8) / 3, 0, 1) * (resp.spontaneous ? 1 : 0) * (1 - neuro.paralysis);
  return {
    pallor,
    cyanosisCentral,
    cyanosisPeripheral,
    flushing: infl.flushing,
    urticaria: infl.urticaria,
    mottling,
    diaphoresis,
    angioedema: clamp(Math.max(resp.upperAirwayEdema, mods.angioedemaTarget), 0, 1),
    bleeding: site && visibleSites.includes(site) ? { site, intensity: clamp(bleedRate / 80, 0.05, 1) } : null,
    accessoryMuscles: accessory,
    nasalFlare: clamp(accessory * 0.9 + ramp(90, 80, resp.sao2 * 100) * 0.4, 0, 1) * (resp.spontaneous ? 1 : 0),
  };
}

export function deriveClinical(ctx: StepContext): DerivedClinical {
  const { cv, resp, neuro } = ctx.phys;
  const organised = cv.rhythm !== 'vfib' && cv.rhythm !== 'asystole';
  const pleth = cv.pulsePresent ? clamp(((cv.sbp - cv.dbp) / 45) * clamp(cv.peripheralPerfusion, 0, 1.2), 0, 1.5) : 0;
  const reliable = ctx.therapy.monitoring.spo2 && cv.pulsePresent && cv.peripheralPerfusion > 0.12 && neuro.agitation < 0.85;
  const speech: DerivedClinical['speechQuality'] = !resp.canSpeak ? 'none' : neuro.dyspnea > 7.5 || resp.stridor > 0.6 ? 'words' : neuro.dyspnea > 5 ? 'phrases' : 'sentences';
  return {
    shockIndex: cv.sbp > 0 ? cv.hr / cv.sbp : 0,
    centralPulse: cv.pulsePresent,
    radialPulse: cv.radialPulse,
    pea: organised && !cv.pulsePresent,
    arrest: !cv.pulsePresent,
    plethAmplitude: pleth,
    spo2Reliable: reliable,
    canSpeak: resp.canSpeak,
    speechQuality: speech,
    painSite: String(ctx.s.detectors['painSite'] ?? ''),
    lastShockAt: Number(ctx.s.detectors['lastShockAt'] ?? -1),
    nibpMeasuring: typeof ctx.s.detectors['nibpResultAt'] === 'number',
    pending: ctx.therapy.pending.map((p) => ({ kind: p.kind, completesAt: p.completesAt })),
  };
}
