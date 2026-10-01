import { SimulationEngine } from '../src/sim/engine/SimulationEngine';
import { SCENARIOS, getScenario } from '../src/sim/scenarios/library';
import type { SimAction } from '../src/sim/interventions/actions';

function line(e: SimulationEngine): string {
  const p = e.s.phys;
  return [
    `t=${(e.s.t / 60).toFixed(1)}m`,
    `${p.cv.rhythm}`,
    `HR ${p.cv.hr.toFixed(0)}`,
    `BP ${p.cv.sbp.toFixed(0)}/${p.cv.dbp.toFixed(0)} (${p.cv.map.toFixed(0)})`,
    `CO ${p.cv.co.toFixed(1)}`,
    `RAP ${p.cv.rap.toFixed(1)} LAP ${p.cv.lap.toFixed(1)}`,
    `RR ${p.resp.rr.toFixed(0)} VT ${p.resp.vt.toFixed(0)}`,
    `SpO2 ${(p.resp.sao2 * 100).toFixed(0)} PaO2 ${p.resp.pao2.toFixed(0)} PaCO2 ${p.resp.paco2.toFixed(0)} Et ${p.resp.etco2.toFixed(0)}`,
    `pH ${p.chem.ph.toFixed(2)} HCO3 ${p.chem.hco3.toFixed(0)} Lac ${p.chem.lactate.toFixed(1)}`,
    `Glu ${p.chem.glucose.toFixed(1)} K ${p.chem.k.toFixed(1)} Na ${p.chem.na.toFixed(0)}`,
    `Hb ${p.blood.hb.toFixed(1)} BV ${p.blood.volume.toFixed(0)}`,
    `T ${p.thermo.core.toFixed(1)} GCS ${p.neuro.gcs} pain ${p.neuro.pain.toFixed(0)} pupil ${p.neuro.pupilLeft.toFixed(1)}`,
  ].join(' | ');
}

const only = process.argv[2];
for (const sc of SCENARIOS) {
  if (only && sc.id !== only) continue;
  const t0 = performance.now();
  const e = SimulationEngine.create({ seed: 'CHECK-0001', scenario: sc });
  const ms = performance.now() - t0;
  console.log(`\n=== ${sc.id} (${e.s.patient.sex} ${e.s.patient.ageYears}y ${e.s.patient.weightKg}kg) init ${ms.toFixed(0)}ms`);
  console.log(line(e));
  for (const m of [2, 5, 10, 20]) {
    const target = m * 60;
    while (e.s.t < target) e.step();
    console.log(line(e));
  }
}
void getScenario;
export type { SimAction };
