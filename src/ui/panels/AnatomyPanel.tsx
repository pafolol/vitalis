import clsx from 'clsx';
import { Eye, EyeOff, Focus } from 'lucide-react';
import { useUi } from '@/client/stores';
import { ANATOMY_LAYERS, createDefaultLayerSettings } from '@/three/types';
import { Button, Section } from '../common';

const SWATCH: Record<string, string> = {
  skin: '#c89478',
  superficial: '#5b7fd6',
  muscle: '#a8382f',
  skeleton: '#e4dccb',
  cardiovascular: '#d2323a',
  respiratory: '#e79aa3',
  digestive: '#c9885a',
  nervous: '#e9cf62',
  organs: '#8e5a7a',
};

export function AnatomyPanel() {
  const { layers, setLayer, isolate, setIsolate, selected, select, set, setPreset } = useUi();
  const presets: { label: string; apply: () => void }[] = [
    { label: 'Clinical (skin)', apply: () => set({ layers: createDefaultLayerSettings(), isolate: null }) },
    {
      label: 'X-ray skin + organs',
      apply: () =>
        set({
          layers: { ...createDefaultLayerSettings(), skin: { visible: true, opacity: 0.18 }, cardiovascular: { visible: true, opacity: 1 }, respiratory: { visible: true, opacity: 0.85 }, digestive: { visible: true, opacity: 1 }, organs: { visible: true, opacity: 1 } },
          isolate: null,
        }),
    },
    {
      label: 'Skeleton',
      apply: () => set({ layers: { ...createDefaultLayerSettings(), skin: { visible: true, opacity: 0.12 }, skeleton: { visible: true, opacity: 1 } }, isolate: null }),
    },
    {
      label: 'Heart & lungs (live)',
      apply: () => {
        set({ layers: { ...createDefaultLayerSettings(), skin: { visible: true, opacity: 0.12 }, cardiovascular: { visible: true, opacity: 1 }, respiratory: { visible: true, opacity: 0.8 } }, isolate: null });
        setPreset('chest');
      },
    },
  ];
  return (
    <div>
      <Section title="Views">
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <Button key={p.label} size="sm" variant="secondary" onClick={p.apply}>
              {p.label}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] leading-snug text-ink-3">Organs animate with the simulation: the heart beats at the simulated rate and contractility, lungs inflate with ventilation (and collapse with a pneumothorax), tissues tint with perfusion and oxygenation.</p>
      </Section>
      <Section title="Layers">
        <ul className="flex flex-col gap-1.5" data-testid="layer-list">
          {ANATOMY_LAYERS.map((l) => {
            const st = layers[l.id];
            return (
              <li key={l.id} className={clsx('rounded-lg border px-2.5 py-2', isolate === l.id ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface-2')}>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-sm" style={{ background: SWATCH[l.id] }} />
                  <span className="flex-1 text-[13px] font-medium">{l.label}</span>
                  <button title={isolate === l.id ? 'Show all' : 'Isolate'} onClick={() => setIsolate(isolate === l.id ? null : l.id)} className={clsx('grid h-6 w-6 place-items-center rounded hover:bg-surface-3', isolate === l.id ? 'text-accent' : 'text-ink-3')}>
                    <Focus size={13} />
                  </button>
                  <button title={st.visible ? 'Hide' : 'Show'} onClick={() => setLayer(l.id, { visible: !st.visible })} className={clsx('grid h-6 w-6 place-items-center rounded hover:bg-surface-3', st.visible ? 'text-ink' : 'text-ink-3')} data-testid={`layer-toggle-${l.id}`}>
                    {st.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                </div>
                {st.visible && (
                  <input type="range" min={0.05} max={1} step={0.05} value={st.opacity} onChange={(e) => setLayer(l.id, { opacity: Number(e.target.value) })} className="mt-1.5 w-full" aria-label={`${l.label} opacity`} data-testid={`layer-opacity-${l.id}`} />
                )}
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title="Selected structure" action={selected ? <button className="text-[11px] text-ink-3 hover:text-ink" onClick={() => select(null)}>clear</button> : null}>
        {selected ? (
          <div data-testid="selected-structure">
            <div className="text-[14px] font-semibold">{selected.name}</div>
            <div className="text-[11.5px] text-ink-3">
              {selected.system}
              {selected.fmaId ? ` · ${selected.fmaId}` : ''}
            </div>
            {selected.description && <p className="mt-1.5 text-[12.5px] leading-snug text-ink-2">{selected.description}</p>}
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-3">Make a layer visible and click a structure in the 3D view.</p>
        )}
        <p className="mt-3 text-[10.5px] leading-snug text-ink-3">Anatomical meshes: BodyParts3D (© DBCLS, CC BY 4.0), decimated and fitted to the generated body — approximate placement, for orientation only.</p>
      </Section>
    </div>
  );
}
