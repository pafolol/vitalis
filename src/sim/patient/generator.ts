import { Rng } from '../core/rng';
import { clamp, lerp } from '../core/math';
import type { Allergy, HistoryItem, HomeMedication, PatientBaseline, PatientDefinition, Sex } from '../types';

/**
 * Seeded procedural patient generator.
 *
 * Demographics and anthropometrics are sampled first; medical history is
 * sampled conditionally on age/BMI/sex/smoking; baseline physiology is then
 * *derived* from those properties (e.g. eGFR declines with age and CKD, pulse
 * pressure widens with arterial stiffening, COPD raises airway resistance and
 * shunt). Different generated patients therefore respond differently to the
 * same insult for physiological reasons.
 */

export interface PatientConstraints {
  ageRange?: [number, number];
  sex?: Sex | 'any';
  bmiRange?: [number, number];
  fitnessRange?: [number, number];
  requiredHistory?: string[];
  forbiddenHistory?: string[];
  allergies?: Allergy[];
  medications?: HomeMedication[];
  social?: Partial<PatientDefinition['social']>;
  /** Unidentified patient (name unknown to staff) */
  unknownIdentity?: boolean;
}

const MALE_NAMES = ['James', 'Daniel', 'Mateo', 'Omar', 'Wei', 'Kwame', 'Liam', 'Arjun', 'Hiroshi', 'Samuel', 'Diego', 'Andrei', 'Tomasz', 'Malik', 'Noah', 'Ethan', 'Rafael', 'Ivan', 'Jonah', 'Farid', 'Kenji', 'Luca', 'Marcus', 'Elias'];
const FEMALE_NAMES = ['Maria', 'Aisha', 'Emily', 'Sofia', 'Mei', 'Amara', 'Olivia', 'Priya', 'Yuki', 'Grace', 'Lucia', 'Elena', 'Zofia', 'Nia', 'Hannah', 'Chloe', 'Leila', 'Ingrid', 'Rosa', 'Fatima', 'Ana', 'Keiko', 'Clara', 'Nora'];
const SURNAMES = ['Okafor', 'Novak', 'García', 'Chen', 'Haddad', 'Kowalski', 'Mensah', 'Patel', 'Nakamura', 'Silva', 'Andersson', 'Ivanova', 'Rahman', 'Moreau', 'Brennan', 'Castillo', 'Adeyemi', 'Schmidt', 'Rossi', 'Kim', 'Johansson', 'Nguyen', 'Walker', 'Dubois', 'Hughes', 'Tanaka', 'Mahmoud', 'Oliveira'];
const OCCUPATIONS = ['teacher', 'warehouse worker', 'nurse', 'software developer', 'retired', 'bus driver', 'student', 'chef', 'accountant', 'construction worker', 'unemployed', 'shop assistant', 'electrician', 'lawyer', 'delivery driver', 'hairdresser', 'farmer', 'engineer', 'cleaner', 'musician'];

interface ConditionDef {
  key: string;
  label: string;
  /** Base prevalence modifier as function of patient features */
  p: (ctx: { age: number; bmi: number; sex: Sex; smoker: boolean }) => number;
  meds: HomeMedication[];
}

