import { approach, clamp, ramp, smoothstep } from '../core/math';
import type { StepContext } from '../engine/state';
import { FLUID_MAP } from '../pharmacology/drugs';
import { oncoticPressure } from './gas';

/**
 * Body fluids, blood, kidneys and coagulation.
 *
 * Compartments: plasma, interstitial fluid (ISF), intracellular fluid (ICF),
 * red-cell volume. Exchanges:
 *  - Infused crystalloid/colloid/blood products enter plasma with their
 *    electrolyte, protein, red-cell, platelet and factor content (and their
 *    temperature — cold products cool the patient).
 *  - Haemorrhage removes whole blood (and consumes factors/platelets).
 *  - Starling filtration: J = Kf·leak·[(Pc − Pif) − σ(πp − πi)] with lymphatic
 *    return; capillary pressure tracks venous/arterial pressures, oncotic
 *    pressures follow simulated protein concentrations. Crystalloid therefore
 *    redistributes (~¼ stays intravascular), colloid stays longer unless
 *    capillaries leak, and plasma is refilled from the ISF after haemorrhage
 *    (haemodilution appears over time, not instantly).
 *  - Osmotic water shift ECF ↔ ICF (e.g. hyperglycaemia, hypertonic loads).
 *  - Kidneys: autoregulated GFR, volume-sensitive urine flow, osmotic
 *    diuresis, loop diuretic natriuresis, AKI from sustained hypoperfusion,
 *    creatinine/urea kinetics.
 * Reference: Starling EH (1896); Landis & Pappenheimer (1963); Hahn RG,
 * volume kinetics of crystalloids (2010).
 */

export interface FluidStepResult {
  /** Heat removed by warming infused fluids to body temperature (W) */
  infusionHeatLossW: number;
}

