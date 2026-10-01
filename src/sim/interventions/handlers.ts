import { approach, clamp, smoothstep } from '../core/math';
import type { StepContext } from '../engine/state';
import { DRUG_MAP, FLUID_MAP, getDrug } from '../pharmacology/drugs';
import { administerBolus, doseToAmount, formatAmount, rateToAmountPerMin } from '../pharmacology/pkpd';
import type { PkContext, Route } from '../pharmacology/types';
import { applyDirectInputs } from '../physiology/metabolic';
import { deliverShock, setRhythm, terminatePathologicRhythm } from '../physiology/rhythm';
import { createOrder } from '../diagnostics/orders';
import type { SimAction } from './actions';
import type { AccessSite, Infusion, OxygenDevice } from '../types';

const DEVICE_LABEL: Record<OxygenDevice, string> = {
  none: 'no supplemental oxygen',
  nasalCannula: 'nasal cannula',
  simpleMask: 'simple face mask',
  nonRebreather: 'non-rebreather mask',
  highFlowNasal: 'high-flow nasal oxygen',
  bvm: 'bag-valve-mask',
  ventilator: 'ventilator',
};

function info(ctx: StepContext, code: string, message: string, severity: 'info' | 'notice' | 'warning' | 'critical' | 'good' = 'info', data?: Record<string, unknown>) {
  ctx.emit({ kind: 'action', code, message, severity, data });
}

function procedurePain(ctx: StepContext, amount: number): void {
  if (ctx.phys.neuro.consciousness > 0.4) ctx.s.detectors['procPain'] = Math.max(Number(ctx.s.detectors['procPain'] ?? 0), amount);
}

function nextId(ctx: StepContext, prefix: string): string {
  ctx.s.counter += 1;
  return `${prefix}${ctx.s.counter}`;
}

function accessSite(ctx: StepContext): AccessSite | null {
  const a = ctx.therapy.access;
  if (a.leftArm) return 'leftArm';
  if (a.rightArm) return 'rightArm';
  if (a.io) return 'io';
  return null;
}

