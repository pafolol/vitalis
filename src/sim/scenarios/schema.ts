import { z } from 'zod';

/**
 * Scenario schema.
 *
 * A scenario is *data*: it composes reusable pathology modules (each with a
 * validated parameter schema) with patient constraints, narrative handoff
 * text, patient knowledge for the AI patient, authored diagnostic evidence
 * that the physiology cannot compute, and learning objectives.
 *
 * AI-generated scenarios are validated against exactly this schema, so the
 * model can only compose capabilities the deterministic simulator supports.
 */

const side = z.enum(['left', 'right']);

export const PathologyParamSchemas = {
  hemorrhage: z.object({
    site: z.enum(['leftThigh', 'rightThigh', 'leftArm', 'rightArm', 'scalp', 'abdomen', 'pelvis', 'chestLeft', 'chestRight', 'gi']),
    /** Bleeding rate at a MAP of 90 mmHg with normal coagulation (mL/min) */
    rateMlMin: z.number().min(1).max(600),
    /** Pre-arrival blood loss already sustained (mL) */
    priorLossMl: z.number().min(0).max(4000).default(0),
    mechanism: z.string().max(120).default('penetrating injury'),
  }),
  anaphylaxis: z.object({
    allergen: z.string().max(80),
    severity: z.number().min(0.1).max(1),
    exposure: z.enum(['ingested', 'sting', 'iv']).default('ingested'),
  }),
  asthma: z.object({
    severity: z.number().min(0.1).max(1),
    /** Rate at which bronchospasm is still worsening (per hour, 0 = static) */
    progression: z.number().min(0).max(1).default(0.2),
    trigger: z.string().max(80).default('viral infection'),
  }),
  opioidToxicity: z.object({
    agent: z.enum(['heroin', 'fentanyl', 'methadone', 'oxycodone']),
    doseMg: z.number().min(0.05).max(500),
    route: z.enum(['IV', 'IN', 'PO']).default('IV'),
  }),
  sepsis: z.object({
    source: z.enum(['urinary', 'pneumonia', 'abdominal', 'skin']),
    organism: z.enum(['ecoli', 'klebsiellaEsbl', 'pseudomonas', 'strepPneumo', 'mssa', 'mrsa']),
    /** Initial pathogen burden 0..1 */
    burden: z.number().min(0.05).max(1),
    /** Doubling tendency (1/h) */
    growth: z.number().min(0.05).max(1.5).default(0.35),
  }),
  hypoglycemia: z.object({
    cause: z.enum(['insulinOverdose', 'missedMeal']),
    insulinUnits: z.number().min(0).max(1000).default(0),
  }),
  dka: z.object({
    severity: z.number().min(0.1).max(1),
  }),
  dehydration: z.object({
    deficitMl: z.number().min(0).max(6000),
    ongoingLossMlH: z.number().min(0).max(1000).default(100),
    diarrhoea: z.boolean().default(true),
  }),
  tensionPneumothorax: z.object({
    side,
    leakMlMin: z.number().min(5).max(800),
    initialAirMl: z.number().min(0).max(3000).default(600),
    traumatic: z.boolean().default(true),
  }),
  myocardialIschemia: z.object({
    territory: z.enum(['lad', 'lcx', 'rca']),
    /** 1 = complete occlusion (STEMI); 0.6–0.9 = subtotal */
    occlusion: z.number().min(0.3).max(1),
    collateral: z.number().min(0).max(0.4).default(0.1),
  }),
  arrhythmia: z.object({
    kind: z.enum(['svt', 'afib', 'chb', 'vtach']),
    rate: z.number().min(30).max(260).optional(),
  }),
  cardiacArrest: z.object({
    initialRhythm: z.enum(['vfib', 'asystole']),
    /** Minutes of no-flow before CPR began */
    noFlowMin: z.number().min(0).max(20).default(2),
    /** Minutes of bystander/EMS CPR before arrival */
    lowFlowMin: z.number().min(0).max(40).default(8),
  }),
  hyperkalemia: z.object({
    initialK: z.number().min(5).max(9.5),
    riseMmolPerHour: z.number().min(0).max(2).default(0.3),
  }),
  hypothermia: z.object({
    coreC: z.number().min(26).max(35.5),
    ambientC: z.number().min(-10).max(22).default(18),
  }),
} as const;

