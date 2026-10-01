import { Rng, seedState } from '../core/rng';
import { stableHash } from '../core/math';
import { generatePatient } from '../patient/generator';
import { createModifiers, resetModifiers, calibrate, createInitialPhysiology, createTherapy } from '../physiology/init';
import { adrenalOutput, endogenousActivation, endogenousTones, stepAutonomic } from '../physiology/autonomic';
import { stepCardiovascular } from '../physiology/cardiovascular';
import { stepRhythm } from '../physiology/rhythm';
import { stepRespiratoryMechanics, stepGasExchange } from '../physiology/respiratory';
import { applyDirectInputs, stepMetabolic } from '../physiology/metabolic';
import { stepFluids } from '../physiology/fluids';
import { stepNeuro, stepThermo } from '../physiology/neuro';
import { createPharmState, computeChannels, stepPharm, sampleHistory, plasmaConcentration, concentrationUnit, formatAmount } from '../pharmacology/pkpd';
import { DRUG_MAP } from '../pharmacology/drugs';
import type { PkContext } from '../pharmacology/types';
import { PATHOLOGY_MODULES, stepPathologies } from '../pathology/modules';
import { type ScenarioDefinition, validateScenario } from '../scenarios/schema';
import { SimActionSchema, type SimAction } from '../interventions/actions';
import { applyAction, stepPendingTasks, infusionDrugRates, updateCprQuality } from '../interventions/handlers';
import { stepDiagnostics } from '../diagnostics/orders';
import { detectEvents } from './detectors';
import { buildPkContext } from './pkContext';
import { deriveAppearance, deriveClinical } from './derive';
import type { EngineState, HistorySample, StepContext, StepRngs } from './state';
import type { SimSnapshot, CaseMeta } from './snapshot';
import type { PhysiologyEngine } from './PhysiologyEngine';
import type { RngStreams, SimulationEvent } from '../types';

export const SIM_DT = 0.1;
const HISTORY_INTERVAL = 5;
const DRUG_HISTORY_INTERVAL = 10;

export interface CreateOptions {
  seed: string;
  scenario: ScenarioDefinition;
  /** Diagnostics hook invoked after every pre-roll step (tests/tools only) */
  onPrerollStep?: (s: EngineState) => void;
}

function makeRngStreams(seed: string): RngStreams {
  return {
    arrhythmia: seedState(seed, 'arrhythmia'),
    defib: seedState(seed, 'defib'),
    procedure: seedState(seed, 'procedure'),
    labs: seedState(seed, 'labs'),
    monitor: seedState(seed, 'monitor'),
    behaviour: seedState(seed, 'behaviour'),
  };
}

export function fillHandoff(template: string, s: EngineState): string {
  const p = s.patient;
  const pronoun = p.sex === 'male' ? 'he' : 'she';
  const ageApprox = s.scenario.patient.unknownIdentity ? `approximately ${Math.round(p.ageYears / 5) * 5}` : String(p.ageYears);
  return template
    .replaceAll('{age}', ageApprox)
    .replaceAll('{sex}', p.sex)
    .replaceAll('{name}', p.name)
    .replaceAll('{pronoun}', pronoun)
    .replaceAll('{Pronoun}', pronoun[0]!.toUpperCase() + pronoun.slice(1));
}

export class SimulationEngine implements PhysiologyEngine {
  readonly engineId = 'vitalis-ts';
  s: EngineState;
  private rngs: StepRngs;
  private emitted = 0;

  private constructor(state: EngineState) {
    this.s = state;
    this.rngs = this.bindRngs();
  }

  get time(): number {
    return this.s.t;
  }

