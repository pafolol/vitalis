import { approach, clamp, hill, ramp, smoothstep } from '../core/math';
import type { EngineState, PathologyInstance, StepContext } from '../engine/state';
import { DRUG_MAP } from '../pharmacology/drugs';
import { administerBolus } from '../pharmacology/pkpd';
import type { PkContext } from '../pharmacology/types';
import type { PathologyParams, PathologyType } from '../scenarios/schema';
import { clotEfficacy } from '../physiology/fluids';
import { buildPkContext } from '../engine/pkContext';

/**
 * Reusable pathology modules.
 *
 * A module owns its private state (e.g. pathogen burden, mast-cell mediator
 * level, pleural leak) and each tick contributes *modifiers* to the
 * physiology — it never assigns vital signs. Toxic exposures are given as
 * real doses through the pharmacology engine. Scenarios compose modules.
 */

export interface InitContext {
  s: EngineState;
  pkContext: PkContext;
}

export interface PathologyModule<K extends PathologyType> {
  type: K;
  label: string;
  system: string;
  init?(inst: PathologyInstance, params: PathologyParams<K>, ctx: InitContext): void;
  step(inst: PathologyInstance, params: PathologyParams<K>, ctx: StepContext): void;
}

const LIMB_OF: Record<string, string> = { leftThigh: 'leftLeg', rightThigh: 'rightLeg', leftArm: 'leftArm', rightArm: 'rightArm' };
const EXTERNAL_SITES = new Set(['leftThigh', 'rightThigh', 'leftArm', 'rightArm', 'scalp']);

const hemorrhage: PathologyModule<'hemorrhage'> = {
  type: 'hemorrhage',
  label: 'Haemorrhage',
  system: 'haematology',
  init(inst, params, { s }) {
    inst.state['hemostasis'] = 0;
    const loss = params.priorLossMl;
    if (loss > 0) {
      const b = s.phys.blood;
      const hct = b.rbcVolume / b.volume;
      b.rbcVolume -= loss * hct;
      b.plasmaVolume -= loss * (1 - hct);
      b.plasmaProtein *= 1 - (loss * (1 - hct)) / (b.plasmaVolume + loss * (1 - hct));
      b.volume -= loss;
      s.phys.cv.vSystemic -= loss;
      b.cumulativeLoss += loss;
      b.clottingFactors = Math.max(0.3, b.clottingFactors - (loss / s.calib.bv0) * 0.3);
    }
  },
  step(inst, p, ctx) {
    const { phys, therapy, mods, dt } = ctx;
    const map = phys.cv.map;
    let control = 0;
    const limb = LIMB_OF[p.site];
    if (limb && therapy.procedures.tourniquet === limb) control = 0.97;
    else if (EXTERNAL_SITES.has(p.site) && therapy.procedures.directPressure) control = 0.65;
    if (p.site === 'pelvis' && therapy.procedures.pelvicBinder) control = Math.max(control, 0.4);
    const internal = !EXTERNAL_SITES.has(p.site);
    if (internal && therapy.procedures.hemostasis.done) control = 0.96;
    let hemostasis = Number(inst.state['hemostasis'] ?? 0);
    const clot = clotEfficacy(ctx);
    // Small bleeds clot spontaneously at low pressure; a pressure surge can dislodge the clot
    hemostasis += (dt / 60) * 0.06 * clot * ramp(95, 55, map) * ramp(80, 10, p.rateMlMin);
    if (map > 100) hemostasis *= 1 - 0.02 * (dt / 1);
    hemostasis = clamp(hemostasis, 0, 0.9);
    inst.state['hemostasis'] = hemostasis;
    const pressureDriven = p.rateMlMin * Math.pow(Math.max(0, map) / 90, 1.4);
    const rate = pressureDriven * (1 - control) * (1 - hemostasis) * clamp(1.7 - 0.8 * clot, 0.6, 1.8) * (1 + 1.5 * ctx.ch.fibrinolytic);
    mods.bleedingRate += rate;
    mods.bleedingSite = p.site;
    if (p.site === 'chestLeft') mods.pleuralBloodRateLeft += rate;
    if (p.site === 'chestRight') mods.pleuralBloodRateRight += rate;
    const pain = p.site === 'abdomen' || p.site === 'pelvis' ? 7 : p.site === 'gi' ? 3 : 6;
    mods.nociception = Math.max(mods.nociception, pain);
    mods.nociceptionSite = p.site;
    if (p.site === 'gi') mods.nausea = Math.max(mods.nausea, 0.4);
    inst.state['currentRate'] = rate;
  },
};

