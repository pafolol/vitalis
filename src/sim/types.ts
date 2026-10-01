/**
 * Core simulation types.
 *
 * Separation of concerns (see docs/ARCHITECTURE.md):
 *   PatientDefinition  – who the patient is (static, generated from a seed)
 *   ScenarioDefinition – what is wrong + narrative (src/sim/scenarios/schema.ts)
 *   PhysiologyState    – the evolving biological state (this file)
 *   TherapyState       – what the clinicians have applied (devices, lines, infusions)
 *   PharmState         – drug amounts per compartment (src/sim/pharmacology)
 *   SimulationEvent    – timeline entries
 */

import type { RngState } from './core/rng';

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

export type Sex = 'male' | 'female';

export interface Allergy {
  agent: string;
  /** Drug class key used by the pharmacology engine for cross-reactivity */
  drugClass?: string;
  reaction: 'anaphylaxis' | 'rash' | 'angioedema' | 'intolerance';
}

export interface HistoryItem {
  /** Machine key (e.g. 'hypertension', 'asthma', 'ckd') */
  key: string;
  label: string;
  /** Whether the patient knows/would report this */
  knownToPatient: boolean;
}

export interface HomeMedication {
  name: string;
  dose: string;
  indication: string;
  /** e.g. 'betaBlocker' — may modify physiology */
  effectKey?: string;
}

export interface PatientDefinition {
  seed: string;
  name: string;
  sex: Sex;
  ageYears: number;
  heightCm: number;
  weightKg: number;
  bmi: number;
  bsa: number;
  leanBodyMassKg: number;
  bodyFatPct: number;
  /** 0 = sedentary/deconditioned, 1 = athlete */
  fitness: number;
  /** 0 = very light .. 1 = very dark (rendering + cyanosis/pallor visibility) */
  skinTone: number;
  occupation: string;
  livingSituation: string;
  history: HistoryItem[];
  medications: HomeMedication[];
  allergies: Allergy[];
  social: { smoking: 'never' | 'former' | 'current'; alcohol: 'none' | 'social' | 'heavy'; drugs: 'none' | 'cannabis' | 'opioids' | 'stimulants' };
  /** Baseline physiological parameters – the physiology engine is calibrated to these. */
  baseline: PatientBaseline;
}

export interface PatientBaseline {
  heartRate: number;
  systolic: number;
  diastolic: number;
  respiratoryRate: number;
  temperatureC: number;
  bloodVolumeMl: number;
  hemoglobin: number; // g/dL
  platelets: number; // 10^9/L
  wbc: number; // 10^9/L
  glucose: number; // mmol/L
  sodium: number;
  potassium: number;
  chloride: number;
  bicarbonate: number;
  creatinine: number; // mg/dL
  bun: number; // mg/dL
  albumin: number; // g/dL
  /** Relative GFR 0..1.3 */
  renalFunction: number;
  /** Relative hepatic metabolic capacity 0..1.2 */
  hepaticFunction: number;
  /** LV contractility multiplier (1 = normal; heart failure ~0.5) */
  lvContractility: number;
  rvContractility: number;
  /** Arterial compliance multiplier (lower in elderly = wider pulse pressure) */
  arterialCompliance: number;
  /** Airway resistance multiplier (1 normal; COPD/asthma > 1) */
  airwayResistance: number;
  /** Baseline intrapulmonary shunt fraction */
  shuntFraction: number;
  /** Coronary vasodilatory reserve 0..1 (atherosclerosis lowers it) */
  coronaryReserve: number;
  /** Insulin sensitivity multiplier */
  insulinSensitivity: number;
  /** Pancreatic beta-cell function 0..1 (type 1 diabetes = 0) */
  betaCellFunction: number;
  /** Liver glycogen store 0..1 */
  glycogenStores: number;
  /** Transcutaneous pacing capture threshold (mA) */
  pacingThresholdmA: number;
  /** Chest wall thickness at 2nd ICS MCL (cm) – affects needle decompression */
  chestWallCm: number;
  /** Chronic hypercapnia (COPD) shifts CO2 set-point */
  chronicPaCO2: number;
  /** Opioid tolerance multiplier on mu-receptor EC50s (1 = naive) */
  opioidTolerance: number;
}