export function applyAction(ctx: StepContext, action: SimAction, pk: PkContext): void {
  const { therapy, phys, t, rng, patient } = ctx;
  switch (action.type) {
    case 'monitor.attach': {
      for (const d of action.devices) therapy.monitoring[d] = true;
      if (action.devices.includes('nibp')) therapy.nibpNextAt = t;
      info(ctx, 'monitor.attach', `Monitoring attached: ${action.devices.map((d) => d.toUpperCase()).join(', ')}`);
      break;
    }
    case 'monitor.detach': {
      for (const d of action.devices) therapy.monitoring[d] = false;
      info(ctx, 'monitor.detach', `Monitoring removed: ${action.devices.join(', ')}`);
      break;
    }
    case 'nibp.measure': {
      if (!therapy.monitoring.nibp) {
        therapy.monitoring.nibp = true;
      }
      therapy.nibpNextAt = t;
      info(ctx, 'nibp.measure', 'Manual NIBP cycle started');
      break;
    }
    case 'nibp.interval': {
      therapy.nibpIntervalMin = action.minutes;
      info(ctx, 'nibp.interval', action.minutes > 0 ? `NIBP auto-cycle every ${action.minutes} min` : 'NIBP auto-cycle off');
      break;
    }
    case 'oxygen.set': {
      therapy.oxygen = { device: action.device, flowLpm: action.device === 'none' ? 0 : action.flowLpm, fio2Set: action.fio2 ?? therapy.oxygen.fio2Set };
      info(ctx, 'oxygen.set', action.device === 'none' ? 'Supplemental oxygen removed' : `Oxygen: ${DEVICE_LABEL[action.device]} at ${action.flowLpm} L/min${action.device === 'highFlowNasal' ? `, FiO2 ${Math.round((action.fio2 ?? 0.6) * 100)}%` : ''}`);
      break;
    }
    case 'airway.manoeuvre': {
      therapy.airway.manoeuvre = action.manoeuvre;
      info(ctx, 'airway.manoeuvre', action.manoeuvre === 'none' ? 'Airway manoeuvre released' : action.manoeuvre === 'jawThrust' ? 'Jaw thrust applied' : 'Head-tilt / chin-lift applied');
      break;
    }
    case 'airway.adjunct': {
      therapy.airway.adjunct = action.adjunct;
      if (action.adjunct === 'opa' && phys.neuro.airwayReflexes && phys.neuro.consciousness > 0.4) procedurePain(ctx, 3);
      info(ctx, 'airway.adjunct', action.adjunct === 'none' ? 'Airway adjunct removed' : `${action.adjunct === 'opa' ? 'Oropharyngeal' : 'Nasopharyngeal'} airway inserted`);
      break;
    }
    case 'airway.suction': {
      const had = phys.resp.vomitInAirway;
      phys.resp.vomitInAirway = false;
      therapy.airway.suctionedAt = t;
      if (phys.neuro.airwayReflexes && phys.neuro.consciousness > 0.5) phys.neuro.nausea = Math.min(1, phys.neuro.nausea + 0.2);
      info(ctx, 'airway.suction', had ? 'Oropharynx suctioned — vomitus cleared' : 'Oropharynx suctioned — small amount of secretions');
      break;
    }
    case 'airway.recoveryPosition': {
      therapy.airway.recoveryPosition = action.on;
      info(ctx, 'airway.recovery', action.on ? 'Patient placed in the recovery position' : 'Patient returned supine');
      break;
    }
    case 'airway.intubate': {
      if (therapy.airway.ett) {
        info(ctx, 'airway.intubate', 'Already intubated', 'notice');
        break;
      }
      const resisting = phys.neuro.consciousness > 0.35 && ctx.ch.nmBlock < 0.5 && phys.neuro.airwayReflexes;
      if (resisting) {
        procedurePain(ctx, 8);
        phys.neuro.nausea = Math.min(1, phys.neuro.nausea + 0.5);
        info(ctx, 'airway.intubateFailed', `Laryngoscopy not possible: patient has intact airway reflexes and jaw tone (GCS ${phys.neuro.gcs}). Consider drug-assisted intubation.`, 'warning');
        break;
      }
      therapy.pending.push({ id: nextId(ctx, 'task'), kind: 'intubation', startedAt: t, completesAt: t + 35, data: { tubeSize: action.tubeSize, bvmWas: therapy.bvm.active } });
      therapy.bvm.active = false;
      ctx.s.detectors['intubating'] = true;
      info(ctx, 'airway.intubating', `Laryngoscopy started (${action.tubeSize} mm tube) — patient apnoeic during the attempt`);
      break;
    }
    case 'airway.extubate': {
      therapy.airway.ett = false;
      therapy.ventilator.on = false;
      info(ctx, 'airway.extubate', 'Endotracheal tube removed');
      break;
    }
    case 'airway.cricothyrotomy': {
      therapy.pending.push({ id: nextId(ctx, 'task'), kind: 'intubation', startedAt: t, completesAt: t + 60, data: { surgical: true } });
      procedurePain(ctx, 9);
      info(ctx, 'airway.cric', 'Surgical cricothyrotomy started', 'notice');
      break;
    }
    case 'bvm.set': {
      therapy.bvm = { active: action.active, rate: action.rate, vt: action.vt };
      info(ctx, 'bvm.set', action.active ? `Bag-valve-mask ventilation at ${action.rate}/min (~${action.vt} mL)` : 'Bag-valve-mask ventilation stopped');
      break;
    }
    case 'ventilator.set': {
      const secured = therapy.airway.ett || !!ctx.s.detectors['surgicalAirway'];
      if (action.on && !secured) {
        info(ctx, 'ventilator.refused', 'Mechanical ventilation requires a secured airway (ETT or surgical airway) in this simulator', 'warning');
        break;
      }
      therapy.ventilator = { on: action.on, mode: 'VC-AC', vt: action.vt, rr: action.rr, peep: action.peep, fio2: action.fio2, ieRatio: action.ieRatio };
      if (action.on) therapy.bvm.active = false;
      info(ctx, 'ventilator.set', action.on ? `Ventilator VC-AC: Vt ${action.vt} mL, RR ${action.rr}, PEEP ${action.peep}, FiO2 ${Math.round(action.fio2 * 100)}%` : 'Ventilator off');
      break;
    }
    case 'access.iv': {
      if (therapy.access[action.site]) {
        info(ctx, 'access.iv', 'IV already in place at that site', 'notice');
        break;
      }
      therapy.pending.push({ id: nextId(ctx, 'task'), kind: 'ivAccess', startedAt: t, completesAt: t + 60, data: { site: action.site } });
      procedurePain(ctx, 2);
      info(ctx, 'access.ivStarted', `Peripheral IV cannulation attempt (${action.site === 'leftArm' ? 'left' : 'right'} antecubital, 18G)`);
      break;
    }
    case 'access.io': {
      therapy.pending.push({ id: nextId(ctx, 'task'), kind: 'ivAccess', startedAt: t, completesAt: t + 25, data: { site: 'io' } });
      procedurePain(ctx, 7);
      info(ctx, 'access.ioStarted', 'Intraosseous access (proximal tibia) being placed');
      break;
    }
    case 'fluid.start': {
      const def = FLUID_MAP[action.fluidId];
      if (!def) {
        info(ctx, 'fluid.error', `Unknown fluid ${action.fluidId}`, 'warning');
        break;
      }
      const site = accessSite(ctx);
      if (!site) {
        info(ctx, 'fluid.noAccess', `Cannot start ${def.label}: no vascular access`, 'warning');
        break;
      }
      const inf: Infusion = {
        id: nextId(ctx, 'inf'),
        kind: def.kind === 'blood' ? 'blood' : 'fluid',
        agentId: def.id,
        label: def.kind === 'blood' ? def.label : `${def.label} ${action.volumeMl} mL`,
        rate: action.rateMlH,
        rateUnit: 'mL/h',
        remainingMl: action.volumeMl,
        totalMl: action.volumeMl,
        infusedMl: 0,
        delivered: 0,
        startedAt: t,
        stoppedAt: null,
        site,
        warmed: action.warmed,
      };
      therapy.infusions.push(inf);
      info(ctx, def.kind === 'blood' ? 'blood.start' : 'fluid.start', `${def.label}: ${action.volumeMl} mL at ${action.rateMlH} mL/h${action.warmed ? ' (warmed)' : ''}`, 'info', { infusionId: inf.id, fluidId: def.id, volume: action.volumeMl, rate: action.rateMlH });
      break;
    }
    case 'infusion.stop': {
      const inf = therapy.infusions.find((i) => i.id === action.infusionId && i.stoppedAt === null);
      if (inf) {
        inf.stoppedAt = t;
        info(ctx, 'infusion.stop', `${inf.label} stopped${inf.kind !== 'drug' ? ` after ${Math.round(inf.infusedMl)} mL` : ''}`);
      }
      break;
    }
    case 'infusion.rate': {
      const inf = therapy.infusions.find((i) => i.id === action.infusionId && i.stoppedAt === null);
      if (inf) {
        inf.rate = action.rate;
        info(ctx, 'infusion.rate', `${inf.label}: rate changed to ${action.rate} ${inf.rateUnit}`);
      }
      break;
    }
    case 'drug.bolus': {
      const drug = DRUG_MAP[action.drugId];
      if (!drug || drug.exposureOnly) {
        info(ctx, 'drug.error', `Unknown drug ${action.drugId}`, 'warning');
        break;
      }
      const route = action.route as Route;
      if ((route === 'IV' && !therapy.access.leftArm && !therapy.access.rightArm) || (route === 'IO' && !therapy.access.io)) {
        const alt = route === 'IV' && therapy.access.io ? ' (IO access is available — choose route IO)' : '';
        info(ctx, 'drug.noAccess', `Cannot give ${drug.name} ${route}: no ${route} access${alt}`, 'warning');
        break;
      }
      let amount: number;
      try {
        amount = doseToAmount(drug, action.dose, action.unit, patient.weightKg);
      } catch (e) {
        info(ctx, 'drug.error', (e as Error).message, 'warning');
        break;
      }
      const routeDef = drug.routes.find((r) => r.route === route);
      if (!routeDef) {
        info(ctx, 'drug.badRoute', `${drug.name} cannot be given ${route} in this simulator`, 'warning');
        break;
      }
      if (routeDef.requiresSwallow && !(phys.neuro.consciousness > 0.75 && phys.neuro.airwayReflexes)) {
        info(ctx, 'drug.unsafeSwallow', `${drug.name} ${route} given to a patient who cannot swallow safely`, 'critical');
        if (!phys.resp.aspirated) {
          phys.resp.aspirated = true;
          ctx.emit({ kind: 'physiology', code: 'resp.aspiration', message: 'Oral administration in an obtunded patient — aspiration', severity: 'critical' });
        }
        break;
      }
      const res = administerBolus(ctx.pharm, drug.id, amount, route, t, pk);
      applyDirectInputs(ctx, res.direct);
      const display = `${action.dose} ${action.unit}`;
      ctx.pharm.doses.push({ t, drugId: drug.id, route, amount, displayDose: display, kind: 'bolus' });
      info(ctx, 'drug.given', `${drug.name} ${display} ${route}`, 'info', { drugId: drug.id, amount, route, display });
      checkAllergy(ctx, drug.id);
      break;
    }
    case 'drug.infusion': {
      const drug = DRUG_MAP[action.drugId];
      if (!drug?.infusion) {
        info(ctx, 'drug.error', `${action.drugId} cannot be infused`, 'warning');
        break;
      }
      const site = accessSite(ctx);
      if (!site) {
        info(ctx, 'drug.noAccess', `Cannot start ${drug.name} infusion: no vascular access`, 'warning');
        break;
      }
      try {
        rateToAmountPerMin(drug, action.rate, action.unit, patient.weightKg);
      } catch (e) {
        info(ctx, 'drug.error', (e as Error).message, 'warning');
        break;
      }
      const existing = therapy.infusions.find((i) => i.kind === 'drug' && i.agentId === drug.id && i.stoppedAt === null);
      if (existing) {
        existing.rate = action.rate;
        existing.rateUnit = action.unit;
        ctx.pharm.doses.push({ t, drugId: drug.id, route: 'IV', amount: 0, displayDose: `${action.rate} ${action.unit}`, kind: 'infusion-change' });
        info(ctx, 'drug.infusionRate', `${drug.name} infusion now ${action.rate} ${action.unit}`);
        break;
      }
      therapy.infusions.push({
        id: nextId(ctx, 'inf'),
        kind: 'drug',
        agentId: drug.id,
        label: `${drug.name} infusion`,
        rate: action.rate,
        rateUnit: action.unit,
        remainingMl: Infinity,
        totalMl: Infinity,
        infusedMl: 0,
        delivered: 0,
        startedAt: t,
        stoppedAt: null,
        site,
        warmed: false,
      });
      ctx.pharm.doses.push({ t, drugId: drug.id, route: 'IV', amount: 0, displayDose: `${action.rate} ${action.unit}`, kind: 'infusion-start' });
      info(ctx, 'drug.infusion', `${drug.name} infusion started at ${action.rate} ${action.unit}`, 'info', { drugId: drug.id });
      checkAllergy(ctx, drug.id);
      break;
    }
    case 'cpr.start': {
      therapy.cpr.active = true;
      therapy.cpr.mode = action.mode;
      therapy.cpr.startedAt = t;
      therapy.cpr.handsOffSince = null;
      therapy.cpr.lastInputAt = t;
      if (phys.cv.pulsePresent) info(ctx, 'cpr.onPulse', 'Chest compressions started on a patient who has a pulse', 'warning');
      else info(ctx, 'cpr.start', `Chest compressions started (${action.mode === 'mechanical' ? 'mechanical device' : 'manual'})`);
      break;
    }
    case 'cpr.stop': {
      therapy.cpr.active = false;
      therapy.cpr.handsOffSince = t;
      therapy.cpr.quality = 0;
      info(ctx, 'cpr.stop', 'Chest compressions paused/stopped');
      break;
    }
    case 'cpr.compressions': {
      const c = therapy.cpr;
      if (!c.active) break;
      c.totalCompressions += action.count;
      if (action.count > 0 && action.meanIntervalMs > 0) {
        c.rate = 60000 / action.meanIntervalMs;
        c.depth = action.depthQuality;
        c.lastInputAt = t;
      }
      break;
    }
    case 'defib.pads': {
      therapy.defib.padsOn = action.on;
      if (action.on) therapy.monitoring.ecg = true;
      info(ctx, 'defib.pads', action.on ? 'Defibrillator pads applied (anterolateral)' : 'Defibrillator pads removed');
      break;
    }
    case 'defib.energy': {
      therapy.defib.energy = action.joules;
      therapy.defib.charged = false;
      break;
    }
    case 'defib.sync': {
      therapy.defib.sync = action.on;
      info(ctx, 'defib.sync', action.on ? 'Synchronised mode ON' : 'Synchronised mode OFF');
      break;
    }
    case 'defib.charge': {
      if (!therapy.defib.padsOn) {
        info(ctx, 'defib.noPads', 'Cannot charge: pads not applied', 'warning');
        break;
      }
      therapy.defib.charged = true;
      info(ctx, 'defib.charge', `Defibrillator charged to ${therapy.defib.energy} J${therapy.defib.sync ? ' (sync)' : ''}`);
      break;
    }
    case 'defib.disarm': {
      therapy.defib.charged = false;
      info(ctx, 'defib.disarm', 'Charge dumped');
      break;
    }
    case 'defib.shock': {
      if (!therapy.defib.padsOn || !therapy.defib.charged) {
        info(ctx, 'defib.notReady', 'Shock not delivered: defibrillator not charged or pads not applied', 'warning');
        break;
      }
      therapy.defib.charged = false;
      therapy.defib.shocks += 1;
      const out = deliverShock(ctx, therapy.defib.energy, therapy.defib.sync);
      ctx.s.detectors['lastShockAt'] = t;
      ctx.emit({ kind: 'action', code: 'defib.shock', message: out.message, severity: out.severity, data: { energy: therapy.defib.energy, sync: therapy.defib.sync, rhythm: phys.cv.rhythm } });
      break;
    }
    case 'pacing.set': {
      therapy.defib.pacing = { on: action.on, rate: action.rate, mA: action.mA };
      if (action.on && !therapy.defib.padsOn) {
        therapy.defib.padsOn = true;
        therapy.monitoring.ecg = true;
      }
      info(ctx, 'pacing.set', action.on ? `Transcutaneous pacing: rate ${action.rate}/min, output ${action.mA} mA` : 'Pacing off');
      break;
    }
    case 'procedure.vagal': {
      therapy.procedures.vagalManoeuvreAt = t;
      if (phys.cv.rhythm === 'svt' && rng.procedure.chance(0.3)) {
        terminatePathologicRhythm(ctx, 'svt');
        setRhythm(ctx, 'sinus', 'vagal manoeuvre');
        info(ctx, 'procedure.vagal', 'Modified Valsalva manoeuvre performed — rhythm converted', 'good');
      } else {
        phys.neuro.parasympathetic = Math.min(1, phys.neuro.parasympathetic + 0.3);
        info(ctx, 'procedure.vagal', 'Modified Valsalva manoeuvre performed — no sustained rhythm change');
      }
      break;
    }
    case 'procedure.needleDecompression': {
      const side = action.side;
      if (therapy.procedures.needleDecompression[side]) {
        info(ctx, 'procedure.needle', `Needle decompression already performed on the ${side}`, 'notice');
        break;
      }
      therapy.procedures.needleDecompression[side] = { at: t, site: action.site };
      procedurePain(ctx, 6);
      const wall = patient.baseline.chestWallCm * (action.site === '5ICS-AAL' ? 0.72 : 1);
      const reaches = wall < 4.6;
      ctx.s.detectors[`needleEffective_${side}`] = reaches;
      const air = side === 'left' ? phys.resp.pleuralAirLeft : phys.resp.pleuralAirRight;
      const siteLabel = action.site === '2ICS-MCL' ? '2nd intercostal space, mid-clavicular line' : '5th intercostal space, anterior axillary line';
      if (!reaches) {
        info(ctx, 'procedure.needle', `Needle decompression (${side}, ${siteLabel}): no rush of air — the 5 cm catheter may not have reached the pleural space`, 'warning');
      } else if (air > 400) {
        info(ctx, 'procedure.needle', `Needle decompression (${side}, ${siteLabel}): audible hiss of air`, 'good');
      } else {
        // Iatrogenic pneumothorax on a side without one
        if (side === 'left') phys.resp.pleuralAirLeft += 350;
        else phys.resp.pleuralAirRight += 350;
        ctx.s.pathologies.push({
          id: nextId(ctx, 'iatro'),
          type: 'tensionPneumothorax',
          params: { side, leakMlMin: 12, initialAirMl: 0, traumatic: false },
          state: { startsAt: t, started: true },
          addedAt: t,
          label: 'Iatrogenic pneumothorax',
          resolved: false,
        });
        info(ctx, 'procedure.needle', `Needle decompression (${side}, ${siteLabel}): no air released`, 'notice');
        ctx.emit({ kind: 'system', code: 'hidden.iatrogenicPtx', message: `Iatrogenic ${side} pneumothorax created by needle decompression`, severity: 'warning', data: { hidden: true } });
      }
      break;
    }
    case 'procedure.chestTube': {
      if (therapy.procedures.chestTube[action.side]) {
        info(ctx, 'procedure.chestTube', `Chest tube already in the ${action.side} hemithorax`, 'notice');
        break;
      }
      therapy.pending.push({ id: nextId(ctx, 'task'), kind: 'chestTube', startedAt: t, completesAt: t + 150, data: { side: action.side } });
      procedurePain(ctx, 8);
      info(ctx, 'procedure.chestTubeStarted', `Tube thoracostomy (${action.side}, 5th ICS mid-axillary) started`);
      break;
    }
    case 'procedure.tourniquet': {
      therapy.procedures.tourniquet = action.limb;
      if (action.limb) procedurePain(ctx, 6);
      info(ctx, 'procedure.tourniquet', action.limb ? `Tourniquet applied — ${limbLabel(action.limb)}` : 'Tourniquet released');
      break;
    }
    case 'procedure.directPressure': {
      therapy.procedures.directPressure = action.on;
      info(ctx, 'procedure.pressure', action.on ? 'Firm direct pressure applied to the wound' : 'Direct pressure released');
      break;
    }
    case 'procedure.pelvicBinder': {
      therapy.procedures.pelvicBinder = action.on;
      info(ctx, 'procedure.binder', action.on ? 'Pelvic binder applied' : 'Pelvic binder removed');
      break;
    }
    case 'procedure.hemostasis': {
      const h = therapy.procedures.hemostasis;
      if (h.requestedAt !== null) break;
      h.requestedAt = t;
      h.completesAt = t + 25 * 60;
      info(ctx, 'procedure.hemostasis', 'Surgical / interventional radiology haemorrhage control requested — team available in ~25 min', 'notice');
      break;
    }
    case 'procedure.reperfusion': {
      const r = therapy.procedures.reperfusion;
      if (r.requestedAt !== null) break;
      r.requestedAt = t;
      r.completesAt = t + 30 * 60;
      r.method = 'pci';
      info(ctx, 'procedure.cathlab', 'Cardiac catheterisation laboratory activated — reperfusion expected in ~30 min', 'notice');
      break;
    }
    case 'procedure.dialysis': {
      const d = therapy.procedures.dialysis;
      if (d.requestedAt !== null) break;
      d.requestedAt = t;
      d.startsAt = t + 30 * 60;
      info(ctx, 'procedure.dialysis', 'Emergency haemodialysis requested — starting in ~30 min', 'notice');
      break;
    }
    case 'procedure.warming': {
      therapy.procedures.warming = action.on;
      info(ctx, 'procedure.warming', action.on ? 'Forced-air warming blanket applied' : 'Warming blanket removed');
      break;
    }
    case 'procedure.expose': {
      therapy.procedures.exposed = action.on;
      info(ctx, 'procedure.expose', action.on ? 'Patient fully exposed for examination' : 'Patient covered with blankets');
      break;
    }
    case 'procedure.legRaise': {
      therapy.procedures.legRaise = action.on;
      info(ctx, 'procedure.legRaise', action.on ? 'Passive leg raise' : 'Legs lowered');
      break;
    }
    case 'procedure.backrest': {
      therapy.procedures.backrestDeg = action.degrees;
      info(ctx, 'procedure.backrest', `Bed backrest set to ${action.degrees}°`);
      break;
    }
    case 'procedure.arterialLine': {
      therapy.pending.push({ id: nextId(ctx, 'task'), kind: 'arterialLine', startedAt: t, completesAt: t + 150, data: {} });
      procedurePain(ctx, 3);
      info(ctx, 'procedure.aline', 'Radial arterial line insertion started');
      break;
    }
    case 'diagnostic.order': {
      const order = createOrder(ctx, action.testId);
      if (order) info(ctx, 'diagnostic.order', `Ordered: ${order.label}`, 'info', { orderId: order.id, testId: action.testId });
      else info(ctx, 'diagnostic.error', `Unknown test ${action.testId}`, 'warning');
      break;
    }
    case 'exam.perform': {
      ctx.emit({ kind: 'exam', code: `exam.${action.exam}`, message: `Examined: ${action.exam}${action.zone ? ` (${action.zone})` : ''}${action.detail ? ` — ${action.detail}` : ''}`, severity: 'info', data: { exam: action.exam, zone: action.zone } });
      break;
    }
    case 'note': {
      ctx.emit({ kind: 'action', code: 'note', message: `Note: ${action.text}`, severity: 'info' });
      break;
    }
    case 'case.end': {
      ctx.s.status.phase = 'ended';
      ctx.s.status.endedAt = t;
      ctx.s.status.endReason = action.reason;
      ctx.emit({ kind: 'outcome', code: 'case.end', message: `Case ended: ${action.reason}${action.diagnosis ? ` — working diagnosis: ${action.diagnosis}` : ''}`, severity: 'info', data: { diagnosis: action.diagnosis } });
      break;
    }
  }
}

