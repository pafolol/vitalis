import { useEffect, useState } from 'react';
import { Lightbulb, Loader2, Send, Sparkles } from 'lucide-react';
import { useCase, useUi } from '@/client/stores';
import { simClient } from '@/client/simClient';
import { api, health } from '@/client/api';
import { buildPatientContext } from '@/client/aiContext';
import { formatClock } from '@/sim/core/math';
import { RHYTHM_LABEL } from '@/sim/types';
import { Badge, Button, Section, inputCls } from '../common';

export function InstructorPanel() {
  const meta = useCase((s) => s.meta);
  const snapshot = useCase((s) => s.snapshot);
  const events = useCase((s) => s.events);
  const msgs = useCase((s) => s.instructorChat);
  const add = useCase((s) => s.addInstructorChat);
  const { showTruth, set } = useUi();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(false);
  const [hintIdx, setHintIdx] = useState(0);
  useEffect(() => {
    health().then((h) => setAi(h.ai));
  }, []);
  if (!meta || !snapshot) return null;
  const sc = meta.scenario;

  const askTutor = async (question: string, mode: 'hint' | 'question') => {
    const snap = simClient().latest!;
    add({ role: 'user', text: question, t: snap.t });
    setBusy(true);
    const observed = events.filter((e) => !e.data?.['hidden'] && (e.kind !== 'physiology' || e.data?.['observable'] !== false)).slice(-40).map((e) => `${formatClock(e.t)} ${e.message}`);
    const r = ai
      ? await api.instructor({
          mode,
          question,
          observedTimeline: observed,
          patient: buildPatientContext(meta, snap, events),
          monitor: monitorSummary(snap),
          learningObjectives: sc.learningObjectives,
          hiddenDiagnosis: sc.hiddenDiagnosis,
          keyEvidence: sc.keyEvidence,
          simulatorNotes: sc.debriefNotes,
        })
      : { ok: false as const };
    setBusy(false);
    if (r.ok && r.data) add({ role: 'instructor', text: r.data.reply.answer, t: snap.t, source: 'ai' });
    else {
      const hints = [
        'Start with a structured ABCDE assessment and attach full monitoring — what does the monitor show you?',
        `Think about which observations best discriminate between your differentials. Key evidence in this case includes: ${sc.keyEvidence[0] ?? 'the physical examination'}.`,
        `Learning focus: ${sc.learningObjectives[hintIdx % sc.learningObjectives.length]}`,
        'Reassess after every intervention: did the physiology move in the direction you expected? If not, why not?',
      ];
      add({ role: 'instructor', text: mode === 'hint' ? hints[hintIdx % hints.length]! : 'The AI tutor is offline. Use the trends panel and timeline to reason through cause and effect, or ask again when the AI service is configured.', t: snap.t, source: 'fallback' });
      setHintIdx((i) => i + 1);
    }
  };

  const p = snapshot.phys;
  return (
    <div>
      <Section title="Tutor" action={ai ? <Badge tone="accent"><Sparkles size={10} /> AI</Badge> : <Badge>offline hints</Badge>}>
        <div className="mb-2 flex flex-col gap-2" data-testid="tutor-log">
          {msgs.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'self-end rounded-xl bg-accent px-3 py-1.5 text-[12.5px] text-accent-ink' : 'rounded-xl bg-surface-3 px-3 py-2 text-[12.5px] leading-relaxed'}>
              {m.text}
            </div>
          ))}
          {busy && (
            <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <Loader2 size={12} className="animate-spin" /> thinking…
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="subtle" icon={<Lightbulb size={13} />} disabled={busy} onClick={() => void askTutor('Give me a hint without revealing the diagnosis.', 'hint')} data-testid="tutor-hint">
            Hint
          </Button>
          <form
            className="flex flex-1 gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) void askTutor(q, 'question');
              setQ('');
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about physiology…" className={inputCls} />
            <Button size="sm" type="submit" variant="primary" disabled={busy}>
              <Send size={13} />
            </Button>
          </form>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">The tutor sees only what you could observe, and is instructed not to reveal the diagnosis. Educational content only — not clinical guidance.</p>
      </Section>

      <Section title="Instructor view">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={showTruth} onChange={(e) => set({ showTruth: e.target.checked })} data-testid="show-truth" />
          Show hidden physiology & diagnosis
        </label>
        {showTruth && (
          <div className="mt-3 flex flex-col gap-3 fade-in-up" data-testid="truth-panel">
            <div className="rounded-lg border border-warn/40 bg-warn-soft p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-warn">Hidden diagnosis</div>
              <div className="text-[13.5px] font-semibold">{sc.hiddenDiagnosis}</div>
              <div className="mt-1 text-[11.5px] text-ink-2">Modules: {sc.pathologies.map((x) => x.type).join(', ')}</div>
            </div>
            <table className="w-full text-[12px]">
              <tbody>
                {[
                  ['Rhythm', RHYTHM_LABEL[p.cv.rhythm] + (snapshot.derived.pea ? ' (pulseless)' : '')],
                  ['CO / SV', `${p.cv.co.toFixed(1)} L/min · ${Math.round(p.cv.sv)} mL`],
                  ['SVR / MSFP', `${p.cv.svr.toFixed(1)} WU · ${p.cv.msfp.toFixed(1)} mmHg`],
                  ['RAP / LAP / PAP', `${p.cv.rap.toFixed(0)} / ${p.cv.lap.toFixed(0)} / ${p.cv.pap.toFixed(0)} mmHg`],
                  ['Contractility LV / RV', `${p.cv.lvContractility.toFixed(2)} / ${p.cv.rvContractility.toFixed(2)}`],
                  ['Myocardial ischaemia', `${Math.round(p.cv.globalIschemia * 100)}% · viability ${Math.round(p.cv.myocardialViability * 100)}%`],
                  ['Blood volume', `${Math.round(p.blood.volume)} mL (lost ${Math.round(p.blood.cumulativeLoss)})`],
                  ['Pleural air L / R', `${Math.round(p.resp.pleuralAirLeft)} / ${Math.round(p.resp.pleuralAirRight)} mL`],
                  ['Shunt / V/Q', `${Math.round(p.resp.shunt * 100)}% / ${Math.round(p.resp.vqMismatch * 100)}%`],
                  ['Airway R / fatigue', `${p.resp.resistance.toFixed(1)}× / ${Math.round(p.resp.fatigue * 100)}%`],
                  ['PaO₂ / PaCO₂', `${Math.round(p.resp.pao2)} / ${Math.round(p.resp.paco2)} mmHg`],
                  ['pH / HCO₃ / lactate', `${p.chem.ph.toFixed(2)} / ${p.chem.hco3.toFixed(0)} / ${p.chem.lactate.toFixed(1)}`],
                  ['Glucose / K', `${p.chem.glucose.toFixed(1)} / ${p.chem.k.toFixed(1)} mmol/L`],
                  ['Sympathetic tone', `${Math.round(p.neuro.sympathetic * 100)}%`],
                  ['Brain injury', `${Math.round(p.neuro.brainInjury * 100)}%`],
                ].map(([k, v]) => (
                  <tr key={k} className="border-b border-line last:border-0">
                    <td className="py-1 pr-2 text-ink-3">{k}</td>
                    <td className="py-1 text-right font-mono tabular">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Learning objectives</div>
              <ul className="list-disc pl-4 text-[12px] text-ink-2">
                {sc.learningObjectives.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

export function monitorSummary(s: NonNullable<ReturnType<typeof simClient>['latest']>): Record<string, string> {
  const m = s.therapy.monitoring;
  const out: Record<string, string> = {};
  if (m.ecg || s.therapy.defib.padsOn) out['ECG'] = `${RHYTHM_LABEL[s.phys.cv.rhythm]} ${Math.round(s.phys.cv.hr)}/min`;
  if (m.spo2) out['SpO2'] = s.derived.spo2Reliable ? `${Math.round(s.phys.resp.sao2 * 100)}%` : 'no signal';
  if (s.therapy.nibpLast?.ok) out['NIBP'] = `${s.therapy.nibpLast.sbp}/${s.therapy.nibpLast.dbp} (${formatClock(s.t - s.therapy.nibpLast.t)} ago)`;
  if (m.etco2) out['EtCO2'] = `${Math.round(s.phys.resp.etco2)} mmHg, RR ${Math.round(s.phys.resp.rr)}`;
  if (m.temp) out['Temp'] = `${s.phys.thermo.core.toFixed(1)} °C`;
  return out;
}
