import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useCase, useUi, type PanelId } from '@/client/stores';
import { simClient } from '@/client/simClient';
import { updateVisualState } from '@/client/visualState';
import { createDefaultVisualState, type AvatarVisualState, type BodyPointerHit } from '@/three/types';
import { ERStage } from '@/three/scene/ERStage';
import { bodyShapeFor } from '@/sim/patient/generator';
import { Monitor } from '../monitor/Monitor';
import { TopBar } from './TopBar';
import { Rail, PANEL_META } from './Rail';
import { ViewportOverlay } from './ViewportOverlay';
import { ExamPopover, type ExamPopoverState } from './ExamPopover';
import { TherapyStrip } from './TherapyStrip';
import { EndCaseDialog } from './EndCaseDialog';
import { PanelContent } from '../panels/PanelContent';
import { useCprInput } from '../panels/useCprInput';

export default function CaseScreen() {
  const meta = useCase((s) => s.meta);
  const panel = useUi((s) => s.panel);
  const setPanel = useUi((s) => s.setPanel);
  const { layers, preset, presetNonce, isolate, selected, select, tool } = useUi();
  const visual = useRef<AvatarVisualState>(createDefaultVisualState()) as MutableRefObject<AvatarVisualState>;
  const [exam, setExam] = useState<ExamPopoverState | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const status = useCase((s) => s.snapshot?.status);
  const [monitorOpen, setMonitorOpen] = useState(true);

  useCprInput(visual);

  // Visual-state loop: physiology → avatar parameters (no React renders)
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastShock = -1;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      const snap = simClient().latest;
      updateVisualState(visual.current, snap, dt, useCase.getState().speed);
      if (snap && snap.derived.lastShockAt >= 0 && snap.derived.lastShockAt !== lastShock) {
        lastShock = snap.derived.lastShockAt;
        visual.current.lastShockAt = visual.current.clock;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Show the end-of-case prompt when the patient dies
  useEffect(() => {
    if (status && !status.alive) setEndOpen(true);
  }, [status?.alive, status]);

  const body = useMemo(() => (meta ? bodyShapeFor(meta.patient) : null), [meta]);

  const onBodyPointer = useCallback(
    (hit: BodyPointerHit) => {
      const t = useUi.getState().tool;
      if (t === 'pointer') return;
      setExam({ hit, tool: t });
    },
    [],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') {
        setExam(null);
        setPanel(null);
      }
      const n = Number(e.key);
      if (!e.ctrlKey && !e.metaKey && n >= 1 && n <= 9) {
        const p = PANEL_META[n - 1];
        if (p) useUi.getState().togglePanel(p.id as Exclude<PanelId, null>);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPanel]);

  if (!meta || !body) return null;
  const panelMeta = PANEL_META.find((p) => p.id === panel);

  return (
    <div className="flex h-full flex-col" data-testid="case-screen">
      <TopBar onEnd={() => setEndOpen(true)} monitorOpen={monitorOpen} onToggleMonitor={() => setMonitorOpen((v) => !v)} />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <div className="relative flex min-w-0 flex-1">
          {/* Drawer */}
          <div
            className={clsx(
              'z-20 flex w-[400px] max-w-[calc(100%-16px)] shrink-0 flex-col border-r border-line bg-surface transition-transform duration-200',
              // Wide screens: the drawer pushes the viewport. Narrower (tablet): it overlays it.
              'absolute inset-y-0 left-0 shadow-2xl 2xl:relative 2xl:shadow-none',
              panel ? 'translate-x-0' : 'pointer-events-none invisible -translate-x-[105%] 2xl:hidden',
            )}
            data-testid="drawer"
            aria-hidden={!panel}
          >
            {panelMeta && (
              <>
                <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
                  <panelMeta.icon size={16} className="text-accent" />
                  <h2 className="text-[14px] font-semibold">{panelMeta.label}</h2>
                  <button className="ml-auto grid h-7 w-7 place-items-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={() => setPanel(null)} aria-label="Close panel">
                    <X size={16} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto scroll-thin" data-testid={`panel-${panel}`}>
                  <PanelContent panel={panel} visual={visual} />
                </div>
              </>
            )}
          </div>

          {/* 3D viewport */}
          <div className="relative min-w-0 flex-1 bg-[#0d1116]" data-testid="viewport">
            <ERStage
              body={body}
              visual={visual}
              layers={layers}
              preset={preset}
              presetNonce={presetNonce}
              isolateLayer={isolate}
              selectedStructureId={selected?.id ?? null}
              onSelectStructure={select}
              onBodyPointer={onBodyPointer}
              toolCursor={tool === 'stethoscope' ? 'stethoscope' : tool === 'palpate' ? 'palpate' : tool === 'inspect' ? 'crosshair' : 'default'}
            />
            <div className={clsx('pointer-events-none absolute inset-0 transition-[left] duration-200', panel && 'max-2xl:left-[400px]')}>
              <ViewportOverlay />
              <TherapyStrip />
            </div>
            {exam && <ExamPopover state={exam} onClose={() => setExam(null)} />}
          </div>
        </div>
        {/* Monitor */}
        <aside className={clsx('shrink-0 border-l border-line transition-[width] duration-200', monitorOpen ? 'w-[400px] xl:w-[430px]' : 'w-0 overflow-hidden')} data-testid="monitor-aside">
          {monitorOpen && <Monitor />}
        </aside>
      </div>
      {endOpen && <EndCaseDialog onClose={() => setEndOpen(false)} />}
    </div>
  );
}