// ---------------------------------------------------------------------------
// Cardiac rhythm
// ---------------------------------------------------------------------------

export type Rhythm =
  | 'sinus'
  | 'afib'
  | 'svt'
  | 'vtach'
  | 'vfib'
  | 'asystole'
  | 'chb' // complete (3rd degree) heart block
  | 'paced';

export const RHYTHM_LABEL: Record<Rhythm, string> = {
  sinus: 'Sinus',
  afib: 'Atrial fibrillation',
  svt: 'SVT (re-entrant)',
  vtach: 'Ventricular tachycardia',
  vfib: 'Ventricular fibrillation',
  asystole: 'Asystole',
  chb: 'Complete heart block',
  paced: 'Paced rhythm',
};

// ---------------------------------------------------------------------------
// Physiology state
// ---------------------------------------------------------------------------

export interface CardiovascularState {
  rhythm: Rhythm;
  /** Ventricular rate (beats/min) */
  hr: number;
  /** Sinus-node rate that would exist without arrhythmia */
  sinusRate: number;
  sbp: number;
  dbp: number;
  map: number;
  /** Right atrial pressure (mmHg, absolute) */
  rap: number;
  /** Left atrial pressure (transmural, mmHg) */
  lap: number;
  /** Mean pulmonary artery pressure */
  pap: number;
  /** Cardiac output L/min (systemic, left side) */
  co: number;
  /** Right ventricular output L/min */
  coRight: number;
  sv: number;
  /** Systemic vascular resistance (Wood units, mmHg·min/L) */
  svr: number;
  pvr: number;
  /** Systemic blood volume (mL) — total blood volume minus pulmonary */
  vSystemic: number;
  /** Pulmonary blood volume (mL) */
  vPulmonary: number;
  msfp: number;
  lvContractility: number;
  rvContractility: number;
  ejectionFraction: number;
  /** Intrathoracic (pleural) mean pressure relative to atmosphere, mmHg */
  intrathoracicPressure: number;
  coronaryPerfusionPressure: number;
  /** 0..1 global myocardial ischaemia (supply/demand) */
  globalIschemia: number;
  /** 0..1 fraction of LV myocardium infarcted */
  infarctLV: number;
  infarctRV: number;
  /** 0..1 territory ischaemia (drives ST changes) */
  territoryIschemia: { lad: number; lcx: number; rca: number };
  /** 0..1 infarcted fraction of each coronary territory */
  territoryInfarct: { lad: number; lcx: number; rca: number };
  /** Troponin released from necrotic myocardium not yet in plasma (ng/L-equivalent) */
  troponinPool: number;
  /** Rhythm to return to when pacing stops */
  underlyingRhythm: Rhythm;
  /** Myocardial energetic reserve 0..1 (falls during no-flow; governs ROSC and defib success) */
  myocardialViability: number;
  /** Whether a pulse is palpable centrally */
  pulsePresent: boolean;
  /** Palpable radial pulse */
  radialPulse: boolean;
  /** Seconds in current rhythm */
  rhythmTime: number;
  /** Seconds since circulatory arrest began (0 if perfusing) */
  arrestTime: number;
  /** Seconds of no-flow (arrest without CPR) accumulated */
  noFlowTime: number;
  /** Seconds of low-flow (CPR) */
  lowFlowTime: number;
  /** ECG parameters (derived) */
  ecg: EcgParams;
  /** Capillary refill (s) */
  capRefill: number;
  /** Peripheral perfusion index 0..1 (drives pleth amplitude, skin temp) */
  peripheralPerfusion: number;
  /** AV nodal conduction 0..1.5 (drugs) */
  avConduction: number;
  /** Beat-to-beat variability for AF (0..1) */
  rrIrregularity: number;
  /** Transient pause (s) remaining, e.g. after adenosine */
  pauseRemaining: number;
  /** Post-ROSC myocardial stunning 0..1 */
  stunning: number;
}

