import { approach, clamp, ramp, smoothstep } from '../core/math';
import type { StepContext } from '../engine/state';
import { isOrganised, ventricularRate } from './rhythm';

/**
 * Circulation: a lumped two-sided Guyton model.
 *
 *  - Systemic venous return VR = (MSFP − RAP) / RVR, MSFP = (Vsys − Vunstressed) / Csys
 *  - RV and LV outputs follow Frank–Starling curves of *transmural* filling
 *    pressure (RAP − intrathoracic pressure; LAP), scaled by contractility,
 *    afterload (MAP / PAP), heart-rate-limited filling and rhythm.
 *  - RAP is solved each sub-step so that VR = RV output; the pulmonary blood
 *    pool integrates RV − LV output, which sets LAP. LV failure therefore
 *    raises LAP (→ pulmonary oedema), RV failure raises RAP with low LAP,
 *    raised intrathoracic pressure (tension pneumothorax, PEEP, auto-PEEP)
 *    impedes venous return (obstructive shock), and blood loss lowers MSFP.
 *  - MAP = CO × SVR + RAP; pulse pressure = SV / arterial compliance.
 *
 * References: Guyton AC (1955, 1973) venous return & cardiac output curves;
 * standard textbook lumped-parameter circulation models. Parameters are
 * calibrated per patient to reproduce their baseline vitals.
 */

function starling(p: number, p50: number): number {
  const x = Math.max(0, p);
  return (x * x) / (x * x + p50 * p50);
}

