import { useState } from 'react';
import { useCase } from '@/client/stores';
import type { Limb, Side } from '@/sim/types';
import { formatClock } from '@/sim/core/math';
import { ActionTile, Badge, Field, Section, Segmented } from '../common';

export function ProceduresPanel() {
  const snapshot = useCase((s) => s.snapshot);
  const dispatch = useCase((s) => s.dispatch);
  const [side, setSide] = useState<Side>('right');
  const [site, setSite] = useState<'2ICS-MCL' | '5ICS-AAL'>('2ICS-MCL');
  const [limb, setLimb] = useState<Limb>('leftLeg');
  if (!snapshot) return null;
  const pr = snapshot.therapy.procedures;
  const t = snapshot.t;
  const eta = (at: number | null) => (at == null ? '' : at > t ? ` · ${formatClock(at - t)}` : '');

  return (
    <div>
      <Section title="Chest decompression">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Segmented size="sm" value={side} onChange={setSide} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} ariaLabel="Side" />
          <Segmented size="sm" value={site} onChange={setSite} options={[{ value: '2ICS-MCL', label: '2nd ICS MCL' }, { value: '5ICS-AAL', label: '4th/5th ICS AAL' }]} ariaLabel="Site" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <ActionTile title="Needle decompression" subtitle="14G 5 cm cannula" active={!!pr.needleDecompression[side]} onClick={() => dispatch({ type: 'procedure.needleDecompression', side, site })} tone="danger" />
          <ActionTile title="Chest drain" subtitle="Tube thoracostomy, 5th ICS MAL (~2–3 min)" active={!!pr.chestTube[side]} onClick={() => dispatch({ type: 'procedure.chestTube', side })} />
        </div>
        {(pr.chestTube.left || pr.chestTube.right) && (
          <p className="mt-2 text-[12px] text-ink-2">
            Drain output:{' '}
            {(['left', 'right'] as const)
              .filter((s) => pr.chestTube[s])
              .map((s) => `${s} ${Math.round(pr.chestTube[s]!.output)} mL`)
              .join(' · ')}
          </p>
        )}
      </Section>

      <Section title="Haemorrhage control">
        <div className="mb-2">
          <Segmented size="sm" value={limb} onChange={setLimb} options={[{ value: 'leftArm', label: 'L arm' }, { value: 'rightArm', label: 'R arm' }, { value: 'leftLeg', label: 'L thigh' }, { value: 'rightLeg', label: 'R thigh' }]} ariaLabel="Limb" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <ActionTile title={pr.tourniquet ? `Tourniquet on (${pr.tourniquet})` : 'Apply tourniquet'} subtitle="Proximal to the wound" active={!!pr.tourniquet} onClick={() => dispatch({ type: 'procedure.tourniquet', limb: pr.tourniquet ? null : limb })} tone="danger" />
          <ActionTile title="Direct pressure" subtitle="Firm manual pressure / packing" active={pr.directPressure} onClick={() => dispatch({ type: 'procedure.directPressure', on: !pr.directPressure })} />
          <ActionTile title="Pelvic binder" active={pr.pelvicBinder} onClick={() => dispatch({ type: 'procedure.pelvicBinder', on: !pr.pelvicBinder })} />
          <ActionTile title="Surgery / IR for bleeding" subtitle={pr.hemostasis.done ? 'Completed' : pr.hemostasis.requestedAt != null ? `Team on the way${eta(pr.hemostasis.completesAt)}` : 'Definitive haemorrhage control'} active={pr.hemostasis.requestedAt != null} onClick={() => dispatch({ type: 'procedure.hemostasis' })} />
        </div>
      </Section>

      <Section title="Cardiac & renal">
        <div className="grid grid-cols-2 gap-2">
          <ActionTile title="Modified Valsalva" subtitle="Vagal manoeuvre" onClick={() => dispatch({ type: 'procedure.vagal' })} />
          <ActionTile title="Arterial line" subtitle={snapshot.therapy.monitoring.arterialLine ? 'Continuous ABP' : 'Radial, ~2 min'} active={snapshot.therapy.monitoring.arterialLine} onClick={() => dispatch({ type: 'procedure.arterialLine' })} />
          <ActionTile title="Activate cath lab" subtitle={pr.reperfusion.done ? 'Reperfusion done' : pr.reperfusion.requestedAt != null ? `Activated${eta(pr.reperfusion.completesAt)}` : 'Primary PCI (~30 min)'} active={pr.reperfusion.requestedAt != null} onClick={() => dispatch({ type: 'procedure.reperfusion' })} />
          <ActionTile title="Emergency dialysis" subtitle={pr.dialysis.active ? 'Running' : pr.dialysis.requestedAt != null ? `Requested${eta(pr.dialysis.startsAt)}` : 'Renal team (~30 min)'} active={pr.dialysis.requestedAt != null} onClick={() => dispatch({ type: 'procedure.dialysis' })} />
        </div>
      </Section>

      <Section title="Environment & positioning" action={<Badge>Backrest {pr.backrestDeg}°</Badge>}>
        <div className="grid grid-cols-2 gap-2">
          <ActionTile title="Expose patient" subtitle="Full examination; increases heat loss" active={pr.exposed} onClick={() => dispatch({ type: 'procedure.expose', on: !pr.exposed })} />
          <ActionTile title="Forced-air warming" active={pr.warming} onClick={() => dispatch({ type: 'procedure.warming', on: !pr.warming })} />
        </div>
        <Field label="Bed backrest">
          <input type="range" min={0} max={70} step={5} defaultValue={pr.backrestDeg} onMouseUp={(e) => dispatch({ type: 'procedure.backrest', degrees: Number((e.target as HTMLInputElement).value) })} onTouchEnd={(e) => dispatch({ type: 'procedure.backrest', degrees: Number((e.target as HTMLInputElement).value) })} />
        </Field>
        <p className="mt-1 text-[11.5px] text-ink-3">Sitting a hypovolaemic patient up pools blood in the legs; lying flat or raising the legs mobilises venous volume.</p>
      </Section>
    </div>
  );
}
