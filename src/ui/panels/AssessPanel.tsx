import { useState } from 'react';
import clsx from 'clsx';
import { Activity, Brain, Eye, Hand, HeartPulse, ScanFace, Shirt, Stethoscope, Wind } from 'lucide-react';
import { useCase, useUi } from '@/client/stores';
import { examine, type ExamKind, type Finding } from '@/sim/exam/findings';
import { formatClock } from '@/sim/core/math';
import { ActionTile, Button, Section, SourceTag } from '../common';

const EXAMS: { kind: ExamKind; label: string; icon: typeof Eye; sub: string }[] = [
  { kind: 'general', label: 'General inspection', icon: Eye, sub: 'Colour, distress, responsiveness' },
  { kind: 'airway', label: 'Airway', icon: Wind, sub: 'Patency, added sounds, reflexes' },
  { kind: 'breathing', label: 'Breathing', icon: Activity, sub: 'Rate, expansion, trachea' },
  { kind: 'circulation', label: 'Circulation', icon: HeartPulse, sub: 'Pulses, CRT, peripheries, JVP' },
  { kind: 'neuro', label: 'Disability (GCS)', icon: Brain, sub: 'Eyes, voice, motor' },
  { kind: 'pupils', label: 'Pupils', icon: ScanFace, sub: 'Size, symmetry, light reflex' },
  { kind: 'abdomen', label: 'Abdomen', icon: Hand, sub: 'Palpation, distension' },
  { kind: 'skin', label: 'Exposure / skin', icon: Shirt, sub: 'Temperature, rash, sweating' },
];

interface Note {
  t: number;
  kind: ExamKind;
  findings: Finding[];
}

export function AssessPanel() {
  const meta = useCase((s) => s.meta);
  const snapshot = useCase((s) => s.snapshot);
  const dispatch = useCase((s) => s.dispatch);
  const setTool = useUi((s) => s.setTool);
  const [notes, setNotes] = useState<Note[]>([]);
  if (!snapshot || !meta) return null;
  const mon = snapshot.therapy.monitoring;
  const allAttached = mon.ecg && mon.spo2 && mon.nibp;

  const run = (kind: ExamKind) => {
    const findings = examine(snapshot, meta.scenario, kind);
    setNotes((n) => [{ t: snapshot.t, kind, findings }, ...n].slice(0, 20));
    dispatch({ type: 'exam.perform', exam: kind, detail: findings.map((f) => f.text).join(' ').slice(0, 180) });
  };

  return (
    <div>
      <Section title="Monitoring">
        <div className="grid grid-cols-2 gap-2">
          <ActionTile
            title={allAttached ? 'Monitoring attached' : 'Attach monitoring'}
            subtitle="3-lead ECG, SpO₂ probe, NIBP cuff"
            active={allAttached}
            onClick={() => dispatch({ type: 'monitor.attach', devices: ['ecg', 'spo2', 'nibp'] })}
            icon={<HeartPulse size={16} />}
          />
          <ActionTile title={mon.temp ? 'Temperature probe on' : 'Core temperature'} subtitle="Continuous temperature probe" active={mon.temp} onClick={() => dispatch({ type: 'monitor.attach', devices: ['temp'] })} icon={<Activity size={16} />} />
          <ActionTile title={mon.etco2 ? 'Capnography on' : 'Capnography'} subtitle="Side-stream / in-line EtCO₂" active={mon.etco2} onClick={() => dispatch({ type: 'monitor.attach', devices: ['etco2'] })} icon={<Wind size={16} />} />
          <ActionTile title="Capillary glucose" subtitle="Point-of-care, ~1 min" onClick={() => dispatch({ type: 'diagnostic.order', testId: 'glucose' })} icon={<Activity size={16} />} />
        </div>
      </Section>
      <Section title="Primary survey" action={<span className="text-[11px] text-ink-3">Findings reflect the patient right now</span>}>
        <div className="grid grid-cols-2 gap-2" data-testid="exam-buttons">
          {EXAMS.map((e) => (
            <ActionTile key={e.kind} title={e.label} subtitle={e.sub} icon={<e.icon size={16} />} onClick={() => run(e.kind)} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="subtle" icon={<Stethoscope size={13} />} onClick={() => setTool('stethoscope')}>
            Auscultate on the patient
          </Button>
          <Button size="sm" variant="subtle" icon={<Hand size={13} />} onClick={() => setTool('palpate')}>
            Palpate on the patient
          </Button>
        </div>
      </Section>
      <Section title="Examination notes">
        {notes.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">Run an examination above, or use the auscultate/palpate tools directly on the 3D patient.</p>
        ) : (
          <ol className="flex flex-col gap-3" data-testid="exam-notes">
            {notes.map((n, i) => (
              <li key={`${n.t}-${i}`} className="rounded-lg border border-line bg-surface-2 p-3 fade-in-up">
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-3">
                  <span className="font-mono">{formatClock(n.t)}</span>
                  <span className="font-semibold uppercase tracking-wide">{EXAMS.find((e) => e.kind === n.kind)?.label}</span>
                </div>
                <ul className="flex flex-col gap-1">
                  {n.findings.map((f, j) => (
                    <li key={j} className="text-[12.5px] leading-snug">
                      <span className={clsx('mr-1.5 font-medium', f.abnormal ? 'text-warn' : 'text-ink-2')}>{f.label}:</span>
                      <span>{f.text}</span> <SourceTag source={f.source} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