export interface EcgParams {
  qrsMs: number;
  prMs: number;
  qtcMs: number;
  /** ST deviation (mm) by lead group */
  stAnterior: number;
  stInferior: number;
  stLateral: number;
  /** T-wave amplitude multiplier (peaked in hyperkalaemia) */
  tWave: number;
  /** P-wave present */
  pWave: boolean;
  /** Pathological Q waves in territory */
  qWaves: { anterior: boolean; inferior: boolean; lateral: boolean };
  /** VF amplitude (mV) — coarse→fine */
  vfAmplitude: number;
  /** Electrical capture while pacing */
  pacingCapture: boolean;
  /** U waves (hypokalaemia) */
  uWave: number;
}

export type AirwayStatus = 'patent' | 'partial' | 'obstructed' | 'secured';

export interface RespiratoryState {
  /** Total respiratory rate (spontaneous + delivered) */
  rr: number;
  /** Tidal volume mL */
  vt: number;
  /** Minute ventilation L/min */
  ve: number;
  /** Alveolar ventilation L/min */
  va: number;
  /** Dead space mL */
  vd: number;
  fio2: number;
  /** Alveolar O2 fraction (dynamic store) */
  fao2: number;
  pao2Alveolar: number;
  pao2: number;
  paco2: number;
  sao2: number;
  /** Mixed venous O2 content (mL/dL) */
  cvo2: number;
  cao2: number;
  /** Mixed venous / tissue PCO2 (body CO2 store) */
  pvco2: number;
  /** Alveolar PCO2 */
  paco2Alveolar: number;
  /** Mean airway pressure (cmH2O) */
  meanAirwayPressure: number;
  /** Positive end-expiratory pressure applied (cmH2O) */
  peep: number;
  /** Nebuliser/airflow delivery factor */
  airflowFactor: number;
  /** Patient can speak */
  canSpeak: boolean;
  /** Snoring/gurgling respirations */
  snoring: boolean;
  /** Vomitus in airway not yet suctioned */
  vomitInAirway: boolean;
  svo2: number;
  etco2: number;
  shunt: number;
  vqMismatch: number;
  /** Airway resistance multiplier */
  resistance: number;
  /** Respiratory system compliance mL/cmH2O */
  compliance: number;
  /** Work of breathing relative to normal */
  workOfBreathing: number;
  /** Respiratory muscle fatigue 0..1 */
  fatigue: number;
  /** Chemical/central drive multiplier (1 normal) */
  drive: number;
  /** Spontaneous breathing present */
  spontaneous: boolean;
  apneaTime: number;
  airway: AirwayStatus;
  /** 0..1 fraction of ventilation reaching alveoli due to airway patency */
  airwayPatency: number;
  /** Upper airway oedema 0..1 */
  upperAirwayEdema: number;
  /** Pleural air per side (mL) */
  pleuralAirLeft: number;
  pleuralAirRight: number;
  /** Pleural blood per side (mL) */
  pleuralBloodLeft: number;
  pleuralBloodRight: number;
  /** Fraction of each lung ventilated (collapse reduces) */
  lungExpansionLeft: number;
  lungExpansionRight: number;
  peakPressure: number;
  plateauPressure: number;
  autoPeep: number;
  /** Pulmonary oedema/consolidation index 0..1 */
  lungWater: number;
  /** Continuous breath phase 0..1 (0 = start of inspiration) */
  breathPhase: number;
  /** Aspiration has occurred */
  aspirated: boolean;
  /** Stridor 0..1, wheeze 0..1, crackles 0..1 (exam) */
  stridor: number;
  wheeze: number;
  crackles: number;
}

export interface BloodState {
  /** Total blood volume mL */
  volume: number;
  plasmaVolume: number;
  rbcVolume: number;
  hb: number;
  hct: number;
  platelets: number;
  wbc: number;
  /** Clotting factor activity 0..1.2 */
  clottingFactors: number;
  fibrinogen: number; // g/L
  inr: number;
  aptt: number; // s
  /** Plasma protein mass (g) and interstitial protein mass (g) */
  plasmaProtein: number;
  interstitialProtein: number;
  albumin: number; // g/dL
  /** Cumulative blood loss (mL) */
  cumulativeLoss: number;
  /** Current bleeding rate (mL/min) */
  bleedingRate: number;
}

