import { approach, clamp, hill, ramp, smoothstep } from '../core/math';
import type { StepContext } from '../engine/state';
import { ATM, WATER_VAPOUR, o2Content, po2FromContent, saturation } from './gas';

/**
 * Respiratory system.
 *
 * Mechanics & control (before the circulation step):
 *  - Pleural air/blood per hemithorax → lung collapse, raised intrathoracic
 *    pressure (tension physiology) that the circulation feels.
 *  - Upper-airway patency from consciousness (tongue), oedema, vomitus,
 *    seizure — relieved by manoeuvres/adjuncts, bypassed by an ETT.
 *  - Chemical drive (central CO2/H+, peripheral hypoxia) depressed by μ-opioid
 *    and GABAergic drugs (Minto-type interaction → synergy), abolished by
 *    neuromuscular blockade. Minute ventilation is limited by mechanics
 *    (resistance, compliance) and respiratory muscle fatigue.
 *  - Bag-mask and mechanical ventilation deliver tidal volumes subject to
 *    seal/patency; PEEP/auto-PEEP raise intrathoracic pressure.
 *
 * Gas exchange (after the circulation step):
 *  - Alveolar O2 is a dynamic store in the FRC (→ realistic apnoeic
 *    desaturation and benefit of pre-oxygenation); end-capillary content mixes
 *    with shunted and low-V/Q blood; venous O2 content is integrated from
 *    tissue consumption. PaO2 is back-calculated from content.
 *  - CO2: body/venous store integrates production minus pulmonary elimination,
 *    alveolar PCO2 from perfusion–ventilation mass balance — so EtCO2 falls
 *    with low pulmonary blood flow (e.g. during CPR) and rises with ROSC.
 */

export function oxygenFio2(ctx: StepContext, ve: number): number {
  const ox = ctx.therapy.oxygen;
  const t = ctx.therapy;
  if (t.ventilator.on && (t.airway.ett || ctx.s.detectors['surgicalAirway'])) return t.ventilator.fio2;
  if (t.bvm.active) return 0.95;
  switch (ox.device) {
    case 'none':
      return 0.21;
    case 'nasalCannula': {
      const dev = Math.min(0.44, 0.21 + 0.035 * Math.min(ox.flowLpm, 6));
      return 0.21 + (dev - 0.21) * clamp(8 / Math.max(ve, 8), 0.45, 1);
    }
    case 'simpleMask': {
      const dev = Math.min(0.58, 0.21 + 0.037 * clamp(ox.flowLpm, 0, 10));
      return 0.21 + (dev - 0.21) * clamp(10 / Math.max(ve, 10), 0.5, 1);
    }
    case 'nonRebreather': {
      const dev = ox.flowLpm >= 10 ? 0.88 : 0.21 + 0.06 * ox.flowLpm;
      return 0.21 + (dev - 0.21) * clamp(15 / Math.max(ve * 0.9, 15), 0.6, 1);
    }
    case 'highFlowNasal': {
      const set = ox.fio2Set;
      return 0.21 + (set - 0.21) * clamp(ox.flowLpm / Math.max(1, ve * 3), 0.55, 1);
    }
    default:
      return 0.21;
  }
}

