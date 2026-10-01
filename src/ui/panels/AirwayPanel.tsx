import { useState } from 'react';
import clsx from 'clsx';
import { useCase } from '@/client/stores';
import type { OxygenDevice } from '@/sim/types';
import { ActionTile, Badge, Button, Field, Section, inputCls } from '../common';

const DEVICES: { id: Exclude<OxygenDevice, 'bvm' | 'ventilator'>; label: string; flows: number[]; def: number; sub: string }[] = [
  { id: 'none', label: 'Room air', flows: [0], def: 0, sub: 'FiO₂ 21%' },
  { id: 'nasalCannula', label: 'Nasal cannula', flows: [1, 2, 3, 4, 6], def: 2, sub: '1–6 L/min' },
  { id: 'simpleMask', label: 'Simple face mask', flows: [5, 6, 8, 10], def: 6, sub: '5–10 L/min' },
  { id: 'nonRebreather', label: 'Non-rebreather', flows: [10, 12, 15], def: 15, sub: 'Reservoir mask 10–15 L/min' },
  { id: 'highFlowNasal', label: 'High-flow nasal', flows: [30, 40, 50, 60], def: 50, sub: 'Heated humidified, set FiO₂' },
];

export function AirwayPanel() {
  const snapshot = useCase((s) => s.snapshot);
  const dispatch = useCase((s) => s.dispatch);
  const [vent, setVent] = useState({ vt: 450, rr: 16, peep: 5, fio2: 1 });
  const [bvmRate, setBvmRate] = useState(10);
  const [hfFio2, setHfFio2] = useState(0.6);
  if (!snapshot) return null;
  const th = snapshot.therapy;
  const resp = snapshot.phys.resp;
  const secured = th.airway.ett;
  const dev = th.oxygen.device;

  return (
    <div>
      <Section title="Oxygen" action={<Badge tone="accent">FiO₂ ≈ {Math.round(resp.fio2 * 100)}%</Badge>}>
        <div className="flex flex-col gap-1.5" data-testid="oxygen-devices">
          {DEVICES.map((d) => (
            <div key={d.id} className={clsx('flex items-center gap-2 rounded-lg border px-3 py-2', dev === d.id ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface-2')}>
              <button className="min-w-0 flex-1 text-left" onClick={() => dispatch({ type: 'oxygen.set', device: d.id, flowLpm: d.def, fio2: d.id === 'highFlowNasal' ? hfFio2 : undefined })} data-testid={`o2-${d.id}`}>
                <div className="text-[13px] font-medium">{d.label}</div>
                <div className="text-[11px] text-ink-3">{d.sub}</div>
              </button>
              {d.id !== 'none' && dev === d.id && (
                <div className="flex gap-1">
                  {d.flows.map((f) => (
                    <button key={f} onClick={() => dispatch({ type: 'oxygen.set', device: d.id, flowLpm: f, fio2: d.id === 'highFlowNasal' ? hfFio2 : undefined })} className={clsx('rounded px-1.5 py-0.5 text-[11px] tabular', th.oxygen.flowLpm === f ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-ink-2')}>
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {dev === 'highFlowNasal' && (
            <Field label={`High-flow FiO₂: ${Math.round(hfFio2 * 100)}%`}>
              <input type="range" min={0.21} max={1} step={0.05} value={hfFio2} onChange={(e) => setHfFio2(Number(e.target.value))} onMouseUp={() => dispatch({ type: 'oxygen.set', device: 'highFlowNasal', flowLpm: th.oxygen.flowLpm, fio2: hfFio2 })} />
            </Field>
          )}
        </div>
      </Section>

      <Section title="Airway manoeuvres & adjuncts" action={<Badge tone={resp.airway === 'patent' || resp.airway === 'secured' ? 'good' : 'warn'}>{resp.airway}</Badge>}>
        <div className="grid grid-cols-2 gap-2">
          <ActionTile title="Head-tilt / chin-lift" active={th.airway.manoeuvre === 'headTiltChinLift'} onClick={() => dispatch({ type: 'airway.manoeuvre', manoeuvre: th.airway.manoeuvre === 'headTiltChinLift' ? 'none' : 'headTiltChinLift' })} />
          <ActionTile title="Jaw thrust" subtitle="Spine-friendly" active={th.airway.manoeuvre === 'jawThrust'} onClick={() => dispatch({ type: 'airway.manoeuvre', manoeuvre: th.airway.manoeuvre === 'jawThrust' ? 'none' : 'jawThrust' })} />
          <ActionTile title="Oropharyngeal airway" subtitle="Only if no gag reflex" active={th.airway.adjunct === 'opa'} onClick={() => dispatch({ type: 'airway.adjunct', adjunct: th.airway.adjunct === 'opa' ? 'none' : 'opa' })} />
          <ActionTile title="Nasopharyngeal airway" subtitle="Tolerated in semi-conscious" active={th.airway.adjunct === 'npa'} onClick={() => dispatch({ type: 'airway.adjunct', adjunct: th.airway.adjunct === 'npa' ? 'none' : 'npa' })} />
          <ActionTile title="Suction" subtitle="Yankauer, oropharynx" onClick={() => dispatch({ type: 'airway.suction' })} />
          <ActionTile title="Recovery position" active={th.airway.recoveryPosition} onClick={() => dispatch({ type: 'airway.recoveryPosition', on: !th.airway.recoveryPosition })} />
        </div>
      </Section>

      <Section title="Bag-valve-mask ventilation">
        <div className="flex items-end gap-2">
          <Field label="Rate (/min)">
            <input type="number" min={4} max={30} value={bvmRate} onChange={(e) => setBvmRate(Number(e.target.value))} className={clsx(inputCls, 'w-20')} />
          </Field>
          <Button variant={th.bvm.active ? 'secondary' : 'primary'} onClick={() => dispatch({ type: 'bvm.set', active: !th.bvm.active, rate: bvmRate, vt: 500 })} data-testid="bvm-toggle">
            {th.bvm.active ? 'Stop bagging' : 'Start BVM (O₂ 15 L)'}
          </Button>
        </div>
        <p className="mt-2 text-[11.5px] text-ink-3">Delivered volume depends on mask seal and airway patency — use manoeuvres/adjuncts. Bagging too fast causes air-trapping in obstructive lung disease.</p>
      </Section>

      <Section title="Advanced airway">
        <div className="grid grid-cols-2 gap-2">
          <ActionTile title={secured ? 'Endotracheal tube in place' : 'Intubate (7.5 ETT)'} subtitle={secured ? 'Ventilate via bag or ventilator' : 'Requires absent airway reflexes or drug-assisted (RSI)'} active={secured} disabled={secured} onClick={() => dispatch({ type: 'airway.intubate', tubeSize: 7.5 })} />
          <ActionTile title="Surgical cricothyrotomy" subtitle="Can't intubate, can't oxygenate" tone="danger" onClick={() => dispatch({ type: 'airway.cricothyrotomy' })} />
          {secured && <ActionTile title="Extubate" onClick={() => dispatch({ type: 'airway.extubate' })} />}
        </div>
      </Section>

      <Section title="Mechanical ventilation" action={th.ventilator.on ? <Badge tone="accent">Running</Badge> : null}>
        <div className="grid grid-cols-4 gap-2">
          <Field label="Vt (mL)">
            <input type="number" value={vent.vt} min={200} max={1000} step={10} onChange={(e) => setVent({ ...vent, vt: Number(e.target.value) })} className={inputCls} />
          </Field>
          <Field label="RR">
            <input type="number" value={vent.rr} min={4} max={40} onChange={(e) => setVent({ ...vent, rr: Number(e.target.value) })} className={inputCls} />
          </Field>
          <Field label="PEEP">
            <input type="number" value={vent.peep} min={0} max={24} onChange={(e) => setVent({ ...vent, peep: Number(e.target.value) })} className={inputCls} />
          </Field>
          <Field label="FiO₂">
            <input type="number" value={vent.fio2} min={0.21} max={1} step={0.05} onChange={(e) => setVent({ ...vent, fio2: Number(e.target.value) })} className={inputCls} />
          </Field>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button variant="primary" disabled={!secured} onClick={() => dispatch({ type: 'ventilator.set', on: true, ...vent, ieRatio: 2 })} data-testid="vent-apply">
            {th.ventilator.on ? 'Apply settings' : 'Start ventilator'}
          </Button>
          {th.ventilator.on && (
            <Button variant="ghost" onClick={() => dispatch({ type: 'ventilator.set', on: false, ...vent, ieRatio: 2 })}>
              Stop
            </Button>
          )}
          {!secured && <span className="text-[11.5px] text-ink-3">Requires a secured airway.</span>}
        </div>
        {th.ventilator.on && (
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[12px]">
            <Readout label="P peak" value={`${Math.round(resp.peakPressure)}`} unit="cmH₂O" warn={resp.peakPressure > 35} />
            <Readout label="P plateau" value={`${Math.round(resp.plateauPressure)}`} unit="cmH₂O" warn={resp.plateauPressure > 30} />
            <Readout label="Auto-PEEP" value={resp.autoPeep.toFixed(1)} unit="cmH₂O" warn={resp.autoPeep > 5} />
          </div>
        )}
      </Section>
    </div>
  );
}

function Readout({ label, value, unit, warn }: { label: string; value: string; unit: string; warn?: boolean }) {
  return (
    <div className={clsx('rounded-lg border p-2', warn ? 'border-warn/50 bg-warn-soft' : 'border-line bg-surface-2')}>
      <div className="text-[10.5px] text-ink-3">{label}</div>
      <div className="font-mono text-[16px] tabular">{value}</div>
      <div className="text-[10px] text-ink-3">{unit}</div>
    </div>
  );
}
