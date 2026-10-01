import { SimulationEngine } from '../src/sim/engine/SimulationEngine';
import { SCENARIOS } from '../src/sim/scenarios/library';
import type { ScenarioDefinition } from '../src/sim/scenarios/schema';

const base = SCENARIOS.find((s) => s.id === 'gastro-elderly')!;
const sc: ScenarioDefinition = { ...base, id: 'baseline', pathologies: [{ type: 'dehydration', params: { deficitMl: 0, ongoingLossMlH: 0, diarrhoea: false }, onsetMinutesBeforeArrival: Number(process.argv[3] ?? 0), startsAfterMinutes: 0 }] as ScenarioDefinition['pathologies'], patient: { ...base.patient, ageRange: [30, 50] } };
const e = SimulationEngine.create({ seed: process.argv[2] ?? 'BASE-1', scenario: sc });
const p = e.s.phys;
const c = e.s.calib;
console.log('calib', { co0: c.co0.toFixed(2), hr0: c.hr0, sv0: c.sv0.toFixed(0), map0: c.map0.toFixed(0), svr0: c.svr0.toFixed(1), bv0: c.bv0, vus0: c.vus0.toFixed(0), cs: c.cs.toFixed(0), cp: c.cp.toFixed(1), vpu0: c.vpu0.toFixed(0), svMaxL: c.svMaxL.toFixed(0), svMaxR: c.svMaxR.toFixed(0), va0: c.va0.toFixed(2), vt0: c.vt0.toFixed(0), e: [c.eAlpha1_0, c.eBeta1_0, c.eBeta2_0].map((x) => x.toFixed(3)) });
for (let i = 0; i <= 60 * 10 * 10; i++) {
  if (i % 300 === 0 || i < 5) {
    console.log(`${e.s.t.toFixed(1)}s ${p.cv.rhythm} HR ${p.cv.hr.toFixed(1)} sinus ${p.cv.sinusRate.toFixed(1)} MAP ${p.cv.map.toFixed(1)} ${p.cv.sbp.toFixed(0)}/${p.cv.dbp.toFixed(0)} CO ${p.cv.co.toFixed(2)} RAP ${p.cv.rap.toFixed(2)} LAP ${p.cv.lap.toFixed(2)} MSFP ${p.cv.msfp.toFixed(2)} Vp ${p.cv.vPulmonary.toFixed(0)} Vs ${p.cv.vSystemic.toFixed(0)} SVR ${p.cv.svr.toFixed(1)} Pit ${p.cv.intrathoracicPressure.toFixed(1)} S ${p.neuro.sympathetic.toFixed(2)} V ${p.neuro.parasympathetic.toFixed(2)} b1 ${e.s.pharm.channels.beta1.toFixed(3)} a1 ${e.s.pharm.channels.alpha1.toFixed(3)} | RR ${p.resp.rr.toFixed(1)} VT ${p.resp.vt.toFixed(0)} drive ${p.resp.drive.toFixed(2)} PaO2 ${p.resp.pao2.toFixed(0)} PaCO2 ${p.resp.paco2.toFixed(1)} Pv ${p.resp.pvco2.toFixed(1)} fao2 ${p.resp.fao2.toFixed(3)} cvo2 ${p.resp.cvo2.toFixed(1)} | pH ${p.chem.ph.toFixed(3)} glu ${p.chem.glucose.toFixed(2)} K ${p.chem.k.toFixed(2)} lac ${p.chem.lactate.toFixed(2)} T ${p.thermo.core.toFixed(2)} C ${p.neuro.consciousness.toFixed(2)} PV ${p.blood.plasmaVolume.toFixed(0)} ISF ${p.fluids.isf.toFixed(0)} J ${p.fluids.filtration.toFixed(2)} uo ${p.renal.urineMlPerHour.toFixed(0)}`);
  }
  e.step();
}