export function stepFluids(ctx: StepContext): FluidStepResult {
  const { phys, calib: c, ch, mods, therapy, patient, dt } = ctx;
  const { blood, fluids, chem, cv, renal, thermo } = phys;
  const dtMin = dt / 60;
  const w = patient.weightKg / 70;
  let heatW = 0;

  // ---------------------------------------------------------------- infusions (fluids & blood)
  for (const inf of therapy.infusions) {
    if (inf.stoppedAt !== null || inf.kind === 'drug') continue;
    const def = FLUID_MAP[inf.agentId];
    if (!def) continue;
    const vol = Math.min(inf.remainingMl, (inf.rate / 3600) * dt);
    if (vol <= 0) continue;
    inf.remainingMl -= vol;
    inf.infusedMl += vol;
    fluids.totalIn += vol;
    const rbc = vol * def.hct;
    const plasmaVol = vol - rbc;
    const oldPv = blood.plasmaVolume;
    blood.plasmaVolume += plasmaVol;
    blood.rbcVolume += rbc;
    blood.volume += vol;
    cv.vSystemic += vol;
    chem.naMass += (def.na * vol) / 1000;
    chem.clMass += (def.cl * vol) / 1000;
    chem.kMass += (def.k * vol) / 1000;
    chem.glucoseMass += (def.glucose * vol) / 1000;
    chem.hco3Mass += (def.hco3Equivalent * vol * 0.85 * patient.baseline.hepaticFunction) / 1000;
    blood.plasmaProtein += (def.protein * plasmaVol) / 1000;
    blood.clottingFactors = (blood.clottingFactors * oldPv + def.factors * plasmaVol) / Math.max(1, blood.plasmaVolume);
    blood.fibrinogen = (blood.fibrinogen * oldPv + def.fibrinogenGL * plasmaVol) / Math.max(1, blood.plasmaVolume);
    blood.platelets = (blood.platelets * oldPv) / Math.max(1, blood.plasmaVolume) + (def.plateletsPerUnit * (vol / def.unitVolume)) / w;
    chem.ica = Math.max(0.5, chem.ica - (def.citrateCaDrop * (vol / def.unitVolume)) / w);
    const fluidTemp = inf.warmed ? 38 : def.kind === 'blood' && def.id !== 'platelets' ? 6 : 21;
    heatW += (vol * 4.18 * (thermo.core - fluidTemp)) / dt;
    if (inf.remainingMl <= 0.01) {
      inf.remainingMl = 0;
      inf.stoppedAt = ctx.t;
      ctx.emit({ kind: 'action', code: 'fluid.complete', message: `${inf.label} completed (${Math.round(inf.infusedMl)} mL)`, severity: 'info' });
    }
  }

  // ---------------------------------------------------------------- haemorrhage
  const bleed = Math.max(0, mods.bleedingRate);
  blood.bleedingRate = bleed;
  if (bleed > 0) {
    const vol = Math.min(blood.volume * 0.2, bleed * dtMin);
    const hct = blood.rbcVolume / blood.volume;
    const plasmaLoss = vol * (1 - hct);
    const ecfMl = blood.plasmaVolume + fluids.isf;
    const frac = plasmaLoss / ecfMl;
    chem.naMass -= chem.naMass * frac;
    chem.clMass -= chem.clMass * frac;
    chem.kMass -= chem.kMass * frac;
    chem.hco3Mass -= chem.hco3Mass * frac;
    chem.glucoseMass -= chem.glucoseMass * frac;
    blood.plasmaProtein -= blood.plasmaProtein * (plasmaLoss / blood.plasmaVolume);
    blood.rbcVolume -= vol * hct;
    blood.plasmaVolume -= plasmaLoss;
    blood.volume -= vol;
    cv.vSystemic -= vol;
    blood.cumulativeLoss += vol;
    fluids.totalOut += vol;
    // consumption of factors/platelets beyond dilution
    blood.clottingFactors = Math.max(0.05, blood.clottingFactors - (vol / c.bv0) * 0.35);
    blood.fibrinogen = Math.max(0.2, blood.fibrinogen - (vol / c.bv0) * 1.2);
    blood.platelets = Math.max(5, blood.platelets - (vol / c.bv0) * blood.platelets * 0.4);
  }

  // ---------------------------------------------------------------- GI / insensible losses
  const insensible = (0.55 + 0.6 * phys.neuro.sweating + 0.1 * Math.max(0, thermo.core - 37)) * w; // mL/min
  const loss = mods.waterLoss + insensible;
  const fromPlasma = loss * 0.25 * dtMin;
  const fromIsf = loss * 0.75 * dtMin;
  blood.plasmaVolume -= fromPlasma;
  blood.volume -= fromPlasma;
  cv.vSystemic -= fromPlasma;
  fluids.isf = Math.max(1000, fluids.isf - fromIsf);
  fluids.totalOut += loss * dtMin;
  // insensible water loss is solute-free; GI losses carry solutes via mods.*Loss

  // ---------------------------------------------------------------- Starling exchange
  const pv = blood.plasmaVolume;
  const isf = fluids.isf;
  const tp = (blood.plasmaProtein / pv) * 100;
  const isfTp = (blood.interstitialProtein / isf) * 100;
  const piP = oncoticPressure(tp);
  const piI = oncoticPressure(isfTp);
  const pc = c.pc0 + 0.18 * (cv.map - c.map0) + 0.9 * (Math.max(cv.rap, 0) - c.rap0);
  const isfRatio = isf / c.isf0;
  const pif = isfRatio >= 1 ? c.pif0 + (isfRatio - 1) * 12 : c.pif0 - (1 - isfRatio) * 25;
  const sigma = clamp(0.9 - mods.sigmaReduction, 0.2, 0.95);
  const leak = mods.capillaryLeak;
  phys.infl.capillaryLeak = leak;
  phys.infl.sigma = sigma;
  const j = c.kf * leak * (pc - pif - sigma * (piP - piI) - c.starlingOffset);
  const lymph = c.lymph0 * clamp(1 + 0.35 * (pif - c.pif0), 0.3, 8);
  fluids.filtration = j;
  fluids.lymph = lymph;
  const netToIsf = (j - lymph) * dtMin;
  blood.plasmaVolume -= netToIsf;
  blood.volume -= netToIsf;
  cv.vSystemic -= netToIsf;
  fluids.isf += netToIsf;
  const protLeak = (Math.max(0, j) * (1 - sigma) * tp) / 100 + (c.proteinPs * leak * (tp - isfTp)) / 100;
  const protReturn = (lymph * isfTp) / 100;
  const dProt = (protLeak - protReturn) * dtMin;
  blood.plasmaProtein = Math.max(5, blood.plasmaProtein - dProt);
  blood.interstitialProtein = Math.max(5, blood.interstitialProtein + dProt);
  blood.albumin = clamp(((blood.plasmaProtein / blood.plasmaVolume) * 100 - 3) * 1, 0.8, 6);

  // ---------------------------------------------------------------- osmotic ECF <-> ICF
  const ecfMl = blood.plasmaVolume + fluids.isf;
  const osmEcf = (2 * chem.naMass * 1000) / ecfMl + (chem.glucoseMass * 1000) / ecfMl + chem.bun / 2.8;
  const osmIcf = (fluids.icfOsmoles * 1000) / fluids.icf;
  const water = 40 * w * (osmIcf - osmEcf) * dtMin; // mL into ICF (+)
  fluids.icf += water;
  fluids.isf -= water * 0.8;
  blood.plasmaVolume -= water * 0.2;
  blood.volume -= water * 0.2;
  cv.vSystemic -= water * 0.2;

  // ---------------------------------------------------------------- kidneys
  const mapFactor = cv.map >= 80 ? 1 : cv.map >= 45 ? 0.15 + (0.85 * (cv.map - 45)) / 35 : Math.max(0, (0.15 * (cv.map - 20)) / 25);
  const sympRenal = 1 - 0.4 * clamp(phys.neuro.sympathetic - c.s0, 0, 1);
  renal.perfusion = clamp(mapFactor * sympRenal * Math.pow(Math.max(0, cv.co) / c.co0, 0.3), 0, 1.2);
  renal.aki = clamp(renal.aki + (0.004 * ramp(0.6, 0.2, renal.perfusion) + mods.renalInjuryRate) * dtMin - (renal.perfusion > 0.8 ? 0.0003 * dtMin : 0), 0, 0.95);
  const ecfNow = (blood.plasmaVolume + fluids.isf) / c.ecf0;
  const volumeGfr = 0.45 + 0.55 * smoothstep(0.76, 0.96, ecfNow);
  renal.gfr = c.gfr0 * (1 - renal.aki) * mapFactor * sympRenal * volumeGfr;
  const bvRatio = blood.volume / c.bv0;
  const ecfRatio = ecfMl / c.ecf0;
  const volumeAvidity = smoothstep(0.8, 1.0, bvRatio) * 0.7 + 0.3;
  const natriuresis = 1 + 4 * Math.max(0, ecfRatio - 1.03);
  const glucosuria = Number(ctx.s.detectors['glucosuria'] ?? 0);
  const nephronMass = Math.sqrt(clamp(patient.baseline.renalFunction, 0.05, 1.2));
  let urine = 1.0 * w * nephronMass * (renal.gfr / c.gfr0) * volumeAvidity * natriuresis + 2.5 * glucosuria + 12 * w * ch.diuretic * (renal.gfr / c.gfr0);
  if (therapy.procedures.dialysis.active) urine *= 0.3;
  urine = Math.max(0, urine);
  renal.urineMlPerHour = approach(renal.urineMlPerHour, urine * 60, 120, dt);
  const uVol = urine * dtMin;
  renal.urineTotal += uVol;
  fluids.totalOut += uVol;
  blood.plasmaVolume -= uVol;
  blood.volume -= uVol;
  cv.vSystemic -= uVol;
  const uNa = 20 + 90 * ch.diuretic + 60 * Math.max(0, ecfRatio - 1.02) + 20 * (1 - volumeAvidity) + 45 * clamp(glucosuria / 0.4, 0, 1);
  chem.naMass -= (uNa * uVol) / 1000;
  chem.clMass -= ((uNa + 10) * uVol) / 1000;
  chem.glucoseMass -= glucosuria * dtMin;

  // creatinine & urea kinetics (distribution: total body water)
  const tbwDl = (ecfMl + fluids.icf) / 100;
  const creatMass = chem.creatinine * tbwDl;
  const creatNew = creatMass + (c.creatinineProduction - (renal.gfr / 100) * chem.creatinine - (therapy.procedures.dialysis.active ? 1.5 * chem.creatinine : 0)) * dtMin;
  chem.creatinine = Math.max(0.2, creatNew / tbwDl);
  const fe = 0.5 * clamp(volumeAvidity + 0.2, 0.4, 1.1);
  const bunMass = chem.bun * tbwDl;
  const bunNew = bunMass + (c.ureaProduction * (mods.bleedingSite === 'gi' ? 1.6 : 1) - (renal.gfr / 100) * chem.bun * fe - (therapy.procedures.dialysis.active ? 2 * chem.bun : 0)) * dtMin;
  chem.bun = Math.max(2, bunNew / tbwDl);

  // ---------------------------------------------------------------- blood indices & coagulation
  blood.volume = blood.plasmaVolume + blood.rbcVolume;
  cv.vSystemic = blood.volume - cv.vPulmonary;
  blood.hct = blood.rbcVolume / blood.volume;
  blood.hb = blood.hct / 0.03;
  blood.clottingFactors = Math.min(1.1, blood.clottingFactors + (0.004 * patient.baseline.hepaticFunction * (1 - blood.clottingFactors)) * dtMin);
  blood.inr = clamp(Math.pow(1 / Math.max(0.05, blood.clottingFactors), 0.9) * (1 + 0.3 * ramp(35, 30, thermo.core)), 0.9, 9);
  blood.aptt = clamp((30 / Math.pow(Math.max(0.05, blood.clottingFactors), 0.8)) * (1 + 2.4 * ch.anticoagulant), 22, 200);
  if (mods.plateletConsumption > 0) blood.platelets = Math.max(5, blood.platelets - mods.plateletConsumption * dtMin);
  const wbcTarget = mods.wbcTarget ?? patient.baseline.wbc * (1 + 0.6 * ch.steroid) * (1 + 0.3 * clamp(phys.neuro.sympathetic - c.s0, 0, 1));
  blood.wbc = approach(blood.wbc, wbcTarget, 90 * 60, dt);

  fluids.netBalance = fluids.totalIn - fluids.totalOut;
  return { infusionHeatLossW: heatW };
}

/** Clot efficacy 0..1 used by haemorrhage modules (lethal triad + drugs). */
export function clotEfficacy(ctx: StepContext): number {
  const { blood, thermo, chem } = ctx.phys;
  const ch = ctx.ch;
  const factors = Math.pow(clamp(blood.clottingFactors, 0, 1.2), 0.7);
  const plt = Math.pow(clamp(blood.platelets / 150, 0, 1.2), 0.35);
  const fib = Math.pow(clamp(blood.fibrinogen / 2, 0, 1.2), 0.3);
  const temp = clamp(1 - 0.1 * Math.max(0, 36 - thermo.core), 0.3, 1);
  const ph = clamp(1 - 1.4 * Math.max(0, 7.3 - chem.ph), 0.3, 1);
  const ica = clamp(1 - 1.2 * Math.max(0, 0.9 - chem.ica), 0.5, 1);
  const drugs = (1 - 0.6 * ch.anticoagulant) * (1 - 0.7 * ch.fibrinolytic) * (1 - 0.25 * ch.antiplatelet) * (1 + 0.18 * ch.antifibrinolytic);
  return clamp(factors * plt * fib * temp * ph * ica * drugs, 0.02, 1.2);
}
