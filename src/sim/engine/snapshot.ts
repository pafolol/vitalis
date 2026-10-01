import type { DiagnosticOrder } from '../diagnostics/types';
import type { EffectChannel } from '../pharmacology/types';
import type { CaseStatus, PatientDefinition, PhysiologyState, SimulationEvent, TherapyState } from '../types';
import type { HistorySample } from './state';
import type { ScenarioDefinition } from '../scenarios/schema';

export interface ActiveDrugView {
  id: string;
  name: string;
  cp: number;
  ce: number;
  unit: string;
  totalGiven: string;
  lastGivenAt: number;
}

export interface ExamFinding {
  id: string;
  system: string;
  label: string;
  text: string;
  source: 'simulated' | 'authored';
  abnormal: boolean;
}

/** Everything the UI needs, produced by the engine (worker) several times per second. */
export interface SimSnapshot {
  engineId: string;
  t: number;
  tick: number;
  status: CaseStatus;
  phys: PhysiologyState;
  therapy: TherapyState;
  channels: Record<EffectChannel, number>;
  drugs: ActiveDrugView[];
  orders: DiagnosticOrder[];
  /** Events appended since the previous snapshot (or all on first) */
  events: SimulationEvent[];
  eventCount: number;
  /** Derived appearance for rendering/exam */
  appearance: Appearance;
  /** Clinical derived values */
  derived: DerivedClinical;
}

export interface Appearance {
  pallor: number;
  cyanosisCentral: number;
  cyanosisPeripheral: number;
  flushing: number;
  urticaria: number;
  mottling: number;
  diaphoresis: number;
  angioedema: number;
  bleeding: { site: string; intensity: number } | null;
  accessoryMuscles: number;
  nasalFlare: number;
}

export interface DerivedClinical {
  shockIndex: number;
  /** Carotid pulse palpable */
  centralPulse: boolean;
  radialPulse: boolean;
  /** Organised electrical activity without a pulse */
  pea: boolean;
  arrest: boolean;
  plethAmplitude: number;
  spo2Reliable: boolean;
  canSpeak: boolean;
  speechQuality: 'sentences' | 'phrases' | 'words' | 'none';
  /** Where the patient feels pain (from active pathology), '' if none */
  painSite: string;
  /** Wall-independent sim-time of the last defibrillation shock (-1 if none) */
  lastShockAt: number;
  /** NIBP cuff currently cycling */
  nibpMeasuring: boolean;
  /** Pending procedures (IV attempts, intubation, drains) with completion times */
  pending: { kind: string; completesAt: number }[];
}

export interface CaseMeta {
  patient: PatientDefinition;
  scenarioId: string;
  scenarioTitle: string;
  tagline: string;
  handoff: string;
  chiefComplaint: string;
  seed: string;
  prerollSeconds: number;
  /** Full scenario (contains hidden information — never shown to students directly) */
  scenario: ScenarioDefinition;
}

export interface HistoryPayload {
  samples: HistorySample[];
  drugHistory: { t: number; cp: Record<string, number>; ce: Record<string, number> }[];
}
