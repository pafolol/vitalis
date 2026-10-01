import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../src/sim/engine/SimulationEngine';
import { generatePatient } from '../src/sim/patient/generator';
import { SCENARIOS } from '../src/sim/scenarios/library';
import { act, allFinite, engine, healthy, run, scenario } from './helpers';

describe('determinism', () => {
  it('same seed + same actions produces an identical state', () => {
    const a = engine('stab-wound-leg', 'DET-1');
    const b = engine('stab-wound-leg', 'DET-1');
    for (const e of [a, b]) {
      run(e, 30);
      act(e, { type: 'procedure.tourniquet', limb: 'leftLeg' });
      act(e, { type: 'access.iv', site: 'rightArm' });
      run(e, 120);
    }
    expect(a.stateHash()).toBe(b.stateHash());
    expect(a.s.phys.cv.map).toBe(b.s.phys.cv.map);
  });

  it('different seeds generate different patients', () => {
    const p1 = generatePatient('SEED-A');
    const p2 = generatePatient('SEED-B');
    expect(p1.seed).not.toBe(p2.seed);
    expect(JSON.stringify(p1)).not.toBe(JSON.stringify(p2));
  });

  it('the same seed regenerates the same patient', () => {
    expect(generatePatient('SEED-C')).toEqual(generatePatient('SEED-C'));
  });

  it('replay from seed + action log reproduces the run', () => {
    const e = engine('found-unresponsive', 'REPLAY-1');
    run(e, 20);
    act(e, { type: 'airway.manoeuvre', manoeuvre: 'jawThrust' });
    run(e, 15);
    act(e, { type: 'access.iv', site: 'leftArm' });
    run(e, 70);
    act(e, { type: 'drug.bolus', drugId: 'naloxone', dose: 0.4, unit: 'mg', route: 'IV' });
    run(e, 60);
    const replayed = SimulationEngine.replay(e.s.seed, e.s.scenario, e.s.actionLog, e.s.tick);
    expect(replayed.s.tick).toBe(e.s.tick);
    expect(replayed.stateHash()).toBe(e.stateHash());
  });

  it('serialise → restore → continue matches uninterrupted continuation', () => {
    const e = engine('cant-breathe', 'SAVE-1');
    run(e, 45);
    const restored = SimulationEngine.restore(e.serialize());
    run(e, 60);
    run(restored, 60);
    expect(restored.stateHash()).toBe(e.stateHash());
  });
});

describe('physiological invariants', () => {
  it('a healthy patient stays near baseline for 10 simulated minutes', () => {
    const e = healthy();
    const b = e.s.patient.baseline;
    run(e, 600);
    const p = e.s.phys;
    expect(Math.abs(p.cv.hr - b.heartRate)).toBeLessThan(12);
    expect(Math.abs(p.cv.sbp - b.systolic)).toBeLessThan(15);
    expect(p.resp.sao2).toBeGreaterThan(0.94);
    expect(p.resp.paco2).toBeGreaterThan(34);
    expect(p.resp.paco2).toBeLessThan(46);
    expect(p.chem.ph).toBeGreaterThan(7.35);
    expect(p.chem.ph).toBeLessThan(7.46);
    expect(p.neuro.gcs).toBe(15);
  });

  it('keeps blood volume = plasma + red cells and all numbers finite', () => {
    for (const id of ['stab-wound-leg', 'fever-confused', 'drowsy-diabetic', 'collapsed-gym']) {
      const e = engine(id);
      run(e, 300);
      const bl = e.s.phys.blood;
      expect(Math.abs(bl.volume - (bl.plasmaVolume + bl.rbcVolume))).toBeLessThan(1);
      expect(Math.abs(e.s.phys.cv.vSystemic + e.s.phys.cv.vPulmonary - bl.volume)).toBeLessThan(5);
      expect(allFinite(e.s.phys)).toEqual([]);
      expect(e.s.phys.resp.sao2).toBeGreaterThanOrEqual(0);
      expect(e.s.phys.resp.sao2).toBeLessThanOrEqual(1);
    }
  });

  it('haemorrhage lowers blood volume, raises heart rate and narrows pulse pressure', () => {
    const e = engine('stab-wound-leg');
    const bv0 = e.s.calib.bv0;
    expect(e.s.phys.blood.volume).toBeLessThan(bv0 * 0.85);
    expect(e.s.phys.cv.hr).toBeGreaterThan(e.s.calib.hr0 + 25);
    expect(e.s.phys.cv.sbp - e.s.phys.cv.dbp).toBeLessThan(e.s.calib.sbp0 - e.s.calib.dbp0);
  });

  it('acute haemorrhage does not immediately lower haemoglobin much, but haemodilution follows', () => {
    const e = engine('stab-wound-leg', 'HB-1');
    const hb0 = e.s.patient.baseline.hemoglobin;
    expect(e.s.phys.blood.hb).toBeGreaterThan(hb0 - 2.5);
    act(e, { type: 'procedure.tourniquet', limb: 'leftLeg' });
    e.s.therapy.access.leftArm = true;
    act(e, { type: 'fluid.start', fluidId: 'ns', volumeMl: 2000, rateMlH: 12000, warmed: false });
    run(e, 900);
    expect(e.s.phys.blood.hb).toBeLessThan(hb0 - 2);
  });

  it('every library scenario arrives with a physiologically valid state', () => {
    for (const sc of SCENARIOS) {
      const e = SimulationEngine.create({ seed: 'ARRIVE-1', scenario: sc });
      expect(allFinite(e.s.phys), sc.id).toEqual([]);
      if (sc.id !== 'collapsed-gym') expect(e.s.phys.cv.pulsePresent, sc.id).toBe(true);
      expect(e.s.status.alive, sc.id).toBe(true);
    }
  });
});

describe('timeline', () => {
  it('events are ordered by time with strictly increasing ids', () => {
    const e = engine('swelling-after-dinner');
    act(e, { type: 'monitor.attach', devices: ['ecg', 'spo2', 'nibp'] });
    run(e, 60);
    act(e, { type: 'drug.bolus', drugId: 'epinephrine', dose: 0.5, unit: 'mg', route: 'IM' });
    run(e, 300);
    const ev = e.s.events;
    expect(ev.length).toBeGreaterThan(3);
    for (let i = 1; i < ev.length; i++) {
      expect(ev[i]!.id).toBeGreaterThan(ev[i - 1]!.id);
      expect(ev[i]!.t).toBeGreaterThanOrEqual(ev[i - 1]!.t);
    }
    expect(ev[0]!.code).toBe('case.arrival');
  });
});

describe('scenario validation', () => {
  it('rejects scenarios with unknown pathologies or bad parameters', async () => {
    const { validateScenario } = await import('../src/sim/scenarios/schema');
    const good = scenario('palpitations');
    expect(validateScenario(good).ok).toBe(true);
    expect(validateScenario({ ...good, pathologies: [{ type: 'alienInfection', params: {} }] }).ok).toBe(false);
    expect(validateScenario({ ...good, pathologies: [{ type: 'hemorrhage', params: { site: 'leftThigh', rateMlMin: 99999 } }] }).ok).toBe(false);
    const leaky = validateScenario({ ...good, title: 'SVT in a young adult' });
    expect(leaky.ok).toBe(false);
    expect(leaky.errors.join(' ')).toMatch(/reveals/);
  });
});
