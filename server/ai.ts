import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { DebriefSchema, InstructorReplySchema, PatientReplySchema, ScenarioDraftSchema, type Debrief, type InstructorReply, type PatientReply } from './schemas';
import { capabilityManifest, draftToScenario } from './scenarioDraft';
import type { ScenarioDefinition } from '../src/sim/scenarios/schema';

/**
 * OpenAI integration (server-side only). Every call uses the Responses API
 * with strict structured outputs. The AI never receives write access to the
 * simulation: it returns text/proposals that the client displays or that the
 * server validates against the simulator schema.
 */

const apiKey = process.env.OPENAI_API_KEY?.trim();
export const MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-5.5';
export const FAST_MODEL = process.env.OPENAI_FAST_MODEL?.trim() || 'gpt-5.4-mini';
export const client = apiKey ? new OpenAI({ apiKey, timeout: 60_000, maxRetries: 1 }) : null;
export const aiAvailable = () => client !== null;

async function structured<T extends z.ZodType>(model: string, schema: T, name: string, instructions: string, input: string): Promise<z.infer<T>> {
  if (!client) throw new Error('AI not configured');
  const res = await client.responses.parse({
    model,
    instructions,
    input,
    text: { format: zodTextFormat(schema, name) },
  });
  const parsed = res.output_parsed as z.infer<T> | null;
  if (!parsed) throw new Error('Model returned no structured output');
  const check = schema.safeParse(parsed);
  if (!check.success) throw new Error('Model output failed schema validation');
  return check.data;
}

const PATIENT_RULES = `You are role-playing a patient in an emergency-department TRAINING SIMULATOR for clinicians.
Rules:
- Stay strictly in character as the patient described in PATIENT_CONTEXT. Speak in first person, plainly, like a real frightened/unwell person — no medical jargon unless the patient would know it.
- You do NOT know your diagnosis. Never name or hint at a diagnosis beyond what the patient themselves believes from their story.
- Only reveal "ifAsked" facts when the clinician asks about that topic. Respect "conceals": initially deny or deflect those, but may admit them if asked directly and respectfully.
- Your ability to talk is set by state.speech and state.responsiveness — obey it exactly:
  * "cannot speak" or responsiveness not "alert"/"drowsy": speech must be "" (or at most a groan) and describe nonverbal behaviour only.
  * "single words": at most 1–3 words. "short phrases": a few words per phrase, breathless.
  * confusion "mild"/"marked": be disoriented, repetitive or off-topic accordingly. agitation "very agitated": restless, may refuse.
  * intubated: cannot speak at all.
- Reflect state.pain, state.breathlessness0to10, state.feelings and recent care events realistically (e.g. relief after pain relief, fear before a procedure).
- Never invent vital-sign numbers, test results, or claims that something "worked" medically. You cannot change your own condition.
- Keep replies short (1–3 sentences).`;

export async function patientReply(context: unknown, history: { role: string; text: string }[], question: string): Promise<PatientReply> {
  const input = `PATIENT_CONTEXT:\n${JSON.stringify(context, null, 1)}\n\nCONVERSATION SO FAR:\n${history.map((h) => `${h.role.toUpperCase()}: ${h.text}`).join('\n') || '(none)'}\n\nCLINICIAN NOW SAYS: ${question}`;
  return structured(FAST_MODEL, PatientReplySchema, 'patient_reply', PATIENT_RULES, input);
}

const INSTRUCTOR_RULES = `You are a senior emergency-medicine educator supervising a learner in a TRAINING SIMULATOR (educational use only; never clinical advice for real patients).
- You are given only what the learner could observe (observedTimeline, monitor, patient's subjective context), the case learning objectives and — for your background only — the hidden diagnosis.
- NEVER reveal or strongly imply the hidden diagnosis. Guide with Socratic questions, point to observations they may have missed, explain physiology concepts.
- In "hint" mode give ONE concise, graded hint (gentle first) aimed at the next most important step in assessment or stabilisation.
- In "question" mode answer the conceptual question accurately and concisely, relating it to what is happening in this simulated patient when relevant.
- When discussing how the simulator behaves, you may use simulatorNotes. Distinguish simulator simplifications from real-world practice.
- Do not invent observations that are not in the provided data.`;

export async function instructorReply(body: unknown): Promise<InstructorReply> {
  return structured(FAST_MODEL, InstructorReplySchema, 'instructor_reply', INSTRUCTOR_RULES, JSON.stringify(body, null, 1));
}

const SCENARIO_RULES = `You design cases for a deterministic emergency-medicine physiology SIMULATOR (educational only).
You may ONLY compose the pathology modules, parameters, history keys, drugs, procedures and tests listed in the CAPABILITY MANIFEST — anything else will be rejected by validation. The simulator (not you) determines all physiology: never state vital signs or outcomes; choose module parameters instead.
Requirements:
- title and tagline must be neutral and must NOT reveal the diagnosis (no diagnosisKeywords in them).
- handoff: realistic paramedic/triage handover (placeholders {age} {sex} {pronoun} {Pronoun} {name} allowed), without naming the diagnosis.
- diagnosisKeywords: lowercase words/phrases that would count as a correct working diagnosis.
- pathologies[].paramsJson: a JSON object that satisfies that module's params JSON schema exactly (respect min/max).
- onsetMinutesBeforeArrival controls how long the process evolved before arrival (0–1440). Choose values that leave the patient alive but ill on arrival.
- patientKnowledge: what the patient knows and would say; conceals for things they'd hide.
- authoredFindings: only for evidence the physiology cannot compute (e.g. tox screen text, CT report, visible wounds). Use null when not needed.
- 3–6 learningObjectives. Plausible, medically coherent, and educational.`;

export async function generateScenario(prompt: string): Promise<{ scenario: ScenarioDefinition; attempts: number; warnings: string[] }> {
  const manifest = capabilityManifest();
  let feedback = '';
  const warnings: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const draft = await structured(MODEL, ScenarioDraftSchema, 'scenario_draft', SCENARIO_RULES, `CAPABILITY MANIFEST:\n${manifest}\n\nINSTRUCTOR REQUEST: ${prompt}${feedback}`);
    const result = draftToScenario(draft);
    if (result.ok && result.scenario) return { scenario: result.scenario, attempts: attempt, warnings };
    warnings.push(...result.errors);
    feedback = `\n\nYOUR PREVIOUS DRAFT FAILED VALIDATION. Fix ALL of these errors and return a complete corrected draft:\n- ${result.errors.join('\n- ')}`;
  }
  throw new Error(`Generated scenario failed validation after 3 attempts: ${warnings.slice(-5).join('; ')}`);
}

const DEBRIEF_RULES = `You write the educational debrief for a completed case in an emergency-medicine PHYSIOLOGY SIMULATOR (educational only, not clinical guidance).
Ground every statement in the provided event log, the deterministic analysis and the physiology trend — do not invent events or values.
Explain WHY the simulated patient responded as they did using mechanisms (e.g. venous return, shunt, receptor pharmacology, drug kinetics) and the simulatorNotes.
Be specific, kind and rigorous: praise good decisions, identify delays and missed information with times, and suggest alternatives the simulator supports.
Always include a clear statement separating simulator behaviour from real-world clinical practice.`;

export async function writeDebrief(body: unknown): Promise<Debrief> {
  return structured(MODEL, DebriefSchema, 'debrief', DEBRIEF_RULES, JSON.stringify(body, null, 1));
}
