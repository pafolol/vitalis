/// <reference lib="webworker" />
import { SimulationEngine } from '@/sim/engine/SimulationEngine';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let engine: SimulationEngine | null = null;
let speed = 1;
let accumulator = 0;
let lastWall = performance.now();
let lastSnapshot = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 20;
const SNAPSHOT_MS = 100;
const MAX_STEPS_PER_TICK = 600;

function post(msg: FromWorker): void {
  self.postMessage(msg);
}

function pushSnapshot(): void {
  if (!engine) return;
  post({ type: 'snapshot', snapshot: engine.snapshot() });
  lastSnapshot = performance.now();
}

function loop(): void {
  if (!engine) return;
  const now = performance.now();
  const wallDt = Math.min(0.5, (now - lastWall) / 1000);
  lastWall = now;
  if (speed > 0 && engine.s.status.phase === 'active') {
    accumulator += wallDt * speed;
    let steps = 0;
    while (accumulator >= engine.s.dt && steps < MAX_STEPS_PER_TICK) {
      engine.step();
      accumulator -= engine.s.dt;
      steps++;
    }
    if (steps >= MAX_STEPS_PER_TICK) accumulator = 0;
  } else {
    accumulator = 0;
    // Actions dispatched while paused are still applied promptly (one tick)
    if (engine.s.pendingActions.length && engine.s.status.phase === 'active') engine.step();
  }
  if (now - lastSnapshot >= SNAPSHOT_MS) pushSnapshot();
}

function start(): void {
  if (timer) clearInterval(timer);
  lastWall = performance.now();
  accumulator = 0;
  timer = setInterval(loop, TICK_MS);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'create': {
        engine = SimulationEngine.create({ seed: msg.seed, scenario: msg.scenario });
        engine.resetEventCursor();
        post({ type: 'created', meta: engine.meta(), snapshot: engine.snapshot(), restored: false });
        start();
        break;
      }
      case 'restore': {
        engine = SimulationEngine.restore(msg.json);
        engine.resetEventCursor();
        post({ type: 'created', meta: engine.meta(), snapshot: engine.snapshot(), restored: true });
        start();
        break;
      }
      case 'action': {
        if (!engine) throw new Error('No active case');
        const r = engine.dispatch(msg.action);
        post({ type: 'actionResult', requestId: msg.requestId, ok: r.ok, error: r.error });
        break;
      }
      case 'speed': {
        speed = Math.max(0, Math.min(60, msg.speed));
        break;
      }
      case 'skip': {
        if (!engine) break;
        const n = Math.round(msg.seconds / engine.s.dt);
        for (let i = 0; i < n && engine.s.status.phase === 'active'; i++) engine.step();
        pushSnapshot();
        break;
      }
      case 'serialize': {
        if (!engine) throw new Error('No active case');
        post({ type: 'serialized', requestId: msg.requestId, json: engine.serialize() });
        break;
      }
      case 'history': {
        if (!engine) throw new Error('No active case');
        post({ type: 'history', requestId: msg.requestId, history: { samples: engine.s.history, drugHistory: engine.s.pharm.history } });
        break;
      }
      case 'events': {
        if (!engine) throw new Error('No active case');
        post({ type: 'events', requestId: msg.requestId, events: engine.s.events });
        break;
      }
      case 'dispose': {
        if (timer) clearInterval(timer);
        timer = null;
        engine = null;
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message });
  }
};
