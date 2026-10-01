import { clamp } from '../core/math';
import type { Calibration } from '../engine/state';
import type { PatientDefinition, PhysiologyModifiers, PhysiologyState, TherapyState } from '../types';
import { o2Content, oncoticPressure } from './gas';

export function createModifiers(): PhysiologyModifiers {
  return {
    svrFactor: 1,
    vasopressorResponsiveness: 1,
    venousCapacitanceFactor: 1,
    capillaryLeak: 1,
    sigmaReduction: 0,
    lvContractilityFactor: 1,
    rvContractilityFactor: 1,
    pvrFactor: 1,
    airwayResistanceAdd: 0,
    airwayResistanceFixed: 0,
    shuntAdd: 0,
    vqMismatchAdd: 0,
    deadSpaceAdd: 0,
    complianceFactor: 1,
    lungWaterAdd: 0,
    upperAirwayEdema: 0,
    respiratoryDriveFactor: 1,
    vo2Factor: 1,
    feverSetpointAdd: 0,
    lactateProduction: 0,
    nociception: 0,
    nociceptionSite: '',
    sympatheticAdd: 0,
    consciousnessFactor: 1,
    bleedingRate: 0,
    bleedingSite: null,
    waterLoss: 0,
    naLoss: 0,
    kLoss: 0,
    hco3Loss: 0,
    clLoss: 0,
    ketoProduction: 0,
    hepaticGlucoseFactor: 1,
    insulinSecretionFactor: 1,
    wbcTarget: null,
    plateletConsumption: 0,
    coronaryFlow: { lad: 1, lcx: 1, rca: 1 },
    forcedRhythm: null,
    vfHazard: 0,
    asystoleHazard: 0,
    kShiftOut: 0,
    renalInjuryRate: 0,
    hepaticInjury: 0,
    seizureHazard: 0,
    nausea: 0,
    urticaria: 0,
    flushing: 0,
    angioedemaTarget: 0,
    confusionAdd: 0,
    pleuralAirRateLeft: 0,
    pleuralAirRateRight: 0,
    pleuralBloodRateLeft: 0,
    pleuralBloodRateRight: 0,
    chronotropyFactor: 1,
    symptoms: new Set<string>(),
  };
}

export function resetModifiers(m: PhysiologyModifiers): void {
  const fresh = createModifiers();
  Object.assign(m, fresh);
}

/** Ideal body weight (Devine) in kg. */
export function idealBodyWeight(p: PatientDefinition): number {
  const inchesOver5ft = Math.max(0, p.heightCm / 2.54 - 60);
  return (p.sex === 'male' ? 50 : 45.5) + 2.3 * inchesOver5ft;
}

export function totalBodyWater(p: PatientDefinition): number {
  // Watson formula (litres)
  const tbw =
    p.sex === 'male'
      ? 2.447 - 0.09516 * p.ageYears + 0.1074 * p.heightCm + 0.3362 * p.weightKg
      : -2.097 + 0.1069 * p.heightCm + 0.2466 * p.weightKg;
  return tbw * 1000;
}