export function stepCardiovascular(ctx: StepContext): void {
  const { phys, calib: c, ch, chU, mods, therapy, patient, dt } = ctx;
  const { cv, neuro, chem, blood, thermo } = phys;
  const b = patient.baseline;

  // ---------------------------------------------------------------- sinus node
  const eB1 = ch.beta1 - c.eBeta1_0;
  const vagal = neuro.parasympathetic * (1 - ch.muscarinicBlock);
  let sinus = c.hr0 * (1 + 1.4 * eB1) * Math.exp(-0.7 * (vagal - c.v0));
  const t = thermo.core;
  sinus *= t > 37 ? 1 + 0.08 * (t - 37) : 1 - 0.05 * (37 - t);
  sinus *= mods.chronotropyFactor * (1 - 0.3 * ch.ccb) * (1 - 0.1 * ch.amiodarone);
  sinus *= clamp(cv.myocardialViability / 0.55, 0.25, 1);
  sinus *= 1 - 0.5 * ramp(35, 20, phys.resp.pao2);
  sinus *= 1 + 0.2 * clamp(chU.nmda / (0.5 + chU.nmda), 0, 1);
  // Sinus rate saturates approaching the age-predicted maximum (soft knee at 60 % of HRmax)
  const knee = 0.6 * c.hrMax;
  if (sinus > knee) sinus = knee + (c.hrMax - knee) * Math.tanh((sinus - knee) / (c.hrMax - knee));
  sinus = clamp(sinus, 20, c.hrMax);
  cv.sinusRate = approach(cv.sinusRate, sinus, 2.5, dt);

  // AV nodal conduction (AF rate control)
  cv.avConduction = clamp((1 - 0.6 * ch.ccb) * (1 - 0.45 * ch.amiodarone) * (1 + 0.3 * eB1), 0.2, 1.4);

  // ---------------------------------------------------------------- contractility
  const acidosis = chem.ph < 7.2 ? clamp(1 - 1.8 * (7.2 - chem.ph), 0.35, 1) : 1;
  const hypoCa = chem.ica < 0.95 ? clamp(1 - (0.95 - chem.ica) * 1.3, 0.5, 1) : 1;
  const hypothermia = t < 33 ? clamp(1 - (33 - t) * 0.05, 0.5, 1) : 1;
  const viab = clamp(cv.myocardialViability / 0.5, 0.1, 1);
  const inotropy = 1 + 0.9 * eB1;
  const isch = cv.territoryIschemia;
  const inf = cv.territoryInfarct;
  const lvIschFactor = (1 - 0.65 * (0.45 * isch.lad + 0.25 * isch.lcx + 0.3 * isch.rca)) * (1 - 0.85 * cv.infarctLV);
  const rvIschFactor = (1 - 0.6 * isch.rca) * (1 - 0.85 * cv.infarctRV);
  const drugNeg = (1 - 0.28 * ch.propofolCV) * (1 - 0.25 * ch.ccb);
  const common = inotropy * acidosis * hypoCa * hypothermia * viab * drugNeg * (1 - 0.55 * cv.stunning);
  cv.lvContractility = clamp(b.lvContractility * common * lvIschFactor * mods.lvContractilityFactor, 0.03, 2.5);
  cv.rvContractility = clamp(b.rvContractility * common * rvIschFactor * mods.rvContractilityFactor, 0.03, 2.5);
  cv.infarctLV = 0.45 * inf.lad + 0.25 * inf.lcx + 0.3 * inf.rca;
  cv.infarctRV = inf.rca * 0.6;

  // ---------------------------------------------------------------- vascular tone
  const responsiveness = mods.vasopressorResponsiveness * (chem.ph < 7.2 ? clamp(1 - 2 * (7.2 - chem.ph), 0.4, 1) : 1);
  const eA1 = (ch.alpha1 - c.eAlpha1_0) * responsiveness;
  const eB2 = ch.beta2 - c.eBeta2_0;
  const viscosity = Math.pow(clamp(blood.hct / Math.max(0.2, (b.hemoglobin * 3) / 100), 0.3, 1.5), 0.55);
  const tempTone = t > 37 ? 1 - 0.05 * (t - 37) : 1 + 0.05 * Math.max(0, 36 - t);
  let svr =
    c.svr0 *
    (1 + 2.2 * eA1) *
    (1 + 1.2 * ch.v1 * Math.max(responsiveness, 0.7)) *
    (1 - 0.35 * eB2) *
    (1 - 0.4 * ch.propofolCV) *
    (1 - 0.25 * ch.ccb) *
    (1 - 0.3 * ch.nitrate * ch.nitrate) *
    (1 - 0.15 * ch.amiodarone) *
    (1 - 0.15 * clamp((chem.mg - 1.5) / 2, 0, 1)) *
    mods.svrFactor *
    viscosity *
    tempTone;
  svr = clamp(svr, 2, 80);
  cv.svr = approach(cv.svr, svr, 2, dt);

  let vusFactor = clamp(1 - 0.8 * eA1 - 0.3 * ch.v1, 0.72, 1.4);
  vusFactor *= (1 + 0.35 * ch.nitrate) * (1 + 0.15 * ch.propofolCV) * mods.venousCapacitanceFactor;
  const backrest = therapy.procedures.backrestDeg;
  let vus = c.vus0 * vusFactor;
  vus += 260 * (Math.sin((backrest * Math.PI) / 180) - Math.sin((15 * Math.PI) / 180));
  if (therapy.procedures.legRaise) vus -= 300;

  const pvr =
    c.pvr0 *
    (1 + 1.3 * ramp(80, 40, phys.resp.pao2Alveolar)) *
    (1 + 0.5 * ramp(7.3, 7.0, chem.ph)) *
    (1 + 0.8 * (2 - phys.resp.lungExpansionLeft - phys.resp.lungExpansionRight) / 2) *
    mods.pvrFactor;
  cv.pvr = pvr;

  // ---------------------------------------------------------------- pumping
  const { rate, svFactor } = ventricularRate(ctx);
  const organised = isOrganised(cv.rhythm);
  const pit = cv.intrathoracicPressure;
  const fitness = patient.fitness;
  const cpr = therapy.cpr;

  let co = 0;
  let coR = 0;
  let sv = 0;
  let map = cv.map;
  let rap = cv.rap;
  let msfp = (cv.vSystemic - vus) / c.cs;

  const pumping = organised && rate > 5 && svFactor > 0;
  if (pumping) {
    const n = Math.max(4, Math.ceil(dt / 0.25));
    const h = dt / n;
    const hFill = rate <= 100 ? 1 : 1 / (1 + Math.pow((rate - 100) / (80 + 50 * fitness), 2));
    const kA = 0.4 + 1.2 * (1 - clamp(cv.lvContractility, 0, 1));
    for (let i = 0; i < n; i++) {
      msfp = Math.max(0, (cv.vSystemic - vus) / c.cs);
      const lap = Math.max(0, (cv.vPulmonary - c.vpu0) / c.cp);
      const afterL = 1 / Math.max(0.3, 1 + kA * clamp((map - c.map0) / c.map0, -0.5, 2));
      const svL = c.svMaxL * cv.lvContractility * starling(lap, c.p50L) * afterL * hFill * svFactor;
      const qL = (rate * svL) / 1000;
      const afterR = 1 / (1 + 0.8 * Math.max(0, (cv.pap - c.pap0) / c.pap0));
      const kR = (rate * c.svMaxR * cv.rvContractility * afterR * hFill * svFactor) / 1000;
      // Solve RAP: kR·g(RAP − Pit) = (MSFP − RAP)/RVR
      let lo = -15;
      let hi = Math.max(msfp, 1) + 5;
      for (let it = 0; it < 32; it++) {
        const mid = 0.5 * (lo + hi);
        const f = kR * starling(mid - pit, c.p50R) - Math.max(0, (msfp - mid) / c.rvr);
        if (f > 0) hi = mid;
        else lo = mid;
      }
      rap = 0.5 * (lo + hi);
      const qR = Math.max(0, (msfp - rap) / c.rvr);
      cv.vPulmonary = Math.max(c.vpu0 * 0.5, cv.vPulmonary + ((qR - qL) * 1000 * h) / 60);
      cv.vSystemic = blood.volume - cv.vPulmonary;
      map = qL * cv.svr + rap;
      co = qL;
      coR = qR;
      sv = svL;
    }
    cv.lap = Math.max(0, (cv.vPulmonary - c.vpu0) / c.cp);
  } else if (cpr.active && cpr.quality > 0.05) {
    // Closed-chest compressions: forward flow ≈ 20–30 % of normal with good CPR
    const volumeFactor = clamp((cv.vSystemic - vus * 0.9) / (c.bv0 - c.vus0 - c.cp * c.lap0 - c.vpu0), 0.15, 1.2);
    co = cpr.quality * 0.3 * c.co0 * volumeFactor * (1 - 0.5 * ramp(-2, 15, pit));
    coR = co;
    sv = cpr.rate > 0 ? (co * 1000) / Math.max(60, cpr.rate) : 0;
    // Diastolic (decompression-phase) right atrial pressure is low; aortic diastolic pressure is supported by vascular tone
    rap = 4 + 0.2 * Math.max(msfp, 0);
    map = co * cv.svr * 0.75 + 6;
    cv.lap = approach(cv.lap, 6, 10, dt);
  } else {
    // No flow: pressures equilibrate toward mean systemic filling pressure
    co = 0;
    coR = 0;
    sv = 0;
    rap = approach(cv.rap, Math.max(0, msfp), 4, dt);
    map = approach(cv.map, Math.max(0, msfp), 4, dt);
    cv.lap = approach(cv.lap, Math.max(0, msfp), 6, dt);
  }
  cv.hr = pumping ? rate : cpr.active ? 0 : 0;
  cv.co = co;
  cv.coRight = coR;
  cv.sv = sv;
  cv.msfp = msfp;
  cv.rap = rap;
  cv.map = clamp(map, 0, 250);
  cv.pap = cv.lap + coR * pvr;

  if (pumping) {
    // Arterial compliance falls at higher distending pressure (non-linear aortic elastance) and with α-tone
    const compliance = c.arterialCompliance * clamp(1 - 0.25 * eA1, 0.6, 1.2) * (1 + 0.15 * (1 - viscosity)) * clamp(Math.pow(c.map0 / Math.max(20, cv.map), 1.2), 0.55, 1.5);
    // Faster ejection under β1 stimulation raises the systolic peak (hyperdynamic, wide pulse pressure)
    const pp = (sv / compliance) * (1 + 0.8 * clamp(eB1, 0, 0.6));
    cv.dbp = Math.max(rap + 1, cv.map - pp / 3);
    cv.sbp = cv.dbp + pp;
    if (cv.sbp < cv.map) cv.sbp = cv.map;
  } else if (cpr.active && cpr.quality > 0.05) {
    cv.dbp = cv.map * 0.72;
    cv.sbp = cv.map * 1.7;
  } else {
    cv.sbp = cv.map;
    cv.dbp = cv.map;
  }

  cv.ejectionFraction = clamp(0.62 * cv.lvContractility * (pumping ? 1 : 0), 0, 0.8);
  cv.pulsePresent = pumping && cv.sbp >= 50 && co > 0.6;
  // Peripheral perfusion: flow relative to baseline, reduced by α-mediated vasoconstriction
  const vasoconstriction = clamp(eA1 * 1.5 + 0.4 * ch.v1 + 0.5 * ramp(35.5, 33, t), 0, 0.85);
  const perfTarget = clamp(Math.pow(co / c.co0, 0.8) * (1 - vasoconstriction) * Math.pow(c.svr0 / cv.svr, 0.25), 0, 1.3);
  cv.peripheralPerfusion = approach(cv.peripheralPerfusion, perfTarget, perfTarget < cv.peripheralPerfusion ? 10 : 25, dt);
  cv.radialPulse = cv.pulsePresent && cv.sbp >= 75 && cv.peripheralPerfusion > 0.25;
  cv.capRefill = clamp(1.6 / Math.max(0.12, Math.pow(cv.peripheralPerfusion, 1.1)), 1, 9);

  stepCoronary(ctx);
  void smoothstep;
}

