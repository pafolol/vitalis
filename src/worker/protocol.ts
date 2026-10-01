import type { SimAction } from '@/sim/interventions/actions';
import type { ScenarioDefinition } from '@/sim/scenarios/schema';
import type { CaseMeta, HistoryPayload, SimSnapshot } from '@/sim/engine/snapshot';
import type { SimulationEvent } from '@/sim/types';

/**
 * Main-thread ↔ worker protocol.
 *
 * The worker owns the engine and advances it at a fixed timestep scaled by
 * the simulation speed; it pushes compact snapshots at ~10 Hz (independent of
 * render FPS). The main thread never runs physiology.
 */
export type ToWorker =
  | { type: 'create'; seed: string; scenario: ScenarioDefinition }
  | { type: 'restore'; json: string }
  | { type: 'action'; action: SimAction; requestId?: number }
  | { type: 'speed'; speed: number }
  | { type: 'skip'; seconds: number }
  | { type: 'serialize'; requestId: number }
  | { type: 'history'; requestId: number }
  | { type: 'events'; requestId: number }
  | { type: 'dispose' };

export type FromWorker =
  | { type: 'created'; meta: CaseMeta; snapshot: SimSnapshot; restored: boolean }
  | { type: 'snapshot'; snapshot: SimSnapshot }
  | { type: 'actionResult'; requestId?: number; ok: boolean; error?: string }
  | { type: 'serialized'; requestId: number; json: string }
  | { type: 'history'; requestId: number; history: HistoryPayload }
  | { type: 'events'; requestId: number; events: SimulationEvent[] }
  | { type: 'error'; message: string };