function airwayPatency(ctx: StepContext): number {
  const { phys, therapy, rng, dt } = ctx;
  const { neuro, resp } = phys;
  const secured = therapy.airway.ett || !!ctx.s.detectors['surgicalAirway'];
  if (secured) {
    resp.airway = 'secured';
    resp.snoring = false;
    return 1;
  }
  const tone = smoothstep(0.2, 0.55, neuro.consciousness) * (1 - ctx.ch.nmBlock);
  let tongue = (1 - tone) * (ctx.ch.nmBlock > 0.5 ? 0.8 : 0.55);
  let relief = 0;
  const m = therapy.airway.manoeuvre;
  if (m === 'headTiltChinLift') relief = Math.max(relief, 0.7);
  if (m === 'jawThrust') relief = Math.max(relief, 0.8);
  const adj = therapy.airway.adjunct;
  if (adj === 'opa') {
    if (neuro.airwayReflexes && neuro.consciousness > 0.4) {
      // Not tolerated — gagging
      if (rng.behaviour.hazard(2, dt)) {
        therapy.airway.adjunct = 'none';
        neuro.nausea = Math.min(1, neuro.nausea + 0.5);
        ctx.emit({ kind: 'patient', code: 'airway.opaRejected', message: 'Patient gags and spits out the oropharyngeal airway (intact gag reflex)', severity: 'warning' });
      }
    } else relief = Math.max(relief, 0.85);
  }
  if (adj === 'npa') relief = Math.max(relief, 0.75);
  if (therapy.airway.recoveryPosition) relief = Math.max(relief, 0.6);
  if (relief > 0 && (adj === 'opa' || adj === 'npa') && m !== 'none') relief = Math.min(0.95, relief + 0.1);
  tongue *= 1 - relief;
  const edema = smoothstep(0.35, 0.95, resp.upperAirwayEdema) * 0.95;
  const vomit = resp.vomitInAirway ? 0.35 : 0;
  const seizure = neuro.seizure ? 0.45 : 0;
  const patency = (1 - tongue) * (1 - edema) * (1 - vomit) * (1 - seizure);
  resp.airway = patency > 0.9 ? 'patent' : patency > 0.4 ? 'partial' : 'obstructed';
  resp.snoring = tongue > 0.15 && neuro.consciousness < 0.5 && resp.spontaneous;
  return patency;
}