export function calibrate(p: PatientDefinition, ambientC: number): Calibration {
  const b = p.baseline;
  const ci = clamp(3.3 - 0.009 * Math.max(0, p.ageYears - 20), 2.4, 3.4);
  const co0 = ci * p.bsa;
  const hr0 = b.heartRate;
  const sv0 = (co0 * 1000) / hr0;
  const pp0 = b.systolic - b.diastolic;
  const map0 = b.diastolic + pp0 / 3;
  const rap0 = 3;
  const lap0 = 8;
  const pvr0 = 1.5;
  const pap0 = lap0 + co0 * pvr0;
  const svr0 = (map0 - rap0) / co0;
  const arterialCompliance = sv0 / pp0;
  const bv0 = b.bloodVolumeMl;
  const vp0 = 0.09 * bv0;
  const cs = 0.036 * bv0;
  const msfp0 = 7.5;
  const vus0 = bv0 - vp0 - msfp0 * cs;
  const rvr = (msfp0 - rap0) / co0;
  const cp = 0.0035 * bv0;
  const vpu0 = vp0 - lap0 * cp;
  const pit0 = -4;
  const p50R = 7;
  const p50L = 10;
  const tmR = rap0 - pit0;
  const gR = (tmR * tmR) / (tmR * tmR + p50R * p50R);
  const gL = (lap0 * lap0) / (lap0 * lap0 + p50L * p50L);
  const svMaxR = sv0 / gR;
  const svMaxL = sv0 / gL;

  const ibw = idealBodyWeight(p);
  const rr0 = b.respiratoryRate;
  const vo2Basal = 125 * p.bsa * (1 + 0.1 * (b.temperatureC - 37));
  const vco2 = vo2Basal * 0.8;
  const paco2Set = b.chronicPaCO2;
  const va0 = (vco2 * 0.863) / paco2Set; // L/min
  const vdAnat = 2.2 * ibw; // mL
  const vt0 = (va0 * 1000) / rr0 + vdAnat;
  const ve0 = (vt0 * rr0) / 1000;
  const frc = (p.sex === 'male' ? 2.6 : 2.2) * (p.heightCm / 170) ** 2 * (1 - Math.max(0, p.bmi - 30) * 0.02);

  const tbw0 = totalBodyWater(p);
  const ecf0 = tbw0 * 0.4;
  const hct0 = (b.hemoglobin * 3) / 100;
  const pv0 = bv0 * (1 - hct0);
  const totalProtein = b.albumin + 3;
  const heatProduction = vo2Basal * 0.335; // W
  const ambient = ambientC;
  const heatLossK = heatProduction / (b.temperatureC - ambient);

  const cao2_0 = o2Content(b.hemoglobin, 0.975, 95);
  const gfr0 = 110 * b.renalFunction * (p.bsa / 1.73);
  const creatinineProduction = (b.creatinine / 100) * gfr0; // mg/min (mg/dL * dL/min)
  const ureaProduction = (b.bun / 100) * gfr0 * 0.5;

  // Starling calibration: baseline filtration == lymph flow
  const isf0 = ecf0 - pv0;
  const icf0 = tbw0 - ecf0;
  const kf = 6 * (p.weightKg / 70);
  const lymph0 = 2.2 * (p.weightKg / 70);
  const pc0 = 17;
  const pif0 = -2;
  const sigma0 = 0.9;
  const piP = oncoticPressure(totalProtein);
  const piI = oncoticPressure(2.6);
  const starlingOffset = pc0 - pif0 - sigma0 * (piP - piI) - lymph0 / kf;
  // protein: convective leak + diffusion balanced by lymphatic return at ISF concentration
  const convective = lymph0 * (1 - sigma0) * (totalProtein / 100);
  const lymphReturn = lymph0 * (2.6 / 100);
  const proteinPs = Math.max(0, (lymphReturn - convective) / ((totalProtein - 2.6) / 100));

  // Glucose: hepatic output balances insulin-independent (60%) and insulin-dependent (40%) uptake at baseline glucose
  const hepaticGlucoseBasal = 0.011 * p.weightKg;
  const gB = b.glucose;
  const uii0 = (0.6 * hepaticGlucoseBasal * (gB + 1.5)) / gB;
  const kId = (0.4 * hepaticGlucoseBasal) / gB;
  const insulinBasal = 8;
  const insulinClearance = 0.014 * p.weightKg; // L/min
  const hill8 = Math.pow(gB, 3) / (Math.pow(gB, 3) + 512);
  // Type 1 diabetes (beta-cell function 0): home basal insulin is represented as a constant secretion-equivalent
  const insulinSecretionMax = b.betaCellFunction > 0 ? (insulinBasal * insulinClearance) / (hill8 * b.betaCellFunction) : insulinBasal * insulinClearance;

  return {
    co0,
    hr0,
    sv0,
    map0,
    sbp0: b.systolic,
    dbp0: b.diastolic,
    rap0,
    lap0,
    pap0,
    svr0,
    pvr0,
    arterialCompliance,
    bv0,
    cs,
    vus0,
    rvr,
    cp,
    vpu0,
    svMaxL,
    svMaxR,
    p50L,
    p50R,
    pit0,
    msfp0,
    vt0,
    rr0,
    vdAnat,
    va0,
    ve0,
    frc,
    compliance0: 100 * (p.heightCm / 175) ** 2,
    co2Capacitance: 30 * (p.weightKg / 70),
    co2Transfer: 6.5,
    paco2Set,
    vo2Basal,
    bsa: p.bsa,
    weight: p.weightKg,
    ecf0,
    tbw0,
    hepaticGlucoseBasal,
    insulinBasal,
    insulinSecretionMax,
    heatLossK,
    ambientC: ambient,
    cao2_0,
    gfr0,
    lymph0,
    kf,
    starlingOffset,
    proteinPs,
    pc0,
    pif0,
    isf0,
    icf0,
    uii0,
    kId,
    glycogenMmol: 450 * b.glycogenStores * (p.weightKg / 70),
    protein0: totalProtein,
    isfProtein0: 2.6,
    creatinineProduction,
    ureaProduction,
    hrMax: 220 - p.ageYears,
    lactateProduction0: 0.8 * (p.weightKg / 70),
    eBeta1_0: 0,
    eAlpha1_0: 0,
    eBeta2_0: 0,
    s0: 0.25,
    v0: 0.5,
  };
}

