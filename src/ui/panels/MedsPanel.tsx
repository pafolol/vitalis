import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Search, Syringe, AlertTriangle } from 'lucide-react';
import { useCase } from '@/client/stores';
import { ORDERABLE_DRUGS, getDrug } from '@/sim/pharmacology/drugs';
import { doseToAmount, formatAmount } from '@/sim/pharmacology/pkpd';
import type { DrugDef, Route } from '@/sim/pharmacology/types';
import { formatClock } from '@/sim/core/math';
import { Badge, Button, Field, Section, inputCls } from '../common';

const CATEGORY_LABEL: Record<DrugDef['category'], string> = {
  resuscitation: 'Resuscitation',
  vasoactive: 'Vasoactive',
  'analgesia-sedation': 'Analgesia / sedation',
  airway: 'Airway / respiratory',
  antiarrhythmic: 'Antiarrhythmics',
  metabolic: 'Metabolic / electrolytes',
  antimicrobial: 'Antimicrobials',
  haematology: 'Haematology',
  other: 'Other',
};

const ROUTE_LABEL: Record<Route, string> = { IV: 'IV', IO: 'IO', IM: 'IM', SC: 'SC', IN: 'Intranasal', PO: 'Oral', SL: 'Sublingual', NEB: 'Nebulised' };

