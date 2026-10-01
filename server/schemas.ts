import { z } from 'zod';

/**
 * Structured-output schemas for every AI endpoint. All fields are required
 * (nullable where optional) so they compile to strict JSON Schema. The model
 * produces *text and proposals only*; none of these shapes can express a
 * change to the simulation state.
 */

export const PatientReplySchema = z.object({
  speech: z.string().describe('Exactly what the patient says aloud. Empty string if the patient cannot speak.'),
  nonverbal: z.string().describe('Brief observable behaviour, e.g. "grimaces, clutching chest". Empty if none.'),
  emotion: z.enum(['calm', 'anxious', 'frightened', 'irritable', 'confused', 'distressed', 'drowsy', 'unresponsive']),
});
export type PatientReply = z.infer<typeof PatientReplySchema>;

export const InstructorReplySchema = z.object({
  answer: z.string().describe('Teaching response. Never state the hidden diagnosis unless the case has ended.'),
  hint_level: z.enum(['none', 'gentle', 'moderate']),
  references_to_observations: z.array(z.string()).describe('Observations from the provided timeline that the learner should reconsider.'),
});
export type InstructorReply = z.infer<typeof InstructorReplySchema>;

/**
 * Scenario drafts: pathology parameters travel as a JSON string so the strict
 * envelope stays small; the server then validates the full draft against the
 * simulator's own ScenarioSchema and returns errors to the model for repair.
 */
export const ScenarioDraftSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  category: z.enum(['respiratory', 'cardiovascular', 'toxicology', 'metabolic', 'trauma', 'infection', 'environmental', 'mixed']),
  difficulty: z.number().int(),
  hiddenDiagnosis: z.string(),
  diagnosisKeywords: z.array(z.string()),
  differentials: z.array(z.string()),
  patient: z.object({
    ageMin: z.number(),
    ageMax: z.number(),
    sex: z.enum(['male', 'female', 'any']),
    requiredHistory: z.array(z.string()),
    unknownIdentity: z.boolean(),
    smoking: z.enum(['never', 'former', 'current']).nullable(),
    alcohol: z.enum(['none', 'social', 'heavy']).nullable(),
    drugs: z.enum(['none', 'cannabis', 'opioids', 'stimulants']).nullable(),
  }),
  presentation: z.object({
    handoff: z.string(),
    chiefComplaint: z.string(),
    arrivalMode: z.enum(['ambulance', 'walk-in', 'transfer']),
  }),
  pathologies: z.array(
    z.object({
      type: z.string(),
      paramsJson: z.string().describe('JSON object with this pathology type’s parameters exactly as listed in the capability manifest'),
      onsetMinutesBeforeArrival: z.number(),
      startsAfterMinutes: z.number(),
    }),
  ),
  patientKnowledge: z.object({
    story: z.string(),
    symptoms: z.array(z.string()),
    ifAsked: z.array(z.string()),
    conceals: z.array(z.string()),
    personality: z.string(),
  }),
  authoredFindings: z.object({
    toxScreen: z.string().nullable(),
    chestXray: z.string().nullable(),
    ctHead: z.string().nullable(),
    fast: z.string().nullable(),
    urinalysis: z.string().nullable(),
    exam: z.array(z.object({ zone: z.string(), finding: z.string() })),
  }),
  learningObjectives: z.array(z.string()),
  keyEvidence: z.array(z.string()),
  debriefNotes: z.array(z.string()),
});
export type ScenarioDraft = z.infer<typeof ScenarioDraftSchema>;

export const DebriefSchema = z.object({
  summary: z.string(),
  timeline_commentary: z.array(z.object({ time: z.string(), comment: z.string() })),
  key_decision_points: z.array(z.object({ time: z.string(), decision: z.string(), assessment: z.string() })),
  physiology_explanation: z.string().describe('Why the simulated patient responded as they did, in terms of the simulated mechanisms.'),
  missed_information: z.array(z.string()),
  alternative_actions: z.array(z.string()).describe('Only actions the simulator supports.'),
  learning_points: z.array(z.string()),
  simulator_vs_real_world: z.string().describe('Explicitly distinguish simulator behaviour from real clinical guidance.'),
});
export type Debrief = z.infer<typeof DebriefSchema>;

/** Request body schemas (untrusted client input). */
export const PatientRequestSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  history: z.array(z.object({ role: z.enum(['clinician', 'patient']), text: z.string().max(2000) })).max(30),
  question: z.string().min(1).max(1000),
});

export const InstructorRequestSchema = z.object({
  mode: z.enum(['hint', 'question']),
  question: z.string().max(1500),
  observedTimeline: z.array(z.string().max(400)).max(80),
  patient: z.record(z.string(), z.unknown()),
  monitor: z.record(z.string(), z.string()),
  learningObjectives: z.array(z.string()).max(12),
  hiddenDiagnosis: z.string().max(300),
  keyEvidence: z.array(z.string()).max(20),
  simulatorNotes: z.array(z.string()).max(12),
});

export const ScenarioRequestSchema = z.object({ prompt: z.string().min(3).max(1000) });

export const DebriefRequestSchema = z.object({
  scenario: z.record(z.string(), z.unknown()),
  patient: z.record(z.string(), z.unknown()),
  analysis: z.record(z.string(), z.unknown()),
  events: z.array(z.string().max(500)).max(600),
  trend: z.array(z.record(z.string(), z.unknown())).max(400),
});