  static create(opts: CreateOptions): SimulationEngine {
    const check = validateScenario(opts.scenario);
    if (!check.ok || !check.scenario) throw new Error(`Invalid scenario: ${check.errors.join('; ')}`);
    const scenario = check.scenario;
    const patient = generatePatient(opts.seed, {
      ageRange: scenario.patient.ageRange,
      sex: scenario.patient.sex,
      bmiRange: scenario.patient.bmiRange,
      fitnessRange: scenario.patient.fitnessRange,
      requiredHistory: scenario.patient.requiredHistory,
      forbiddenHistory: scenario.patient.forbiddenHistory,
      allergies: scenario.patient.allergies,
      social: scenario.patient.social,
      unknownIdentity: scenario.patient.unknownIdentity,
    });
    const calib = calibrate(patient, scenario.presentation.ambientC);
    // Endogenous-tone baselines at resting sympathetic outflow
    for (const tone of endogenousTones(calib.s0)) {
      const e = endogenousActivation(tone.u, tone.gamma);
      if (tone.channel === 'alpha1') calib.eAlpha1_0 = e;
      if (tone.channel === 'beta1') calib.eBeta1_0 = e;
      if (tone.channel === 'beta2') calib.eBeta2_0 = e;
    }
    const preroll = Math.min(1440, Math.max(0, ...scenario.pathologies.map((p) => p.onsetMinutesBeforeArrival))) * 60;
    const state: EngineState = {
      version: 1,
      engineId: 'vitalis-ts',
      seed: opts.seed,
      scenario,
      patient,
      calib,
      tick: 0,
      t: -preroll,
      dt: SIM_DT,
      phys: createInitialPhysiology(patient, calib),
      therapy: createTherapy(),
      pharm: createPharmState(),
      pathologies: [],
      diagnostics: { orders: [] },
      events: [],
      eventSeq: 0,
      history: [],
      status: { phase: 'active', alive: true, deathTime: null, deathCause: null, rosc: false, endedAt: null, endReason: null },
      rng: makeRngStreams(opts.seed),
      detectors: { ambientC: scenario.presentation.ambientC },
      prerollSeconds: preroll,
      pendingActions: [],
      actionLog: [],
      counter: 0,
    };
    const engine = new SimulationEngine(state);
    engine.initPathologies();
    engine.runPreroll(opts.onPrerollStep);
    engine.initDuePathologies();
    engine.applyPrehospital();
    return engine;
  }

  static restore(json: string): SimulationEngine {
    const state = JSON.parse(json, (_k, v) => (v === '__Infinity__' ? Infinity : v)) as EngineState;
    if (state.version !== 1) throw new Error('Unsupported save version');
    return new SimulationEngine(state);
  }

  /** Re-simulate from the seed + scenario + action log (deterministic replay). */
  static replay(seed: string, scenario: ScenarioDefinition, actionLog: { tick: number; action: SimAction }[], untilTick?: number): SimulationEngine {
    const engine = SimulationEngine.create({ seed, scenario });
    const sorted = [...actionLog].sort((a, b) => a.tick - b.tick);
    const end = untilTick ?? (sorted.length ? sorted[sorted.length - 1]!.tick + 1 : 0);
    let i = 0;
    while (engine.s.tick < end) {
      while (i < sorted.length && sorted[i]!.tick === engine.s.tick) {
        engine.s.pendingActions.push(sorted[i]!.action);
        i++;
      }
      engine.step();
    }
    return engine;
  }

  private bindRngs(): StepRngs {
    const r = this.s.rng;
    return {
      arrhythmia: new Rng(r.arrhythmia),
      defib: new Rng(r.defib),
      procedure: new Rng(r.procedure),
      labs: new Rng(r.labs),
      monitor: new Rng(r.monitor),
      behaviour: new Rng(r.behaviour),
    };
  }

  private pkContext(): PkContext {
    return buildPkContext(this.s);
  }

  private initPathologies(): void {
    const s = this.s;
    for (const [i, p] of s.scenario.pathologies.entries()) {
      const onset = -Math.min(s.prerollSeconds, p.onsetMinutesBeforeArrival * 60);
      const startsAt = p.startsAfterMinutes > 0 ? p.startsAfterMinutes * 60 : onset;
      s.pathologies.push({
        id: `p${i}`,
        type: p.type,
        params: p.params as Record<string, unknown>,
        state: { startsAt },
        addedAt: startsAt,
        label: PATHOLOGY_MODULES[p.type].label,
        resolved: false,
      });
    }
  }

  /** Simulate the pre-arrival period so the patient arrives in a physiologically consistent state. */
  private runPreroll(hook?: (s: EngineState) => void): void {
    const s = this.s;
    if (s.prerollSeconds <= 0) return;
    const saveDt = s.dt;
    s.dt = s.prerollSeconds > 7200 ? 2 : s.prerollSeconds > 1800 ? 1 : 0.25;
    while (s.t < -1e-9) {
      const remaining = -s.t;
      if (remaining < s.dt) s.dt = remaining;
      this.stepInternal(true);
      hook?.(s);
    }
    s.dt = saveDt;
    s.t = 0;
    s.tick = 0;
    // Pre-arrival events are part of the hidden story, not the student timeline
    s.events = [];
    s.eventSeq = 0;
    s.history = [];
    s.pharm.history = [];
    s.phys.fluids.totalIn = 0;
    s.phys.fluids.totalOut = 0;
    s.phys.fluids.netBalance = 0;
    s.phys.renal.urineTotal = 0;
    s.detectors['ambientC'] = s.scenario.presentation.ambientC;
  }

  /** Initialise processes that begin exactly at arrival so the first snapshot already reflects them. */
  private initDuePathologies(): void {
    const s = this.s;
    for (const inst of s.pathologies) {
      if (inst.state['started'] || Number(inst.state['startsAt']) > 0) continue;
      const mod = PATHOLOGY_MODULES[inst.type as keyof typeof PATHOLOGY_MODULES] as unknown as { init?: (i: typeof inst, p: unknown, c: unknown) => void };
      inst.state['started'] = true;
      mod.init?.(inst, inst.params, { s, pkContext: this.pkContext() });
    }
  }