export function createInitialPhysiology(p: PatientDefinition, c: Calibration): PhysiologyState {
  const b = p.baseline;
  const hct = (b.hemoglobin * 3) / 100;
  const pv = c.bv0 * (1 - hct);
  const isf = c.ecf0 - pv;
  const icf = c.tbw0 - c.ecf0;
  const ecf = c.ecf0;
  const na = b.sodium;
  const glucose = b.glucose;
  const bunMmol = b.bun / 2.8;
  const osm = 2 * na + glucose + bunMmol;
  const sao2 = 0.975;
  const cao2 = o2Content(b.hemoglobin, sao2, 95);
  const cvo2 = cao2 - c.vo2Basal / (c.co0 * 10);
  const pp = b.systolic - b.diastolic;
  const map = b.diastolic + pp / 3;
  const plasmaProtein = (c.protein0 * pv) / 100;
  const interstitialProtein = (c.isfProtein0 * isf) / 100;

  return {
    cv: {
      rhythm: 'sinus',
      hr: b.heartRate,
      sinusRate: b.heartRate,
      sbp: b.systolic,
      dbp: b.diastolic,
      map,
      rap: c.rap0,
      lap: c.lap0,
      pap: c.pap0,
      co: c.co0,
      coRight: c.co0,
      sv: c.sv0,
      svr: c.svr0,
      pvr: c.pvr0,
      vSystemic: c.bv0 - (c.vpu0 + c.lap0 * c.cp),
      vPulmonary: c.vpu0 + c.lap0 * c.cp,
      msfp: c.msfp0,
      lvContractility: b.lvContractility,
      rvContractility: b.rvContractility,
      ejectionFraction: clamp(0.62 * b.lvContractility, 0.1, 0.75),
      intrathoracicPressure: c.pit0,
      coronaryPerfusionPressure: b.diastolic - c.lap0,
      globalIschemia: 0,
      infarctLV: 0,
      infarctRV: 0,
      territoryIschemia: { lad: 0, lcx: 0, rca: 0 },
      territoryInfarct: { lad: 0, lcx: 0, rca: 0 },
      troponinPool: 0,
      underlyingRhythm: 'sinus',
      myocardialViability: 1,
      pulsePresent: true,
      radialPulse: true,
      rhythmTime: 0,
      arrestTime: 0,
      noFlowTime: 0,
      lowFlowTime: 0,
      ecg: {
        qrsMs: 90,
        prMs: 160,
        qtcMs: 420,
        stAnterior: 0,
        stInferior: 0,
        stLateral: 0,
        tWave: 1,
        pWave: true,
        qWaves: { anterior: false, inferior: false, lateral: false },
        vfAmplitude: 1,
        pacingCapture: false,
        uWave: 0,
      },
      capRefill: 1.5,
      peripheralPerfusion: 1,
      avConduction: 1,
      rrIrregularity: 0,
      pauseRemaining: 0,
      stunning: 0,
    },
    resp: {
      rr: c.rr0,
      vt: c.vt0,
      ve: c.ve0,
      va: c.va0,
      vd: c.vdAnat,
      fio2: 0.21,
      fao2: 0.15,
      pao2Alveolar: 102,
      pao2: 95,
      paco2: c.paco2Set,
      sao2,
      cvo2,
      cao2,
      pvco2: c.paco2Set + 6,
      paco2Alveolar: c.paco2Set,
      meanAirwayPressure: 0,
      peep: 0,
      airflowFactor: 1,
      canSpeak: true,
      snoring: false,
      vomitInAirway: false,
      svo2: 0.75,
      etco2: c.paco2Set - 3,
      shunt: b.shuntFraction,
      vqMismatch: 0,
      resistance: b.airwayResistance,
      compliance: c.compliance0,
      workOfBreathing: 1,
      fatigue: 0,
      drive: 1,
      spontaneous: true,
      apneaTime: 0,
      airway: 'patent',
      airwayPatency: 1,
      upperAirwayEdema: 0,
      pleuralAirLeft: 0,
      pleuralAirRight: 0,
      pleuralBloodLeft: 0,
      pleuralBloodRight: 0,
      lungExpansionLeft: 1,
      lungExpansionRight: 1,
      peakPressure: 0,
      plateauPressure: 0,
      autoPeep: 0,
      lungWater: 0,
      breathPhase: 0,
      aspirated: false,
      stridor: 0,
      wheeze: 0,
      crackles: 0,
    },
    blood: {
      volume: c.bv0,
      plasmaVolume: pv,
      rbcVolume: c.bv0 * hct,
      hb: b.hemoglobin,
      hct,
      platelets: b.platelets,
      wbc: b.wbc,
      clottingFactors: 1,
      fibrinogen: 3,
      inr: 1.0,
      aptt: 30,
      plasmaProtein,
      interstitialProtein,
      albumin: b.albumin,
      cumulativeLoss: 0,
      bleedingRate: 0,
    },
    fluids: {
      isf,
      icf,
      icfOsmoles: (osm * icf) / 1000,
      filtration: c.lymph0,
      lymph: c.lymph0,
      netBalance: 0,
      totalIn: 0,
      totalOut: 0,
    },
    chem: {
      naMass: (na * ecf) / 1000,
      kMass: (b.potassium * ecf) / 1000,
      clMass: (b.chloride * ecf) / 1000,
      hco3Mass: (b.bicarbonate * ecf) / 1000,
      kIcf: 140 * (icf / 1000),
      na,
      k: b.potassium,
      cl: b.chloride,
      hco3: b.bicarbonate,
      glucose,
      glucoseMass: (glucose * ecf) / 1000,
      lactate: 1.0,
      ketones: 0.1,
      ica: 1.2,
      mg: 0.9,
      ph: 6.1 + Math.log10(b.bicarbonate / (0.0307 * c.paco2Set)),
      baseExcess: 0,
      anionGap: na - b.chloride - b.bicarbonate,
      osmolality: osm,
      bun: b.bun,
      creatinine: b.creatinine,
      troponin: 3,
      alt: 22,
      bilirubin: 0.6,
      insulin: c.insulinBasal,
      insulinAction: 0,
      glycogen: b.glycogenStores,
      ck: 120,
    },
    renal: {
      gfr: c.gfr0,
      urineMlPerHour: 60,
      urineTotal: 0,
      aki: 0,
      perfusion: 1,
    },
    neuro: {
      consciousness: 1,
      gcsE: 4,
      gcsV: 5,
      gcsM: 6,
      gcs: 15,
      avpu: 'A',
      confusion: 0,
      agitation: 0,
      anxiety: 0.2,
      pain: 0,
      nociception: 0,
      sedation: 0,
      pupilLeft: 4,
      pupilRight: 4,
      pupilsReactive: true,
      seizure: false,
      seizureTime: 0,
      postictal: 0,
      cerebralO2: 1,
      brainInjury: 0,
      sympathetic: c.s0,
      parasympathetic: c.v0,
      airwayReflexes: true,
      tremor: 0,
      dyspnea: 0,
      nausea: 0,
      paralysis: 0,
      withdrawal: 0,
      sweating: 0,
    },
    thermo: {
      core: b.temperatureC,
      setpoint: b.temperatureC,
      shivering: 0,
      netHeat: 0,
      skin: 33,
    },
    metab: {
      vo2Demand: c.vo2Basal,
      vo2: c.vo2Basal,
      vco2: c.vo2Basal * 0.8,
      do2: c.co0 * 10 * cao2,
      o2Extraction: 0.25,
      o2Deficit: 0,
      metabolicRate: 1,
    },
    infl: {
      sirs: 0,
      mediators: 0,
      capillaryLeak: 1,
      sigma: 0.9,
      urticaria: 0,
      flushing: 0,
    },
  };
}

