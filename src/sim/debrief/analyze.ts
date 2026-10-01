import type { ScenarioDefinition, PathologyType } from '../scenarios/schema';
import type { SimulationEvent, CaseStatus } from '../types';
import type { HistorySample } from '../engine/state';
import { formatClock } from '../core/math';

/**
 * Deterministic debrief analysis — reconstructs the case from the event log
 * and physiology history. Works without AI; the AI narrative (if available)
 * is layered on top and is given this analysis as its factual basis.
 */

export interface KeyAction {
  label: string;
  /** Predicate over the action log */
  match: (e: SimulationEvent) => boolean;
  why: string;
}

export interface DecisionPoint {
  label: string;
  done: boolean;
  at: number | null;
  why: string;
}

export interface ResponseObservation {
  t: number;
  action: string;
  observation: string;
}

export interface DebriefAnalysis {
  outcome: string;
  survived: boolean;
  duration: number;
  diagnosisSubmitted: string | null;
  diagnosisCorrect: boolean | null;
  hiddenDiagnosis: string;
  decisions: DecisionPoint[];
  responses: ResponseObservation[];
  missed: string[];
  harms: string[];
  alternatives: string[];
  counts: { actions: number; examinations: number; tests: number; drugs: number };
}

const drug = (id: string) => (e: SimulationEvent) => (e.code === 'drug.given' || e.code === 'drug.infusion') && e.data?.['drugId'] === id;
const code = (c: string) => (e: SimulationEvent) => e.code === c;
const order = (id: string) => (e: SimulationEvent) => e.code === 'diagnostic.order' && e.data?.['testId'] === id;
const fluid = () => (e: SimulationEvent) => e.code === 'fluid.start' || e.code === 'blood.start';
const blood = () => (e: SimulationEvent) => e.code === 'blood.start';
const antibiotic = () => (e: SimulationEvent) => (e.code === 'drug.given' || e.code === 'drug.infusion') && ['ceftriaxone', 'piperacillinTazobactam', 'meropenem', 'vancomycin'].includes(String(e.data?.['drugId']));

const COMMON: KeyAction[] = [
  { label: 'Attach monitoring', match: code('monitor.attach'), why: 'Continuous ECG, SpO₂ and blood pressure reveal the trajectory and the response to treatment.' },
  { label: 'Establish vascular access', match: (e) => e.code === 'access.iv' || e.code === 'access.io', why: 'Most time-critical drugs and fluids need IV or IO access.' },
];

