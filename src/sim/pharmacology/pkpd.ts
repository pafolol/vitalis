import { clamp } from '../core/math';
import { DRUG_MAP, getDrug } from './drugs';
import type { DirectSubstance, DrugDef, DrugInstance, EffectChannel, PharmState, PkContext, Route } from './types';

export const ALL_CHANNELS: EffectChannel[] = [
  'alpha1', 'beta1', 'beta2', 'v1', 'mu', 'gaba', 'nmda', 'muscarinicBlock', 'nmBlock', 'h1Block', 'steroid', 'nitrate',
  'antiplatelet', 'anticoagulant', 'fibrinolytic', 'antifibrinolytic', 'amiodarone', 'adenosine', 'ccb', 'propofolCV',
  'antipyretic', 'diuretic', 'glucagon', 'antiemetic', 'beta2Airway', 'muscarinicAirway',
];

export function emptyChannels(): Record<EffectChannel, number> {
  return Object.fromEntries(ALL_CHANNELS.map((c) => [c, 0])) as Record<EffectChannel, number>;
}

export function createPharmState(): PharmState {
  return { drugs: {}, doses: [], channels: emptyChannels(), channelU: emptyChannels(), history: [] };
}

function instanceFor(state: PharmState, drugId: string, t: number): DrugInstance {
  let inst = state.drugs[drugId];
  if (!inst) {
    inst = { id: drugId, a1: 0, a2: 0, depots: [], lung: 0, ce: 0, totalGiven: 0, firstGivenAt: t, lastGivenAt: t, latched: 0 };
    state.drugs[drugId] = inst;
  }
  return inst;
}

/** Direct chemistry inputs produced during a step (mmol, water mL, CO2 mL). */
export interface DirectInputs {
  glucose: number;
  k: number;
  ca: number;
  hco3: number;
  mg: number;
  na: number;
  cl: number;
  waterMl: number;
  co2Ml: number;
}

export function emptyDirect(): DirectInputs {
  return { glucose: 0, k: 0, ca: 0, hco3: 0, mg: 0, na: 0, cl: 0, waterMl: 0, co2Ml: 0 };
}

function addDirect(out: DirectInputs, drug: DrugDef, mmol: number): void {
  const d = drug.direct;
  if (!d) return;
  out[d.substance as DirectSubstance] += mmol;
  if (d.companion) out[d.companion.substance] += mmol * d.companion.ratio;
  if (d.waterPerMmol) out.waterMl += mmol * d.waterPerMmol;
  if (d.co2PerMmol) out.co2Ml += mmol * d.co2PerMmol;
}

export interface BolusResult {
  ok: boolean;
  reason?: string;
  direct: DirectInputs;
}

/**
 * Administer a bolus. `amount` is in the drug's amount unit.
 * IV/IO enter the central compartment; other routes enter an absorption depot
 * with the route's bioavailability.
 */
export function administerBolus(state: PharmState, drugId: string, amount: number, route: Route, t: number, ctx: PkContext): BolusResult {
  const drug = getDrug(drugId);
  const routeDef = drug.routes.find((r) => r.route === route);
  const direct = emptyDirect();
  if (!routeDef) return { ok: false, reason: `${drug.name} cannot be given ${route} in this simulator`, direct };
  const inst = instanceFor(state, drugId, t);
  inst.totalGiven += amount;
  inst.lastGivenAt = t;
  const isInstant = route === 'IV' || route === 'IO';

  if (drug.direct && !drug.pk) {
    // Electrolytes / glucose: IV goes straight into ECF chemistry; oral via depot
    if (isInstant) {
      addDirect(direct, drug, amount * routeDef.F);
    } else {
      inst.depots.push({ amount: amount * routeDef.F, ka: routeDef.ka ?? 0.05, perfusionDependent: !!routeDef.perfusionDependent, toLung: false });
    }
    return { ok: true, direct };
  }

  if (route === 'NEB') {
    const deposition = (routeDef.lungDeposition ?? 0.1) * clamp(ctx.airflowFactor, 0.05, 1.2);
    inst.depots.push({ amount: amount * deposition, ka: 0.15, perfusionDependent: false, toLung: true });
    const swallowed = Math.max(0, routeDef.F - deposition) * amount;
    if (swallowed > 0) inst.depots.push({ amount: swallowed, ka: 0.02, perfusionDependent: false, toLung: false });
    return { ok: true, direct };
  }

  if (isInstant) {
    inst.a1 += amount * routeDef.F;
  } else {
    inst.depots.push({ amount: amount * routeDef.F, ka: routeDef.ka ?? 0.05, perfusionDependent: !!routeDef.perfusionDependent, toLung: false });
  }
  return { ok: true, direct };
}

