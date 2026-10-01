import { useEffect, type MutableRefObject } from 'react';
import { create } from 'zustand';
import { simClient } from '@/client/simClient';
import type { AvatarVisualState } from '@/three/types';

interface CprInputState {
  presses: number[];
  depth: number;
  lastRate: number;
  setDepth: (d: number) => void;
}

export const useCprState = create<CprInputState>((set) => ({
  presses: [],
  depth: 0.8,
  lastRate: 0,
  setDepth: (depth) => set({ depth }),
}));

let visualRef: MutableRefObject<AvatarVisualState> | null = null;

/** Register one manual chest compression (keyboard Space or on-screen pad). */
export function compress(): void {
  const snap = simClient().latest;
  if (!snap?.therapy.cpr.active || snap.therapy.cpr.mode !== 'manual') return;
  const now = performance.now();
  useCprState.setState((s) => ({ presses: [...s.presses.filter((t) => now - t < 4000), now] }));
  if (visualRef) visualRef.current.cprCompression = useCprState.getState().depth;
}

/**
 * Converts the rhythm of user compressions into `cpr.compressions` actions
 * every 2 s (rate, depth). The engine computes CPR quality → forward flow,
 * coronary/cerebral perfusion and EtCO2 from these inputs.
 */
export function useCprInput(visual: MutableRefObject<AvatarVisualState>): void {
  useEffect(() => {
    visualRef = visual;
    let lastSentCount = 0;
    const send = setInterval(() => {
      const snap = simClient().latest;
      if (!snap?.therapy.cpr.active || snap.therapy.cpr.mode !== 'manual') return;
      const { presses, depth } = useCprState.getState();
      const now = performance.now();
      const recent = presses.filter((t) => now - t < 2000);
      const intervals = recent.slice(1).map((t, i) => t - recent[i]!);
      const mean = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
      const rate = mean > 0 ? 60000 / mean : 0;
      useCprState.setState({ lastRate: rate });
      simClient().dispatch({ type: 'cpr.compressions', count: Math.max(0, recent.length - lastSentCount > 0 ? recent.length : 0), meanIntervalMs: Math.min(5000, mean), depthQuality: depth, windowMs: 2000 });
      lastSentCount = 0;
    }, 2000);
    const decay = setInterval(() => {
      if (visual.current.cprCompression > 0 && simClient().latest?.therapy.cpr.mode === 'manual') visual.current.cprCompression *= 0.55;
    }, 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
      const snap = simClient().latest;
      if (snap?.therapy.cpr.active && snap.therapy.cpr.mode === 'manual') {
        e.preventDefault();
        compress();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(send);
      clearInterval(decay);
      window.removeEventListener('keydown', onKey);
      visualRef = null;
    };
  }, [visual]);
}
