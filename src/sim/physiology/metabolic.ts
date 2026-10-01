import { approach, clamp, ramp } from '../core/math';
import type { StepContext } from '../engine/state';
import type { DirectInputs } from '../pharmacology/pkpd';
import { DRUG_MAP } from '../pharmacology/drugs';
import { baseExcess, phFrom } from './gas';

/**
 * Metabolism, glucose homeostasis, electrolytes and acid–base.
 *
 *  - VO2 demand scales with temperature (Q10≈2 → ~10 %/°C), shivering,
 *    sympathetic tone, seizures, work of breathing, sepsis.
 *  - O2 debt (demand − supply) generates lactate; hepatic (flow- and
 *    function-dependent) clearance removes it. Lactic/keto-acid production
 *    consumes ECF bicarbonate (≈55 % of the buffer load) and liberates CO2.
 *  - Glucose: hepatic output (suppressed by insulin action, stimulated by
 *    catecholamines/glucagon, limited by glycogen), insulin-independent
 *    (brain) and insulin-dependent uptake, renal glucosuria above threshold
 *    (→ osmotic diuresis). Insulin action lags plasma insulin (remote
 *    compartment, Bergman-style).
 *  - Potassium: ECF/ICF distribution shifted by insulin, β2 stimulation and
 *    acidaemia; renal excretion depends on GFR; dialysis removes it.
 *  - pH from Henderson–Hasselbalch using simulated HCO3− and PaCO2.
 */

export function applyDirectInputs(ctx: StepContext, d: DirectInputs): void {
  const { chem, fluids, blood, metab } = ctx.phys;
  const ecfL = (blood.plasmaVolume + fluids.isf) / 1000;
  chem.glucoseMass += d.glucose;
  chem.kMass += d.k;
  chem.naMass += d.na;
  chem.clMass += d.cl;
  chem.hco3Mass += d.hco3;
  if (d.ca > 0) chem.ica += (d.ca * 0.45) / Math.max(1, ecfL);
  if (d.mg > 0) chem.mg += d.mg / Math.max(1, ecfL);
  if (d.waterMl > 0) {
    blood.plasmaVolume += d.waterMl;
    blood.volume += d.waterMl;
    ctx.phys.cv.vSystemic += d.waterMl;
    fluids.totalIn += d.waterMl;
  }
  if (d.co2Ml > 0) ctx.s.detectors['co2Load'] = Number(ctx.s.detectors['co2Load'] ?? 0) + d.co2Ml;
  void metab;
}