function clearanceFor(drug: DrugDef, ctx: PkContext): number {
  const pk = drug.pk!;
  const w = ctx.weightKg;
  const ageFactor = 1 - 0.006 * Math.max(0, ctx.ageYears - 40);
  const tempFactor = Math.pow(0.93, Math.max(0, 37 - ctx.temperatureC));
  const hepatic = pk.hepaticFraction * ctx.hepaticFunction * (pk.flowLimited ? ctx.hepaticFlowFactor : Math.min(1, 0.5 + 0.5 * ctx.hepaticFlowFactor)) * tempFactor;
  const renal = pk.renalFraction * ctx.renalFactor;
  const other = Math.max(0, 1 - pk.renalFraction - pk.hepaticFraction);
  return pk.cl * w * Math.max(0.05, hepatic + renal + other) * ageFactor;
}

/**
 * Advance all drug compartments by dt seconds. `infusionRates` gives amount
 * per minute per drug (amountUnit/min) currently entering the central
 * compartment (or chemistry for direct drugs).
 */
export function stepPharm(state: PharmState, dtSec: number, ctx: PkContext, infusionRates: Record<string, number>, t: number): DirectInputs {
  const dt = dtSec / 60; // minutes
  const direct = emptyDirect();

  for (const [drugId, rate] of Object.entries(infusionRates)) {
    if (rate <= 0) continue;
    const drug = DRUG_MAP[drugId];
    if (!drug) continue;
    const inst = instanceFor(state, drugId, t);
    const amt = rate * dt;
    inst.totalGiven += amt;
    inst.lastGivenAt = t;
    if (drug.direct && !drug.pk) addDirect(direct, drug, amt);
    else inst.a1 += amt;
  }

  for (const inst of Object.values(state.drugs)) {
    const drug = DRUG_MAP[inst.id]!;
    // absorption
    for (const depot of inst.depots) {
      if (depot.amount <= 1e-9) continue;
      const ka = depot.ka * (depot.perfusionDependent ? clamp(ctx.peripheralPerfusion, 0.05, 1.2) : 1);
      const absorbed = depot.amount * (1 - Math.exp(-ka * dt));
      depot.amount -= absorbed;
      if (depot.toLung) inst.lung += absorbed;
      else if (drug.direct && !drug.pk) addDirect(direct, drug, absorbed);
      else inst.a1 += absorbed;
    }
    inst.depots = inst.depots.filter((d) => d.amount > 1e-6);

    // lung (local airway) compartment absorbs systemically
    if (inst.lung > 0) {
      const routeDef = drug.routes.find((r) => r.route === 'NEB');
      const kLung = routeDef?.ka ?? 0.08;
      const out = inst.lung * (1 - Math.exp(-kLung * dt));
      inst.lung -= out;
      inst.a1 += out;
    }

    if (!drug.pk) continue;
    const pk = drug.pk;
    const v1 = pk.v1 * ctx.weightKg;
    const v2 = pk.v2 * ctx.weightKg;
    const cl = clearanceFor(drug, ctx);
    const q = pk.q * ctx.weightKg;
    // sub-step for very fast drugs (adenosine) to keep explicit integration stable
    const kMax = cl / v1 + (v2 > 0 ? q / v1 : 0);
    const n = Math.max(1, Math.ceil((kMax * dt) / 0.2));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const c1 = inst.a1 / v1;
      const c2 = v2 > 0 ? inst.a2 / v2 : 0;
      const elim = cl * c1 * h;
      const dist = v2 > 0 ? q * (c1 - c2) * h : 0;
      inst.a1 = Math.max(0, inst.a1 - elim - dist);
      if (v2 > 0) inst.a2 = Math.max(0, inst.a2 + dist);
      const cp = inst.a1 / v1;
      inst.ce += (cp - inst.ce) * (1 - Math.exp(-pk.ke0 * h));
    }
  }

  // periodic cleanup: drop drugs that are fully gone
  for (const [id, inst] of Object.entries(state.drugs)) {
    const drug = DRUG_MAP[id]!;
    const v1 = (drug.pk?.v1 ?? 1) * ctx.weightKg;
    const tiny = inst.a1 / v1 < 1e-6 && inst.a2 < 1e-6 && inst.ce < 1e-6 && inst.lung < 1e-6 && inst.depots.length === 0 && inst.latched === 0;
    if (tiny && t - inst.lastGivenAt > 600 && !(id in infusionRates && infusionRates[id]! > 0)) delete state.drugs[id];
  }
  return direct;
}