export function MedsPanel() {
  const snapshot = useCase((s) => s.snapshot);
  const meta = useCase((s) => s.meta);
  const events = useCase((s) => s.events);
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filtered = useMemo(() => ORDERABLE_DRUGS.filter((d) => `${d.name} ${d.drugClass}`.toLowerCase().includes(q.toLowerCase())), [q]);
  const grouped = useMemo(() => {
    const g = new Map<string, DrugDef[]>();
    for (const d of filtered) g.set(d.category, [...(g.get(d.category) ?? []), d]);
    return [...g.entries()];
  }, [filtered]);
  if (!snapshot || !meta) return null;
  const history = events.filter((e) => e.code === 'drug.given' || e.code === 'drug.infusion' || e.code === 'drug.infusionRate').slice().reverse();

  return (
    <div>
      {selectedId ? (
        <DrugForm key={selectedId} drug={getDrug(selectedId)} onBack={() => setSelectedId(null)} weight={meta.patient.weightKg} />
      ) : (
        <Section title="Formulary">
          <div className="relative mb-3">
            <Search size={14} className="absolute left-2.5 top-2 text-ink-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search drugs…" className={clsx(inputCls, 'pl-8')} data-testid="drug-search" />
          </div>
          <div className="flex flex-col gap-3">
            {grouped.map(([cat, drugs]) => (
              <div key={cat}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{CATEGORY_LABEL[cat as DrugDef['category']]}</div>
                <div className="flex flex-col">
                  {drugs.map((d) => (
                    <button key={d.id} onClick={() => setSelectedId(d.id)} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-3" data-testid={`drug-${d.id}`}>
                      <Syringe size={13} className="shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{d.name}</span>
                        <span className="block truncate text-[11px] text-ink-3">{d.drugClass}</span>
                      </span>
                      <span className="text-[10.5px] text-ink-3">{d.routes.map((r) => r.route).join(' · ')}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
      <Section title="On board now">
        {snapshot.drugs.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">No drugs with measurable levels.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {snapshot.drugs.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <span className="font-mono tabular text-ink-2" title="Plasma concentration">
                  Cp {fmt(d.cp)} {d.unit}
                </span>
                <span className="w-24 text-right font-mono tabular text-ink-3" title="Total administered">
                  {d.totalGiven}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Administration record">
        {history.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">Nothing given yet.</p>
        ) : (
          <ol className="flex flex-col gap-1" data-testid="med-history">
            {history.map((e) => (
              <li key={e.id} className="flex gap-2 text-[12px]">
                <span className="font-mono text-ink-3">{formatClock(e.t)}</span>
                <span>{e.message}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}

function fmt(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function DrugForm({ drug, onBack, weight }: { drug: DrugDef; onBack: () => void; weight: number }) {
  const dispatch = useCase((s) => s.dispatch);
  const snapshot = useCase((s) => s.snapshot);
  const def = drug.defaultDose;
  const [route, setRoute] = useState<Route>(def?.route ?? drug.routes[0]!.route);
  const baseUnits = drug.doseUnits.map((u) => u.unit);
  const units = [...baseUnits, ...baseUnits.filter((u) => u === 'mg' || u === 'mcg' || u === 'units').map((u) => `${u}/kg`)];
  const [unit, setUnit] = useState(def?.unit ?? baseUnits[0]!);
  const [dose, setDose] = useState<number>(def?.amount ?? 1);
  const [confirmLarge, setConfirmLarge] = useState(false);
  const inf = drug.infusion;
  const [rate, setRate] = useState(inf?.defaultRate ?? 0);
  const [rateUnit, setRateUnit] = useState(inf?.defaultUnit ?? '');
  const access = snapshot?.therapy.access;
  const needsIv = route === 'IV' && !(access?.leftArm || access?.rightArm);
  const needsIo = route === 'IO' && !access?.io;

  let amount = 0;
  let amountError: string | null = null;
  try {
    amount = doseToAmount(drug, dose, unit, weight);
  } catch (e) {
    amountError = (e as Error).message;
  }
  const defaultAmount = def ? doseToAmount(drug, def.amount, def.unit, weight) : null;
  const large = defaultAmount != null && amount > defaultAmount * 4;
  const allergyHit = drug.allergyClass && useCase.getState().meta?.patient.allergies.some((a) => a.drugClass === drug.allergyClass);

  const give = () => {
    if (large && !confirmLarge) {
      setConfirmLarge(true);
      return;
    }
    dispatch({ type: 'drug.bolus', drugId: drug.id, dose, unit, route });
    setConfirmLarge(false);
  };

  return (
    <>
      <Section title={<button className="normal-case tracking-normal text-accent hover:underline" onClick={onBack}>← Formulary</button>}>
        <div className="mb-2">
          <div className="text-[16px] font-semibold">{drug.name}</div>
          <div className="text-[12px] text-ink-3">{drug.drugClass}</div>
        </div>
        <p className="text-[12.5px] leading-snug text-ink-2">{drug.notes}</p>
        {drug.typicalDose && (
          <p className="mt-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-[11.5px] text-ink-2">
            <span className="font-semibold">Typical adult dosing (educational reference):</span> {drug.typicalDose}
          </p>
        )}
        <p className="mt-1.5 text-[10.5px] text-ink-3">Model basis: {drug.basis}</p>
      </Section>
      <Section title="Give a dose">
        <div className="mb-2 flex flex-wrap gap-1">
          {drug.routes.map((r) => (
            <button key={r.route} onClick={() => setRoute(r.route)} className={clsx('rounded-md border px-2.5 py-1 text-[12px]', route === r.route ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line text-ink-2')} data-testid={`route-${r.route}`}>
              {ROUTE_LABEL[r.route]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Dose">
            <input type="number" value={dose} min={0} step="any" onChange={(e) => { setDose(Number(e.target.value)); setConfirmLarge(false); }} className={inputCls} data-testid="dose-input" />
          </Field>
          <Field label="Unit">
            <select value={unit} onChange={(e) => { setUnit(e.target.value); setConfirmLarge(false); }} className={inputCls}>
              {units.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-3">{amountError ?? `= ${formatAmount(drug, amount)}${unit.endsWith('/kg') ? ` for ${weight} kg` : ''}`}</div>
        {allergyHit && (
          <div className="mt-2 flex items-center gap-1.5 rounded-md bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">
            <AlertTriangle size={13} /> Documented allergy to this drug class.
          </div>
        )}
        {large && (
          <div className="mt-2 flex items-center gap-1.5 rounded-md bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
            <AlertTriangle size={13} /> This is more than 4× the usual dose.{confirmLarge ? ' Click again to confirm.' : ''}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Button variant={confirmLarge ? 'danger' : 'primary'} icon={<Syringe size={14} />} onClick={give} disabled={!!amountError || dose <= 0 || needsIv || needsIo} data-testid="give-drug">
            {confirmLarge ? 'Confirm & give' : `Give ${ROUTE_LABEL[route]}`}
          </Button>
          {(needsIv || needsIo) && <span className="text-[11.5px] text-warn">No {route} access.</span>}
        </div>
      </Section>
      {inf && (
        <Section title="Continuous infusion" action={inf.typical ? <Badge>{inf.typical}</Badge> : null}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Rate">
              <input type="number" value={rate} step="any" min={0} onChange={(e) => setRate(Number(e.target.value))} className={inputCls} />
            </Field>
            <Field label="Unit">
              <select value={rateUnit} onChange={(e) => setRateUnit(e.target.value)} className={inputCls}>
                {inf.units.map((u) => (
                  <option key={u.unit}>{u.unit}</option>
                ))}
              </select>
            </Field>
          </div>
          <Button className="mt-2" variant="subtle" disabled={rate <= 0} onClick={() => dispatch({ type: 'drug.infusion', drugId: drug.id, rate, unit: rateUnit })} data-testid="start-infusion">
            Start / update infusion
          </Button>
          {snapshot?.therapy.infusions
            .filter((i) => i.kind === 'drug' && i.agentId === drug.id && i.stoppedAt === null)
            .map((i) => (
              <div key={i.id} className="mt-2 flex items-center gap-2 text-[12px]">
                <Badge tone="accent">running</Badge> {i.rate} {i.rateUnit}
                <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'infusion.stop', infusionId: i.id })}>
                  Stop
                </Button>
              </div>
            ))}
        </Section>
      )}
    </>
  );
}
