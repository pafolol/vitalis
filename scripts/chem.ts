import { SimulationEngine } from '../src/sim/engine/SimulationEngine';
import { getScenario } from '../src/sim/scenarios/library';
import type { EngineState } from '../src/sim/engine/state';
const id = process.argv[2]!;
const every = Number(process.argv[3] ?? 1800);
const after = Number(process.argv[4] ?? 10);
let last = -1e9;
function row(s: EngineState) {
  const p = s.phys, c = p.chem;
  const sep = s.pathologies.find((x) => x.type === 'sepsis');
  return `${(s.t / 60).toFixed(0)}m ${p.cv.rhythm} HR ${p.cv.hr.toFixed(0)} BP ${p.cv.sbp.toFixed(0)}/${p.cv.dbp.toFixed(0)} RR ${p.resp.rr.toFixed(0)} Sa ${(p.resp.sao2*100).toFixed(0)} PaCO2 ${p.resp.paco2.toFixed(0)} | pH ${c.ph.toFixed(2)} HCO3 ${c.hco3.toFixed(1)} AG ${c.anionGap.toFixed(0)} lac ${c.lactate.toFixed(1)} ket ${c.ketones.toFixed(1)} glu ${c.glucose.toFixed(1)} ins ${c.insulin.toFixed(1)} X ${c.insulinAction.toFixed(2)} gly ${c.glycogen.toFixed(2)} K ${c.k.toFixed(1)} Na ${c.na.toFixed(0)} Cl ${c.cl.toFixed(0)} Cr ${c.creatinine.toFixed(2)} BUN ${c.bun.toFixed(0)} osm ${c.osmolality.toFixed(0)} | BV ${p.blood.volume.toFixed(0)} ISF ${p.fluids.isf.toFixed(0)} UO ${p.renal.urineMlPerHour.toFixed(0)} T ${p.thermo.core.toFixed(1)} GCS ${p.neuro.gcs} WBC ${p.blood.wbc.toFixed(1)}${sep ? ` burden ${Number(sep.state['burden']).toFixed(2)} sirs ${Number(sep.state['sirs']).toFixed(2)}` : ''}`;
}
const e = SimulationEngine.create({ seed: process.argv[5] ?? 'CHECK-0001', scenario: getScenario(id)!, onPrerollStep: (s) => { if (s.t - last >= every) { last = s.t; console.log('pre ' + row(s)); } } });
console.log('ARR ' + row(e.s));
for (let m = 5; m <= after; m += 5) { while (e.s.t < m * 60) e.step(); console.log('live ' + row(e.s)); }