export function plasmaConcentration(inst: DrugInstance, weightKg: number): number {
  const drug = DRUG_MAP[inst.id];
  if (!drug?.pk) return 0;
  return inst.a1 / (drug.pk.v1 * weightKg);
}

export interface EndogenousTone {
  channel: EffectChannel;
  /** Potency-normalised concentration (U = C/EC50) */
  u: number;
  emax: number;
  gamma: number;
}

/**
 * Combine all drugs (plus endogenous agonist tone) into channel activations.
 *
 * For each channel: agonists are summed in potency-normalised units
 * U = Σ Ce_i / EC50_i (Minto-type additive interaction), divided by
 * (1 + Σ Ce_j / Ki_j) for competitive antagonists. Activation =
 * Emax_mix · U^γ / (1 + U^γ), with Emax and γ weighted by each agonist's share.
 */
export function computeChannels(state: PharmState, weightKg: number, endogenous: EndogenousTone[], opioidTolerance: number): Record<EffectChannel, number> {
  const acc = new Map<EffectChannel, { u: number; emaxW: number; gammaW: number; antag: number }>();
  const get = (c: EffectChannel) => {
    let v = acc.get(c);
    if (!v) {
      v = { u: 0, emaxW: 0, gammaW: 0, antag: 0 };
      acc.set(c, v);
    }
    return v;
  };

  for (const e of endogenous) {
    const a = get(e.channel);
    a.u += e.u;
    a.emaxW += e.u * e.emax;
    a.gammaW += e.u * e.gamma;
  }

  for (const inst of Object.values(state.drugs)) {
    const drug = DRUG_MAP[inst.id];
    if (!drug) continue;
    for (const eff of drug.effects) {
      const a = get(eff.channel);
      const conc = eff.local ? inst.lung : inst.ce;
      if (eff.antagonistKi !== undefined) {
        a.antag += conc / eff.antagonistKi;
        continue;
      }
      const ec50 = eff.channel === 'mu' ? eff.ec50 * opioidTolerance : eff.ec50;
      const u = conc / ec50;
      if (u <= 0) continue;
      a.u += u;
      a.emaxW += u * eff.emax;
      a.gammaW += u * eff.gamma;
    }
    // irreversible antiplatelet latch
    if (drug.id === 'aspirin') {
      const eff = drug.effects[0]!;
      const e = eff.emax * hillU(inst.ce / eff.ec50, eff.gamma);
      inst.latched = Math.max(inst.latched, e);
    }
  }

  const channels = emptyChannels();
  const channelU = emptyChannels();
  for (const [c, a] of acc) {
    if (a.u <= 0) continue;
    const u = a.u / (1 + a.antag);
    channelU[c] = u;
    const emax = a.emaxW / a.u;
    const gamma = a.gammaW / a.u;
    channels[c] = clamp(emax * hillU(u, gamma), 0, 1);
  }
  const aspirin = state.drugs['aspirin'];
  if (aspirin) channels.antiplatelet = Math.max(channels.antiplatelet, aspirin.latched);
  state.channels = channels;
  state.channelU = channelU;
  void weightKg;
  return channels;
}

