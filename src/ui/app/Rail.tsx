import clsx from 'clsx';
import { Activity, Bone, ClipboardList, FlaskConical, GraduationCap, HeartPulse, MessageSquare, Pill, Scissors, Stethoscope, Wind, LineChart } from 'lucide-react';
import { useUi, type PanelId } from '@/client/stores';

export const PANEL_META: { id: Exclude<PanelId, null>; label: string; short: string; icon: typeof Activity }[] = [
  { id: 'assess', label: 'Examination', short: 'Exam', icon: Stethoscope },
  { id: 'airway', label: 'Airway & breathing', short: 'Airway', icon: Wind },
  { id: 'circulation', label: 'Circulation & resuscitation', short: 'Circ', icon: HeartPulse },
  { id: 'meds', label: 'Medications', short: 'Meds', icon: Pill },
  { id: 'procedures', label: 'Procedures', short: 'Proc', icon: Scissors },
  { id: 'diagnostics', label: 'Diagnostics', short: 'Tests', icon: FlaskConical },
  { id: 'talk', label: 'Talk to the patient', short: 'Talk', icon: MessageSquare },
  { id: 'timeline', label: 'Event timeline', short: 'Timeline', icon: ClipboardList },
  { id: 'anatomy', label: 'Anatomy layers', short: 'Anatomy', icon: Bone },
  { id: 'pharm', label: 'Drug levels & trends', short: 'Trends', icon: LineChart },
  { id: 'instructor', label: 'Instructor', short: 'Tutor', icon: GraduationCap },
];

export function Rail() {
  const panel = useUi((s) => s.panel);
  const toggle = useUi((s) => s.togglePanel);
  return (
    <nav className="flex w-[64px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-line bg-surface py-2 scroll-thin" aria-label="Clinical tools" data-testid="rail">
      {PANEL_META.map((p, i) => {
        const active = panel === p.id;
        return (
          <button
            key={p.id}
            onClick={() => toggle(p.id)}
            title={`${p.label}${i < 9 ? ` (${i + 1})` : ''}`}
            className={clsx('group flex w-[56px] flex-col items-center gap-0.5 rounded-lg py-1.5 transition-colors', active ? 'bg-accent-soft text-accent' : 'text-ink-3 hover:bg-surface-3 hover:text-ink')}
            data-testid={`rail-${p.id}`}
            aria-pressed={active}
          >
            <p.icon size={18} />
            <span className="text-[10px] font-medium">{p.short}</span>
          </button>
        );
      })}
    </nav>
  );
}