export type PathologyType = keyof typeof PathologyParamSchemas;
export const PATHOLOGY_TYPES = Object.keys(PathologyParamSchemas) as PathologyType[];

const pathologyEntry = z.discriminatedUnion(
  'type',
  PATHOLOGY_TYPES.map((t) =>
    z.object({
      type: z.literal(t),
      params: PathologyParamSchemas[t],
      /** Minutes the process has been evolving before the patient arrives (simulated pre-roll) */
      onsetMinutesBeforeArrival: z.number().min(0).max(1440).default(0),
      /** Minutes after arrival at which this process begins (complications) */
      startsAfterMinutes: z.number().min(0).max(240).default(0),
    }),
  ) as unknown as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]],
);

export const AllergySchema = z.object({
  agent: z.string().max(80),
  drugClass: z.string().max(40).optional(),
  reaction: z.enum(['anaphylaxis', 'rash', 'angioedema', 'intolerance']),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1).max(80),
  version: z.literal(1).default(1),
  title: z.string().min(1).max(120),
  /** Neutral student-facing tagline — must not reveal the diagnosis */
  tagline: z.string().max(200),
  category: z.enum(['respiratory', 'cardiovascular', 'toxicology', 'metabolic', 'trauma', 'infection', 'environmental', 'mixed']),
  difficulty: z.number().int().min(1).max(5),
  hiddenDiagnosis: z.string().min(1).max(200),
  /** Keywords accepted as a correct working diagnosis in the debrief */
  diagnosisKeywords: z.array(z.string().max(60)).min(1).max(20),
  differentials: z.array(z.string().max(80)).max(12).default([]),
  patient: z.object({
    ageRange: z.tuple([z.number().min(16).max(100), z.number().min(16).max(100)]),
    sex: z.enum(['male', 'female', 'any']).default('any'),
    bmiRange: z.tuple([z.number().min(15).max(55), z.number().min(15).max(55)]).optional(),
    fitnessRange: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
    requiredHistory: z.array(z.string().max(40)).max(8).default([]),
    forbiddenHistory: z.array(z.string().max(40)).max(12).default([]),
    allergies: z.array(AllergySchema).max(4).optional(),
    social: z
      .object({
        smoking: z.enum(['never', 'former', 'current']).optional(),
        alcohol: z.enum(['none', 'social', 'heavy']).optional(),
        drugs: z.enum(['none', 'cannabis', 'opioids', 'stimulants']).optional(),
      })
      .optional(),
    unknownIdentity: z.boolean().default(false),
  }),
  presentation: z.object({
    /** Paramedic/triage handoff. Placeholders: {age} {sex} {name} {pronoun} */
    handoff: z.string().min(10).max(1200),
    chiefComplaint: z.string().max(200),
    arrivalMode: z.enum(['ambulance', 'walk-in', 'transfer']).default('ambulance'),
    /** Ambient temperature of the ED (°C) */
    ambientC: z.number().min(15).max(30).default(22),
    /** Interventions already in place on arrival */
    prehospital: z
      .object({
        oxygen: z.enum(['none', 'nasalCannula', 'simpleMask', 'nonRebreather']).default('none'),
        oxygenFlow: z.number().min(0).max(15).default(0),
        ivAccess: z.boolean().default(false),
        cprInProgress: z.boolean().default(false),
        bvm: z.boolean().default(false),
        tourniquet: z.enum(['leftArm', 'rightArm', 'leftLeg', 'rightLeg']).nullable().default(null),
      })
      .default({ oxygen: 'none', oxygenFlow: 0, ivAccess: false, cprInProgress: false, bvm: false, tourniquet: null }),
  }),
  pathologies: z.array(pathologyEntry).min(1).max(5),
  /** What the patient personally knows and would say (drives the AI patient) */
  patientKnowledge: z.object({
    story: z.string().max(1500),
    symptoms: z.array(z.string().max(120)).max(15).default([]),
    /** Facts the patient knows but only reveals if asked specifically */
    ifAsked: z.array(z.string().max(200)).max(15).default([]),
    /** Things the patient would deny or conceal (e.g. drug use) */
    conceals: z.array(z.string().max(200)).max(6).default([]),
    personality: z.string().max(200).default('cooperative but frightened'),
  }),
  /** Evidence the physiology cannot compute (clearly marked as authored in results) */
  authoredFindings: z
    .object({
      toxScreen: z.string().max(300).optional(),
      chestXray: z.string().max(400).optional(),
      ctHead: z.string().max(400).optional(),
      ctAbdomen: z.string().max(400).optional(),
      fast: z.string().max(300).optional(),
      urinalysis: z.string().max(300).optional(),
      bloodCulture: z.string().max(200).optional(),
      lipase: z.number().optional(),
      exam: z.array(z.object({ zone: z.string().max(40), finding: z.string().max(200) })).max(12).default([]),
    })
    .default({ exam: [] }),
  learningObjectives: z.array(z.string().max(200)).min(1).max(10),
  keyEvidence: z.array(z.string().max(200)).max(15).default([]),
  /** Author notes for the debrief (simulator-specific behaviours to highlight) */
  debriefNotes: z.array(z.string().max(400)).max(10).default([]),
  source: z.enum(['library', 'ai-generated', 'custom']).default('library'),
});