function hillU(u: number, gamma: number): number {
  if (u <= 0) return 0;
  const r = Math.pow(u, gamma);
  return r / (1 + r);
}

/** Receptor occupancy-style fraction for a single agonist channel ignoring others (for display). */
export function antagonistFactor(state: PharmState, channel: EffectChannel): number {
  let antag = 0;
  for (const inst of Object.values(state.drugs)) {
    const drug = DRUG_MAP[inst.id];
    if (!drug) continue;
    for (const eff of drug.effects) if (eff.channel === channel && eff.antagonistKi !== undefined) antag += inst.ce / eff.antagonistKi;
  }
  return 1 / (1 + antag);
}

export function sampleHistory(state: PharmState, t: number, weightKg: number): void {
  const cp: Record<string, number> = {};
  const ce: Record<string, number> = {};
  let any = false;
  for (const inst of Object.values(state.drugs)) {
    const drug = DRUG_MAP[inst.id];
    if (!drug?.pk) continue;
    cp[inst.id] = inst.a1 / (drug.pk.v1 * weightKg);
    ce[inst.id] = inst.ce;
    any = true;
  }
  if (!any && state.history.length === 0) return;
  state.history.push({ t, cp, ce });
  if (state.history.length > 2500) state.history.splice(0, state.history.length - 2500);
}

/** Convert a UI dose (value + unit) to the drug's amount unit. */
export function doseToAmount(drug: DrugDef, value: number, unit: string, weightKg: number): number {
  if (unit.endsWith('/kg')) {
    const base = unit.slice(0, -3);
    const du = drug.doseUnits.find((u) => u.unit === base);
    if (!du) throw new Error(`Unsupported unit ${unit} for ${drug.id}`);
    return value * du.toAmount * weightKg;
  }
  const du = drug.doseUnits.find((u) => u.unit === unit);
  if (!du) throw new Error(`Unsupported unit ${unit} for ${drug.id}`);
  return value * du.toAmount;
}

/** Convert an infusion rate to amountUnit/min. */
export function rateToAmountPerMin(drug: DrugDef, rate: number, unit: string, weightKg: number): number {
  const ru = drug.infusion?.units.find((u) => u.unit === unit);
  if (!ru) throw new Error(`Unsupported rate unit ${unit} for ${drug.id}`);
  return rate * ru.toAmountPerMin * (ru.perKg ? weightKg : 1);
}

export function formatAmount(drug: DrugDef, amount: number): string {
  switch (drug.amountUnit) {
    case 'mcg':
      if (amount >= 1_000_000) return `${+(amount / 1_000_000).toFixed(2)} g`;
      if (amount >= 1000) return `${+(amount / 1000).toFixed(2)} mg`;
      return `${+amount.toFixed(1)} mcg`;
    case 'mU':
      return `${+(amount / 1000).toFixed(1)} units`;
    case 'U':
      return `${+amount.toFixed(amount < 10 ? 2 : 0)} units`;
    case 'mmol':
      return `${+amount.toFixed(1)} mmol`;
  }
}

/** Concentration unit label for charts. */
export function concentrationUnit(drug: DrugDef): string {
  switch (drug.amountUnit) {
    case 'mcg':
      return 'ng/mL';
    case 'mU':
      return 'mU/L';
    case 'U':
      return 'U/L';
    case 'mmol':
      return 'mmol/L';
  }
}