/** Myocardial oxygen supply/demand, ischaemia, infarction, viability, troponin. */
function stepCoronary(ctx: StepContext): void {
  const { phys, calib: c, ch, mods, patient, dt, therapy } = ctx;
  const { cv, resp } = phys;
  const dtMin = dt / 60;
  const pumping = cv.co > 0 && cv.rhythm !== 'vfib' && cv.rhythm !== 'asystole';

  // Demand ∝ rate–pressure product and contractile state (VF myocardium still consumes O2)
  let demand: number;
  if (cv.rhythm === 'vfib') demand = 0.9;
  else if (!pumping) demand = 0.35;
  else demand = clamp(((cv.hr * cv.sbp) / (c.hr0 * c.sbp0)) * (0.6 + (0.4 * cv.lvContractility) / patient.baseline.lvContractility), 0.2, 4);

  const cpp = pumping || therapy.cpr.active ? cv.dbp - Math.max(cv.rap, cv.lap * 0.7) : 0;
  cv.coronaryPerfusionPressure = cpp;
  const cpp0 = c.dbp0 - c.lap0 * 0.7;
  const o2 = resp.cao2 / c.cao2_0;
  const reserve = 1 + 3 * patient.baseline.coronaryReserve;
  const dilation = 1 + 0.2 * ch.nitrate;

  const terr = ['lad', 'lcx', 'rca'] as const;
  for (const k of terr) {
    const flowMax = Math.max(0, cpp / cpp0) * reserve * mods.coronaryFlow[k] * dilation;
    const supplyRatio = clamp((flowMax * o2) / demand, 0, 1);
    const isch = 1 - supplyRatio;
    cv.territoryIschemia[k] = approach(cv.territoryIschemia[k], isch, isch > cv.territoryIschemia[k] ? 15 : 40, dt);
    const dInf = 0.0055 * smoothstep(0.35, 0.85, cv.territoryIschemia[k]) * (1 - cv.territoryInfarct[k]) * dtMin;
    cv.territoryInfarct[k] += dInf;
    cv.troponinPool += dInf * 30000;
  }
  const g = 0.45 * cv.territoryIschemia.lad + 0.25 * cv.territoryIschemia.lcx + 0.3 * cv.territoryIschemia.rca;
  cv.globalIschemia = g;
  // demand ischaemia (type 2) releases a little troponin
  cv.troponinPool += 25 * smoothstep(0.2, 0.6, g) * dtMin;

  // Myocardial energetic viability: falls when global O2 supply < ~35 % of demand
  const r = 1 - g;
  const dropRate = cv.rhythm === 'vfib' ? 0.14 : 0.11;
  if (r < 0.35) cv.myocardialViability -= dropRate * (1 - r / 0.35) * dtMin;
  else cv.myocardialViability += 0.08 * (r - 0.35) * dtMin;
  cv.myocardialViability = clamp(cv.myocardialViability, 0, 1);
  if (cv.stunning > 0) cv.stunning = Math.max(0, cv.stunning - dtMin / 45);

  // Troponin appearance and clearance
  const appear = cv.troponinPool * (1 - Math.exp(-0.0015 * dtMin));
  cv.troponinPool -= appear;
  const chem = phys.chem;
  chem.troponin = Math.max(3, chem.troponin + appear - (chem.troponin - 3) * (1 - Math.exp(-0.0007 * dtMin)));

  // ECG morphology
  const ecg = cv.ecg;
  const occl = mods.coronaryFlow;
  const transmural = (k: 'lad' | 'lcx' | 'rca') => (occl[k] < 0.6 ? cv.territoryIschemia[k] : 0);
  const subendo = clamp(g - 0.1, 0, 1);
  ecg.stAnterior = 3.2 * transmural('lad') - 1.2 * transmural('rca') - 1.5 * subendo * (occl.lad >= 0.6 ? 1 : 0);
  ecg.stInferior = 2.8 * transmural('rca') - 1.4 * transmural('lad') - 1.2 * subendo * (occl.rca >= 0.6 ? 1 : 0) - 0.6 * transmural('lcx');
  ecg.stLateral = 2.2 * transmural('lcx') + 1.2 * transmural('lad') - 1.4 * transmural('rca') - 1.2 * subendo * (occl.lcx >= 0.6 ? 1 : 0);
  ecg.qWaves = { anterior: cv.territoryInfarct.lad > 0.3, inferior: cv.territoryInfarct.rca > 0.3, lateral: cv.territoryInfarct.lcx > 0.3 };
  const k = chem.k;
  ecg.tWave = 1 + 1.6 * ramp(5.6, 7.6, k) - 0.6 * ramp(3.4, 2.5, k);
  ecg.uWave = ramp(3.3, 2.4, k);
  ecg.qrsMs = 88 + 70 * ramp(6.6, 9, k) + 12 * ch.amiodarone + (cv.rhythm === 'vtach' || cv.rhythm === 'chb' ? 60 : 0) + (cv.rhythm === 'paced' ? 70 : 0);
  ecg.prMs = 160 + 70 * ramp(6.2, 8.2, k) + 40 * ch.ccb + 30 * clamp(1 - cv.avConduction, 0, 1);
  ecg.pWave = k < 8.2 && cv.rhythm !== 'afib' && cv.rhythm !== 'svt';
  ecg.qtcMs = 420 + 45 * ch.amiodarone + 50 * ramp(1.1, 0.8, chem.ica) + 40 * ramp(3.3, 2.5, k) + 30 * ramp(35, 30, phys.thermo.core);
  cv.rrIrregularity = cv.rhythm === 'afib' ? 0.25 : 0;

  // Arrest bookkeeping
  const arrested = !cv.pulsePresent;
  if (arrested) {
    cv.arrestTime += dt;
    if (therapy.cpr.active && therapy.cpr.quality > 0.2) cv.lowFlowTime += dt;
    else cv.noFlowTime += dt;
  } else if (cv.arrestTime > 0) {
    cv.stunning = Math.max(cv.stunning, clamp(cv.arrestTime / 900, 0.15, 0.7));
    cv.arrestTime = 0;
  }
}