const anaphylaxis: PathologyModule<'anaphylaxis'> = {
  type: 'anaphylaxis',
  label: 'Anaphylaxis',
  system: 'immune',
  init(inst) {
    inst.state['m'] = 0;
  },
  step(inst, p, ctx) {
    const { ch, mods, dt, t } = ctx;
    const minutes = Math.max(0, (t - inst.addedAt) / 60);
    const stabilise = 1 - 0.75 * Math.max(ch.beta2, 0) * (ch.beta2 > 0.35 ? 1 : 0.5);
    const steroid = 1 - 0.4 * ch.steroid;
    let m = Number(inst.state['m'] ?? 0);
    const release = 0.17 * p.severity * Math.exp(-minutes / 25) * stabilise * steroid;
    m += (release - m / 15) * (dt / 60);
    m = clamp(m, 0, 1.5);
    inst.state['m'] = m;
    const me = m;
    ctx.phys.infl.mediators = Math.max(ctx.phys.infl.mediators, me);
    const vaso = clamp(me, 0, 1) * (1 - 0.35 * ch.alpha1);
    mods.svrFactor *= 1 - 0.75 * vaso;
    mods.vasopressorResponsiveness *= 1 - 0.3 * clamp(me, 0, 1);
    mods.venousCapacitanceFactor *= 1 + 0.6 * vaso;
    mods.capillaryLeak *= 1 + 10 * me * (1 - 0.6 * ch.alpha1);
    mods.sigmaReduction += 0.5 * clamp(me, 0, 1) * (1 - 0.5 * ch.alpha1);
    mods.airwayResistanceAdd += 3.2 * me;
    mods.vqMismatchAdd += 0.08 * me;
    const edemaGain = p.exposure === 'ingested' ? 1.05 : p.exposure === 'iv' ? 0.85 : 0.75;
    mods.angioedemaTarget = Math.max(mods.angioedemaTarget, clamp(me * edemaGain * (1 - 0.6 * ch.alpha1), 0, 1));
    mods.upperAirwayEdema = Math.max(mods.upperAirwayEdema, mods.angioedemaTarget);
    mods.urticaria = Math.max(mods.urticaria, clamp(me * 1.2 * (1 - 0.7 * ch.h1Block), 0, 1));
    mods.flushing = Math.max(mods.flushing, clamp(me * (1 - 0.5 * ch.h1Block), 0, 1));
    mods.nausea = Math.max(mods.nausea, 0.45 * me);
    mods.nociception = Math.max(mods.nociception, 3 * me);
    mods.nociceptionSite = 'abdominal cramps / throat tightness';
    mods.confusionAdd += 0.1 * me;
    ctx.phys.infl.urticaria = mods.urticaria;
    ctx.phys.infl.flushing = mods.flushing;
    if (minutes > 60 && me < 0.03) inst.resolved = true;
  },
};

const asthma: PathologyModule<'asthma'> = {
  type: 'asthma',
  label: 'Acute asthma',
  system: 'respiratory',
  init(inst, p, { s, pkContext }) {
    // The exacerbation builds during the pre-arrival period toward `severity`
    inst.state['spasm'] = p.severity * 0.3;
    inst.state['inflammation'] = p.severity * 0.6;
    // Repeated use of the patient's own reliever inhaler before arrival (systemic salbutamol exposure)
    administerBolus(s.pharm, 'salbutamol', 2500 * p.severity, 'NEB', s.t, { ...pkContext, airflowFactor: 0.5 });
  },
  step(inst, p, ctx) {
    const { ch, mods, dt } = ctx;
    const dtH = dt / 3600;
    let spasm = Number(inst.state['spasm']);
    let infl = Number(inst.state['inflammation']);
    infl = clamp(infl + (p.progression * 0.5 * (1 - 0.9 * ch.steroid) - 0.3 * ch.steroid) * dtH, 0, 1.2);
    const target = clamp(p.severity * (0.75 + 0.9 * (infl - p.severity * 0.6)), 0, 1.3);
    spasm = clamp(approach(spasm, target, 1500, dt), 0, 1.3);
    inst.state['spasm'] = spasm;
    inst.state['inflammation'] = infl;
    mods.airwayResistanceAdd += 5.2 * spasm;
    mods.airwayResistanceFixed += 1.4 * infl;
    mods.vqMismatchAdd += 0.14 * spasm;
    mods.nociception = Math.max(mods.nociception, 2.5 * spasm);
    mods.nociceptionSite = 'chest tightness';
  },
};

