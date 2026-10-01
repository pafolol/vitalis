import { Ambulance, ArrowRight, ShieldAlert } from 'lucide-react';
import { useCase } from '@/client/stores';
import { Badge, Button } from '../common';

export function Handoff() {
  const meta = useCase((s) => s.meta);
  const setScreen = useCase((s) => s.setScreen);
  const setSpeed = useCase((s) => s.setSpeed);
  const toStart = useCase((s) => s.exitToStart);
  if (!meta) return null;
  const receive = () => {
    setScreen('case');
    setSpeed(1);
  };
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-4 backdrop-blur-sm" data-testid="handoff">
      <div className="fade-in-up w-full max-w-xl overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-accent">
            <Ambulance size={20} />
          </span>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Paramedic handover</div>
            <div className="text-[17px] font-semibold">{meta.scenarioTitle}</div>
          </div>
          <Badge tone="warn" className="ml-auto">
            <ShieldAlert size={11} /> Simulation
          </Badge>
        </div>
        <div className="px-6 py-5">
          <blockquote className="border-l-2 border-accent pl-4 text-[15px] leading-relaxed text-ink" data-testid="handoff-text">
            “{meta.handoff}”
          </blockquote>
          <dl className="mt-5 grid grid-cols-3 gap-3 text-[12px]">
            <div className="rounded-lg bg-surface-2 p-2.5">
              <dt className="text-ink-3">Patient</dt>
              <dd className="mt-0.5 font-medium">{meta.patient.name}</dd>
            </div>
            <div className="rounded-lg bg-surface-2 p-2.5">
              <dt className="text-ink-3">Estimated weight</dt>
              <dd className="mt-0.5 font-medium tabular">{Math.round(meta.patient.weightKg / 5) * 5} kg</dd>
            </div>
            <div className="rounded-lg bg-surface-2 p-2.5">
              <dt className="text-ink-3">Complaint</dt>
              <dd className="mt-0.5 font-medium">{meta.chiefComplaint}</dd>
            </div>
          </dl>
          <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
            The patient's condition has been evolving before arrival and will keep evolving in real time. Monitoring is not yet attached. Examine, talk to the patient, investigate and treat — then submit a working diagnosis to receive a debrief.
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line bg-surface-2 px-6 py-3.5">
          <Button variant="ghost" onClick={toStart}>
            Back
          </Button>
          <Button variant="primary" size="lg" onClick={receive} data-testid="receive-patient">
            Receive patient <ArrowRight size={16} />
          </Button>
        </div>
      </div>
    </div>
  );
}