export interface FluidState {
  /** Interstitial fluid volume mL */
  isf: number;
  /** Intracellular fluid volume mL */
  icf: number;
  /** Intracellular osmoles (mOsm) */
  icfOsmoles: number;
  /** Capillary filtration (mL/min, + = plasma -> ISF) */
  filtration: number;
  lymph: number;
  /** Net fluid balance since arrival (mL) */
  netBalance: number;
  totalIn: number;
  totalOut: number;
}

export interface ChemistryState {
  /** Extracellular solute masses (mmol) */
  naMass: number;
  kMass: number;
  clMass: number;
  hco3Mass: number;
  /** Intracellular potassium mmol */
  kIcf: number;
  /** Concentrations (mmol/L) */
  na: number;
  k: number;
  cl: number;
  hco3: number;
  glucose: number;
  /** Glucose mass in ECF (mmol) */
  glucoseMass: number;
  lactate: number;
  ketones: number;
  /** Ionised calcium mmol/L */
  ica: number;
  mg: number;
  ph: number;
  baseExcess: number;
  anionGap: number;
  osmolality: number;
  bun: number;
  creatinine: number;
  troponin: number; // ng/L (hs)
  alt: number;
  bilirubin: number;
  /** Endogenous plasma insulin (mU/L) */
  insulin: number;
  /** Insulin action (remote compartment) */
  insulinAction: number;
  /** Hepatic glycogen 0..1 */
  glycogen: number;
  /** Ammonia-like marker skipped; CK */
  ck: number;
}

export interface RenalState {
  gfr: number; // mL/min
  urineMlPerHour: number;
  urineTotal: number;
  /** Acute kidney injury 0..1 */
  aki: number;
  /** Renal perfusion 0..1 */
  perfusion: number;
}

export interface NeuroState {
  /** 0..1 level of consciousness (1 = alert) */
  consciousness: number;
  gcsE: number;
  gcsV: number;
  gcsM: number;
  gcs: number;
  avpu: 'A' | 'V' | 'P' | 'U';
  /** Confusion 0..1 */
  confusion: number;
  agitation: number;
  anxiety: number;
  /** Perceived pain 0..10 */
  pain: number;
  /** Nociceptive input 0..10 (before analgesia) */
  nociception: number;
  sedation: number;
  pupilLeft: number;
  pupilRight: number;
  pupilsReactive: boolean;
  seizure: boolean;
  seizureTime: number;
  postictal: number;
  /** Cerebral O2 delivery relative to normal */
  cerebralO2: number;
  /** Irreversible hypoxic-ischaemic brain injury 0..1 */
  brainInjury: number;
  sympathetic: number;
  parasympathetic: number;
  /** Airway reflexes (gag/cough) present */
  airwayReflexes: boolean;
  /** Tremor 0..1 */
  tremor: number;
  /** Dyspnoea 0..10 */
  dyspnea: number;
  /** Nausea 0..1 */
  nausea: number;
  /** Paralysed by neuromuscular blockade 0..1 */
  paralysis: number;
  /** Opioid withdrawal severity 0..1 */
  withdrawal: number;
  /** Diaphoresis 0..1 */
  sweating: number;
}

export interface ThermoState {
  core: number;
  setpoint: number;
  shivering: number;
  /** Net heat flow W (+ = warming) */
  netHeat: number;
  /** Peripheral skin temperature °C */
  skin: number;
}

export interface MetabolicState {
  vo2Demand: number; // mL/min
  vo2: number; // mL/min actual
  vco2: number; // mL/min
  do2: number; // mL/min
  o2Extraction: number;
  /** O2 debt rate mL/min */
  o2Deficit: number;
  metabolicRate: number; // multiplier
}

