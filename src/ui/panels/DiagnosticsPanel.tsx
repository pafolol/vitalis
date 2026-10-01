import { useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, Clock, FlaskConical, ImageIcon, Activity } from 'lucide-react';
import { useCase } from '@/client/stores';
import { TESTS } from '@/sim/diagnostics/orders';
import type { DiagnosticOrder } from '@/sim/diagnostics/types';
import type { EcgParams } from '@/sim/types';
import { formatClock } from '@/sim/core/math';
import { Badge, Section, SourceTag } from '../common';
import { Ecg12 } from './Ecg12';

const CAT_LABEL: Record<string, string> = {
  'point-of-care': 'Point of care',
  laboratory: 'Laboratory',
  cardiac: 'Cardiac',
  imaging: 'Imaging',
  microbiology: 'Microbiology',
};

export function DiagnosticsPanel() {
  const snapshot = useCase((s) => s.snapshot);
  const dispatch = useCase((s) => s.dispatch);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!snapshot) return null;
  const orders = snapshot.orders.slice().reverse();
  const cats = ['point-of-care', 'cardiac', 'laboratory', 'imaging', 'microbiology'];

  return (
    <div>
      <Section title="Order" action={<span className="text-[11px] text-ink-3">Samples reflect the patient at collection time</span>}>
        <div className="flex flex-col gap-3">
          {cats.map((c) => (
            <div key={c}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{CAT_LABEL[c]}</div>
              <div className="flex flex-wrap gap-1.5">
                {TESTS.filter((t) => t.category === c).map((t) => (
                  <button key={t.id} onClick={() => dispatch({ type: 'diagnostic.order', testId: t.id })} className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-[12px] hover:border-accent/50 hover:text-accent" title={`${t.description} · ~${formatClock(t.collectDelay + t.turnaround)}`} data-testid={`order-${t.id}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title={`Orders & results (${orders.length})`}>
        {orders.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">No investigations ordered.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="orders">
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} now={snapshot.t} open={openId === o.id} onToggle={() => setOpenId(openId === o.id ? null : o.id)} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function OrderRow({ order, now, open, onToggle }: { order: DiagnosticOrder; now: number; open: boolean; onToggle: () => void }) {
  const done = order.status === 'resulted';
  const collected = now >= order.collectedAt;
  const abnormal = order.items.filter((i) => i.flag).length;
  const Icon = order.testId === 'ecg12' ? Activity : ['cxr', 'pocus', 'ctHead', 'ctAbdomen'].includes(order.testId) ? ImageIcon : FlaskConical;
  const ecg = order.payload?.['ecg'] as EcgParams | undefined;
  return (
    <li className={clsx('rounded-lg border bg-surface-2', done && abnormal ? 'border-warn/40' : 'border-line')}>
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={onToggle} disabled={!done} data-testid={`order-row-${order.testId}`}>
        <Icon size={14} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{order.label}</span>
          <span className="block text-[11px] text-ink-3">
            ordered {formatClock(order.orderedAt)}
            {done ? ` · resulted ${formatClock(order.resultAt)}` : collected ? ' · sample taken' : ' · awaiting sample'}
          </span>
        </span>
        {done ? (
          abnormal ? <Badge tone="warn">{abnormal} abnormal</Badge> : <CheckCircle2 size={15} className="text-good" />
        ) : (
          <span className="flex items-center gap-1 font-mono text-[11px] text-ink-3">
            <Clock size={12} />
            {formatClock(Math.max(0, order.resultAt - now))}
          </span>
        )}
      </button>
      {done && open && (
        <div className="border-t border-line px-3 py-2.5 fade-in-up" data-testid="result-detail">
          {ecg && <Ecg12 ecg={ecg} rhythm={String(order.payload?.['rhythm'])} rate={Number(order.payload?.['rate'] ?? 60)} />}
          {order.report && order.testId !== 'pocus' && <p className="mt-2 text-[12.5px] leading-relaxed text-ink">{order.report}</p>}
          <table className="mt-2 w-full text-[12px]">
            <tbody>
              {order.items.map((it) => (
                <tr key={it.key} className="border-b border-line last:border-0">
                  <td className="py-1 pr-2 text-ink-2">{it.label}</td>
                  <td className={clsx('py-1 pr-2 font-mono tabular', it.flag === 'HH' || it.flag === 'LL' ? 'font-bold text-danger' : it.flag ? 'text-warn' : 'text-ink')}>
                    {it.value}
                    {it.unit ? <span className="ml-1 font-sans text-[10.5px] text-ink-3">{it.unit}</span> : null}
                    {it.flag && it.flag !== 'abnormal' ? <span className="ml-1 text-[10px]">{it.flag}</span> : null}
                  </td>
                  <td className="py-1 pr-2 text-[10.5px] text-ink-3">{it.ref}</td>
                  <td className="py-1 text-right">
                    <SourceTag source={it.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}
