import { SimulationEngine } from '../src/sim/engine/SimulationEngine';
import { getScenario } from '../src/sim/scenarios/library';
import type { EngineState } from '../src/sim/engine/state';

const id = process.argv[2]!;
const every = Number(process.argv[3] ?? 60);
const after = Number(process.argv[4] ?? 5);
let last = -1e9;
function row(s: EngineState) {
  const p = s.phys;
  const ch = s.pharm.channels;
  return `${(s.t / 60).toFixed(1)}m ${p.cv.rhythm} HR ${p.cv.hr.toFixed(0)} MAP ${p.cv.map.toFixed(0)} ${p.cv.sbp.toFixed(0)}/${p.cv.dbp.toFixed(0)} CO ${p.cv.co.toFixed(2)} RAP ${p.cv.rap.toFixed(1)} LAP ${p.cv.lap.toFixed(1)} Pit ${p.cv.intrathoracicPressure.toFixed(1)} SVR ${p.cv.svr.toFixed(1)} S ${p.neuro.sympathetic.toFixed(2)} Lc ${p.cv.lvContractility.toFixed(2)} Rc ${p.cv.rvContractility.toFixed(2)} viab ${p.cv.myocardialViability.toFixed(2)} isch ${p.cv.globalIschemia.toFixed(2)} lad ${p.cv.territoryIschemia.lad.toFixed(2)}/${p.cv.territoryInfarct.lad.toFixed(2)} rca ${p.cv.territoryIschemia.rca.toFixed(2)}/${p.cv.territoryInfarct.rca.toFixed(2)} trop ${p.chem.troponin.toFixed(0)} pain ${p.neuro.pain.toFixed(1)} | RR ${p.resp.rr.toFixed(0)} VT ${p.resp.vt.toFixed(0)} drive ${p.resp.drive.toFixed(2)} R ${p.resp.resistance.toFixed(1)} fat ${p.resp.fatigue.toFixed(2)} pat ${p.resp.airwayPatency.toFixed(2)} FiO2 ${p.resp.fio2.toFixed(2)} PaO2 ${p.resp.pao2.toFixed(0)} Sa ${(p.resp.sao2 * 100).toFixed(0)} PaCO2 ${p.resp.paco2.toFixed(0)} shunt ${p.resp.shunt.toFixed(2)} | pH ${p.chem.ph.toFixed(2)} HCO3 ${p.chem.hco3.toFixed(1)} lac ${p.chem.lactate.toFixed(1)} ket ${p.chem.ketones.toFixed(1)} glu ${p.chem.glucose.toFixed(1)} K ${p.chem.k.toFixed(1)} | BV ${p.blood.volume.toFixed(0)} C ${p.neuro.consciousness.toFixed(2)} sed ${p.neuro.sedation.toFixed(2)} T ${p.thermo.core.toFixed(1)} | med ${s.phys.infl.mediators.toFixed(2)} mu ${s.pharm.channelU.mu.toFixed(2)} a1 ${ch.alpha1.toFixed(2)} b1 ${ch.beta1.toFixed(2)} b2 ${ch.beta2.toFixed(2)}`;
}
const e = SimulationEngine.create({
  seed: process.argv[5] ?? 'CHECK-0001',
  scenario: getScenario(id)!,
  onPrerollStep: (s) => {
    if (s.t - last >= every) {
      last = s.t;
      console.log('pre ' + row(s));
    }
  },
});
console.log('ARRIVE ' + row(e.s));
for (let m = 1; m <= after; m++) {
  while (e.s.t < m * 60) e.step();
  console.log('live ' + row(e.s));
}
