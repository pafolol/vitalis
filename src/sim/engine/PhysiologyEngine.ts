import type { SimAction } from '../interventions/actions';
import type { SimSnapshot } from './snapshot';

/**
 * Engine-agnostic contract between the application and a physiology engine.
 *
 * The bundled implementation (`SimulationEngine`, id `vitalis-ts`) is a
 * deterministic TypeScript engine that runs in a Web Worker. A backend adapter
 * for a mature native engine (e.g. Kitware Pulse via its Python API running
 * in a simulation service) can implement this interface; the UI, AI layer,
 * diagnostics and 3D renderer only consume `SimSnapshot`s and emit
 * `SimAction`s. See docs/PHYSIOLOGY.md → "Replacing the engine".
 */
export interface PhysiologyEngine {
  readonly engineId: string;
  /** Simulated seconds since patient arrival */
  readonly time: number;
  /** Advance by one fixed timestep */
  step(): void;
  /** Advance by (approximately) `seconds` of simulated time */
  advance(seconds: number): void;
  /** Queue a validated action to be applied at the next tick */
  dispatch(action: SimAction): { ok: boolean; error?: string };
  snapshot(): SimSnapshot;
  serialize(): string;
}