export function stepMetabolic(ctx: StepContext): void {
  const { phys, calib: c, ch, mods, patient, dt, pharm } = ctx;
  const { chem, metab, thermo, neuro, resp, cv, blood, fluids, renal } = phys;
  const dtMin = dt / 60;
  const b = patient.baseline;
  const w = patient.weightKg / 70;
  const ecfMl = blood.plasmaVolume + fluids.isf;
  const ecfL = ecfMl / 1000;
  const tbwL = (ecfMl + fluids.icf) / 1000;

  // ---------------------------------------------------------------- O2 demand
  const q10 = 1 + 0.1 * (thermo.core - 37);
  metab.metabolicRate =
    clamp(q10, 0.3, 1.6) *
    (1 + 0.9 * thermo.shivering) *
    (1 + 0.25 * Math.max(0, neuro.sympathetic - c.s0)) *
    mods.vo2Factor *
    (neuro.seizure ? 2.2 : 1) *
    (1 + 0.04 * Math.max(0, resp.workOfBreathing - 1)) *
    (1 - 0.15 * ch.nmBlock) *
    (1 - 0.12 * neuro.sedation) *
    (1 + 0.3 * neuro.agitation);
  metab.vo2Demand = c.vo2Basal * metab.metabolicRate;
  const co2Load = Number(ctx.s.detectors['co2Load'] ?? 0);
  const co2Release = co2Load * (1 - Math.exp(-dtMin / 2));
  ctx.s.detectors['co2Load'] = co2Load - co2Release;

  // ---------------------------------------------------------------- lactate
  const hepaticFlow = clamp(Math.pow(cv.co / c.co0, 0.9) * (1 - 0.35 * Math.max(0, neuro.sympathetic - c.s0)), 0, 1.4);
  ctx.s.detectors['hepaticFlow'] = hepaticFlow;
  const lacProd =
    c.lactateProduction0 +
    (metab.o2Deficit / 22.4) * 2 +
    mods.lactateProduction +
    0.9 * w * Math.max(0, ch.beta2 - c.eBeta2_0) +
    (neuro.seizure ? 1.1 * w : 0) +
    0.4 * w * thermo.shivering;
  const lacClear = (3.0 * b.hepaticFunction * hepaticFlow + 0.4 * renal.perfusion) * w * (chem.lactate / (chem.lactate + 3));
  const netAcid = lacProd - lacClear; // mmol/min
  chem.lactate = clamp(chem.lactate + (netAcid * dtMin) / Math.max(10, tbwL), 0.3, 30);

  // ---------------------------------------------------------------- ketones
  const insulinTotal = chem.insulin + insulinFromDrugs(ctx);
  const ketoProd = mods.ketoProduction + 0.25 * w * ramp(-0.55, -0.9, chem.insulinAction);
  const ketoOxidised = 0.035 * w * chem.ketones * (1 + Math.max(0, chem.insulinAction) * 2);
  // Urinary ketoanion loss removes potential bicarbonate (no HCO3 regenerated)
  const ketoUrine = (renal.gfr / c.gfr0) * 0.012 * chem.ketones * ecfL * 0.1;
  const netKeto = ketoProd - ketoOxidised - ketoUrine;
  // Ketoanions stay largely extracellular (Δanion gap ≈ ΔHCO3 in DKA)
  chem.ketones = clamp(chem.ketones + (netKeto * dtMin) / Math.max(5, ecfL), 0.05, 12);

  // Acid load consumes ECF bicarbonate (lactate Δ/Δ ≈ 1.6 → ~60 % borne by ECF HCO3; ketoacids ≈ 1:1) and liberates CO2
  const lacBuffered = ((netAcid * dtMin) / Math.max(10, tbwL)) * 0.62 * ecfL;
  const ketoBuffered = (ketoProd - ketoOxidised) * dtMin;
  chem.hco3Mass -= lacBuffered + ketoBuffered;
  const bufferedCo2 = Math.max(0, (lacBuffered + ketoBuffered) / Math.max(dtMin, 1e-9)) * 22.4; // mL/min
  metab.vco2 = metab.vo2 * 0.8 + bufferedCo2 + (dtMin > 0 ? co2Release / dtMin : 0);

  // ---------------------------------------------------------------- insulin / glucose
  const g = chem.glucose;
  const alphaSuppression = 1 - 0.7 * ramp(0.35, 0.9, neuro.sympathetic);
  let secretion: number;
  if (b.betaCellFunction > 0) {
    const h = Math.pow(g, 3) / (Math.pow(g, 3) + 512);
    secretion = c.insulinSecretionMax * h * b.betaCellFunction * alphaSuppression * mods.insulinSecretionFactor;
  } else {
    secretion = c.insulinSecretionMax * mods.insulinSecretionFactor; // home basal insulin (type 1)
  }
  const vIns = 0.1 * patient.weightKg;
  const clIns = 0.014 * patient.weightKg * (0.65 + 0.35 * (renal.gfr / c.gfr0));
  chem.insulin = Math.max(0, chem.insulin + ((secretion - clIns * chem.insulin) / vIns) * dtMin);
  const xTarget = clamp((b.insulinSensitivity * (insulinTotal - c.insulinBasal)) / c.insulinBasal, -0.95, 12);
  chem.insulinAction = approach(chem.insulinAction, xTarget, 20 * 60, dt);
  const x = chem.insulinAction;

  const glycogenAvail = clamp(chem.glycogen / 0.15, 0, 1);
  const catechol = 1.5 * ramp(0.3, 1, neuro.sympathetic) + 0.8 * Math.max(0, ch.beta2 - c.eBeta2_0);
  // Endogenous glucagon rises with hypoglycaemia and insulin deficiency; plus any administered glucagon
  const endoGlucagon = 1.6 * ramp(3.8, 2.0, g) + 0.8 * ramp(-0.4, -0.9, chem.insulinAction);
  const glucagonEff = 3 * ch.glucagon + endoGlucagon;
  const glycogenolysis = c.hepaticGlucoseBasal * 0.5 * (catechol + glucagonEff) * glycogenAvail;
  // Hepatic glucose output: gluconeogenesis (≈45 % basal; driven by counter-regulation) + glycogenolysis (≈55 %; needs glycogen)
  const insulinSuppression = Math.max(0.05, 1 - 0.65 * Math.max(0, Math.min(x, 3)));
  const deficiency = 1 + 0.8 * Math.max(0, -x);
  const gluconeo = 0.45 * c.hepaticGlucoseBasal * insulinSuppression * deficiency * mods.hepaticGlucoseFactor * b.hepaticFunction * (1 + 0.2 * ch.steroid);
  const glycogenBasal = 0.55 * c.hepaticGlucoseBasal * insulinSuppression * deficiency * glycogenAvail * b.hepaticFunction;
  const hgo = gluconeo + glycogenBasal + glycogenolysis;
  const glycogenSynth = 0.55 * c.hepaticGlucoseBasal * (1 + 0.5 * Math.max(0, Math.min(x, 3)));
  chem.glycogen = clamp(chem.glycogen - ((glycogenolysis + glycogenBasal - glycogenSynth * (g > 4 ? 1 : 0.3)) * dtMin) / Math.max(50, c.glycogenMmol), 0, 1.2);
  const uii = (c.uii0 * g) / (g + 1.5);
  // maximal insulin-stimulated disposal ≈ 5× basal; uptake is saturable at low glucose
  const uid = c.kId * Math.max(0, 1 + Math.min(x, 4)) * g * (g / (g + 1.2)) * 1.24 * (neuro.seizure ? 2 : 1);
  const glucosuria = Math.max(0, g - 11) * (renal.gfr / 1000) * 0.85;
  ctx.s.detectors['glucosuria'] = glucosuria;
  chem.glucoseMass = Math.max(0.5, chem.glucoseMass + (hgo - uii - uid - glucosuria) * dtMin);
  chem.glucose = chem.glucoseMass / ecfL;

  // ---------------------------------------------------------------- potassium
  const kTotalRatio = chem.kIcf / (140 * (c.icf0 / 1000));
  const acidShift = 1 + 1.5 * Math.max(0, 7.4 - chem.ph) - 0.6 * Math.max(0, chem.ph - 7.4);
  const kEq = b.potassium * Math.pow(kTotalRatio, 3) * Math.max(0.62, Math.exp(-0.12 * Math.min(Math.max(0, x), 3) - 0.35 * Math.max(0, ch.beta2 - c.eBeta2_0))) * acidShift * (1 + mods.kShiftOut) * (x < -0.5 ? 1 + 0.25 * (-0.5 - x) : 1);
  const kNow = chem.kMass / ecfL;
  const shift = ((kEq - kNow) * ecfL) / 15; // mmol/min toward equilibrium
  chem.kMass += shift * dtMin;
  chem.kIcf -= shift * dtMin;
  // Net renal K handling relative to dietary intake (zero at baseline; positive balance in renal failure)
  const kRenal = 0.06 * w * ((renal.gfr / c.gfr0) * Math.pow(kNow / b.potassium, 2) * (1 + 2 * ch.diuretic) - 1);
  const dialysis = ctx.therapy.procedures.dialysis.active ? 0.25 * Math.max(0, kNow - 4) * ecfL * 0.02 : 0;
  chem.kMass = Math.max(0.5, chem.kMass - (kRenal + dialysis + mods.kLoss) * dtMin);
  chem.k = chem.kMass / ecfL;

  // Succinylcholine potassium release
  const sux = pharm.drugs['succinylcholine'];
  if (sux && !ctx.s.detectors['suxK' + sux.firstGivenAt]) {
    ctx.s.detectors['suxK' + sux.firstGivenAt] = true;
    chem.kMass += 0.5 * ecfL;
  }

  // ---------------------------------------------------------------- Na, Cl, HCO3
  chem.naMass -= mods.naLoss * dtMin;
  chem.clMass -= mods.clLoss * dtMin;
  chem.hco3Mass -= mods.hco3Loss * dtMin;
  // Renal bicarbonate regeneration toward the patient's baseline (slow, needs kidneys)
  const hco3Now = chem.hco3Mass / ecfL;
  // Renal new-bicarbonate generation is slow and capacity-limited (≈1 mmol/kg/day)
  const renalRegen = clamp(((b.bicarbonate - hco3Now) * ecfL) / (48 * 60), -0.05, 0.025 * w * clamp(renal.gfr / c.gfr0, 0, 1.2));
  const dialysisHco3 = ctx.therapy.procedures.dialysis.active ? ((26 - hco3Now) * ecfL) / 120 : 0;
  chem.hco3Mass += (renalRegen + dialysisHco3) * dtMin;
  chem.naMass = Math.max(10, chem.naMass);
  chem.clMass = Math.max(10, chem.clMass);
  chem.hco3Mass = Math.max(0.5 * ecfL, chem.hco3Mass);
  chem.na = chem.naMass / ecfL;
  chem.cl = chem.clMass / ecfL;
  chem.hco3 = chem.hco3Mass / ecfL;

  // ---------------------------------------------------------------- Ca, Mg
  chem.ica = approach(chem.ica, 1.2, 90 * 60, dt);
  chem.mg = approach(chem.mg, 0.9, (240 * 60) / Math.max(0.2, renal.gfr / c.gfr0), dt);

  // ---------------------------------------------------------------- acid-base
  chem.ph = phFrom(chem.hco3, resp.paco2);
  chem.baseExcess = baseExcess(chem.hco3, chem.ph);
  chem.anionGap = chem.na - chem.cl - chem.hco3;
  chem.osmolality = 2 * chem.na + chem.glucose + chem.bun / 2.8;

  // Liver injury (shock liver) & bilirubin — slow markers
  const hypoperf = ramp(0.5, 0.2, hepaticFlow);
  chem.alt += (hypoperf * 3 + mods.hepaticInjury * 2) * dtMin;
  chem.alt = Math.max(15, chem.alt - (chem.alt - 22) * (1 - Math.exp(-dtMin / (47 * 60))));
  chem.ck = Math.max(60, chem.ck + (neuro.seizure ? 30 : 0) * dtMin);
}

function insulinFromDrugs(ctx: StepContext): number {
  let total = 0;
  for (const id of ['insulinRegular', 'insulinGlargine']) {
    const inst = ctx.pharm.drugs[id];
    const drug = DRUG_MAP[id];
    if (inst && drug?.pk) total += inst.a1 / (drug.pk.v1 * ctx.patient.weightKg);
  }
  return total;
}