const OPIOID_DRUG: Record<string, string> = { heroin: 'heroin', fentanyl: 'fentanyl', methadone: 'methadone', oxycodone: 'heroin' };

const opioidToxicity: PathologyModule<'opioidToxicity'> = {
  type: 'opioidToxicity',
  label: 'Opioid toxicity',
  system: 'toxicology',
  init(inst, p, { s, pkContext }) {
    const drugId = OPIOID_DRUG[p.agent] ?? 'heroin';
    const drug = DRUG_MAP[drugId]!;
    const route = drug.routes.some((r) => r.route === p.route) ? p.route : drug.routes[0]!.route;
    // oxycodone approximated as a heroin/morphine-equivalent species at ~⅓ potency
    const amount = p.doseMg * 1000 * (p.agent === 'oxycodone' ? 0.35 : 1);
    administerBolus(s.pharm, drugId, amount, route, s.t, pkContext);
    inst.state['drugId'] = drugId;
  },
  step(_inst, _p, ctx) {
    ctx.mods.symptoms.add('opioid exposure');
  },
};

const COVERAGE: Record<string, string> = {
  ecoli: 'gram-negative-community',
  klebsiellaEsbl: 'esbl',
  pseudomonas: 'pseudomonas',
  strepPneumo: 'strep',
  mssa: 'mssa',
  mrsa: 'mrsa',
};

const sepsis: PathologyModule<'sepsis'> = {
  type: 'sepsis',
  label: 'Sepsis',
  system: 'infection',
  init(inst, p) {
    inst.state['burden'] = p.burden;
    inst.state['sirs'] = smoothstep(0.05, 0.6, p.burden) * 0.5;
  },
  step(inst, p, ctx) {
    const { mods, dt, pharm, patient, ch } = ctx;
    const dtMin = dt / 60;
    let burden = Number(inst.state['burden']);
    let kill = 0;
    const cover = COVERAGE[p.organism]!;
    for (const d of Object.values(pharm.drugs)) {
      const def = DRUG_MAP[d.id];
      if (!def?.antimicrobial || !def.pk) continue;
      if (!def.antimicrobial.spectrum.includes(cover)) continue;
      const cpMgL = d.a1 / (def.pk.v1 * patient.weightKg) / 1000;
      kill += 0.05 * hill(cpMgL / def.antimicrobial.micMgL, 4, 2);
    }
    const growth = (p.growth / 60) * burden * (1 - burden);
    const immune = 0.0008 * burden;
    burden = clamp(burden + (growth - kill * burden - immune) * dtMin, 0.001, 1);
    inst.state['burden'] = burden;
    inst.state['killing'] = kill > 0.005;
    let sirs = Number(inst.state['sirs']);
    const target = smoothstep(0.04, 0.6, burden) * (1 - 0.15 * ch.steroid);
    sirs = approach(sirs, target, target > sirs ? 30 * 60 : 120 * 60, dt);
    inst.state['sirs'] = sirs;
    ctx.phys.infl.sirs = Math.max(ctx.phys.infl.sirs, sirs);
    const I = sirs;
    const w = patient.weightKg / 70;
    mods.svrFactor *= 1 - 0.5 * I;
    mods.vasopressorResponsiveness *= 1 - 0.55 * I;
    mods.venousCapacitanceFactor *= 1 + 0.15 * I;
    mods.capillaryLeak *= 1 + 2.5 * I;
    mods.sigmaReduction += 0.3 * I;
    mods.lvContractilityFactor *= 1 - 0.3 * smoothstep(0.5, 1, I);
    mods.rvContractilityFactor *= 1 - 0.2 * smoothstep(0.5, 1, I);
    const hypothermic = patient.ageYears > 78 && I > 0.75;
    mods.feverSetpointAdd += hypothermic ? -1.2 : 2.4 * I;
    mods.vo2Factor *= 1 + 0.3 * I;
    mods.lactateProduction += 0.55 * I * I * w;
    mods.wbcTarget = I > 0.92 ? 2.5 : patient.baseline.wbc + 16 * I;
    mods.plateletConsumption += 0.35 * I * I;
    mods.renalInjuryRate += 0.0012 * I * I;
    mods.hepaticInjury += 0.5 * I * I;
    mods.confusionAdd += 0.35 * smoothstep(0.3, 0.8, I);
    mods.consciousnessFactor *= 1 - 0.3 * smoothstep(0.6, 1, I);
    mods.hepaticGlucoseFactor *= 1 + 0.3 * I;
    mods.sympatheticAdd += 0.05 * I;
    if (p.source === 'pneumonia') {
      mods.shuntAdd += 0.2 * smoothstep(0.05, 0.7, burden);
      mods.lungWaterAdd += 0.35 * smoothstep(0.6, 1, I);
      mods.nociception = Math.max(mods.nociception, 3);
      mods.nociceptionSite = 'pleuritic chest pain';
    } else if (p.source === 'urinary') {
      mods.nociception = Math.max(mods.nociception, 3.5);
      mods.nociceptionSite = 'flank pain';
    } else if (p.source === 'abdominal') {
      mods.nociception = Math.max(mods.nociception, 6.5);
      mods.nociceptionSite = 'abdominal pain';
      mods.nausea = Math.max(mods.nausea, 0.4);
    } else {
      mods.nociception = Math.max(mods.nociception, 4);
      mods.nociceptionSite = 'painful swollen leg';
    }
  },
};

