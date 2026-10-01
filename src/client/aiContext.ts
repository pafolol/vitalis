import type { CaseMeta, SimSnapshot } from '@/sim/engine/snapshot';
import type { SimulationEvent } from '@/sim/types';
import { formatClock } from '@/sim/core/math';

/**
 * Builds the structured context sent to the AI endpoints.
 *
 * The patient context contains only what the *patient* could know or feel:
 * their story, history they are aware of, and subjective state derived from
 * the simulation (level of consciousness, ability to speak, pain, breathlessness,
 * confusion). It deliberately omits the hidden diagnosis, pathology modules and
 * raw physiology numbers. The AI's output is text only and cannot change state.
 */
export interface PatientAIContext {
  demographics: { name: string; age: number; sex: string; occupation: string; livingSituation: string; knownIdentity: boolean };
  knowledge: {
    story: string;
    symptoms: string[];
    ifAsked: string[];
    conceals: string[];
    personality: string;
    history: string[];
    medications: string[];
    allergies: string[];
    social: string;
  };
  state: {
    responsiveness: 'alert' | 'drowsy' | 'responds to pain only' | 'unresponsive';
    canSpeak: boolean;
    speech: 'full sentences' | 'short phrases' | 'single words' | 'cannot speak';
    confusion: 'none' | 'mild' | 'marked';
    agitation: 'calm' | 'restless' | 'very agitated';
    pain: { level0to10: number; where: string };
    breathlessness0to10: number;
    nausea: boolean;
    seizing: boolean;
    intubated: boolean;
    oxygenMask: boolean;
    feelings: string[];
  };
  recentCareEvents: string[];
  minutesInDepartment: number;
}

export function buildPatientContext(meta: CaseMeta, s: SimSnapshot, events: SimulationEvent[]): PatientAIContext {
  const p = meta.patient;
  const k = meta.scenario.patientKnowledge;
  const n = s.phys.neuro;
  const resp = s.phys.resp;
  const feelings: string[] = [];
  if (s.appearance.diaphoresis > 0.5) feelings.push('sweaty and clammy');
  if (s.phys.thermo.core < 35) feelings.push('very cold, shivering');
  if (s.phys.thermo.core > 38.5) feelings.push('feverish, hot and cold');
  if (n.tremor > 0.4) feelings.push('shaky');
  if (s.phys.cv.hr > 130 && n.consciousness > 0.7) feelings.push('heart pounding');
  if (s.phys.cv.map < 60 && n.consciousness > 0.6) feelings.push('light-headed, feels faint');
  if (s.appearance.urticaria > 0.3) feelings.push('itchy all over');
  if (resp.stridor > 0.3) feelings.push('throat feels like it is closing');
  if (n.withdrawal > 0.3) feelings.push('aching, restless, craving (withdrawal)');
  if (n.anxiety > 0.6) feelings.push('frightened, sense of impending doom');
  return {
    demographics: { name: p.name, age: p.ageYears, sex: p.sex, occupation: p.occupation, livingSituation: p.livingSituation, knownIdentity: !meta.scenario.patient.unknownIdentity },
    knowledge: {
      story: k.story,
      symptoms: k.symptoms,
      ifAsked: k.ifAsked,
      conceals: k.conceals,
      personality: k.personality,
      history: p.history.filter((h) => h.knownToPatient).map((h) => h.label),
      medications: p.medications.map((m) => `${m.name} ${m.dose} (${m.indication})`),
      allergies: p.allergies.map((a) => `${a.agent} (${a.reaction})`),
      social: `smoking: ${p.social.smoking}; alcohol: ${p.social.alcohol}; recreational drugs: ${p.social.drugs}`,
    },
    state: {
      responsiveness: n.avpu === 'A' ? 'alert' : n.avpu === 'V' ? 'drowsy' : n.avpu === 'P' ? 'responds to pain only' : 'unresponsive',
      canSpeak: s.derived.canSpeak,
      speech: s.derived.speechQuality === 'sentences' ? 'full sentences' : s.derived.speechQuality === 'phrases' ? 'short phrases' : s.derived.speechQuality === 'words' ? 'single words' : 'cannot speak',
      confusion: n.confusion < 0.15 ? 'none' : n.confusion < 0.5 ? 'mild' : 'marked',
      agitation: n.agitation < 0.25 ? 'calm' : n.agitation < 0.6 ? 'restless' : 'very agitated',
      pain: { level0to10: Math.round(n.pain), where: s.derived.painSite || 'none' },
      breathlessness0to10: Math.round(n.dyspnea),
      nausea: n.nausea > 0.4,
      seizing: n.seizure,
      intubated: s.therapy.airway.ett,
      oxygenMask: s.therapy.oxygen.device !== 'none',
      feelings,
    },
    recentCareEvents: events
      .filter((e) => e.kind === 'action' && !e.data?.['hidden'])
      .slice(-8)
      .map((e) => `${formatClock(e.t)} ${e.message}`),
    minutesInDepartment: Math.round(s.t / 60),
  };
}