export type PathologyParams<K extends PathologyType> = z.infer<(typeof PathologyParamSchemas)[K]>;

export type ScenarioPathology = {
  [K in PathologyType]: { type: K; params: PathologyParams<K>; onsetMinutesBeforeArrival: number; startsAfterMinutes: number };
}[PathologyType];

export type ScenarioDefinition = Omit<z.infer<typeof ScenarioSchema>, 'pathologies'> & { pathologies: ScenarioPathology[] };
export type ScenarioInput = Omit<z.input<typeof ScenarioSchema>, 'pathologies'> & {
  pathologies: { type: PathologyType; params: Record<string, unknown>; onsetMinutesBeforeArrival?: number; startsAfterMinutes?: number }[];
};

export interface ValidationOutcome {
  ok: boolean;
  scenario?: ScenarioDefinition;
  errors: string[];
}

export function validateScenario(input: unknown): ValidationOutcome {
  const parsed = ScenarioSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const s = parsed.data as unknown as ScenarioDefinition;
  const errors: string[] = [];
  if (s.patient.ageRange[0] > s.patient.ageRange[1]) errors.push('patient.ageRange: min > max');
  if (s.patient.bmiRange && s.patient.bmiRange[0] > s.patient.bmiRange[1]) errors.push('patient.bmiRange: min > max');
  const lowerTitle = `${s.title} ${s.tagline}`.toLowerCase();
  for (const kw of s.diagnosisKeywords) {
    const k = kw.toLowerCase();
    const words = lowerTitle.split(/[^a-z0-9]+/);
    const leaks = k.length > 3 ? lowerTitle.includes(k) : words.includes(k);
    if (leaks) errors.push(`title/tagline reveals the hidden diagnosis keyword "${kw}"`);
  }
  const arrest = s.pathologies.filter((p) => p.type === 'cardiacArrest').length;
  if (arrest > 1) errors.push('only one cardiacArrest pathology is supported');
  return errors.length ? { ok: false, errors } : { ok: true, scenario: s, errors: [] };
}
