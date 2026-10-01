/**
 * Pharmacology types.
 *
 * Drugs act exclusively through PK/PD: a dose enters a depot or the central
 * compartment, distributes (1- or 2-compartment model), is eliminated by
 * renal/hepatic clearance that depends on the *simulated* organ function and
 * blood flow, equilibrates with an effect site (ke0), and produces effects on
 * named receptor/effector channels via sigmoid Emax models. The physiology
 * modules read only channel activations — never drug names — so interactions
 * (synergy on a shared channel, competitive antagonism) emerge.
 */

export type Route = 'IV' | 'IO' | 'IM' | 'SC' | 'IN' | 'PO' | 'SL' | 'NEB';

export type EffectChannel =
  | 'alpha1'
  | 'beta1'
  | 'beta2'
  | 'v1'
  | 'mu'
  | 'gaba'
  | 'nmda'
  | 'muscarinicBlock'
  | 'nmBlock'
  | 'h1Block'
  | 'steroid'
  | 'nitrate'
  | 'antiplatelet'
  | 'anticoagulant'
  | 'fibrinolytic'
  | 'antifibrinolytic'
  | 'amiodarone'
  | 'adenosine'
  | 'ccb'
  | 'propofolCV'
  | 'antipyretic'
  | 'diuretic'
  | 'glucagon'
  | 'antiemetic'
  | 'beta2Airway'
  | 'muscarinicAirway';

export type AmountUnit = 'mcg' | 'mU' | 'U' | 'mmol';

export interface RouteDef {
  route: Route;
  /** Bioavailability 0..1 */
  F: number;
  /** First-order absorption rate constant (1/min). Omit for IV/IO (instant). */
  ka?: number;
  /** Absorption slows with poor peripheral perfusion (IM/SC in shock) */
  perfusionDependent?: boolean;
  /** Requires a conscious patient with airway reflexes (PO/SL) */
  requiresSwallow?: boolean;
  /** Nebulised: fraction deposited in lower airways at normal airflow */
  lungDeposition?: number;
}

export interface EffectDef {
  channel: EffectChannel;
  /** Effect-site concentration (amountUnit/L) producing 50% of the drug's Emax on this channel */
  ec50: number;
  emax: number;
  gamma: number;
  /** When set, the drug is a competitive antagonist with this Ki (amountUnit/L) */
  antagonistKi?: number;
  /** Local (airway) effect driven by the lung depot amount (amountUnit) instead of Ce */
  local?: boolean;
}

export interface PkParams {
  /** Central volume L/kg */
  v1: number;
  /** Peripheral volume L/kg (0 for one-compartment) */
  v2: number;
  /** Inter-compartmental clearance L/kg/min */
  q: number;
  /** Total clearance L/kg/min in a healthy 40-year-old */
  cl: number;
  /** Fraction of clearance that is renal (scaled by simulated GFR) */
  renalFraction: number;
  /** Fraction hepatic (scaled by hepatic function; flow-limited drugs also by hepatic blood flow) */
  hepaticFraction: number;
  flowLimited?: boolean;
  /** Effect-site equilibration rate constant (1/min) */
  ke0: number;
}

export type DirectSubstance = 'glucose' | 'k' | 'ca' | 'hco3' | 'mg' | 'na';

export interface DirectDef {
  /** Substance added to the chemistry pools; amounts are in mmol */
  substance: DirectSubstance;
  /** Accompanying anion/cation added (e.g. KCl adds chloride) */
  companion?: { substance: 'cl' | 'na'; ratio: number };
  /** Free water per mmol (mL) — e.g. D50 carries 50 mL per 25 g */
  waterPerMmol?: number;
  /** CO2 liberated per mmol (bicarbonate) in mL */
  co2PerMmol?: number;
}

export interface DoseUnitDef {
  unit: string;
  /** Multiply by this to convert to amountUnit */
  toAmount: number;
}

export interface RateUnitDef {
  unit: string;
  /** Convert a rate in this unit to amountUnit/min; weight-based units get weight multiplied at runtime */
  toAmountPerMin: number;
  perKg?: boolean;
}

export interface DrugDef {
  id: string;
  name: string;
  /** Brand-neutral class shown to students */
  drugClass: string;
  category: 'resuscitation' | 'vasoactive' | 'analgesia-sedation' | 'airway' | 'antiarrhythmic' | 'metabolic' | 'antimicrobial' | 'haematology' | 'other';
  amountUnit: AmountUnit;
  /** Allergy class used for cross-reactivity (e.g. 'penicillin') */
  allergyClass?: string;
  routes: RouteDef[];
  doseUnits: DoseUnitDef[];
  defaultDose?: { amount: number; unit: string; route: Route };
  /** Educational reference range for adult bolus dose (in the first dose unit) */
  typicalDose?: string;
  infusion?: { units: RateUnitDef[]; defaultRate: number; defaultUnit: string; typical?: string };
  pk?: PkParams;
  effects: EffectDef[];
  direct?: DirectDef;
  /** Antibiotic properties */
  antimicrobial?: { spectrum: string[]; micMgL: number };
  /** Not orderable by the student (toxic exposure agents) */
  exposureOnly?: boolean;
  notes: string;
  /** Source / basis of the PK/PD parameters */
  basis: string;
}

/** Runtime state for one drug in one patient. */
export interface DrugInstance {
  id: string;
  /** Central amount (amountUnit) */
  a1: number;
  /** Peripheral amount */
  a2: number;
  /** Absorption depots */
  depots: { amount: number; ka: number; perfusionDependent: boolean; toLung: boolean }[];
  /** Local airway amount (nebulised) */
  lung: number;
  /** Effect-site concentration */
  ce: number;
  /** Total administered (amountUnit) */
  totalGiven: number;
  firstGivenAt: number;
  lastGivenAt: number;
  /** Latched irreversible effect (aspirin) */
  latched: number;
}

export interface DoseRecord {
  t: number;
  drugId: string;
  route: Route;
  amount: number; // in amountUnit
  displayDose: string;
  kind: 'bolus' | 'infusion-start' | 'infusion-change' | 'infusion-stop';
}

export interface PharmState {
  drugs: Record<string, DrugInstance>;
  doses: DoseRecord[];
  /** Latest channel activations 0..1 (includes endogenous tone where modelled) */
  channels: Record<EffectChannel, number>;
  /**
   * Potency-normalised agonist drive per channel after competitive antagonism
   * (U = Σ Ce/EC50 / (1 + Σ Ce/Ki)). Lets different endpoints of one receptor
   * system have different sensitivities (e.g. μ analgesia vs respiratory depression).
   */
  channelU: Record<EffectChannel, number>;
  /** Concentration history samples for charts: t -> { drugId: Cp } */
  history: { t: number; cp: Record<string, number>; ce: Record<string, number> }[];
}

export interface PkContext {
  weightKg: number;
  ageYears: number;
  /** GFR relative to normal (0..1.3) */
  renalFactor: number;
  hepaticFunction: number;
  /** Hepatic blood-flow relative to normal */
  hepaticFlowFactor: number;
  /** Peripheral perfusion 0..1 */
  peripheralPerfusion: number;
  temperatureC: number;
  /** Minute ventilation relative to normal (nebuliser delivery) */
  airflowFactor: number;
}