export function stepRespiratoryMechanics(ctx: StepContext): void {
  const { phys, calib: c, ch, chU, mods, therapy, patient, dt, rng } = ctx;
  const { resp, neuro, chem, thermo, cv } = phys;
  const b = patient.baseline;
  const dtMin = dt / 60;

  // ---------------------------------------------------------------- pleural spaces
  const hemithorax = 2600 * (patient.heightCm / 175) ** 2;
  const ppv = (therapy.ventilator.on && (therapy.airway.ett || !!ctx.s.detectors['surgicalAirway'])) || therapy.bvm.active;
  const leakMultiplier = ppv ? 3 : 1;
  resp.pleuralAirLeft += mods.pleuralAirRateLeft * leakMultiplier * dtMin;
  resp.pleuralAirRight += mods.pleuralAirRateRight * leakMultiplier * dtMin;
  resp.pleuralBloodLeft += mods.pleuralBloodRateLeft * dtMin;
  resp.pleuralBloodRight += mods.pleuralBloodRateRight * dtMin;

  for (const side of ['left', 'right'] as const) {
    const key = side === 'left' ? 'Left' : 'Right';
    const tube = therapy.procedures.chestTube[side];
    const needle = therapy.procedures.needleDecompression[side];
    const airKey = `pleuralAir${key}` as const;
    const bloodKey = `pleuralBlood${key}` as const;
    if (tube) {
      const air = resp[airKey];
      resp[airKey] = approach(air, 0, 25, dt);
      const drained = resp[bloodKey] * (1 - Math.exp(-dt / 60));
      resp[bloodKey] -= drained;
      tube.output += drained;
    } else if (needle) {
      const patentKey = `needlePatent_${side}`;
      if (ctx.s.detectors[patentKey] === undefined) ctx.s.detectors[patentKey] = true;
      const effective = ctx.s.detectors[`needleEffective_${side}`] !== false;
      if (ctx.s.detectors[patentKey] && effective) {
        resp[airKey] = approach(resp[airKey], Math.min(resp[airKey], 0.25 * hemithorax), 20, dt);
        if (rng.procedure.hazard(0.06, dt)) {
          ctx.s.detectors[patentKey] = false;
          ctx.emit({ kind: 'physiology', code: 'needle.occluded', message: `The ${side} decompression catheter has kinked/occluded — venting has stopped`, severity: 'warning' });
        }
      }
    }
    resp[airKey] = clamp(resp[airKey], 0, hemithorax * 1.2);
  }
  const occL = (resp.pleuralAirLeft + resp.pleuralBloodLeft) / hemithorax;
  const occR = (resp.pleuralAirRight + resp.pleuralBloodRight) / hemithorax;
  resp.lungExpansionLeft = clamp(1 - occL * 1.15, 0.03, 1);
  resp.lungExpansionRight = clamp(1 - occR * 1.15, 0.03, 1);
  const tension = Math.min(20, 15 * smoothstep(0.45, 1.1, occL) + 15 * smoothstep(0.45, 1.1, occR));

  // ---------------------------------------------------------------- airway
  resp.upperAirwayEdema = approach(resp.upperAirwayEdema, mods.upperAirwayEdema, mods.upperAirwayEdema > resp.upperAirwayEdema ? 240 : 900, dt);
  const patency = airwayPatency(ctx);
  resp.airwayPatency = patency;

  // ---------------------------------------------------------------- lung water & mechanics
  const hydrostatic = 0.9 * smoothstep(18, 32, cv.lap);
  const lwTarget = clamp(mods.lungWaterAdd + hydrostatic + (resp.aspirated ? 0.3 : 0), 0, 1);
  resp.lungWater = approach(resp.lungWater, lwTarget, lwTarget > resp.lungWater ? 300 : 1500, dt);

  const bronchodilation = Math.max(ch.beta2Airway, 0.85 * ch.beta2);
  const mgEffect = clamp((chem.mg - 0.9) / 1.0, 0, 1);
  const spasm = mods.airwayResistanceAdd * (1 - 0.72 * bronchodilation) * (1 - 0.22 * ch.muscarinicAirway) * (1 - 0.2 * mgEffect) * (1 - 0.25 * hill(chU.nmda, 1));
  resp.resistance = b.airwayResistance * (1 + spasm + mods.airwayResistanceFixed);
  const avgExp = (resp.lungExpansionLeft + resp.lungExpansionRight) / 2;
  const obesity = 1 - clamp((patient.bmi - 30) * 0.012, 0, 0.3);
  resp.compliance = c.compliance0 * mods.complianceFactor * (1 - 0.55 * resp.lungWater) * (0.35 + 0.65 * avgExp) * obesity;

  // ---------------------------------------------------------------- drive
  const set = c.paco2Set;
  const hco3 = Math.max(4, chem.hco3);
  const centralCO2 = resp.paco2 >= set ? 1 + 0.15 * (resp.paco2 - set) : Math.max(0.25, 1 + 0.03 * (resp.paco2 - set));
  // Arterial [H+] (nmol/L) relative to the patient's own baseline drives peripheral/central chemoreceptors
  const hArt = (24 * resp.paco2) / hco3;
  const h0 = (24 * set) / b.bicarbonate;
  const phDrive = clamp(Math.exp(0.083 * (hArt - h0)), 0.5, 4.5);
  const hypoxic = 1 + 2.0 * ramp(65, 30, resp.pao2);
  // Chemical drive (capped: maximal voluntary ventilation ≈ 6–8× resting) with chemoreflex lag
  // Pulmonary irritant (bronchoconstriction) and J-receptor (interstitial lung water) afferents add
  // non-chemical drive and favour rapid breathing — tachypnoea with a low PaCO2 early in asthma/oedema/pneumonia.
  const lungReceptors = clamp(0.6 * smoothstep(1.3, 3.5, resp.resistance / b.airwayResistance) + 0.6 * smoothstep(0.08, 0.45, resp.lungWater), 0, 1);
  let chemical = Math.min(8, centralCO2 * phDrive * hypoxic * (1 + 0.35 * lungReceptors));
  chemical *= 1 + 0.04 * neuro.pain + 0.25 * neuro.anxiety + 0.1 * Math.max(0, thermo.core - 37) + 0.3 * neuro.withdrawal + 0.2 * neuro.agitation;
  const prevChem = Number(ctx.s.detectors['chemDrive'] ?? 1);
  chemical = approach(prevChem, Math.min(9, chemical), 6, dt);
  ctx.s.detectors['chemDrive'] = chemical;
  let drive = chemical * mods.respiratoryDriveFactor;
  // Respiratory depressants: Minto-type additive interaction of μ-opioid and GABAergic drive
  const uMu = chU.mu / 2.4;
  const uGaba = chU.gaba / 2.2;
  const uR = uMu + uGaba;
  const emaxMix = uR > 0 ? (uMu * 1.0 + uGaba * 0.8) / uR : 0;
  const respDep = emaxMix * hill(uR, 1, 1.6);
  drive *= 1 - respDep;
  drive *= 1 - 0.95 * smoothstep(0.75, 1, neuro.brainInjury);
  if (neuro.seizure) drive *= 0.25;
  if (!cv.pulsePresent && cv.arrestTime > 20) drive *= Math.max(0, 1 - (cv.arrestTime - 20) / 40); // agonal → apnoea
  resp.drive = drive;
  neuro.paralysis = ch.nmBlock;
  const muscle = 1 - ch.nmBlock;

  // ---------------------------------------------------------------- spontaneous ventilation
  const veDemand = c.ve0 * drive;
  // Sustainable maximal ventilation ≈ 60 % of MVV; MVV scales ~1/R under expiratory flow limitation
  const size = clamp(patient.leanBodyMassKg / 55, 0.6, 1.5);
  const veMax = ((85 * (0.7 + 0.5 * patient.fitness) * size) / Math.pow(resp.resistance, 0.9)) * Math.pow(resp.compliance / c.compliance0, 0.4) * (1 - 0.8 * resp.fatigue) * muscle;
  const veSpont = veDemand <= 0 ? 0 : (veDemand * veMax) / Math.pow(Math.pow(veDemand, 3) + Math.pow(veMax, 3), 1 / 3);
  const restrictive = Math.pow(c.compliance0 / Math.max(10, resp.compliance), 0.35);
  // Breathing pattern: high resistance favours slower, deeper breaths; stiff lungs favour rapid shallow breathing
  const rrMax = clamp((58 / Math.pow(resp.resistance, 0.33)) * Math.pow(restrictive, 0.6), 18, 55);
  // Rate follows achieved ventilation (VT rises too), with extra rate from unmet demand ("air hunger")
  const veRatio = Math.max(veSpont, 0) / c.ve0;
  const hunger = veSpont > 0 ? (1 + 0.45 * Math.log(Math.max(1, veDemand / veSpont))) * (1 + 0.3 * neuro.anxiety) : 1;
  let rrSpont = drive <= 0 ? 0 : c.rr0 * Math.pow(veRatio, 0.55) * hunger * (1 + 0.35 * lungReceptors) * (1 - 0.65 * hill(chU.mu, 2.5, 1.5)) * restrictive * muscle;
  rrSpont = rrSpont <= 0 ? 0 : (rrSpont * rrMax) / Math.pow(Math.pow(rrSpont, 4) + Math.pow(rrMax, 4), 0.25);
  const apnoeic = drive < 0.07 || muscle < 0.1 || rrSpont < 2;
  resp.spontaneous = !apnoeic;
  const vtSpont = apnoeic ? 0 : (veSpont * 1000) / rrSpont;

  // ---------------------------------------------------------------- delivered ventilation
  const secured = therapy.airway.ett || !!ctx.s.detectors['surgicalAirway'];
  let rr = 0;
  let vt = 0;
  let peep = 0;
  let ppvDelivered = false;
  if (therapy.ventilator.on && secured) {
    const v = therapy.ventilator;
    const triggered = apnoeic ? 0 : rrSpont * (1 - neuro.sedation);
    rr = Math.max(v.rr, triggered);
    vt = v.vt;
    peep = v.peep;
    ppvDelivered = true;
  } else if (therapy.bvm.active) {
    const seal = secured ? 1 : clamp(0.35 + 0.65 * patency, 0, 1) * (resp.upperAirwayEdema > 0.8 ? 0.3 : 1);
    rr = therapy.bvm.rate;
    vt = therapy.bvm.vt * seal;
    ppvDelivered = rr > 0;
    if (!apnoeic) {
      // Spontaneous breaths continue between assisted breaths
      rr += rrSpont * 0.5;
      vt = (therapy.bvm.rate * vt + rrSpont * 0.5 * vtSpont * patency) / Math.max(1, rr);
    }
  } else if (!apnoeic) {
    rr = rrSpont;
    vt = vtSpont * (0.35 + 0.65 * patency);
    if (patency < 0.15) vt *= patency / 0.15;
  }
  if (therapy.oxygen.device === 'highFlowNasal' && !ppvDelivered) peep = Math.min(6, therapy.oxygen.flowLpm / 12);
  // Chest compressions without an advanced airway interrupt effective spontaneous breathing
  resp.rr = rr;
  resp.vt = vt;
  resp.ve = (rr * vt) / 1000;
  resp.peep = peep;

  // Dynamic hyperinflation / auto-PEEP from expiratory flow limitation
  const ieFactor = ppvDelivered ? clamp(rr / 12, 0.5, 3) : 1;
  resp.autoPeep = clamp(Math.max(0, resp.resistance - 1.6) * resp.ve * 0.18 * ieFactor, 0, 25);
  const elastic = vt / Math.max(10, resp.compliance);
  resp.plateauPressure = ppvDelivered ? peep + resp.autoPeep + elastic : 0;
  resp.peakPressure = ppvDelivered ? resp.plateauPressure + resp.resistance * 6 * (vt / 500) : 0;
  const mawp = ppvDelivered ? peep + resp.autoPeep + 0.45 * elastic : peep * 0.6 + resp.autoPeep * 0.5;
  resp.meanAirwayPressure = mawp;

  // Intrathoracic pressure felt by the heart (mmHg)
  let pit = c.pit0 + tension;
  if (ppvDelivered) pit += 4 + 0.5 * mawp * 0.74;
  else pit += 0.4 * mawp * 0.74;
  cv.intrathoracicPressure = approach(cv.intrathoracicPressure, pit, 2, dt);

  // Work of breathing & fatigue
  resp.workOfBreathing = ppvDelivered && apnoeic ? 0.2 : (resp.ve / c.ve0) * (0.6 * resp.resistance + (0.4 * c.compliance0) / Math.max(10, resp.compliance));
  if (!ppvDelivered && resp.spontaneous) {
    const load = Math.max(0, resp.workOfBreathing - 3.2);
    resp.fatigue += 0.0028 * load * (1 + ramp(60, 40, resp.pao2)) * (1 + ramp(7.3, 7.1, chem.ph)) * dtMin;
  }
  if (resp.workOfBreathing < 2 || ppvDelivered) resp.fatigue -= 0.006 * dtMin;
  resp.fatigue = clamp(resp.fatigue, 0, 0.95);

  resp.breathPhase = (resp.breathPhase + (dt * rr) / 60) % 1;
  resp.airflowFactor = clamp((veSpont / c.ve0) * patency, 0.05, 1.2) * (ppvDelivered ? 0.5 : 1);

  // Exam sounds
  resp.wheeze = smoothstep(1.7, 4.5, resp.resistance) * clamp(resp.ve / 4, 0, 1);
  resp.stridor = resp.spontaneous && !secured ? smoothstep(0.35, 0.8, resp.upperAirwayEdema) : 0;
  resp.crackles = smoothstep(0.12, 0.5, resp.lungWater);
}