  private applyPrehospital(): void {
    const s = this.s;
    const pre = s.scenario.presentation.prehospital;
    if (pre.oxygen !== 'none') s.therapy.oxygen = { device: pre.oxygen, flowLpm: pre.oxygenFlow, fio2Set: 0.21 };
    if (pre.ivAccess) s.therapy.access.leftArm = true;
    if (pre.tourniquet) s.therapy.procedures.tourniquet = pre.tourniquet;
    if (pre.bvm) s.therapy.bvm = { active: true, rate: 10, vt: 500 };
    if (pre.cprInProgress) {
      s.therapy.cpr.active = true;
      s.therapy.cpr.mode = 'mechanical';
      s.therapy.cpr.startedAt = 0;
      s.therapy.defib.padsOn = true;
      s.therapy.monitoring.ecg = true;
    } else if (!s.phys.cv.pulsePresent && s.therapy.cpr.active) {
      s.therapy.cpr.active = false;
    }
    this.emit({ kind: 'system', code: 'case.arrival', message: `Patient arrives in resuscitation bay (${s.scenario.presentation.arrivalMode})`, severity: 'info' });
    this.recordHistory();
  }

  meta(): CaseMeta {
    const s = this.s;
    return {
      patient: s.patient,
      scenarioId: s.scenario.id,
      scenarioTitle: s.scenario.title,
      tagline: s.scenario.tagline,
      handoff: fillHandoff(s.scenario.presentation.handoff, s),
      chiefComplaint: s.scenario.presentation.chiefComplaint,
      seed: s.seed,
      prerollSeconds: s.prerollSeconds,
      scenario: s.scenario,
    };
  }

  dispatch(action: SimAction): { ok: boolean; error?: string } {
    const parsed = SimActionSchema.safeParse(action);
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
    if (this.s.status.phase === 'ended' && parsed.data.type !== 'note') return { ok: false, error: 'Case has ended' };
    this.s.pendingActions.push(parsed.data);
    return { ok: true };
  }

  private emit(e: Omit<SimulationEvent, 'id' | 't'> & { t?: number }): void {
    const s = this.s;
    const ev: SimulationEvent = { id: ++s.eventSeq, t: e.t ?? s.t, kind: e.kind, code: e.code, message: e.message, severity: e.severity, data: e.data };
    s.events.push(ev);
  }

  private makeContext(preroll: boolean): StepContext {
    const s = this.s;
    return {
      s,
      dt: s.dt,
      t: s.t,
      phys: s.phys,
      patient: s.patient,
      calib: s.calib,
      therapy: s.therapy,
      pharm: s.pharm,
      ch: s.pharm.channels,
      chU: s.pharm.channelU,
      mods: createModifiers(),
      rng: this.rngs,
      preroll,
      emit: (e) => this.emit(e),
    };
  }

  step(): void {
    this.stepInternal(false);
  }

  advance(seconds: number): void {
    const n = Math.max(0, Math.round(seconds / this.s.dt));
    for (let i = 0; i < n; i++) this.step();
  }

  private stepInternal(preroll: boolean): void {
    const s = this.s;
    if (s.status.phase === 'ended' && !preroll) return;
    const ctx = this.makeContext(preroll);

    // 1. clinician actions queued for this tick
    if (!preroll && s.pendingActions.length) {
      const actions = s.pendingActions.splice(0);
      for (const a of actions) {
        s.actionLog.push({ tick: s.tick, action: a });
        applyAction(ctx, a, this.pkContext());
      }
    }
    stepPendingTasks(ctx);
    updateCprQuality(ctx);

    // 2. pharmacology
    const direct = stepPharm(s.pharm, s.dt, this.pkContext(), infusionDrugRates(ctx), s.t);
    const adrenal = adrenalOutput(s.phys.chem.glucose, s.phys.neuro.sympathetic, s.phys.neuro.pain);
    s.detectors['adrenal'] = adrenal;
    const ch = computeChannels(s.pharm, s.patient.weightKg, endogenousTones(s.phys.neuro.sympathetic, adrenal), s.patient.baseline.opioidTolerance);
    ctx.ch = ch;
    ctx.chU = s.pharm.channelU;
    applyDirectInputs(ctx, direct);

    // 3. pathology → modifiers
    resetModifiers(ctx.mods);
    stepPathologies(ctx);
    s.detectors['painSite'] = ctx.mods.nociception > 1 ? ctx.mods.nociceptionSite : '';

    // 4. physiology
    const fluid = stepFluids(ctx);
    stepAutonomic(ctx);
    stepRespiratoryMechanics(ctx);
    stepCardiovascular(ctx);
    stepGasExchange(ctx);
    stepMetabolic(ctx);
    stepThermo(ctx, fluid.infusionHeatLossW);
    stepNeuro(ctx);
    stepRhythm(ctx);

    // 5. diagnostics, events, outcome
    if (!preroll) {
      stepDiagnostics(ctx);
      detectEvents(ctx);
    }
    this.checkOutcome(ctx);

    s.tick++;
    s.t = +(s.t + s.dt).toFixed(6);
    if (!preroll) {
      if (Math.floor(s.t / HISTORY_INTERVAL) !== Math.floor((s.t - s.dt) / HISTORY_INTERVAL)) this.recordHistory();
      if (Math.floor(s.t / DRUG_HISTORY_INTERVAL) !== Math.floor((s.t - s.dt) / DRUG_HISTORY_INTERVAL)) sampleHistory(s.pharm, s.t, s.patient.weightKg);
    }
  }

