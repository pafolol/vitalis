import type { SimAction } from '@/sim/interventions/actions';
import type { ScenarioDefinition } from '@/sim/scenarios/schema';
import type { CaseMeta, HistoryPayload, SimSnapshot } from '@/sim/engine/snapshot';
import type { SimulationEvent } from '@/sim/types';
import type { FromWorker, ToWorker } from '@/worker/protocol';

type Listener = (s: SimSnapshot) => void;

/**
 * Owns the simulation worker. The latest snapshot is kept in a plain mutable
 * field (`latest`) that render loops (monitor canvas, 3D scene) read every
 * frame without triggering React renders. React-facing stores subscribe at a
 * lower rate.
 */
export class SimClient {
  private worker: Worker;
  latest: SimSnapshot | null = null;
  /** Wall-clock time the latest snapshot arrived (ms) */
  latestAt = 0;
  meta: CaseMeta | null = null;
  speed = 1;
  private listeners = new Set<Listener>();
  private createdListeners = new Set<(meta: CaseMeta, snapshot: SimSnapshot, restored: boolean) => void>();
  private errorListeners = new Set<(msg: string) => void>();
  private pending = new Map<number, (v: unknown) => void>();
  private reqId = 1;

  constructor() {
    this.worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(ev.data);
    this.worker.onerror = (e) => this.errorListeners.forEach((l) => l(e.message || 'Simulation worker error'));
  }

  private send(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  private handle(msg: FromWorker): void {
    switch (msg.type) {
      case 'created':
        this.meta = msg.meta;
        this.latest = msg.snapshot;
        this.latestAt = performance.now();
        this.createdListeners.forEach((l) => l(msg.meta, msg.snapshot, msg.restored));
        break;
      case 'snapshot':
        this.latest = msg.snapshot;
        this.latestAt = performance.now();
        this.listeners.forEach((l) => l(msg.snapshot));
        break;
      case 'actionResult':
        if (!msg.ok) this.errorListeners.forEach((l) => l(msg.error ?? 'Action rejected'));
        if (msg.requestId) this.resolve(msg.requestId, msg);
        break;
      case 'serialized':
        this.resolve(msg.requestId, msg.json);
        break;
      case 'history':
        this.resolve(msg.requestId, msg.history);
        break;
      case 'events':
        this.resolve(msg.requestId, msg.events);
        break;
      case 'error':
        this.errorListeners.forEach((l) => l(msg.message));
        break;
    }
  }

  private resolve(id: number, value: unknown): void {
    const r = this.pending.get(id);
    if (r) {
      this.pending.delete(id);
      r(value);
    }
  }

  private request<T>(build: (id: number) => ToWorker): Promise<T> {
    const id = this.reqId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, res as (v: unknown) => void);
      this.send(build(id));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('Worker request timed out'));
        }
      }, 15000);
    });
  }

  create(seed: string, scenario: ScenarioDefinition): void {
    this.send({ type: 'create', seed, scenario });
  }

  restore(json: string): void {
    this.send({ type: 'restore', json });
  }

  dispatch(action: SimAction): void {
    this.send({ type: 'action', action });
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.send({ type: 'speed', speed });
  }

  skip(seconds: number): void {
    this.send({ type: 'skip', seconds });
  }

  serialize(): Promise<string> {
    return this.request<string>((requestId) => ({ type: 'serialize', requestId }));
  }

  history(): Promise<HistoryPayload> {
    return this.request<HistoryPayload>((requestId) => ({ type: 'history', requestId }));
  }

  allEvents(): Promise<SimulationEvent[]> {
    return this.request<SimulationEvent[]>((requestId) => ({ type: 'events', requestId }));
  }

  onSnapshot(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onCreated(l: (meta: CaseMeta, snapshot: SimSnapshot, restored: boolean) => void): () => void {
    this.createdListeners.add(l);
    return () => this.createdListeners.delete(l);
  }

  onError(l: (msg: string) => void): () => void {
    this.errorListeners.add(l);
    return () => this.errorListeners.delete(l);
  }

  dispose(): void {
    this.send({ type: 'dispose' });
    this.worker.terminate();
  }
}

let singleton: SimClient | null = null;
export function simClient(): SimClient {
  if (!singleton) singleton = new SimClient();
  return singleton;
}