export function stepGasExchange(ctx: StepContext): void {
  const { phys, calib: c, mods, therapy, dt } = ctx;
  const { resp, cv, blood, chem, thermo, metab } = phys;
  const dtMin = dt / 60;
  const hb = blood.hb;

  const secured = therapy.airway.ett || !!ctx.s.detectors['surgicalAirway'];
  const fio2 = oxygenFio2(ctx, resp.ve);
  resp.fio2 = fio2;

  // Dead space (anatomical + apparatus reduction + alveolar dead space from low pulmonary flow)
  const vdAnat = c.vdAnat * (secured ? 0.6 : 1) * (therapy.oxygen.device === 'highFlowNasal' ? 0.8 : 1);
  const flowRatio = cv.coRight / c.co0;
  const fDSalv = clamp(0.06 + 0.9 * ramp(0.6, 0.05, flowRatio) + 0.03 * Math.max(0, resp.resistance - 2), 0, 0.95);
  resp.vd = vdAnat + mods.deadSpaceAdd;
  const va = Math.max(0, (resp.rr * Math.max(0, resp.vt - resp.vd)) / 1000);
  resp.va = va;

  // Shunt and V/Q mismatch
  const peepTotal = resp.peep + resp.autoPeep;
  const recruit = Math.exp(-peepTotal / 12);
  const collapse = (1 - resp.lungExpansionLeft) * 0.5 * 0.6 + (1 - resp.lungExpansionRight) * 0.5 * 0.6;
  resp.shunt = clamp(ctx.patient.baseline.shuntFraction + mods.shuntAdd + (0.38 * resp.lungWater + (resp.aspirated ? 0.08 : 0)) * recruit + collapse, 0, 0.85);
  resp.vqMismatch = clamp(mods.vqMismatchAdd + 0.05 * Math.max(0, resp.resistance - 1), 0, 0.5);

  // Alveolar O2 store
  const frcEff = Math.max(0.4, c.frc * (0.35 + 0.65 * (resp.lungExpansionLeft + resp.lungExpansionRight) / 2) * (1 - 0.5 * resp.lungWater) + 0.03 * peepTotal);
  const pAlvFactor = ATM - WATER_VAPOUR;
  resp.pao2Alveolar = Math.max(1, resp.fao2 * pAlvFactor - 0.15 * resp.paco2Alveolar);
  const diffusion = 2 + 20 * resp.lungWater;
  const pc = Math.max(1, resp.pao2Alveolar - diffusion);
  const acid = chem.ph;
  const temp = thermo.core;
  const cc = o2Content(hb, saturation(pc, acid, temp, resp.paco2), pc);
  const pLow = resp.pao2Alveolar * 0.45 + 12;
  const cLow = o2Content(hb, saturation(pLow, acid, temp, resp.paco2), pLow);
  const cv_ = resp.cvo2;
  const fs = resp.shunt;
  const fm = Math.min(resp.vqMismatch, 1 - fs);
  const cao2 = (1 - fs - fm) * cc + fm * cLow + fs * cv_;
  resp.cao2 = cao2;
  const co = cv.co;
  const uptake = Math.max(0, co * 10 * ((1 - fs - fm) * (cc - cv_) + fm * (cLow - cv_))); // mL/min

  // Apnoeic oxygenation: with a patent airway, O2 uptake draws gas in by mass flow
  const massFlow = va < 0.3 && resp.airwayPatency > 0.5 ? uptake / 1000 : 0;
  const dFao2 = ((va * (fio2 - resp.fao2) + massFlow * fio2 - uptake / 1000) / frcEff) * dtMin;
  resp.fao2 = clamp(resp.fao2 + dFao2, 0.005, 0.99);

  // Arterial PO2 / SaO2
  resp.pao2 = po2FromContent(cao2, hb, acid, temp, resp.paco2);
  resp.sao2 = saturation(resp.pao2, acid, temp, resp.paco2);

  // Tissue O2 consumption and venous O2 content
  metab.do2 = co * 10 * cao2;
  const vo2 = Math.min(metab.vo2Demand, metab.do2 * 0.8);
  metab.vo2 = vo2;
  metab.o2Deficit = Math.max(0, metab.vo2Demand - vo2);
  metab.o2Extraction = metab.do2 > 1 ? vo2 / metab.do2 : 1;
  const venousDl = (0.7 * blood.volume) / 100;
  resp.cvo2 = clamp(cv_ + ((co * 10 * (cao2 - cv_) - vo2) / venousDl) * dtMin, 0.5, cao2);
  resp.svo2 = clamp((resp.cvo2 - 0.003 * 40) / (1.34 * hb), 0, 1);

  // CO2
  const g = c.co2Transfer;
  const qp = cv.coRight;
  const vaPrime = (va * 1000) / 863;
  const pv = resp.pvco2;
  const pa = g * qp + vaPrime > 1e-6 ? (g * qp * pv) / (g * qp + vaPrime) : pv;
  const elimination = g * qp * (pv - pa); // mL/min
  resp.pvco2 = clamp(pv + ((metab.vco2 - elimination) / c.co2Capacitance) * dtMin, 10, 200);
  resp.paco2Alveolar = pa;
  resp.paco2 = (1 - fs) * pa + fs * resp.pvco2;
  const exhaling = va > 0.05 || (resp.rr > 0 && resp.vt > 50);
  resp.etco2 = exhaling ? Math.max(0, pa * (1 - fDSalv) * clamp(resp.airwayPatency * 1.1, 0, 1)) : 0;

  // Apnoea timer
  if (resp.rr < 2 || resp.vt < 60) resp.apneaTime += dt;
  else resp.apneaTime = 0;

  // Speech
  resp.canSpeak = phys.neuro.consciousness > 0.6 && resp.airwayPatency > 0.5 && !secured && !phys.neuro.seizure && resp.stridor < 0.8;
}