const hypoglycemia: PathologyModule<'hypoglycemia'> = {
  type: 'hypoglycemia',
  label: 'Hypoglycaemia',
  system: 'metabolic',
  init(_inst, p, { s, pkContext }) {
    if (p.cause === 'insulinOverdose' && p.insulinUnits > 0) {
      administerBolus(s.pharm, 'insulinGlargine', p.insulinUnits * 1000, 'SC', s.t, pkContext);
    }
    if (p.cause === 'missedMeal') s.phys.chem.glycogen = Math.min(s.phys.chem.glycogen, 0.25);
  },
  step(_inst, p, ctx) {
    if (p.cause === 'missedMeal') ctx.mods.hepaticGlucoseFactor *= 0.8;
  },
};

const dka: PathologyModule<'dka'> = {
  type: 'dka',
  label: 'Diabetic ketoacidosis',
  system: 'metabolic',
  step(_inst, p, ctx) {
    const { mods, phys, patient } = ctx;
    const w = patient.weightKg / 70;
    mods.insulinSecretionFactor *= 1 - p.severity;
    const x = phys.chem.insulinAction;
    mods.ketoProduction += 0.28 * p.severity * w * ramp(-0.3, -0.85, x);
    mods.hepaticGlucoseFactor *= 1 + 1.1 * p.severity;
    mods.sympatheticAdd += 0.06 * p.severity;
    mods.nausea = Math.max(mods.nausea, 0.35 * p.severity * ramp(1, 3, phys.chem.ketones));
    mods.nociception = Math.max(mods.nociception, 4 * p.severity * ramp(1, 4, phys.chem.ketones));
    mods.nociceptionSite = 'abdominal pain';
    // vomiting losses
    const vomit = 0.5 * p.severity * ramp(1, 4, phys.chem.ketones);
    mods.waterLoss += vomit;
    mods.naLoss += vomit * 0.06;
    mods.kLoss += vomit * 0.012 + 0.004 * w * p.severity * ramp(10, 25, phys.chem.glucose);
    mods.clLoss += vomit * 0.08;
  },
};

const dehydration: PathologyModule<'dehydration'> = {
  type: 'dehydration',
  label: 'Dehydration',
  system: 'renal',
  init(_inst, p, { s }) {
    const def = p.deficitMl;
    const b = s.phys.blood;
    const plasma = def * 0.2;
    b.plasmaVolume -= plasma;
    b.volume -= plasma;
    s.phys.cv.vSystemic -= plasma;
    s.phys.fluids.isf -= def * 0.8;
    const c = s.phys.chem;
    c.naMass -= (def * 138) / 1000;
    c.kMass -= (def * 3) / 1000;
    c.kIcf -= (def * (p.diarrhoea ? 30 : 15)) / 1000;
    if (p.diarrhoea) {
      c.hco3Mass -= (def * 30) / 1000;
      c.clMass -= (def * 95) / 1000;
    } else {
      c.clMass -= (def * 130) / 1000;
      c.hco3Mass += (def * 12) / 1000;
    }
  },
  step(_inst, p, ctx) {
    const { mods } = ctx;
    const rate = p.ongoingLossMlH / 60;
    mods.waterLoss += rate;
    mods.naLoss += rate * 0.09;
    mods.kLoss += rate * (p.diarrhoea ? 0.03 : 0.012);
    if (p.diarrhoea) {
      mods.hco3Loss += rate * 0.035;
      mods.clLoss += rate * 0.075;
    } else {
      mods.clLoss += rate * 0.11;
    }
    mods.nausea = Math.max(mods.nausea, 0.35);
    mods.nociception = Math.max(mods.nociception, 3);
    mods.nociceptionSite = 'crampy abdominal pain';
  },
};

