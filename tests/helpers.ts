import { SimulationEngine } from '../src/sim/engine/SimulationEngine';
import { getScenario } from '../src/sim/scenarios/library';
import type { SimAction } from '../src/sim/interventions/actions';
import type { ScenarioDefinition } from '../src/sim/scenarios/schema';

export function scenario(id: string): ScenarioDefinition {
  const s = getScenario(id);
  if (!s) throw new Error(`missing scenario ${id}`);
  return s;
}

export function engine(id: string, seed = 'TEST-SEED-1'): SimulationEngine {
  return SimulationEngine.create({ seed, scenario: scenario(id) });
}

/** A healthy patient: a scenario whose only pathology does nothing. */
export function healthy(seed = 'HEALTHY-1'): SimulationEngine {
  const base = scenario('gastro-elderly');
  const sc: ScenarioDefinition = {
    ...base,
    id: 'healthy',
    patient: { ...base.patient, ageRange: [30, 45], forbiddenHistory: ['heartFailure', 'ckd', 'copd', 'asthma', 'cad', 'afibChronic'] },
    pathologies: [{ type: 'dehydration', params: { deficitMl: 0, ongoingLossMlH: 0, diarrhoea: false }, onsetMinutesBeforeArrival: 0, startsAfterMinutes: 0 }],
  };
  return SimulationEngine.create({ seed, scenario: sc });
}

export function run(e: SimulationEngine, seconds: number): void {
  const end = e.s.t + seconds;
  while (e.s.t < end - 1e-9) e.step();
}

export function act(e: SimulationEngine, action: SimAction): void {
  const r = e.dispatch(action);
  if (!r.ok) throw new Error(`dispatch failed: ${r.error}`);
  e.step();
}

export function giveIvAccess(e: SimulationEngine): void {
  e.s.therapy.access.leftArm = true;
}

export function allFinite(obj: unknown, path = ''): string[] {
  const bad: string[] = [];
  const visit = (v: unknown, p: string) => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v) && v !== Infinity) bad.push(p);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, `${p}.${k}`);
    }
  };
  visit(obj, path);
  return bad;
}