function limbLabel(l: string): string {
  return { leftArm: 'left arm', rightArm: 'right arm', leftLeg: 'left thigh', rightLeg: 'right thigh' }[l] ?? l;
}

function checkAllergy(ctx: StepContext, drugId: string): void {
  const drug = getDrug(drugId);
  if (!drug.allergyClass) return;
  const allergy = ctx.patient.allergies.find((a) => a.drugClass === drug.allergyClass);
  if (!allergy) return;
  const severity = allergy.reaction === 'anaphylaxis' ? 0.85 : allergy.reaction === 'angioedema' ? 0.6 : 0.3;
  ctx.s.pathologies.push({
    id: `allergy-${ctx.s.counter++}`,
    type: 'anaphylaxis',
    params: { allergen: drug.name, severity, exposure: 'iv' },
    state: { startsAt: ctx.t, started: true, m: 0 },
    addedAt: ctx.t,
    label: 'Drug-induced anaphylaxis',
    resolved: false,
  });
  ctx.emit({ kind: 'system', code: 'hidden.allergy', message: `Allergic reaction triggered: patient has a documented ${allergy.agent} allergy (${allergy.reaction})`, severity: 'critical', data: { hidden: true, drugId } });
}

/** Complete time-consuming procedures, NIBP cycles and consult timers. */
export function stepPendingTasks(ctx: StepContext): void {
  const { therapy, t, phys, rng, patient } = ctx;
  if (ctx.preroll) return;
  const done = therapy.pending.filter((p) => p.completesAt <= t);
  if (done.length) therapy.pending = therapy.pending.filter((p) => p.completesAt > t);
  for (const task of done) {
    switch (task.kind) {
      case 'ivAccess': {
        const site = task.data['site'] as 'leftArm' | 'rightArm' | 'io';
        if (site === 'io') {
          therapy.access.io = true;
          info(ctx, 'access.io', 'Intraosseous access established (proximal tibia)', 'good');
          break;
        }
        const perf = phys.cv.peripheralPerfusion;
        const p = 0.92 * smoothstep(0.05, 0.55, perf) * (patient.bmi > 35 ? 0.75 : 1);
        if (rng.procedure.chance(p)) {
          therapy.access[site] = true;
          info(ctx, 'access.iv', `IV access established — ${site === 'leftArm' ? 'left' : 'right'} antecubital 18G`, 'good');
        } else {
          info(ctx, 'access.ivFailed', `IV attempt failed (${perf < 0.35 ? 'collapsed, shut-down veins' : 'vein blew'}). Consider another attempt or IO access.`, 'warning');
        }
        break;
      }
      case 'intubation': {
        ctx.s.detectors['intubating'] = false;
        if (task.data['bvmWas']) therapy.bvm.active = true;
        if (task.data['surgical']) {
          if (rng.procedure.chance(0.9)) {
            ctx.s.detectors['surgicalAirway'] = true;
            info(ctx, 'airway.cric', 'Surgical airway placed (cuffed tube through the cricothyroid membrane). Ventilate via bag or ventilator.', 'good');
          } else info(ctx, 'airway.cricFailed', 'Cricothyrotomy attempt unsuccessful — bleeding obscures anatomy', 'critical');
          break;
        }
        const edema = phys.resp.upperAirwayEdema;
        let p = 0.93 - 0.55 * smoothstep(0.55, 0.9, edema) - (patient.bmi > 35 ? 0.12 : 0) - (phys.resp.vomitInAirway ? 0.25 : 0);
        if (phys.neuro.consciousness > 0.3 && ctx.ch.nmBlock < 0.5) p -= 0.4;
        if (rng.procedure.chance(clamp(p, 0.02, 0.97))) {
          therapy.airway.ett = true;
          therapy.airway.ettPlacedAt = t;
          therapy.airway.adjunct = 'none';
          info(ctx, 'airway.intubated', `Endotracheal tube placed (${String(task.data['tubeSize'] ?? 7.5)} mm). Confirm placement and ventilate.`, 'good');
        } else {
          info(ctx, 'airway.intubationFailed', edema > 0.6 ? 'Intubation failed: grossly swollen supraglottic tissues, no view of the cords' : 'Intubation attempt failed: poor view of the larynx', 'critical');
        }
        break;
      }
      case 'chestTube': {
        const side = task.data['side'] as 'left' | 'right';
        const blood = side === 'left' ? phys.resp.pleuralBloodLeft : phys.resp.pleuralBloodRight;
        const air = side === 'left' ? phys.resp.pleuralAirLeft : phys.resp.pleuralAirRight;
        therapy.procedures.chestTube[side] = { at: t, output: 0 };
        const desc = air > 300 && blood > 300 ? 'rush of air and blood' : air > 300 ? 'rush of air, bubbling in the drain' : blood > 300 ? `${Math.round(blood)} mL of blood drained immediately` : 'minimal drainage';
        info(ctx, 'procedure.chestTube', `Chest tube inserted (${side}): ${desc}`, air > 300 || blood > 300 ? 'good' : 'notice');
        break;
      }
      case 'arterialLine': {
        if (phys.cv.radialPulse || phys.cv.pulsePresent) {
          therapy.monitoring.arterialLine = true;
          info(ctx, 'procedure.aline', 'Arterial line in situ — continuous arterial pressure displayed', 'good');
        } else info(ctx, 'procedure.alineFailed', 'Arterial line failed — no palpable radial pulse', 'warning');
        break;
      }
    }
  }

  // Consult / procedure timers
  const h = therapy.procedures.hemostasis;
  if (h.completesAt !== null && !h.done && t >= h.completesAt) {
    h.done = true;
    const internal = ctx.s.pathologies.some((p) => p.type === 'hemorrhage' && !['leftThigh', 'rightThigh', 'leftArm', 'rightArm', 'scalp'].includes(String(p.params['site'])));
    info(ctx, 'procedure.hemostasisDone', internal ? 'Definitive haemorrhage control achieved in theatre/IR' : 'Surgical exploration: no ongoing surgical bleeding identified', internal ? 'good' : 'notice');
  }
  const r = therapy.procedures.reperfusion;
  if (r.completesAt !== null && !r.done && t >= r.completesAt) {
    r.done = true;
    const lesion = ctx.s.pathologies.some((p) => p.type === 'myocardialIschemia');
    info(ctx, 'procedure.pciDone', lesion ? 'Coronary angiography: culprit lesion identified and stented' : 'Coronary angiography: no culprit lesion', lesion ? 'good' : 'notice');
  }
  const d = therapy.procedures.dialysis;
  if (d.startsAt !== null && !d.active && t >= d.startsAt) {
    d.active = true;
    info(ctx, 'procedure.dialysisStarted', 'Haemodialysis running', 'good');
  }

  // NIBP measurement cycle (result appears ~25 s after the cuff starts)
  if (therapy.monitoring.nibp) {
    const pendingAt = ctx.s.detectors['nibpResultAt'];
    if (typeof pendingAt === 'number' && t >= pendingAt) {
      ctx.s.detectors['nibpResultAt'] = false;
      const cv = phys.cv;
      const ok = cv.pulsePresent && cv.sbp > 45;
      const noise = () => rng.monitor.normal(0, cv.rhythm === 'afib' ? 5 : 2.5);
      therapy.nibpLast = ok ? { t, sbp: Math.round(cv.sbp + noise()), dbp: Math.round(cv.dbp + noise()), map: Math.round(cv.map + noise() * 0.5), ok } : { t, sbp: 0, dbp: 0, map: 0, ok: false };
      if (therapy.nibpIntervalMin > 0) therapy.nibpNextAt = t + therapy.nibpIntervalMin * 60 - 25;
      else therapy.nibpNextAt = Infinity;
    } else if (pendingAt === false || pendingAt === undefined) {
      if (t >= therapy.nibpNextAt) {
        ctx.s.detectors['nibpResultAt'] = t + 25;
        therapy.nibpNextAt = Infinity;
      }
    }
  }
}