const CONDITIONS: ConditionDef[] = [
  { key: 'hypertension', label: 'Hypertension', p: ({ age, bmi }) => clamp(0.02 + (age - 25) * 0.009 + (bmi - 25) * 0.015, 0, 0.7), meds: [{ name: 'Amlodipine', dose: '5 mg daily', indication: 'blood pressure' }] },
  { key: 'type2Diabetes', label: 'Type 2 diabetes', p: ({ age, bmi }) => clamp((age - 30) * 0.004 + (bmi - 27) * 0.012, 0, 0.35), meds: [{ name: 'Metformin', dose: '1 g twice daily', indication: 'diabetes' }] },
  { key: 'asthma', label: 'Asthma', p: ({ age }) => (age < 50 ? 0.09 : 0.06), meds: [{ name: 'Salbutamol inhaler', dose: 'as needed', indication: 'asthma' }, { name: 'Budesonide inhaler', dose: '200 mcg twice daily', indication: 'asthma prevention' }] },
  { key: 'copd', label: 'COPD', p: ({ age, smoker }) => (smoker && age > 45 ? 0.25 : age > 55 ? 0.03 : 0), meds: [{ name: 'Tiotropium inhaler', dose: 'once daily', indication: 'COPD' }] },
  { key: 'cad', label: 'Coronary artery disease', p: ({ age, sex, smoker }) => clamp((age - 40) * (sex === 'male' ? 0.006 : 0.004) + (smoker ? 0.05 : 0), 0, 0.35), meds: [{ name: 'Aspirin', dose: '75 mg daily', indication: 'heart' }, { name: 'Atorvastatin', dose: '40 mg nightly', indication: 'cholesterol' }] },
  { key: 'heartFailure', label: 'Heart failure (reduced EF)', p: ({ age }) => clamp((age - 55) * 0.004, 0, 0.12), meds: [{ name: 'Bisoprolol', dose: '5 mg daily', indication: 'heart failure', effectKey: 'betaBlocker' }, { name: 'Furosemide', dose: '40 mg daily', indication: 'fluid' }] },
  { key: 'ckd', label: 'Chronic kidney disease (stage 3)', p: ({ age }) => clamp((age - 50) * 0.005, 0, 0.2), meds: [] },
  { key: 'afibChronic', label: 'Atrial fibrillation (paroxysmal)', p: ({ age }) => clamp((age - 60) * 0.006, 0, 0.15), meds: [{ name: 'Apixaban', dose: '5 mg twice daily', indication: 'stroke prevention' }] },
  { key: 'hypothyroidism', label: 'Hypothyroidism', p: ({ sex }) => (sex === 'female' ? 0.05 : 0.01), meds: [{ name: 'Levothyroxine', dose: '100 mcg daily', indication: 'thyroid' }] },
  { key: 'depression', label: 'Depression', p: () => 0.08, meds: [{ name: 'Sertraline', dose: '50 mg daily', indication: 'mood' }] },
  { key: 'gord', label: 'Gastro-oesophageal reflux', p: () => 0.08, meds: [{ name: 'Omeprazole', dose: '20 mg daily', indication: 'reflux' }] },
];

/** Conditions that are only added when a scenario requires them. */
const SCENARIO_CONDITIONS: Record<string, { label: string; meds: HomeMedication[] }> = {
  type1Diabetes: { label: 'Type 1 diabetes', meds: [{ name: 'Insulin glargine', dose: '22 units nightly', indication: 'diabetes' }, { name: 'Insulin aspart', dose: 'with meals', indication: 'diabetes' }] },
  opioidUseDisorder: { label: 'Opioid use disorder', meds: [] },
  esrd: { label: 'End-stage renal disease on haemodialysis', meds: [{ name: 'Sevelamer', dose: '800 mg with meals', indication: 'phosphate' }] },
  alcoholUse: { label: 'Alcohol use disorder', meds: [{ name: 'Thiamine', dose: '100 mg daily', indication: 'vitamin' }] },
  peanutAllergy: { label: 'Peanut allergy', meds: [{ name: 'Epinephrine auto-injector', dose: '0.3 mg as needed', indication: 'allergy' }] },
  wpw: { label: 'Recurrent palpitations', meds: [] },
  chronicPain: { label: 'Chronic back pain', meds: [{ name: 'Oxycodone', dose: '10 mg twice daily', indication: 'pain' }] },
};

function bloodVolumeNadler(sex: Sex, heightM: number, weightKg: number): number {
  const h3 = heightM * heightM * heightM;
  const litres = sex === 'male' ? 0.3669 * h3 + 0.03219 * weightKg + 0.6041 : 0.3561 * h3 + 0.03308 * weightKg + 0.1833;
  return litres * 1000;
}

function leanBodyMassBoer(sex: Sex, heightCm: number, weightKg: number): number {
  return sex === 'male' ? 0.407 * weightKg + 0.267 * heightCm - 19.2 : 0.252 * weightKg + 0.473 * heightCm - 48.3;
}

