import clsx from 'clsx';
import { Eye, Hand, MousePointer2, Stethoscope } from 'lucide-react';
import { useUi, type Tool } from '@/client/stores';
import type { CameraPreset } from '@/three/types';
import { useCase } from '@/client/stores';

const PRESETS: { id: CameraPreset; label: string }[] = [
  { id: 'full', label: 'Full body' },
  { id: 'head', label: 'Head' },
  { id: 'chest', label: 'Chest' },
  { id: 'abdomen', label: 'Abdomen' },
  { id: 'arms', label: 'Arms' },
  { id: 'legs', label: 'Legs' },
];

const TOOLS: { id: Tool; label: string; icon: typeof Eye; hint: string }[] = [
  { id: 'pointer', label: 'Orbit', icon: MousePointer2, hint: 'Drag to orbit, right-drag to pan, scroll to zoom' },
  { id: 'inspect', label: 'Inspect', icon: Eye, hint: 'Click a body region to look closely' },
  { id: 'stethoscope', label: 'Auscultate', icon: Stethoscope, hint: 'Click the chest, neck or abdomen to listen' },
  { id: 'palpate', label: 'Palpate', icon: Hand, hint: 'Click to feel pulses, skin, abdomen' },
];

export function ViewportOverlay() {
  const { preset, setPreset, tool, setTool } = useUi();
  const speed = useCase((s) => s.speed);
  const current = TOOLS.find((t) => t.id === tool)!;
  return (
    <>
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap gap-1" data-testid="camera-presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPreset(p.id)}
            className={clsx('pointer-events-auto rounded-md border px-2.5 py-1 text-[12px] font-medium backdrop-blur transition-colors', preset === p.id ? 'border-accent/60 bg-accent/20 text-white' : 'border-white/10 bg-black/35 text-white/75 hover:bg-black/55 hover:text-white')}
            data-testid={`preset-${p.id}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {speed === 0 && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-md border border-warn/40 bg-black/50 px-2.5 py-1 text-[12px] font-medium text-amber-300 backdrop-blur">Simulation paused</div>
      )}
      <div className="pointer-events-none absolute bottom-14 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5" data-testid="tool-selector">
        <div className="pointer-events-auto flex gap-1 rounded-xl border border-white/10 bg-black/45 p-1 backdrop-blur-md">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              className={clsx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors', tool === t.id ? 'bg-accent text-accent-ink' : 'text-white/75 hover:bg-white/10 hover:text-white')}
              data-testid={`tool-${t.id}`}
              title={t.hint}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </div>
        <span className="rounded bg-black/40 px-2 py-0.5 text-[11px] text-white/60">{current.hint}</span>
      </div>
    </>
  );
}