const BY_PATHOLOGY: Partial<Record<PathologyType, { actions: KeyAction[]; tests: string[]; alternatives: string[] }>> = {
  opioidToxicity: {
    actions: [
      { label: 'Open/support the airway', match: (e) => e.code === 'airway.manoeuvre' || e.code === 'airway.adjunct' || e.code === 'bvm.set', why: 'Hypoventilation and a soft-tissue obstructed airway are the immediate threats.' },
      { label: 'Give naloxone (titrated)', match: drug('naloxone'), why: 'Competitive μ-antagonist restores ventilatory drive.' },
    ],
    tests: ['glucose', 'vbg'],
    alternatives: ['Bag-mask ventilation before naloxone', 'Intranasal or IM naloxone when IV access is difficult', 'Observation for re-sedation (naloxone is shorter-acting)'],
  },
  anaphylaxis: {
    actions: [
      { label: 'IM adrenaline', match: drug('epinephrine'), why: 'Adrenaline reverses vasodilation, airway oedema and bronchospasm and stabilises mast cells.' },
      { label: 'IV fluid bolus', match: fluid(), why: 'Capillary leak and venodilation cause relative hypovolaemia.' },
    ],
    tests: [],
    alternatives: ['Repeat IM adrenaline every 5 min', 'Adrenaline infusion for refractory shock', 'Early senior airway help as oedema progresses', 'Antihistamine/steroid only as adjuncts'],
  },
  asthma: {
    actions: [
      { label: 'Nebulised salbutamol', match: drug('salbutamol'), why: 'First-line bronchodilation.' },
      { label: 'Systemic corticosteroid', match: (e) => drug('hydrocortisone')(e) || drug('methylprednisolone')(e), why: 'Reduces airway inflammation over hours.' },
      { label: 'IV magnesium', match: drug('magnesium'), why: 'Adjunct bronchodilator in severe asthma.' },
    ],
    tests: ['vbg', 'abg', 'cxr'],
    alternatives: ['Add ipratropium', 'IV/IM adrenaline for life-threatening features', 'Ketamine as bronchodilating induction agent', 'Low-rate ventilation to avoid air trapping'],
  },
  hemorrhage: {
    actions: [
      { label: 'Control the bleeding', match: (e) => e.code === 'procedure.tourniquet' || e.code === 'procedure.pressure' || e.code === 'procedure.hemostasis' || e.code === 'procedure.binder', why: 'No resuscitation keeps up with uncontrolled haemorrhage.' },
      { label: 'Transfuse blood products', match: blood(), why: 'Restores oxygen-carrying capacity and coagulation; crystalloid dilutes both.' },
      { label: 'Tranexamic acid', match: drug('tranexamic'), why: 'Modest reduction in bleeding when given early.' },
    ],
    tests: ['vbg', 'cbc', 'coag'],
    alternatives: ['Permissive hypotension until haemorrhage control', 'Warm products to avoid hypothermia', 'FAST to locate internal bleeding', 'Calcium with massive transfusion'],
  },
  tensionPneumothorax: {
    actions: [
      { label: 'Decompress the chest', match: (e) => e.code === 'procedure.needle' || e.code === 'procedure.chestTube' || e.code === 'procedure.chestTubeStarted', why: 'Relieves the raised intrathoracic pressure obstructing venous return.' },
      { label: 'High-flow oxygen', match: code('oxygen.set'), why: 'Collapsed lung causes shunt-driven hypoxaemia.' },
    ],
    tests: ['pocus'],
    alternatives: ['Finger thoracostomy at the 4th/5th ICS anterior axillary line', 'Avoid positive-pressure ventilation before decompression', 'Chest drain after needle decompression'],
  },
  myocardialIschemia: {
    actions: [
      { label: '12-lead ECG', match: order('ecg12'), why: 'Diagnostic within minutes; determines the reperfusion strategy.' },
      { label: 'Aspirin', match: drug('aspirin'), why: 'Slows thrombus propagation.' },
      { label: 'Reperfusion (cath lab / lysis)', match: (e) => e.code === 'procedure.cathlab' || drug('tenecteplase')(e), why: 'Infarct size grows with every minute of occlusion.' },
    ],
    tests: ['ecg12', 'troponin'],
    alternatives: ['Opioid analgesia for pain', 'Nitrates (caution with RV involvement or hypotension)', 'Anticoagulation', 'Pads on in case of VF'],
  },
  sepsis: {
    actions: [
      { label: 'Antibiotics', match: antibiotic(), why: 'Every hour of delay in septic shock worsens outcome; coverage must match the organism.' },
      { label: 'Fluid resuscitation', match: fluid(), why: 'Restores preload lost to vasodilation and capillary leak.' },
      { label: 'Vasopressor', match: (e) => drug('norepinephrine')(e) || drug('vasopressin')(e), why: 'Needed when hypotension persists despite fluid.' },
    ],
    tests: ['lactate', 'cultures', 'cbc', 'bmp'],
    alternatives: ['Cultures before antibiotics without delaying them', 'Source identification (urinalysis, CXR)', 'Check allergies before β-lactams'],
  },
  hypoglycemia: {
    actions: [
      { label: 'Check glucose', match: order('glucose'), why: 'Every patient with altered consciousness needs a glucose check.' },
      { label: 'IV dextrose / glucagon', match: (e) => drug('dextrose50')(e) || drug('dextrose10')(e) || drug('glucagon')(e), why: 'Rapidly restores cerebral glucose supply.' },
    ],
    tests: ['glucose'],
    alternatives: ['Dextrose infusion for long-acting insulin overdose', 'IM glucagon without IV access'],
  },
  dka: {
    actions: [
      { label: 'Fluid resuscitation', match: fluid(), why: 'Profound osmotic-diuresis volume deficit.' },
      { label: 'Insulin infusion', match: drug('insulinRegular'), why: 'Stops ketogenesis.' },
      { label: 'Potassium replacement', match: drug('potassiumChloride'), why: 'Insulin shifts K into cells; total body K is depleted.' },
    ],
    tests: ['vbg', 'ketones', 'bmp'],
    alternatives: ['Delay insulin until K is known', 'Frequent glucose/K monitoring', 'Add dextrose once glucose falls'],
  },
  dehydration: {
    actions: [{ label: 'Balanced crystalloid bolus', match: fluid(), why: 'Restores ECF volume.' }],
    tests: ['bmp', 'vbg'],
    alternatives: ['Reassess after each bolus (POCUS IVC, BP, urine output)', 'Replace potassium'],
  },
  arrhythmia: {
    actions: [
      { label: '12-lead ECG', match: order('ecg12'), why: 'Rhythm diagnosis guides therapy.' },
      { label: 'Rhythm-specific therapy', match: (e) => ['adenosine', 'diltiazem', 'metoprolol', 'amiodarone', 'atropine', 'isoproterenol'].includes(String(e.data?.['drugId'])) || e.code === 'procedure.vagal' || e.code === 'defib.shock' || e.code === 'pacing.set', why: 'Each arrhythmia has a mechanism-specific treatment.' },
    ],
    tests: ['ecg12', 'bmp'],
    alternatives: ['Synchronised cardioversion for instability', 'Pacing with analgesia/sedation for CHB'],
  },
  cardiacArrest: {
    actions: [
      { label: 'Defibrillation', match: code('defib.shock'), why: 'The definitive treatment for VF/pulseless VT.' },
      { label: 'Adrenaline', match: drug('epinephrine'), why: 'Raises aortic diastolic (coronary perfusion) pressure during CPR.' },
      { label: 'Amiodarone', match: drug('amiodarone'), why: 'After three shocks in refractory VF.' },
    ],
    tests: ['vbg'],
    alternatives: ['Minimise pauses in compressions', 'Use EtCO₂ to gauge CPR quality and detect ROSC', 'Consider reversible causes (Hs & Ts)'],
  },
  hyperkalemia: {
    actions: [
      { label: 'IV calcium', match: (e) => drug('calciumGluconate')(e) || drug('calciumChloride')(e), why: 'Stabilises the myocardium within minutes.' },
      { label: 'Insulin–dextrose', match: drug('insulinRegular'), why: 'Shifts potassium into cells.' },
      { label: 'Definitive removal (dialysis)', match: code('procedure.dialysis'), why: 'Shifts are temporary.' },
    ],
    tests: ['ecg12', 'vbg'],
    alternatives: ['Nebulised salbutamol as additional shift', 'Continuous ECG monitoring'],
  },
  hypothermia: {
    actions: [
      { label: 'Core temperature', match: (e) => e.code === 'monitor.attach' && JSON.stringify(e.message).includes('TEMP'), why: 'Diagnosis and severity depend on core temperature.' },
      { label: 'Active rewarming', match: (e) => e.code === 'procedure.warming' || (e.code === 'fluid.start' && e.data?.['fluidId'] !== undefined && String(e.message).includes('warmed')), why: 'Forced-air warming and warmed fluids.' },
    ],
    tests: ['glucose', 'vbg'],
    alternatives: ['Gentle handling to avoid VF', 'Remove wet clothing'],
  },
};

