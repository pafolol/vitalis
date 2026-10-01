import { useState } from 'react';
import clsx from 'clsx';
import { useCase, useUi } from '@/client/stores';
import { formatClock } from '@/sim/core/math';
import type { EventKind } from '@/sim/types';
import { Segmented } from '../common';

type Filter = 'all' | 'actions' | 'observations' | 'results';

const TONE: Record<string, string> = {
  critical: 'bg-danger',
  warning: 'bg-warn',
  good: 'bg-good',
  notice: 'bg-accent',
  info: 'bg-ink-3',
};

export function TimelinePanel() {
  const events = useCase((s) => s.events);
  const showTruth = useUi((s) => s.showTruth);
  const [filter, setFilter] = useState<Filter>('all');
  const kinds: Record<Filter, EventKind[]> = {
    all: ['system', 'action', 'physiology', 'alarm', 'result', 'patient', 'exam', 'outcome'],
    actions: ['action'],
    observations: ['physiology', 'patient', 'exam', 'alarm'],
    results: ['result'],
  };
  const visible = events
    .filter((e) => kinds[filter].includes(e.kind))
    // Students only see physiology they could observe with current monitoring (instructor sees all)
    .filter((e) => showTruth || !e.data?.['hidden'])
    .filter((e) => showTruth || e.kind !== 'physiology' || e.data?.['observable'] !== false)
    .slice()
    .reverse();
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'actions', label: 'Actions' }, { value: 'observations', label: 'Observations' }, { value: 'results', label: 'Results' }]} />
        <span className="ml-auto text-[11px] text-ink-3">{visible.length} events</span>
      </div>
      <ol className="relative px-4 py-3" data-testid="timeline">
        <span className="absolute bottom-3 left-[74px] top-3 w-px bg-line" />
        {visible.map((e) => (
          <li key={e.id} className="relative flex gap-3 py-1.5">
            <span className="w-[46px] shrink-0 pt-px text-right font-mono text-[11px] text-ink-3 tabular">{formatClock(e.t)}</span>
            <span className={clsx('relative z-10 mt-[5px] h-2 w-2 shrink-0 rounded-full ring-2 ring-surface', TONE[e.severity])} />
            <span className={clsx('text-[12.5px] leading-snug', e.severity === 'critical' ? 'font-medium text-danger' : e.kind === 'action' ? 'text-ink' : 'text-ink-2')}>
              {e.message}
              {e.data?.['hidden'] ? <span className="ml-1 rounded bg-warn-soft px-1 text-[10px] text-warn">hidden</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
