import { describe, expect, it } from 'vitest';
import { capabilityManifest, draftToScenario } from '../server/scenarioDraft';
import { DebriefSchema, PatientReplySchema, ScenarioDraftSchema, type ScenarioDraft } from '../server/schemas';
import { PATHOLOGY_TYPES } from '../src/sim/scenarios/schema';
import { buildPatientContext, fallbackPatientReply } from '../src/client/aiContext';
import { SimulationEngine } from '../src/sim/engine/SimulationEngine';
import { engine, run } from './helpers';

const baseDraft = (): ScenarioDraft => ({
  id: 'wheezy-student',
  title: 'Breathless student',
  tagline: 'University student brought in breathless',
  category: 'respiratory',
  difficulty: 3,
  hiddenDiagnosis: 'Severe acute asthma',
  diagnosisKeywords: ['asthma'],
  differentials: ['Anaphylaxis', 'Pneumothorax'],
  patient: { ageMin: 18, ageMax: 24, sex: 'any', requiredHistory: ['asthma'], unknownIdentity: false, smoking: null, alcohol: null, drugs: null },
  presentation: { handoff: '{age}-year-old {sex}, breathless for an hour, using inhaler without relief.', chiefComplaint: 'Breathless', arrivalMode: 'ambulance' },
  pathologies: [{ type: 'asthma', paramsJson: JSON.stringify({ severity: 0.6, progression: 0.3, trigger: 'cold air' }), onsetMinutesBeforeArrival: 60, startsAfterMinutes: 0 }],
  patientKnowledge: { story: 'Wheezy since running for the bus.', symptoms: ['tight chest'], ifAsked: ['Uses salbutamol'], conceals: [], personality: 'anxious' },
  authoredFindings: { toxScreen: null, chestXray: null, ctHead: null, fast: null, urinalysis: null, exam: [] },
  learningObjectives: ['Treat bronchospasm early'],
  keyEvidence: ['Wheeze'],
  debriefNotes: [],
});

describe('AI scenario generation is constrained by the simulator schema', () => {
  it('accepts a draft that only uses supported modules and parameters', () => {
    const d = baseDraft();
    expect(ScenarioDraftSchema.safeParse(d).success).toBe(true);
    const r = draftToScenario(d);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.scenario!.source).toBe('ai-generated');
    // and the engine can actually run it
    const e = SimulationEngine.create({ seed: 'AI-1', scenario: r.scenario! });
    run(e, 30);
    expect(e.s.phys.resp.resistance).toBeGreaterThan(1.5);
  });

  it('rejects invented pathologies', () => {
    const d = baseDraft();
    d.pathologies = [{ type: 'dragonFlu', paramsJson: '{}', onsetMinutesBeforeArrival: 0, startsAfterMinutes: 0 }];
    const r = draftToScenario(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not a supported pathology/);
  });

  it('rejects out-of-range or unknown parameters and malformed JSON', () => {
    const bad = baseDraft();
    bad.pathologies[0]!.paramsJson = JSON.stringify({ severity: 7 });
    expect(draftToScenario(bad).ok).toBe(false);
    const malformed = baseDraft();
    malformed.pathologies[0]!.paramsJson = '{severity:';
    expect(draftToScenario(malformed).errors.join(' ')).toMatch(/not valid JSON/);
  });

  it('rejects titles that leak the diagnosis', () => {
    const d = baseDraft();
    d.title = 'Asthma attack';
    const r = draftToScenario(d);
    expect(r.ok).toBe(false);
  });

  it('capability manifest lists every pathology module', () => {
    const m = capabilityManifest();
    for (const t of PATHOLOGY_TYPES) expect(m).toContain(`- ${t}:`);
  });
});

describe('AI structured output schemas', () => {
  it('validate well-formed replies and reject malformed ones', () => {
    expect(PatientReplySchema.safeParse({ speech: 'It hurts', nonverbal: '', emotion: 'anxious' }).success).toBe(true);
    expect(PatientReplySchema.safeParse({ speech: 'x', emotion: 'ecstatic' }).success).toBe(false);
    expect(DebriefSchema.safeParse({ summary: 'x' }).success).toBe(false);
  });
});

describe('patient context & fallback', () => {
  it('never includes the hidden diagnosis or pathology modules in the patient context', () => {
    const e = engine('motorbike-chest', 'CTX-1');
    const snap = e.snapshot();
    const ctx = buildPatientContext(e.meta(), snap, e.s.events);
    const json = JSON.stringify(ctx).toLowerCase();
    expect(json).not.toContain('pneumothorax');
    expect(json).not.toContain('tensionpneumothorax');
    expect(json).not.toContain(e.s.scenario.hiddenDiagnosis.toLowerCase());
  });

  it('an unconscious patient cannot hold a conversation', () => {
    const e = engine('found-unresponsive', 'CTX-2');
    const ctx = buildPatientContext(e.meta(), e.snapshot(), e.s.events);
    const r = fallbackPatientReply(ctx, 'What happened to you?');
    expect(r.speech).toBe('');
    expect(r.nonverbal.length).toBeGreaterThan(0);
  });

  it('an alert patient answers allergy questions from their own history', () => {
    const e = engine('swelling-after-dinner', 'CTX-3');
    e.s.phys.neuro.consciousness = 1;
    const snap = e.snapshot();
    snap.derived.canSpeak = true;
    snap.phys.neuro.avpu = 'A';
    const ctx = buildPatientContext(e.meta(), snap, e.s.events);
    const r = fallbackPatientReply(ctx, 'Are you allergic to anything?');
    expect(r.speech.toLowerCase()).toContain('peanut');
  });
});
