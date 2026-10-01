import { useState } from 'react';
import clsx from 'clsx';
import { Droplets, HeartPulse, Square, Zap } from 'lucide-react';
import { useCase } from '@/client/stores';
import { FLUIDS } from '@/sim/pharmacology/drugs';
import { ActionTile, Badge, Button, Field, Section, Segmented, inputCls } from '../common';
import { compress, useCprState } from './useCprInput';

const ENERGIES = [50, 100, 120, 150, 200, 300, 360];

export function CirculationPanel() {
  const snapshot = useCase((s) => s.snapshot);
  const dispatch = useCase((s) => s.dispatch);
  const [fluidId, setFluidId] = useState('lr');
  const [volume, setVolume] = useState(1000);
  const [rate, setRate] = useState(2000);
  const [warmed, setWarmed] = useState(false);
  const [pace, setPace] = useState({ rate: 70, mA: 60 });
  const { depth, setDepth, lastRate } = useCprState();
  if (!snapshot) return null;
  const th = snapshot.therapy;
  const hasAccess = th.access.leftArm || th.access.rightArm || th.access.io;
  const fluid = FLUIDS.find((f) => f.id === fluidId)!;
  const defib = th.defib;
  const active = th.infusions.filter((i) => i.stoppedAt === null && i.kind !== 'drug');
  const pendingAccess = snapshot.derived.pending.filter((p) => p.kind === 'ivAccess');

  return (
    <div>
      <Section title="Vascular access" action={pendingAccess.length ? <Badge tone="accent">attempt in progress</Badge> : null}>
        <div className="grid grid-cols-3 gap-2">
          <ActionTile title="IV left arm" subtitle={th.access.leftArm ? '18G in situ' : '18G antecubital'} active={th.access.leftArm} onClick={() => dispatch({ type: 'access.iv', site: 'leftArm' })} />
          <ActionTile title="IV right arm" subtitle={th.access.rightArm ? '18G in situ' : '18G antecubital'} active={th.access.rightArm} onClick={() => dispatch({ type: 'access.iv', site: 'rightArm' })} />
          <ActionTile title="Intraosseous" subtitle={th.access.io ? 'Tibial IO' : 'Proximal tibia'} active={th.access.io} onClick={() => dispatch({ type: 'access.io' })} />
        </div>
      </Section>

      <Section title="Fluids & blood products">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Product">
            <select value={fluidId} onChange={(e) => {
              const f = FLUIDS.find((x) => x.id === e.target.value)!;
              setFluidId(f.id);
              setVolume(f.kind === 'blood' ? f.unitVolume : f.unitVolume === 500 ? 500 : 1000);
              setRate(f.kind === 'blood' ? 1200 : 2000);
            }} className={inputCls} data-testid="fluid-select">
              {FLUIDS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Volume (mL)">
            <input type="number" value={volume} min={50} max={3000} step={50} onChange={(e) => setVolume(Number(e.target.value))} className={inputCls} />
          </Field>
          <Field label="Rate (mL/h)" hint={`≈ ${Math.round((volume / rate) * 60)} min`}>
            <input type="number" value={rate} min={10} max={20000} step={50} onChange={(e) => setRate(Number(e.target.value))} className={inputCls} />
          </Field>
          <label className="mt-5 flex items-center gap-2 text-[12px] text-ink-2">
            <input type="checkbox" checked={warmed} onChange={(e) => setWarmed(e.target.checked)} />
            Through fluid warmer
          </label>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">{fluid.notes}</p>
        <div className="mt-2 flex gap-2">
          <Button variant="primary" icon={<Droplets size={14} />} disabled={!hasAccess} onClick={() => dispatch({ type: 'fluid.start', fluidId, volumeMl: volume, rateMlH: rate, warmed })} data-testid="fluid-start">
            Start {fluid.kind === 'blood' ? 'transfusion' : 'infusion'}
          </Button>
          <Button variant="ghost" disabled={!hasAccess} onClick={() => dispatch({ type: 'fluid.start', fluidId, volumeMl: 500, rateMlH: 6000, warmed })}>
            500 mL bolus
          </Button>
        </div>
        {!hasAccess && <p className="mt-2 text-[11.5px] text-warn">No vascular access yet.</p>}
        {active.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {active.map((i) => (
              <li key={i.id} className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px]">
                <Droplets size={12} className={i.kind === 'blood' ? 'text-danger' : 'text-accent'} />
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                <span className="font-mono tabular text-ink-2">
                  {Math.round(i.infusedMl)}/{Math.round(i.totalMl)}
                </span>
                <button className="text-ink-3 hover:text-danger" onClick={() => dispatch({ type: 'infusion.stop', infusionId: i.id })} title="Stop">
                  <Square size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant={th.procedures.legRaise ? 'subtle' : 'ghost'} onClick={() => dispatch({ type: 'procedure.legRaise', on: !th.procedures.legRaise })}>
            {th.procedures.legRaise ? 'Legs raised' : 'Passive leg raise'}
          </Button>
        </div>
      </Section>

      <Section title="Cardiopulmonary resuscitation" action={th.cpr.active ? <Badge tone="danger">CPR in progress</Badge> : snapshot.derived.arrest ? <Badge tone="danger">no pulse</Badge> : null}>
        <div className="flex flex-wrap items-center gap-2">
          {!th.cpr.active ? (
            <>
              <Button variant="danger" icon={<HeartPulse size={14} />} onClick={() => dispatch({ type: 'cpr.start', mode: 'manual' })} data-testid="cpr-start">
                Start CPR (manual)
              </Button>
              <Button variant="secondary" onClick={() => dispatch({ type: 'cpr.start', mode: 'mechanical' })}>
                Mechanical device
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => dispatch({ type: 'cpr.stop' })} data-testid="cpr-stop">
              Stop / pause CPR
            </Button>
          )}
        </div>
        {th.cpr.active && th.cpr.mode === 'manual' && (
          <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
            <button
              onPointerDown={(e) => {
                e.preventDefault();
                compress();
              }}
              className="flex h-20 w-full items-center justify-center rounded-lg bg-danger/15 text-[13px] font-semibold text-danger active:bg-danger/30"
              data-testid="cpr-pad"
            >
              Tap here or press <span className="mx-1 rounded border border-danger/40 px-1 font-mono text-[11px]">Space</span> for each compression
            </button>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[12px]">
              <div>
                <div className="text-ink-3">Rate</div>
                <div className={clsx('font-mono text-[18px] tabular', lastRate >= 100 && lastRate <= 120 ? 'text-good' : 'text-warn')}>{lastRate ? Math.round(lastRate) : '—'}</div>
              </div>
              <div>
                <div className="text-ink-3">Quality</div>
                <div className="font-mono text-[18px] tabular">{Math.round(th.cpr.quality * 100)}%</div>
              </div>
              <div>
                <div className="text-ink-3">Target</div>
                <div className="font-mono text-[13px]">100–120/min</div>
              </div>
            </div>
            <Field label={`Compression depth: ${depth < 0.5 ? 'shallow' : depth < 0.75 ? 'moderate' : 'adequate (5–6 cm)'}`}>
              <input type="range" min={0.2} max={1} step={0.05} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
            </Field>
          </div>
        )}
        <p className="mt-2 text-[11.5px] text-ink-3">CPR produces a fraction of normal cardiac output; the simulator derives coronary and cerebral perfusion — and EtCO₂ — from compression quality and vascular tone.</p>
      </Section>

      <Section title="Defibrillator / pacer" action={<Badge tone={defib.charged ? 'danger' : 'neutral'}>{defib.charged ? `charged ${defib.energy} J` : `${defib.shocks} shocks`}</Badge>}>
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={defib.padsOn ? 'subtle' : 'secondary'} onClick={() => dispatch({ type: 'defib.pads', on: !defib.padsOn })} data-testid="pads-toggle">
              {defib.padsOn ? 'Pads on (anterolateral)' : 'Apply pads'}
            </Button>
            <Segmented size="sm" value={defib.sync ? 'sync' : 'async'} onChange={(v) => dispatch({ type: 'defib.sync', on: v === 'sync' })} options={[{ value: 'async', label: 'Defib' }, { value: 'sync', label: 'Sync' }]} />
          </div>
          <div className="flex flex-wrap gap-1">
            {ENERGIES.map((j) => (
              <button key={j} onClick={() => dispatch({ type: 'defib.energy', joules: j })} className={clsx('rounded px-2 py-1 font-mono text-[11.5px]', defib.energy === j ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-ink-2 hover:text-ink')}>
                {j}J
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!defib.padsOn} onClick={() => dispatch({ type: 'defib.charge' })} data-testid="defib-charge">
              Charge
            </Button>
            <Button variant="danger" icon={<Zap size={14} />} disabled={!defib.padsOn || !defib.charged} onClick={() => dispatch({ type: 'defib.shock' })} data-testid="defib-shock">
              Shock
            </Button>
            {defib.charged && (
              <Button variant="ghost" onClick={() => dispatch({ type: 'defib.disarm' })}>
                Disarm
              </Button>
            )}
          </div>
          <div className="mt-1 rounded-lg border border-line bg-surface-2 p-2.5">
            <div className="mb-1.5 text-[12px] font-medium">Transcutaneous pacing</div>
            <div className="flex items-end gap-2">
              <Field label="Rate">
                <input type="number" value={pace.rate} min={30} max={180} onChange={(e) => setPace({ ...pace, rate: Number(e.target.value) })} className={clsx(inputCls, 'w-20')} />
              </Field>
              <Field label="Output (mA)">
                <input type="number" value={pace.mA} min={0} max={200} step={5} onChange={(e) => setPace({ ...pace, mA: Number(e.target.value) })} className={clsx(inputCls, 'w-24')} />
              </Field>
              <Button variant={defib.pacing.on ? 'subtle' : 'secondary'} onClick={() => dispatch({ type: 'pacing.set', on: true, rate: pace.rate, mA: pace.mA })}>
                {defib.pacing.on ? 'Update' : 'Start'}
              </Button>
              {defib.pacing.on && (
                <Button variant="ghost" onClick={() => dispatch({ type: 'pacing.set', on: false, rate: pace.rate, mA: pace.mA })}>
                  Off
                </Button>
              )}
            </div>
            {defib.pacing.on && (
              <p className="mt-1.5 text-[11.5px] text-ink-3">
                Electrical capture: <span className={snapshot.phys.cv.ecg.pacingCapture ? 'text-good' : 'text-warn'}>{snapshot.phys.cv.ecg.pacingCapture ? 'yes' : 'no'}</span> — confirm mechanical capture with a pulse check. Painful when awake.
              </p>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