  private checkOutcome(ctx: StepContext): void {
    const s = this.s;
    if (!s.status.alive) return;
    const { neuro, cv } = s.phys;
    if (neuro.brainInjury >= 0.999 || (!cv.pulsePresent && cv.arrestTime > 45 * 60)) {
      s.status.alive = false;
      s.status.deathTime = s.t;
      s.status.deathCause = !cv.pulsePresent ? 'Circulatory arrest with irreversible hypoxic–ischaemic brain injury' : 'Irreversible hypoxic–ischaemic brain injury';
      if (!ctx.preroll) ctx.emit({ kind: 'outcome', code: 'outcome.death', message: 'The patient has died (irreversible hypoxic brain injury in the simulation)', severity: 'critical' });
    }
  }

  private recordHistory(): void {
    const s = this.s;
    const p = s.phys;
    const sample: HistorySample = {
      t: s.t,
      hr: +p.cv.hr.toFixed(1),
      sbp: +p.cv.sbp.toFixed(1),
      dbp: +p.cv.dbp.toFixed(1),
      map: +p.cv.map.toFixed(1),
      spo2: +(p.resp.sao2 * 100).toFixed(1),
      sao2: +p.resp.sao2.toFixed(3),
      rr: +p.resp.rr.toFixed(1),
      etco2: +p.resp.etco2.toFixed(1),
      temp: +p.thermo.core.toFixed(2),
      co: +p.cv.co.toFixed(2),
      gcs: p.neuro.gcs,
      glucose: +p.chem.glucose.toFixed(1),
      lactate: +p.chem.lactate.toFixed(2),
      ph: +p.chem.ph.toFixed(3),
      paco2: +p.resp.paco2.toFixed(1),
      pao2: +p.resp.pao2.toFixed(1),
      k: +p.chem.k.toFixed(2),
      hb: +p.blood.hb.toFixed(1),
      bv: Math.round(p.blood.volume),
      pain: +p.neuro.pain.toFixed(1),
      rhythm: p.cv.rhythm,
      urine: Math.round(p.renal.urineTotal),
    };
    s.history.push(sample);
    if (s.history.length > 6000) s.history.splice(0, s.history.length - 6000);
  }

  snapshot(): SimSnapshot {
    const s = this.s;
    const newEvents = s.events.slice(this.emitted);
    this.emitted = s.events.length;
    const drugs = Object.values(s.pharm.drugs)
      .filter((d) => DRUG_MAP[d.id]?.pk)
      .map((d) => {
        const def = DRUG_MAP[d.id]!;
        return { id: d.id, name: def.name, cp: plasmaConcentration(d, s.patient.weightKg), ce: d.ce, unit: concentrationUnit(def), totalGiven: formatAmount(def, d.totalGiven), lastGivenAt: d.lastGivenAt };
      });
    const ctx = this.makeContext(false);
    return {
      engineId: this.engineId,
      t: s.t,
      tick: s.tick,
      status: { ...s.status },
      phys: structuredCloneSafe(s.phys),
      therapy: structuredCloneSafe(s.therapy),
      channels: { ...s.pharm.channels },
      drugs,
      orders: s.diagnostics.orders.map((o) => ({ ...o, items: o.status === 'resulted' ? o.items : [] })),
      events: newEvents,
      eventCount: s.events.length,
      appearance: deriveAppearance(ctx),
      derived: deriveClinical(ctx),
    };
  }

  /** Reset the incremental event cursor (e.g. after the UI reconnects). */
  resetEventCursor(): void {
    this.emitted = 0;
  }

  serialize(): string {
    return JSON.stringify(this.s, (_k, v) => (v === Infinity ? '__Infinity__' : v));
  }

  stateHash(): string {
    return stableHash({ phys: this.s.phys, pharm: this.s.pharm.drugs, t: this.s.t, rng: this.s.rng });
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (x === Infinity ? 1e12 : x instanceof Set ? [...x] : x))) as T;
}