const tensionPneumothorax: PathologyModule<'tensionPneumothorax'> = {
  type: 'tensionPneumothorax',
  label: 'Tension pneumothorax',
  system: 'respiratory',
  init(_inst, p, { s }) {
    if (p.side === 'left') s.phys.resp.pleuralAirLeft += p.initialAirMl;
    else s.phys.resp.pleuralAirRight += p.initialAirMl;
  },
  step(_inst, p, ctx) {
    const { mods, therapy, t } = ctx;
    const tube = therapy.procedures.chestTube[p.side];
    const seal = tube ? Math.exp(-(t - tube.at) / 1800) : 1;
    const leak = p.leakMlMin * seal;
    if (p.side === 'left') mods.pleuralAirRateLeft += leak;
    else mods.pleuralAirRateRight += leak;
    mods.nociception = Math.max(mods.nociception, p.traumatic ? 7 : 5);
    mods.nociceptionSite = `${p.side} pleuritic chest pain`;
  },
};

const myocardialIschemia: PathologyModule<'myocardialIschemia'> = {
  type: 'myocardialIschemia',
  label: 'Acute coronary occlusion',
  system: 'cardiovascular',
  init(inst, p) {
    inst.state['occlusion'] = p.occlusion;
    inst.state['reperfused'] = false;
  },
  step(inst, p, ctx) {
    const { mods, ch, dt, therapy, phys, rng } = ctx;
    const dtMin = dt / 60;
    let occ = Number(inst.state['occlusion']);
    let reperfused = Boolean(inst.state['reperfused']);
    if (!reperfused) {
      occ = clamp(occ + 0.0025 * (1 - 0.65 * ch.antiplatelet) * (1 - 0.5 * ch.anticoagulant) * (1 - occ) * dtMin, 0, 1);
      const minutesSinceOnset = (ctx.t - inst.addedAt) / 60;
      const lysisHazard = 0.07 * ch.fibrinolytic * Math.exp(-Math.max(0, minutesSinceOnset - 60) / 240);
      if (therapy.procedures.reperfusion.done || rng.arrhythmia.hazard(lysisHazard, dt)) {
        reperfused = true;
        ctx.emit({ kind: 'physiology', code: 'coronary.reperfused', message: `Coronary flow restored in the ${p.territory.toUpperCase()} territory`, severity: 'good' });
      }
    }
    inst.state['occlusion'] = occ;
    inst.state['reperfused'] = reperfused;
    const flow = reperfused ? 0.92 : p.collateral + (1 - occ) * (1 - p.collateral);
    mods.coronaryFlow[p.territory] = Math.min(mods.coronaryFlow[p.territory], flow);
    const isch = phys.cv.territoryIschemia[p.territory];
    mods.nociception = Math.max(mods.nociception, 7.5 * smoothstep(0.1, 0.6, isch));
    mods.nociceptionSite = 'central crushing chest pain';
    mods.nausea = Math.max(mods.nausea, 0.4 * isch);
    mods.sympatheticAdd += 0.08 * isch;
    mods.vfHazard += 0.0025 * isch;
  },
};

const arrhythmia: PathologyModule<'arrhythmia'> = {
  type: 'arrhythmia',
  label: 'Arrhythmia',
  system: 'cardiovascular',
  step(inst, p, ctx) {
    if (inst.state['terminated']) {
      if (!inst.resolved) inst.resolved = true;
      return;
    }
    const { mods, s } = ctx;
    const rhythm = p.kind === 'afib' ? 'afib' : p.kind;
    mods.forcedRhythm = rhythm;
    if (p.kind === 'svt') s.detectors['svtRate'] = p.rate ?? 190;
    if (p.kind === 'vtach') s.detectors['vtRate'] = p.rate ?? 175;
    if (p.kind === 'afib') s.detectors['afibPathology'] = true;
    mods.nociception = Math.max(mods.nociception, p.kind === 'chb' ? 1 : 2.5);
    mods.nociceptionSite = p.kind === 'chb' ? 'light-headedness' : 'palpitations / chest discomfort';
  },
};

