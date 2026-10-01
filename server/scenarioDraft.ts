import { z } from 'zod';
import { PathologyParamSchemas, PATHOLOGY_TYPES, validateScenario, type ScenarioDefinition } from '../src/sim/scenarios/schema';
import { ORDERABLE_DRUGS } from '../src/sim/pharmacology/drugs';
import type { ScenarioDraft } from './schemas';

/** Human/LLM-readable manifest of what the deterministic simulator can do. */
export function capabilityManifest(): string {
  const pathologies = PATHOLOGY_TYPES.map((t) => {
    const schema = z.toJSONSchema(PathologyParamSchemas[t]);
    return `- ${t}: params JSON schema ${JSON.stringify(schema)}`;
  }).join('\n');
  const drugs = ORDERABLE_DRUGS.map((d) => d.id).join(', ');
  return [
    'PATHOLOGY MODULES (the only disease processes the simulator can run):',
    pathologies,
    '',
    'Known patient history keys usable in requiredHistory: hypertension, type2Diabetes, type1Diabetes, asthma, copd, cad, heartFailure, ckd, esrd, afibChronic, hypothyroidism, depression, gord, opioidUseDisorder, alcoholUse, peanutAllergy, chronicPain, wpw.',
    `Drugs available to learners (treatments must be possible with these): ${drugs}.`,
    'Fluids/blood: ns, lr, plasmalyte, d5w, albumin5, prbc, ffp, platelets, wholeblood.',
    'Procedures: oxygen devices, airway manoeuvres/adjuncts, BVM, intubation, cricothyrotomy, ventilator, IV/IO, CPR, defibrillation/cardioversion, pacing, needle decompression, chest drain, tourniquet, direct pressure, pelvic binder, surgery/IR haemostasis, cath lab, dialysis, warming, arterial line.',
    'Tests: glucose, vbg, abg, ketones, ecg12, cbc, bmp, lft, coag, troponin, lactate, tox, urinalysis, cultures, cxr, pocus, ctHead, ctAbdomen.',
    'Exam zones for authored findings: general, chest, abdomen, arms, legs, leftArm, rightArm, back, skin.',
  ].join('\n');
}

/** Convert a model draft into a candidate ScenarioDefinition and validate it with the simulator's schema. */
export function draftToScenario(d: ScenarioDraft): { ok: boolean; scenario?: ScenarioDefinition; errors: string[] } {
  const errors: string[] = [];
  const pathologies = d.pathologies.map((p, i) => {
    let params: unknown = {};
    try {
      params = JSON.parse(p.paramsJson);
    } catch {
      errors.push(`pathologies.${i}.paramsJson is not valid JSON`);
    }
    if (!(PATHOLOGY_TYPES as string[]).includes(p.type)) errors.push(`pathologies.${i}.type "${p.type}" is not a supported pathology module`);
    return { type: p.type, params, onsetMinutesBeforeArrival: p.onsetMinutesBeforeArrival, startsAfterMinutes: p.startsAfterMinutes };
  });
  const candidate = {
    id: `ai-${d.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40)}`,
    version: 1,
    title: d.title,
    tagline: d.tagline,
    category: d.category,
    difficulty: Math.min(5, Math.max(1, Math.round(d.difficulty))),
    hiddenDiagnosis: d.hiddenDiagnosis,
    diagnosisKeywords: d.diagnosisKeywords,
    differentials: d.differentials,
    patient: {
      ageRange: [d.patient.ageMin, d.patient.ageMax],
      sex: d.patient.sex,
      requiredHistory: d.patient.requiredHistory,
      forbiddenHistory: [],
      unknownIdentity: d.patient.unknownIdentity,
      social: {
        ...(d.patient.smoking ? { smoking: d.patient.smoking } : {}),
        ...(d.patient.alcohol ? { alcohol: d.patient.alcohol } : {}),
        ...(d.patient.drugs ? { drugs: d.patient.drugs } : {}),
      },
    },
    presentation: { handoff: d.presentation.handoff, chiefComplaint: d.presentation.chiefComplaint, arrivalMode: d.presentation.arrivalMode },
    pathologies,
    patientKnowledge: d.patientKnowledge,
    authoredFindings: Object.fromEntries(Object.entries(d.authoredFindings).filter(([, v]) => v !== null)),
    learningObjectives: d.learningObjectives,
    keyEvidence: d.keyEvidence,
    debriefNotes: d.debriefNotes,
    source: 'ai-generated',
  };
  if (errors.length) return { ok: false, errors };
  const v = validateScenario(candidate);
  return v.ok ? { ok: true, scenario: v.scenario, errors: [] } : { ok: false, errors: v.errors };
}
