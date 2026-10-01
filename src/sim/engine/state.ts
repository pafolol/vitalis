import type { RngState } from '../core/rng';
import type { EffectChannel, PharmState } from '../pharmacology/types';
import type { ScenarioDefinition } from '../scenarios/schema';
import type { CaseStatus, PatientDefinition, PhysiologyModifiers, PhysiologyState, RngStreams, SimulationEvent, TherapyState } from '../types';
import type { Rng } from '../core/rng';
import type { DiagnosticsState } from '../diagnostics/types';
import type { SimAction } from '../interventions/actions';

/**
 * Constants derived once per patient so that, without pathology, the model
 * rests at the patient's generated baseline. Pathology then perturbs a
 * calibrated system rather than authored numbers.
 */
export interface Calibration {
  co0: number; // L/min
  hr0: number;
  sv0: number; // mL
  map0: number;
  sbp0: number;
  dbp0: number;
  rap0: number;
  lap0: number;
  pap0: number;
  svr0: number;
  pvr0: number;
  arterialCompliance: number; // mL/mmHg
  bv0: number;
  cs: number; // systemic compliance mL/mmHg
  vus0: number; // systemic unstressed volume mL
  rvr: number; // resistance to venous return
  cp: number; // pulmonary compliance mL/mmHg
  vpu0: number; // pulmonary unstressed volume
  svMaxL: number;
  svMaxR: number;
  p50L: number;
  p50R: number;
  pit0: number;
  msfp0: number;
  // respiratory
  vt0: number;
  rr0: number;
  vdAnat: number;
  va0: number;
  ve0: number;
  frc: number; // L
  compliance0: number; // mL/cmH2O
  co2Capacitance: number; // mL/mmHg
  co2Transfer: number; // mL CO2 per L blood per mmHg
  paco2Set: number;
  // metabolic
  vo2Basal: number; // mL/min
  bsa: number;
  weight: number;
  ecf0: number; // mL
  tbw0: number;
  hepaticGlucoseBasal: number; // mmol/min
  insulinBasal: number; // mU/L
  insulinSecretionMax: number; // mU/min
  heatLossK: number; // W/°C
  ambientC: number;
  cao2_0: number;
  gfr0: number;
  lymph0: number;
  kf: number;
  /** Starling offset so that baseline filtration equals lymph flow */
  starlingOffset: number;
  /** Diffusive protein permeability (mL/min) */
  proteinPs: number;
  pc0: number;
  pif0: number;
  isf0: number;
  icf0: number;
  /** Hepatic/peripheral glucose kinetics */
  uii0: number;
  kId: number;
  glycogenMmol: number;
  protein0: number; // g/dL total protein
  isfProtein0: number;
  creatinineProduction: number; // mg/min
  ureaProduction: number; // mg BUN per min
  hrMax: number;
  lactateProduction0: number; // mmol/min
  /** Endogenous tone baselines */
  eBeta1_0: number;
  eAlpha1_0: number;
  eBeta2_0: number;
  s0: number;
  v0: number;
}

export interface PathologyInstance {
  id: string;
  type: string;
  params: Record<string, unknown>;
  state: Record<string, unknown>;
  addedAt: number;
  /** Seconds before arrival the process started (for pre-roll) */
  label: string;
  resolved: boolean;
}

export interface ActionRecord {
  tick: number;
  action: SimAction;
}

export interface HistorySample {
  t: number;
  hr: number;
  sbp: number;
  dbp: number;
  map: number;
  spo2: number;
  sao2: number;
  rr: number;
  etco2: number;
  temp: number;
  co: number;
  gcs: number;
  glucose: number;
  lactate: number;
  ph: number;
  paco2: number;
  pao2: number;
  k: number;
  hb: number;
  bv: number;
  pain: number;
  rhythm: string;
  urine: number;
}

export interface EngineState {
  version: 1;
  engineId: 'vitalis-ts';
  seed: string;
  scenario: ScenarioDefinition;
  patient: PatientDefinition;
  calib: Calibration;
  tick: number;
  t: number;
  dt: number;
  phys: PhysiologyState;
  therapy: TherapyState;
  pharm: PharmState;
  pathologies: PathologyInstance[];
  diagnostics: DiagnosticsState;
  events: SimulationEvent[];
  eventSeq: number;
  history: HistorySample[];
  status: CaseStatus;
  rng: RngStreams;
  /** Detector memory for threshold events/alarms (hysteresis) */
  detectors: Record<string, number | boolean | string>;
  /** Pre-roll seconds simulated before arrival */
  prerollSeconds: number;
  /** Queue of actions applied at the next tick */
  pendingActions: SimAction[];
  /** Every applied action, for deterministic replay */
  actionLog: ActionRecord[];
  counter: number;
}

export interface StepRngs {
  arrhythmia: Rng;
  defib: Rng;
  procedure: Rng;
  labs: Rng;
  monitor: Rng;
  behaviour: Rng;
}

export interface StepContext {
  s: EngineState;
  dt: number;
  t: number;
  phys: PhysiologyState;
  patient: PatientDefinition;
  calib: Calibration;
  therapy: TherapyState;
  pharm: PharmState;
  ch: Record<EffectChannel, number>;
  chU: Record<EffectChannel, number>;
  mods: PhysiologyModifiers;
  rng: StepRngs;
  /** True while simulating the pre-arrival period */
  preroll: boolean;
  emit: (e: Omit<SimulationEvent, 'id' | 't'> & { t?: number }) => void;
}

export type RngStateMap = Record<keyof RngStreams, RngState>;