export function analyzeCase(scenario: ScenarioDefinition, events: SimulationEvent[], history: HistorySample[], status: CaseStatus, diagnosis: string | null): DebriefAnalysis {
  const actions = events.filter((e) => e.kind === 'action');
  const types = Array.from(new Set(scenario.pathologies.map((p) => p.type)));
  const keyActions: KeyAction[] = [...COMMON];
  const tests = new Set<string>();
  const alternatives: string[] = [];
  for (const t of types) {
    const spec = BY_PATHOLOGY[t];
    if (!spec) continue;
    keyActions.push(...spec.actions);
    spec.tests.forEach((x) => tests.add(x));
    alternatives.push(...spec.alternatives);
  }
  const decisions: DecisionPoint[] = keyActions.map((k) => {
    const first = actions.find(k.match);
    return { label: k.label, done: !!first, at: first?.t ?? null, why: k.why };
  });

  // Physiological response 5 min after each drug/fluid/procedure
  const responses: ResponseObservation[] = [];
  const at = (t: number) => history.reduce<HistorySample | null>((best, h) => (Math.abs(h.t - t) < Math.abs((best?.t ?? Infinity) - t) ? h : best), null);
  for (const a of actions.filter((e) => /^(drug\.given|drug\.infusion|fluid\.start|blood\.start|procedure\.|defib\.shock|oxygen\.set|bvm\.set|ventilator\.set|airway\.intubated)/.test(e.code))) {
    const before = at(a.t);
    const after = at(a.t + 300);
    if (!before || !after || after.t <= before.t) continue;
    const deltas: string[] = [];
    const d = (label: string, b: number, x: number, unit: string, thr: number) => {
      if (Math.abs(x - b) >= thr) deltas.push(`${label} ${Math.round(b)}→${Math.round(x)}${unit}`);
    };
    d('MAP', before.map, after.map, ' mmHg', 6);
    d('HR', before.hr, after.hr, '/min', 10);
    d('SaO₂', before.spo2, after.spo2, '%', 3);
    d('RR', before.rr, after.rr, '/min', 4);
    d('PaCO₂', before.paco2, after.paco2, ' mmHg', 6);
    if (Math.abs(after.glucose - before.glucose) > 1.5) deltas.push(`glucose ${before.glucose.toFixed(1)}→${after.glucose.toFixed(1)}`);
    if (Math.abs(after.k - before.k) > 0.4) deltas.push(`K ${before.k.toFixed(1)}→${after.k.toFixed(1)}`);
    if (before.rhythm !== after.rhythm) deltas.push(`rhythm ${before.rhythm}→${after.rhythm}`);
    if (Math.abs(after.gcs - before.gcs) >= 2) deltas.push(`GCS ${before.gcs}→${after.gcs}`);
    responses.push({ t: a.t, action: a.message, observation: deltas.length ? `Within 5 min: ${deltas.join(', ')}.` : 'No major change in the tracked variables within 5 min.' });
  }

  const ordered = new Set(events.filter((e) => e.code === 'diagnostic.order').map((e) => String(e.data?.['testId'])));
  const missed: string[] = [];
  for (const t of tests) if (!ordered.has(t)) missed.push(`Investigation not obtained: ${t}`);
  for (const d of decisions) if (!d.done) missed.push(`Not done: ${d.label} — ${d.why}`);
  const examined = events.filter((e) => e.kind === 'exam');
  if (!examined.some((e) => String(e.data?.['exam']).includes('breathing') || String(e.data?.['exam']).includes('auscultation'))) missed.push('Chest was never examined/auscultated.');
  if (!events.some((e) => e.code === 'exam.history')) missed.push('No history was taken from the patient.');

  const harms = events.filter((e) => e.code.startsWith('hidden.') || e.code === 'resp.aspiration' || e.code === 'cpr.onPulse' || e.code === 'drug.unsafeSwallow' || e.code === 'patient.shockPain' || (e.code === 'defib.shock' && e.severity === 'critical')).map((e) => `${formatClock(e.t)} ${e.message}`);

  const dxText = (diagnosis ?? '').toLowerCase();
  const diagnosisCorrect = diagnosis ? scenario.diagnosisKeywords.some((k) => dxText.includes(k.toLowerCase())) : null;
  const end = status.endedAt ?? history[history.length - 1]?.t ?? 0;
  return {
    outcome: !status.alive ? `Died at ${formatClock(status.deathTime ?? end)} (${status.deathCause})` : status.rosc ? 'Return of spontaneous circulation achieved; alive at end of case' : 'Alive at end of case',
    survived: status.alive,
    duration: end,
    diagnosisSubmitted: diagnosis,
    diagnosisCorrect,
    hiddenDiagnosis: scenario.hiddenDiagnosis,
    decisions,
    responses,
    missed,
    harms,
    alternatives: Array.from(new Set(alternatives)),
    counts: {
      actions: actions.length,
      examinations: examined.length,
      tests: ordered.size,
      drugs: actions.filter((e) => e.code === 'drug.given' || e.code === 'drug.infusion').length,
    },
  };
}
