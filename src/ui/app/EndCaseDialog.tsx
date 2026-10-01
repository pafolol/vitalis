import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Flag, X } from 'lucide-react';
import { useCase } from '@/client/stores';
import { SCENARIOS } from '@/sim/scenarios/library';
import { Button, Field, inputCls } from '../common';

const REASONS = ['Patient stabilised — handed over', 'Transferred to theatre / cath lab / ICU', 'Resuscitation stopped', 'Patient died', 'Time limit reached'];

export function EndCaseDialog({ onClose }: { onClose: () => void }) {
  const snapshot = useCase((s) => s.snapshot);
  const endCase = useCase((s) => s.endCase);
  const setScreen = useCase((s) => s.setScreen);
  const save = useCase((s) => s.save);
  const setSpeed = useCase((s) => s.setSpeed);
  const died = snapshot && !snapshot.status.alive;
  const [diagnosis, setDiagnosis] = useState('');
  const [reason, setReason] = useState(died ? 'Patient died' : REASONS[0]!);
  const suggestions = useMemo(() => Array.from(new Set(SCENARIOS.flatMap((s) => [...s.differentials]))).sort(), []);

  useEffect(() => {
    setSpeed(0);
  }, [setSpeed]);

  const submit = async () => {
    endCase(reason, diagnosis.trim() || 'No diagnosis submitted');
    await new Promise((r) => setTimeout(r, 250));
    await save();
    setScreen('debrief');
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-4 backdrop-blur-sm" data-testid="end-dialog">
      <div className="fade-in-up w-full max-w-lg rounded-2xl border border-line-strong bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <Flag size={16} className="text-accent" />
          <h2 className="text-[15px] font-semibold">{died ? 'The patient has died' : 'End case & submit diagnosis'}</h2>
          <button className="ml-auto text-ink-3 hover:text-ink" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {died && <p className="rounded-lg bg-danger-soft p-3 text-[13px] text-ink">In the simulation the patient sustained irreversible hypoxic–ischaemic injury. You can still submit your working diagnosis and review the debrief.</p>}
          <Field label="Working diagnosis" hint="The hidden diagnosis is revealed in the debrief.">
            <input list="dx-suggestions" value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} className={inputCls} placeholder="e.g. tension pneumothorax" autoFocus data-testid="diagnosis-input" />
            <datalist id="dx-suggestions">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="Outcome / disposition">
            <div className="flex flex-wrap gap-1.5">
              {REASONS.map((r) => (
                <button key={r} onClick={() => setReason(r)} className={clsx('rounded-md border px-2.5 py-1 text-[12px]', reason === r ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line text-ink-2 hover:text-ink')}>
                  {r}
                </button>
              ))}
            </div>
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          {!died && (
            <Button variant="ghost" onClick={onClose}>
              Continue case
            </Button>
          )}
          <Button variant="primary" onClick={submit} data-testid="submit-end">
            End case & view debrief
          </Button>
        </div>
      </div>
    </div>
  );
}