export function updateCprQuality(ctx: StepContext): void {
  const c = ctx.therapy.cpr;
  if (!c.active) {
    c.quality = 0;
    return;
  }
  if (c.mode === 'mechanical') {
    c.rate = 102;
    c.depth = 0.85;
    c.quality = 0.85;
    return;
  }
  const since = ctx.t - c.lastInputAt;
  if (since > 2.5) {
    c.quality = approach(c.quality, 0, 1.2, ctx.dt);
    if (c.handsOffSince === null) c.handsOffSince = c.lastInputAt;
    return;
  }
  c.handsOffSince = null;
  const rateScore = c.rate >= 100 && c.rate <= 120 ? 1 : clamp(1 - Math.min(Math.abs(c.rate - 100), Math.abs(c.rate - 120)) / 45, 0, 1);
  const target = rateScore * (0.35 + 0.65 * c.depth);
  c.quality = approach(c.quality, target, 1.5, ctx.dt);
}

/** Drug infusion rates in amountUnit/min for the pharmacology engine. */
export function infusionDrugRates(ctx: StepContext): Record<string, number> {
  const out: Record<string, number> = {};
  for (const inf of ctx.therapy.infusions) {
    if (inf.kind !== 'drug' || inf.stoppedAt !== null) continue;
    const drug = DRUG_MAP[inf.agentId];
    if (!drug) continue;
    const perMin = rateToAmountPerMin(drug, inf.rate, inf.rateUnit, ctx.patient.weightKg);
    out[drug.id] = (out[drug.id] ?? 0) + perMin;
    inf.delivered += (perMin * ctx.dt) / 60;
  }
  return out;
}

export function describeInfusionDelivered(drugId: string, amount: number): string {
  const d = DRUG_MAP[drugId];
  return d ? formatAmount(d, amount) : String(amount);
}