/**
 * Deterministic fallback patient used when the AI service is unavailable.
 * Keyword intents map to the scenario's patient knowledge, shaped by the
 * simulated ability to speak.
 */
export function fallbackPatientReply(ctx: PatientAIContext, question: string): { speech: string; nonverbal: string } {
  const st = ctx.state;
  if (st.intubated) return { speech: '', nonverbal: 'Intubated — cannot speak. Eyes flicker at your voice.' };
  if (st.seizing) return { speech: '', nonverbal: 'Rhythmic jerking of all limbs; no response.' };
  if (st.responsiveness === 'unresponsive') return { speech: '', nonverbal: 'No response.' };
  if (st.responsiveness === 'responds to pain only') return { speech: '', nonverbal: 'Groans incomprehensibly; eyes stay closed.' };
  if (!st.canSpeak) return { speech: '', nonverbal: st.breathlessness0to10 > 7 ? 'Too breathless to speak — shakes head, gasping.' : 'Mumbles; words cannot be made out.' };
  const q = question.toLowerCase();
  const k = ctx.knowledge;
  const find = (words: string[]) => k.ifAsked.find((f) => words.some((w) => f.toLowerCase().includes(w)));
  let answer: string;
  if (/name|who are you/.test(q)) answer = ctx.demographics.knownIdentity ? `${ctx.demographics.name}.` : st.confusion !== 'none' ? "I... I don't... what?" : `It's ${ctx.demographics.name.split(' ')[0] === 'Unknown' ? 'none of your business' : ctx.demographics.name}.`;
  else if (/pain|hurt|sore/.test(q)) answer = st.pain.level0to10 > 0 ? `It hurts — ${st.pain.where}. About ${st.pain.level0to10} out of 10.` : "No real pain.";
  else if (/breath|breathe/.test(q)) answer = st.breathlessness0to10 > 5 ? "Can't... get... air in." : st.breathlessness0to10 > 2 ? "A bit short of breath." : "Breathing's okay.";
  else if (/allerg/.test(q)) answer = k.allergies.length ? `I'm allergic to ${k.allergies.join(', ')}.` : 'No allergies that I know of.';
  else if (/medic|tablet|pill|take any/.test(q)) answer = k.medications.length ? `I take ${k.medications.map((m) => m.split(' (')[0]).join(', ')}.` : "I don't take any regular medicines.";
  else if (/history|problem|condition|illness|diagnos/.test(q)) answer = k.history.length ? `I have ${k.history.join(', ').toLowerCase()}.` : 'Nothing major.';
  else if (/drug|heroin|use|inject/.test(q)) answer = k.conceals.length && st.confusion === 'none' ? "Why does that matter? ... Okay, maybe." : (find(['use', 'drug', 'heroin', 'drink']) ?? 'No.');
  else if (/happen|what brought|why are you|how did/.test(q)) {
    // The scenario story is author-facing (third person); the fallback speaks only first-person symptoms
    const sx = k.symptoms.slice(0, 3);
    answer = k.conceals.length
      ? `I don't really know... I just started feeling ${sx[0] ?? 'unwell'} and then I was here.`
      : `I started feeling ${sx.slice(0, 2).join(' and ') || 'really unwell'}${sx[2] ? `, and now I'm ${sx[2]}` : ''}.`;
  }
  else if (/feel|how are you/.test(q)) answer = [...k.symptoms.slice(0, 2), ...st.feelings.slice(0, 2)].join(', ') || 'Not great.';
  else if (/eat|meal|food/.test(q)) answer = find(['ate', 'eat', 'meal', 'lunch']) ?? "I haven't eaten much.";
  else answer = find(q.split(/\W+/).filter((w) => w.length > 3)) ?? "I'm not sure... can you help me?";
  if (st.speech === 'short phrases') answer = answer.split(/[,.]/)[0]! + '...';
  if (st.speech === 'single words') answer = answer.split(/\s+/).slice(0, 2).join(' ') + '...';
  if (st.confusion === 'marked') answer = `Where am I? ${answer.split(' ').slice(0, 4).join(' ')}...`;
  const nonverbal = st.agitation === 'very agitated' ? 'Restless, pulling at the mask.' : st.pain.level0to10 > 6 ? 'Grimacing.' : st.breathlessness0to10 > 5 ? 'Breathless between words.' : '';
  return { speech: answer, nonverbal };
}