export function createTherapy(): TherapyState {
  return {
    monitoring: { ecg: false, spo2: false, nibp: false, etco2: false, temp: false, arterialLine: false },
    nibpIntervalMin: 5,
    nibpLast: null,
    nibpNextAt: Infinity,
    oxygen: { device: 'none', flowLpm: 0, fio2Set: 0.21 },
    airway: { manoeuvre: 'none', adjunct: 'none', ett: false, ettPlacedAt: null, recoveryPosition: false, suctionedAt: null },
    bvm: { active: false, rate: 10, vt: 500 },
    ventilator: { on: false, mode: 'VC-AC', vt: 450, rr: 16, peep: 5, fio2: 1, ieRatio: 2 },
    access: { leftArm: false, rightArm: false, io: false },
    infusions: [],
    cpr: { active: false, mode: 'manual', rate: 0, depth: 0, quality: 0, startedAt: null, handsOffSince: null, totalCompressions: 0, lastInputAt: -1 },
    defib: { padsOn: false, energy: 200, charged: false, sync: false, shocks: 0, pacing: { on: false, rate: 70, mA: 0 } },
    procedures: {
      tourniquet: null,
      directPressure: false,
      pelvicBinder: false,
      needleDecompression: { left: null, right: null },
      chestTube: { left: null, right: null },
      hemostasis: { requestedAt: null, completesAt: null, done: false },
      reperfusion: { requestedAt: null, completesAt: null, done: false, method: null },
      dialysis: { requestedAt: null, startsAt: null, active: false },
      warming: false,
      exposed: false,
      legRaise: false,
      backrestDeg: 15,
      vagalManoeuvreAt: null,
    },
    pending: [],
  };
}