export function generatePatient(seed: string, constraints: PatientConstraints = {}): PatientDefinition {
  const rng = Rng.from(seed, 'patient');

  const sex: Sex = constraints.sex && constraints.sex !== 'any' ? constraints.sex : rng.chance(0.5) ? 'male' : 'female';
  const [aMin, aMax] = constraints.ageRange ?? [18, 85];
  const ageYears = Math.round(rng.range(aMin, aMax));

  const heightMean = sex === 'male' ? 176 : 163;
  const heightCm = Math.round(rng.normalClamped(heightMean - Math.max(0, ageYears - 60) * 0.15, 7, heightMean - 18, heightMean + 20));
  const [bMin, bMax] = constraints.bmiRange ?? [18.5, 38];
  const bmiMean = 24 + Math.min(4, Math.max(0, ageYears - 25) * 0.08);
  const bmi = +clamp(rng.normalClamped(bmiMean, 4.2, 17.5, 45), bMin, bMax).toFixed(1);
  const heightM = heightCm / 100;
  const weightKg = Math.round(bmi * heightM * heightM);

  const smokingRoll = rng.next();
  const smoking = constraints.social?.smoking ?? (smokingRoll < 0.17 ? 'current' : smokingRoll < 0.35 ? 'former' : 'never');
  const alcoholRoll = rng.next();
  const alcohol = constraints.social?.alcohol ?? (alcoholRoll < 0.06 ? 'heavy' : alcoholRoll < 0.6 ? 'social' : 'none');
  const drugs = constraints.social?.drugs ?? 'none';

  const [fMin, fMax] = constraints.fitnessRange ?? [0, 1];
  const fitness = +clamp(rng.normalClamped(0.55 - Math.max(0, ageYears - 40) * 0.006 - Math.max(0, bmi - 27) * 0.02 - (smoking === 'current' ? 0.1 : 0), 0.18, 0, 1), fMin, fMax).toFixed(2);

  const skinTone = +rng.range(0.05, 0.95).toFixed(2);

  // --- history ---

  const forbidden = new Set(constraints.forbiddenHistory ?? []);
  const history: HistoryItem[] = [];
  const medications: HomeMedication[] = [...(constraints.medications ?? [])];
  const addCondition = (key: string, label: string, meds: HomeMedication[], known = true) => {
    if (history.some((h) => h.key === key)) return;
    history.push({ key, label, knownToPatient: known });
    for (const m of meds) if (!medications.some((x) => x.name === m.name)) medications.push(m);
  };
  for (const req of constraints.requiredHistory ?? []) {
    const cond = CONDITIONS.find((c) => c.key === req);
    if (cond) addCondition(cond.key, cond.label, cond.meds);
    else if (SCENARIO_CONDITIONS[req]) addCondition(req, SCENARIO_CONDITIONS[req].label, SCENARIO_CONDITIONS[req].meds);
  }
  for (const c of CONDITIONS) {
    if (forbidden.has(c.key)) continue;
    if (rng.chance(c.p({ age: ageYears, bmi, sex, smoker: smoking === 'current' || (smoking === 'former' && ageYears > 50) }))) addCondition(c.key, c.label, c.meds);
  }
  // COPD and asthma are mutually exclusive in the generator for clarity
  if (history.some((h) => h.key === 'copd') && history.some((h) => h.key === 'asthma') && !(constraints.requiredHistory ?? []).includes('asthma')) {
    history.splice(history.findIndex((h) => h.key === 'asthma'), 1);
  }
  if (alcohol === 'heavy') addCondition('alcoholUse', 'Alcohol use disorder', SCENARIO_CONDITIONS.alcoholUse!.meds);
  if (drugs === 'opioids') addCondition('opioidUseDisorder', 'Opioid use disorder', []);

  // --- allergies ---
  const allergies: Allergy[] = [...(constraints.allergies ?? [])];
  const allergyRoll = rng.next();
  if (allergies.length === 0 || !constraints.allergies) {
    if (allergyRoll < 0.08) allergies.push({ agent: 'Penicillin', drugClass: 'penicillin', reaction: rng.chance(0.25) ? 'anaphylaxis' : 'rash' });
    else if (allergyRoll < 0.11) allergies.push({ agent: 'Sulfonamides', drugClass: 'sulfonamide', reaction: 'rash' });
    else if (allergyRoll < 0.13) allergies.push({ agent: 'Codeine', drugClass: 'codeine', reaction: 'intolerance' });
  }

  const has = (k: string) => history.some((h) => h.key === k);

  // --- derived baseline physiology ---
  const ageOver40 = Math.max(0, ageYears - 40);
  const bloodVolumeMl = Math.round(bloodVolumeNadler(sex, heightM, weightKg));
  const leanBodyMassKg = +leanBodyMassBoer(sex, heightCm, weightKg).toFixed(1);
  const bodyFatPct = +clamp((1 - leanBodyMassKg / weightKg) * 100, 6, 55).toFixed(1);
  const bsa = +Math.sqrt((heightCm * weightKg) / 3600).toFixed(2);

  let renalFunction = clamp(1.1 - ageOver40 * 0.009, 0.45, 1.2);
  if (has('ckd')) renalFunction *= 0.45;
  if (has('esrd')) renalFunction = 0.08;
  if (has('type2Diabetes')) renalFunction *= 0.9;

  let hepaticFunction = 1 - Math.max(0, ageYears - 65) * 0.005;
  if (alcohol === 'heavy') hepaticFunction *= 0.75;

  let lv = 1.05 - ageOver40 * 0.002;
  if (has('heartFailure')) lv *= 0.5;
  if (has('cad')) lv *= 0.92;
  let rv = 1;
  if (has('copd')) rv *= 0.9;

  let airwayResistance = 1;
  let shunt = 0.03;
  let chronicPaCO2 = 40;
  if (has('asthma')) airwayResistance *= 1.3;
  if (has('copd')) {
    airwayResistance *= 1.9;
    shunt += 0.04;
    chronicPaCO2 = rng.chance(0.4) ? 50 : 42;
  }
  if (smoking === 'current') airwayResistance *= 1.1;

  const arterialCompliance = clamp(1.15 - ageOver40 * 0.011 - (has('hypertension') ? 0.12 : 0), 0.45, 1.25);

  let coronaryReserve = clamp(1 - ageOver40 * 0.006 - (smoking === 'current' ? 0.1 : 0) - (has('type2Diabetes') ? 0.1 : 0), 0.3, 1);
  if (has('cad')) coronaryReserve *= 0.6;

  let insulinSensitivity = clamp(1.3 - (bmi - 22) * 0.04 + fitness * 0.3, 0.3, 1.6);
  if (has('type2Diabetes')) insulinSensitivity *= 0.5;
  let betaCellFunction = has('type2Diabetes') ? 0.45 : 1;
  if (has('type1Diabetes')) betaCellFunction = 0;
  const glycogenStores = alcohol === 'heavy' ? 0.35 : 1;

  const hrBase = Math.round(clamp(rng.normal(74 - fitness * 16 + (has('hypertension') ? 2 : 0), 6), 50, 96));
  const betaBlocked = medications.some((m) => m.effectKey === 'betaBlocker');
  const heartRate = betaBlocked ? Math.round(hrBase * 0.85) : hrBase;

  const sbpBase = 112 + ageOver40 * 0.6 + (has('hypertension') ? 16 : 0) + (sex === 'male' ? 4 : 0) + (bmi - 25) * 0.4;
  const systolic = Math.round(rng.normalClamped(sbpBase, 7, 95, 175));
  const ppBase = 43 + ageOver40 * 0.45 + (has('hypertension') ? 8 : 0);
  const diastolic = Math.round(clamp(systolic - ppBase + rng.normal(0, 4), 55, 100));

  const sodium = Math.round(rng.normalClamped(140, 1.8, 135, 145));
  const bicarbonate = Math.round(rng.normalClamped(chronicPaCO2 > 45 ? 30 : 24.5, 1.2, 22, 32));
  const baseline: PatientBaseline = {
    heartRate,
    systolic,
    diastolic,
    respiratoryRate: Math.round(clamp(rng.normal(14, 1.6), 10, 18)),
    temperatureC: +rng.normalClamped(36.8, 0.2, 36.3, 37.3).toFixed(1),
    bloodVolumeMl,
    hemoglobin: +rng.normalClamped(sex === 'male' ? 14.8 : 13.2, 0.9, 11.2, 17).toFixed(1),
    platelets: Math.round(rng.normalClamped(250, 45, 160, 380)),
    wbc: +rng.normalClamped(7, 1.4, 4.2, 10.5).toFixed(1),
    glucose: +rng.normalClamped(has('type2Diabetes') ? 8.2 : 5.1, 0.5, 4.2, 11).toFixed(1),
    sodium,
    potassium: +rng.normalClamped(4.1, 0.25, 3.6, has('ckd') ? 5.2 : 4.8).toFixed(1),
    chloride: 0,
    bicarbonate,
    creatinine: +clamp((sex === 'male' ? 0.95 : 0.78) * (leanBodyMassKg / (sex === 'male' ? 60 : 45)) / Math.max(0.15, renalFunction), 0.5, 9).toFixed(2),
    bun: Math.round(clamp(14 / Math.max(0.2, renalFunction) * lerp(0.8, 1.2, rng.next()), 7, 90)),
    albumin: +rng.normalClamped(alcohol === 'heavy' ? 3.4 : 4.2, 0.25, 3, 5).toFixed(1),
    renalFunction: +renalFunction.toFixed(2),
    hepaticFunction: +hepaticFunction.toFixed(2),
    lvContractility: +lv.toFixed(2),
    rvContractility: +rv.toFixed(2),
    arterialCompliance: +arterialCompliance.toFixed(2),
    airwayResistance: +airwayResistance.toFixed(2),
    shuntFraction: +shunt.toFixed(3),
    coronaryReserve: +coronaryReserve.toFixed(2),
    insulinSensitivity: +insulinSensitivity.toFixed(2),
    betaCellFunction,
    glycogenStores,
    pacingThresholdmA: Math.round(clamp(rng.normal(55 + (bmi - 25) * 1.5, 10), 35, 110)),
    chestWallCm: +clamp(2.5 + (bmi - 22) * 0.28 + (sex === 'female' ? 0.6 : 0) + rng.normal(0, 0.4), 1.8, 9).toFixed(1),
    chronicPaCO2,
    opioidTolerance: drugs === 'opioids' || has('opioidUseDisorder') ? +rng.range(2.5, 5).toFixed(1) : has('chronicPain') ? 1.8 : 1,
  };

  baseline.chloride = Math.round(sodium - bicarbonate - rng.normalClamped(10, 1.5, 7, 13));
  const first = sex === 'male' ? rng.pick(MALE_NAMES) : rng.pick(FEMALE_NAMES);
  const pickedLast = rng.pick(SURNAMES);
  // Slavic surnames take a gendered form
  const last = pickedLast === 'Ivanova' && sex === 'male' ? 'Ivanov' : pickedLast;
  const name = constraints.unknownIdentity ? `Unknown ${sex === 'male' ? 'male' : 'female'}` : `${first} ${last}`;

  return {
    seed,
    name,
    sex,
    ageYears,
    heightCm,
    weightKg,
    bmi,
    bsa,
    leanBodyMassKg,
    bodyFatPct,
    fitness,
    skinTone,
    occupation: ageYears >= 67 ? 'retired' : rng.pick(OCCUPATIONS),
    livingSituation: rng.pick(['lives alone', 'lives with partner', 'lives with family', 'lives with flatmates']),
    history,
    medications,
    allergies,
    social: { smoking, alcohol, drugs },
    baseline,
  };
}

/** Map the patient to renderer body-shape parameters. */
export function bodyShapeFor(p: PatientDefinition): { sex: Sex; ageYears: number; heightM: number; weightFactor: number; muscleFactor: number; skinTone: number } {
  const weightFactor = clamp((p.bmi - 24) / 10, -1, 1);
  const muscleFactor = clamp((p.fitness - 0.5) * 1.6 + (p.sex === 'male' ? 0.1 : -0.1) - Math.max(0, p.ageYears - 60) * 0.015, -1, 1);
  return { sex: p.sex, ageYears: p.ageYears, heightM: p.heightCm / 100, weightFactor: +weightFactor.toFixed(2), muscleFactor: +muscleFactor.toFixed(2), skinTone: p.skinTone };
}
