import { describe, expect, it } from 'vitest';
import { act, engine, giveIvAccess, run } from './helpers';
import { SimulationEngine } from '../src/sim/engine/SimulationEngine';

/**
 * Interventions must work *through* physiology: each test compares a treated
 * run against an untreated control with the same seed.
 */
describe('interventions change outcomes through the physiology', () => {
  it('naloxone reverses opioid-induced hypoventilation', () => {
    const control = engine('found-unresponsive', 'NAL-1');
    const treated = engine('found-unresponsive', 'NAL-1');
    giveIvAccess(treated);
    const rr0 = treated.s.phys.resp.rr;
    act(treated, { type: 'drug.bolus', drugId: 'naloxone', dose: 0.4, unit: 'mg', route: 'IV' });
    run(treated, 180);
    run(control, 180 + 0.1);
    expect(treated.s.phys.resp.rr).toBeGreaterThan(rr0 + 4);
    expect(treated.s.phys.resp.paco2).toBeLessThan(control.s.phys.resp.paco2 - 5);
    expect(treated.s.phys.neuro.gcs).toBeGreaterThan(control.s.phys.neuro.gcs);
  });

  it('IM adrenaline improves blood pressure in anaphylaxis compared with no treatment', () => {
    const control = engine('swelling-after-dinner', 'EPI-1');
    const treated = engine('swelling-after-dinner', 'EPI-1');
    act(treated, { type: 'drug.bolus', drugId: 'epinephrine', dose: 0.5, unit: 'mg', route: 'IM' });
    run(treated, 600);
    run(control, 600 + 0.1);
    expect(treated.s.phys.cv.map).toBeGreaterThan(control.s.phys.cv.map + 10);
    expect(treated.s.phys.resp.airwayPatency).toBeGreaterThan(control.s.phys.resp.airwayPatency);
  });

  it('antihistamine alone does not treat anaphylactic shock', () => {
    const control = engine('swelling-after-dinner', 'H1-1');
    const treated = engine('swelling-after-dinner', 'H1-1');
    giveIvAccess(treated);
    act(treated, { type: 'drug.bolus', drugId: 'diphenhydramine', dose: 50, unit: 'mg', route: 'IV' });
    run(treated, 600);
    run(control, 600 + 0.1);
    expect(Math.abs(treated.s.phys.cv.map - control.s.phys.cv.map)).toBeLessThan(8);
    expect(treated.s.phys.infl.urticaria).toBeLessThan(control.s.phys.infl.urticaria);
  });

  it('a tourniquet stops compressible limb haemorrhage', () => {
    const control = engine('stab-wound-leg', 'TQ-1');
    const treated = engine('stab-wound-leg', 'TQ-1');
    act(treated, { type: 'procedure.tourniquet', limb: 'leftLeg' });
    run(treated, 600);
    run(control, 600 + 0.1);
    expect(treated.s.phys.blood.bleedingRate).toBeLessThan(5);
    expect(treated.s.phys.cv.map).toBeGreaterThan(control.s.phys.cv.map + 15);
  });

  it('a tourniquet on the wrong limb does not help', () => {
    const e = engine('stab-wound-leg', 'TQ-2');
    act(e, { type: 'procedure.tourniquet', limb: 'rightLeg' });
    run(e, 60);
    expect(e.s.phys.blood.bleedingRate).toBeGreaterThan(20);
  });

  it('needle decompression of the correct side relieves tension physiology', () => {
    const control = engine('motorbike-chest', 'PTX-1');
    const treated = engine('motorbike-chest', 'PTX-1');
    treated.s.patient.baseline.chestWallCm = 3;
    control.s.patient.baseline.chestWallCm = 3;
    run(treated, 120);
    run(control, 120);
    act(treated, { type: 'procedure.needleDecompression', side: 'right', site: '5ICS-AAL' });
    run(treated, 120);
    run(control, 120 + 0.1);
    expect(treated.s.phys.cv.map).toBeGreaterThan(control.s.phys.cv.map + 15);
    expect(treated.s.phys.resp.lungExpansionRight).toBeGreaterThan(control.s.phys.resp.lungExpansionRight);
  });

  it('decompressing the wrong side creates a pneumothorax instead of helping', () => {
    const e = engine('motorbike-chest', 'PTX-2');
    e.s.patient.baseline.chestWallCm = 3;
    act(e, { type: 'procedure.needleDecompression', side: 'left', site: '2ICS-MCL' });
    run(e, 30);
    expect(e.s.phys.resp.pleuralAirLeft).toBeGreaterThan(200);
  });

  it('adenosine (rapid IV) terminates re-entrant SVT; sinus rate follows', () => {
    let converted = 0;
    for (const seed of ['ADN-1', 'ADN-2', 'ADN-3']) {
      const e = engine('palpitations', seed);
      giveIvAccess(e);
      act(e, { type: 'drug.bolus', drugId: 'adenosine', dose: 12, unit: 'mg', route: 'IV' });
      run(e, 60);
      if (e.s.phys.cv.rhythm === 'sinus') converted++;
    }
    expect(converted).toBeGreaterThanOrEqual(2);
  });

  it('IV dextrose corrects hypoglycaemia within minutes and consciousness improves', () => {
    const e = engine('strange-behaviour', 'DEX-1');
    giveIvAccess(e);
    const g0 = e.s.phys.chem.glucose;
    const gcs0 = e.s.phys.neuro.gcs;
    act(e, { type: 'drug.bolus', drugId: 'dextrose50', dose: 50, unit: 'mL', route: 'IV' });
    run(e, 300);
    expect(g0).toBeLessThan(3);
    expect(e.s.phys.chem.glucose).toBeGreaterThan(5);
    expect(e.s.phys.neuro.gcs).toBeGreaterThan(gcs0 + 4);
  });

  it('defibrillation during CPR can convert VF; shocking asystole never does', () => {
    let converted = 0;
    for (const seed of ['VF-1', 'VF-2', 'VF-3', 'VF-4']) {
      const e = engine('collapsed-gym', seed);
      if (e.s.phys.cv.rhythm !== 'vfib') continue;
      act(e, { type: 'defib.charge' });
      act(e, { type: 'defib.shock' });
      run(e, 5);
      if (e.s.phys.cv.rhythm !== 'vfib') converted++;
    }
    expect(converted).toBeGreaterThanOrEqual(1);

    const a = engine('collapsed-gym', 'ASYS-1');
    a.s.phys.cv.rhythm = 'asystole';
    act(a, { type: 'defib.charge' });
    act(a, { type: 'defib.shock' });
    expect(a.s.phys.cv.rhythm).toBe('asystole');
  });

  it('calcium does not lower potassium, insulin–dextrose does', () => {
    const ca = engine('missed-dialysis', 'K-1');
    const ins = engine('missed-dialysis', 'K-1');
    giveIvAccess(ca);
    giveIvAccess(ins);
    const k0 = ca.s.phys.chem.k;
    act(ca, { type: 'drug.bolus', drugId: 'calciumGluconate', dose: 30, unit: 'mL', route: 'IV' });
    act(ins, { type: 'drug.bolus', drugId: 'insulinRegular', dose: 10, unit: 'units', route: 'IV' });
    act(ins, { type: 'drug.bolus', drugId: 'dextrose50', dose: 50, unit: 'mL', route: 'IV' });
    run(ca, 1200);
    run(ins, 1200);
    expect(Math.abs(ca.s.phys.chem.k - k0)).toBeLessThan(0.6);
    expect(ins.s.phys.chem.k).toBeLessThan(k0 - 0.5);
    expect(ca.s.phys.chem.ica).toBeGreaterThan(1.25);
  });

  it('fluids and IV drugs require vascular access', () => {
    const e = engine('gastro-elderly', 'ACC-1');
    act(e, { type: 'fluid.start', fluidId: 'lr', volumeMl: 1000, rateMlH: 999, warmed: false });
    expect(e.s.therapy.infusions.length).toBe(0);
    expect(e.s.events.some((x) => x.code === 'fluid.noAccess')).toBe(true);
  });

  it('crystalloid bolus raises BP in hypovolaemia and mostly redistributes out of the circulation', () => {
    const e = engine('gastro-elderly', 'FLU-1');
    giveIvAccess(e);
    const bv0 = e.s.phys.blood.volume;
    act(e, { type: 'fluid.start', fluidId: 'lr', volumeMl: 1000, rateMlH: 6000, warmed: false });
    run(e, 600);
    const gainAt10 = e.s.phys.blood.volume - bv0;
    run(e, 3600);
    const gainAt70 = e.s.phys.blood.volume - bv0;
    expect(gainAt10).toBeGreaterThan(300);
    expect(gainAt70).toBeLessThan(gainAt10);
  });

  it('giving a drug the patient is allergic to triggers anaphylaxis', () => {
    const e = engine('fever-confused', 'ALG-1');
    e.s.patient.allergies = [{ agent: 'Penicillin', drugClass: 'penicillin', reaction: 'anaphylaxis' }];
    giveIvAccess(e);
    const map0 = e.s.phys.cv.map;
    act(e, { type: 'drug.bolus', drugId: 'piperacillinTazobactam', dose: 4.5, unit: 'g', route: 'IV' });
    run(e, 900);
    expect(e.s.pathologies.some((p) => p.type === 'anaphylaxis')).toBe(true);
    expect(e.s.phys.cv.map).toBeLessThan(map0 - 10);
  });

  it('awake patients cannot be intubated without drugs; RSI makes intubation possible', () => {
    const e = engine('cant-breathe', 'RSI-1');
    act(e, { type: 'airway.intubate', tubeSize: 7.5 });
    expect(e.s.therapy.airway.ett).toBe(false);
    giveIvAccess(e);
    act(e, { type: 'drug.bolus', drugId: 'ketamine', dose: 100, unit: 'mg', route: 'IV' });
    act(e, { type: 'drug.bolus', drugId: 'rocuronium', dose: 80, unit: 'mg', route: 'IV' });
    run(e, 90);
    expect(e.s.phys.neuro.paralysis).toBeGreaterThan(0.8);
    act(e, { type: 'airway.intubate', tubeSize: 7.5 });
    run(e, 40);
    expect(e.s.therapy.airway.ett).toBe(true);
    // paralysed + intubated + not ventilated → apnoea and falling SpO2
    run(e, 120);
    expect(e.s.phys.resp.rr).toBe(0);
  });

  it('diagnostics capture state at collection and report after turnaround', () => {
    const e = engine('drowsy-diabetic', 'LAB-1');
    act(e, { type: 'diagnostic.order', testId: 'vbg' });
    const order = e.s.diagnostics.orders[0]!;
    expect(order.status).toBe('pending');
    run(e, order.resultAt - e.s.t + 1);
    expect(order.status).toBe('resulted');
    const ph = order.items.find((i) => i.key === 'ph')!;
    expect(Number(ph.value)).toBeLessThan(7.3);
    expect(ph.source).toBe('simulated');
  });
});

describe('engine API', () => {
  it('rejects malformed actions', () => {
    const e = SimulationEngine.create({ seed: 'API-1', scenario: engine('palpitations').s.scenario });
    // @ts-expect-error intentionally invalid
    expect(e.dispatch({ type: 'drug.bolus', drugId: 'x' }).ok).toBe(false);
  });
});