export interface InflammationState {
  /** Systemic inflammation 0..1 */
  sirs: number;
  /** Mast-cell mediator level 0..1+ */
  mediators: number;
  /** Capillary leak multiplier (1 = normal) */
  capillaryLeak: number;
  /** Reflection coefficient for protein */
  sigma: number;
  /** Visible skin findings */
  urticaria: number;
  flushing: number;
}

export interface PhysiologyState {
  cv: CardiovascularState;
  resp: RespiratoryState;
  blood: BloodState;
  fluids: FluidState;
  chem: ChemistryState;
  renal: RenalState;
  neuro: NeuroState;
  thermo: ThermoState;
  metab: MetabolicState;
  infl: InflammationState;
}

// ---------------------------------------------------------------------------
// Modifiers: pathology modules contribute these every tick (never overwrite
// physiological state directly). They are reset each tick.
// ---------------------------------------------------------------------------

export interface PhysiologyModifiers {
  svrFactor: number;
  /** Vascular responsiveness to α-adrenergic/vasopressin stimulation (sepsis, acidosis reduce it) */
  vasopressorResponsiveness: number;
  venousCapacitanceFactor: number;
  capillaryLeak: number;
  sigmaReduction: number;
  lvContractilityFactor: number;
  rvContractilityFactor: number;
  pvrFactor: number;
  /** Bronchospasm component of airway resistance (β2/anticholinergic responsive) */
  airwayResistanceAdd: number;
  /** Inflammatory/mucus component (not bronchodilator responsive; steroids act slowly) */
  airwayResistanceFixed: number;
  shuntAdd: number;
  vqMismatchAdd: number;
  deadSpaceAdd: number;
  complianceFactor: number;
  lungWaterAdd: number;
  upperAirwayEdema: number;
  respiratoryDriveFactor: number;
  vo2Factor: number;
  feverSetpointAdd: number;
  lactateProduction: number; // mmol/min extra
  nociception: number; // 0..10
  nociceptionSite: string;
  sympatheticAdd: number;
  consciousnessFactor: number;
  bleedingRate: number; // mL/min whole blood lost externally/internally
  bleedingSite: string | null;
  /** Additional water loss mL/min and solutes */
  waterLoss: number;
  naLoss: number;
  kLoss: number;
  hco3Loss: number;
  clLoss: number;
  /** Ketoacid production mmol/min */
  ketoProduction: number;
  hepaticGlucoseFactor: number;
  insulinSecretionFactor: number;
  wbcTarget: number | null;
  plateletConsumption: number;
  /** Coronary flow factors per territory 1 = normal, 0 = occluded */
  coronaryFlow: { lad: number; lcx: number; rca: number };
  /** Rhythm the pathology is pushing (null = none) */
  forcedRhythm: Rhythm | null;
  /** Additional arrhythmia hazard per minute for VF */
  vfHazard: number;
  /** Additional hazard of asystole per minute */
  asystoleHazard: number;
  kShiftOut: number;
  renalInjuryRate: number;
  hepaticInjury: number;
  seizureHazard: number;
  nausea: number;
  urticaria: number;
  flushing: number;
  angioedemaTarget: number;
  confusionAdd: number;
  pleuralAirRateLeft: number;
  pleuralAirRateRight: number;
  pleuralBloodRateLeft: number;
  pleuralBloodRateRight: number;
  /** Extra SA-node rate multiplier (e.g. hyperthyroid, fever handled elsewhere) */
  chronotropyFactor: number;
  /** Contributions to visible symptoms (free text keys) */
  symptoms: Set<string>;
}

// ---------------------------------------------------------------------------
// Therapy (clinician-applied state)
// ---------------------------------------------------------------------------

export type OxygenDevice = 'none' | 'nasalCannula' | 'simpleMask' | 'nonRebreather' | 'highFlowNasal' | 'bvm' | 'ventilator';

export type AirwayManoeuvre = 'none' | 'headTiltChinLift' | 'jawThrust';
export type AirwayAdjunct = 'none' | 'opa' | 'npa';
export type Limb = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';
export type Side = 'left' | 'right';
export type AccessSite = 'leftArm' | 'rightArm' | 'io';