const cardiacArrest: PathologyModule<'cardiacArrest'> = {
  type: 'cardiacArrest',
  label: 'Cardiac arrest',
  system: 'cardiovascular',
  init(inst, p, { s }) {
    s.phys.cv.rhythm = p.initialRhythm;
    s.phys.cv.rhythmTime = 0;
    s.phys.cv.pulsePresent = false;
    inst.state['cprStartsAt'] = s.t + p.noFlowMin * 60;
  },
  step(inst, _p, ctx) {
    const { t, therapy, preroll } = ctx;
    // Pre-hospital: bystander/EMS CPR after the no-flow interval (mechanical device quality)
    if (preroll && t >= Number(inst.state['cprStartsAt']) && !therapy.cpr.active) {
      therapy.cpr.active = true;
      therapy.cpr.mode = 'mechanical';
      therapy.cpr.quality = 0.7;
      therapy.bvm.active = true;
      therapy.bvm.rate = 10;
    }
  },
};

const hyperkalemia: PathologyModule<'hyperkalemia'> = {
  type: 'hyperkalemia',
  label: 'Hyperkalaemia',
  system: 'renal',
  init(inst, p, { s }) {
    // Total-body potassium excess sets a raised ECF equilibrium; shifts (insulin, β2, alkalosis) still act on it
    const ecfL = (s.phys.blood.plasmaVolume + s.phys.fluids.isf) / 1000;
    inst.state['kTarget'] = p.initialK;
    s.phys.chem.kMass = p.initialK * ecfL;
    s.phys.chem.k = p.initialK;
  },
  step(inst, p, ctx) {
    const { mods, therapy, patient, dt } = ctx;
    let target = Number(inst.state['kTarget']);
    if (therapy.procedures.dialysis.active) target = Math.max(4.3, target - (1.4 * dt) / 3600);
    else target += (p.riseMmolPerHour * dt) / 3600;
    inst.state['kTarget'] = target;
    mods.kShiftOut += target / patient.baseline.potassium - 1;
    mods.hco3Loss += 0.003;
    mods.nausea = Math.max(mods.nausea, 0.2);
    mods.symptoms.add('weakness');
  },
};

const hypothermia: PathologyModule<'hypothermia'> = {
  type: 'hypothermia',
  label: 'Accidental hypothermia',
  system: 'environmental',
  init(_inst, p, { s }) {
    s.phys.thermo.core = p.coreC;
    s.detectors['ambientC'] = p.ambientC;
    s.detectors['prehospitalAmbient'] = p.ambientC;
  },
  step(_inst, _p, ctx) {
    ctx.mods.symptoms.add('cold exposure');
  },
};

export const PATHOLOGY_MODULES: { [K in PathologyType]: PathologyModule<K> } = {
  hemorrhage,
  anaphylaxis,
  asthma,
  opioidToxicity,
  sepsis,
  hypoglycemia,
  dka,
  dehydration,
  tensionPneumothorax,
  myocardialIschemia,
  arrhythmia,
  cardiacArrest,
  hyperkalemia,
  hypothermia,
};

export function stepPathologies(ctx: StepContext): void {
  for (const inst of ctx.s.pathologies) {
    if (inst.resolved) continue;
    const startsAt = Number(inst.state['startsAt'] ?? -Infinity);
    if (ctx.t < startsAt) continue;
    const mod = PATHOLOGY_MODULES[inst.type as PathologyType] as PathologyModule<PathologyType>;
    if (!inst.state['started']) {
      inst.state['started'] = true;
      mod.init?.(inst, inst.params as PathologyParams<PathologyType>, { s: ctx.s, pkContext: buildPkContext(ctx.s) });
      if (startsAt > 0) ctx.emit({ kind: 'system', code: 'pathology.onset', message: 'A new process has begun (hidden)', severity: 'info', data: { hidden: true } });
    }
    mod.step(inst, inst.params as PathologyParams<PathologyType>, ctx);
  }
}