export interface Infusion {
  id: string;
  kind: 'fluid' | 'drug' | 'blood';
  /** fluid id or drug id */
  agentId: string;
  label: string;
  /** For fluids/blood: mL/h. For drugs: amount unit per minute (in drug's rate unit) */
  rate: number;
  rateUnit: string;
  /** Remaining volume mL (fluids/blood); Infinity for continuous drug infusions */
  remainingMl: number;
  totalMl: number;
  infusedMl: number;
  /** For drug infusions: total drug amount delivered (drug amount unit) */
  delivered: number;
  startedAt: number;
  stoppedAt: number | null;
  site: AccessSite;
  warmed: boolean;
}

export interface TherapyState {
  monitoring: { ecg: boolean; spo2: boolean; nibp: boolean; etco2: boolean; temp: boolean; arterialLine: boolean };
  nibpIntervalMin: number;
  nibpLast: { t: number; sbp: number; dbp: number; map: number; ok: boolean } | null;
  nibpNextAt: number;
  oxygen: { device: OxygenDevice; flowLpm: number; fio2Set: number };
  airway: { manoeuvre: AirwayManoeuvre; adjunct: AirwayAdjunct; ett: boolean; ettPlacedAt: number | null; recoveryPosition: boolean; suctionedAt: number | null };
  bvm: { active: boolean; rate: number; vt: number };
  ventilator: { on: boolean; mode: 'VC-AC'; vt: number; rr: number; peep: number; fio2: number; ieRatio: number };
  access: { leftArm: boolean; rightArm: boolean; io: boolean };
  infusions: Infusion[];
  cpr: {
    active: boolean;
    mode: 'manual' | 'mechanical';
    /** compressions/min over last window (manual) */
    rate: number;
    /** 0..1 depth adequacy (manual) */
    depth: number;
    /** 0..1 overall quality */
    quality: number;
    startedAt: number | null;
    handsOffSince: number | null;
    totalCompressions: number;
    lastInputAt: number;
  };
  defib: {
    padsOn: boolean;
    energy: number;
    charged: boolean;
    sync: boolean;
    shocks: number;
    pacing: { on: boolean; rate: number; mA: number };
  };
  procedures: {
    tourniquet: Limb | null;
    directPressure: boolean;
    pelvicBinder: boolean;
    needleDecompression: { left: { at: number; site: string } | null; right: { at: number; site: string } | null };
    chestTube: { left: { at: number; output: number } | null; right: { at: number; output: number } | null };
    hemostasis: { requestedAt: number | null; completesAt: number | null; done: boolean };
    reperfusion: { requestedAt: number | null; completesAt: number | null; done: boolean; method: 'pci' | 'lysis' | null };
    dialysis: { requestedAt: number | null; startsAt: number | null; active: boolean };
    warming: boolean;
    exposed: boolean;
    legRaise: boolean;
    backrestDeg: number;
    vagalManoeuvreAt: number | null;
  };
  /** Pending procedure (e.g. IV insertion) — completes after duration */
  pending: PendingTask[];
}

export interface PendingTask {
  id: string;
  kind: 'ivAccess' | 'intubation' | 'chestTube' | 'arterialLine';
  startedAt: number;
  completesAt: number;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventKind = 'system' | 'action' | 'physiology' | 'alarm' | 'result' | 'patient' | 'exam' | 'outcome';

export interface SimulationEvent {
  id: number;
  t: number;
  kind: EventKind;
  /** Short machine code, e.g. 'rhythm.vfib', 'drug.given' */
  code: string;
  message: string;
  severity: 'info' | 'notice' | 'warning' | 'critical' | 'good';
  data?: Record<string, unknown>;
}

export interface CaseStatus {
  phase: 'active' | 'ended';
  alive: boolean;
  deathTime: number | null;
  deathCause: string | null;
  rosc: boolean;
  endedAt: number | null;
  endReason: string | null;
}

export interface RngStreams {
  arrhythmia: RngState;
  defib: RngState;
  procedure: RngState;
  labs: RngState;
  monitor: RngState;
  behaviour: RngState;
}
