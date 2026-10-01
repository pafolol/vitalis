import type { SimSnapshot } from '@/sim/engine/snapshot';
import type { AvatarVisualState, BodyRegion, Limb } from '@/three/types';
import { FLUID_MAP } from '@/sim/pharmacology/drugs';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const approach = (cur: number, target: number, tau: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));

const SITE_REGION: Record<string, BodyRegion> = {
  leftThigh: 'leftLeg',
  rightThigh: 'rightLeg',
  leftArm: 'leftArm',
  rightArm: 'rightArm',
  scalp: 'head',
};

/**
 * Derive the renderer's visual state from the latest simulation snapshot.
 *
 * Animation phases (breathing, heartbeat) are integrated here on the visual
 * clock using the *simulated* rates so motion is smooth between 10 Hz
 * snapshots. When the simulation is time-accelerated, motion is shown at
 * real-time speed (rates are physiological, not multiplied) for readability;
 * when paused, motion freezes.
 */
/** Position within the current respiratory cycle (0..1); the visual state exposes lung volume instead. */
let breathCycle = 0;

export function updateVisualState(v: AvatarVisualState, snap: SimSnapshot | null, dtWall: number, speed: number): void {
  if (!snap) return;
  const dt = speed > 0 ? dtWall : 0;
  v.clock += dt;
  const { phys, therapy, appearance, derived } = snap;
  const { resp, cv, neuro } = phys;

  // ---------------------------------------------------------------- breathing
  const rr = resp.rr;
  // Respiratory cycle → normalised lung volume (the renderer's breathPhase: 0 end-expiration, 1 end-inspiration).
  // Inspiration is a smooth rise; expiration is passive (fast initially) and prolonged when airways are narrowed.
  if (rr > 0.5) {
    breathCycle = (breathCycle + (dt * rr) / 60) % 1;
    const ti = resp.resistance > 3 ? 0.25 : 0.36;
    if (breathCycle < ti) {
      v.breathPhase = 0.5 - 0.5 * Math.cos(Math.PI * (breathCycle / ti));
    } else {
      const e = (breathCycle - ti) / (1 - ti);
      const shaped = 1 - (1 - e) ** 2.2;
      v.breathPhase = 0.5 + 0.5 * Math.cos(Math.PI * shaped);
    }
  } else v.breathPhase = approach(v.breathPhase, 0, 1.5, dt);
  const normalVt = 7 * 70;
  v.breathDepth = approach(v.breathDepth, clamp(resp.vt / normalVt, 0, 2.6), 0.8, dt);
  v.chestRiseLeft = approach(v.chestRiseLeft, clamp(resp.lungExpansionLeft, 0.05, 1), 1, dt);
  v.chestRiseRight = approach(v.chestRiseRight, clamp(resp.lungExpansionRight, 0.05, 1), 1, dt);
  v.passiveVentilation = therapy.bvm.active || therapy.ventilator.on;
  v.abdominalFraction = clamp(0.45 + 0.35 * (1 - neuro.consciousness) - 0.25 * appearance.accessoryMuscles + (resp.resistance > 3 ? -0.15 : 0), 0.1, 0.9);
  v.accessoryMuscles = approach(v.accessoryMuscles, appearance.accessoryMuscles, 2, dt);
  v.nasalFlare = approach(v.nasalFlare, appearance.nasalFlare, 2, dt);

  // ---------------------------------------------------------------- cardiac
  const hr = cv.hr;
  if (hr > 1) v.cardiacPhase = (v.cardiacPhase + (dt * hr) / 60) % 1;
  v.heartRate = hr;
  v.pulseStrength = approach(v.pulseStrength, derived.centralPulse ? clamp((cv.sbp - cv.dbp) / 45, 0.1, 1.4) : 0, 0.5, dt);

  // ---------------------------------------------------------------- neuro / behaviour
  const C = neuro.consciousness;
  const eyesTarget = neuro.seizure ? 0.3 : clamp((C - 0.3) / 0.45, 0, 1) * (1 - 0.6 * neuro.sedation);
  v.eyesOpen = approach(v.eyesOpen, eyesTarget, 0.6, dt);
  v.gazeFollow = approach(v.gazeFollow, C > 0.8 && neuro.confusion < 0.4 ? 1 : C > 0.6 ? 0.4 : 0, 1, dt);
  const lolling = clamp((0.45 - C) / 0.45, 0, 1);
  v.headTurn = approach(v.headTurn, lolling * 0.55, 2, dt);
  v.jawOpen = approach(v.jawOpen, clamp(lolling * 0.6 + (therapy.airway.ett ? 0.35 : 0) + (therapy.bvm.active ? 0.1 : 0), 0, 1), 1, dt);
  v.painExpression = approach(v.painExpression, clamp(neuro.pain / 9 + neuro.dyspnea / 18, 0, 1) * (C > 0.35 ? 1 : 0), 1.2, dt);
  v.agitation = approach(v.agitation, neuro.agitation, 1, dt);
  v.tremor = approach(v.tremor, neuro.tremor, 1, dt);
  v.seizure = approach(v.seizure, neuro.seizure ? 1 : 0, 0.3, dt);
  v.handToChest = approach(v.handToChest, C > 0.6 && neuro.pain > 4 && /chest|palpitation/.test(derived.painSite) ? 1 : 0, 1.5, dt);
  v.pupilMm = approach(v.pupilMm, (neuro.pupilLeft + neuro.pupilRight) / 2, 1, dt);

  // ---------------------------------------------------------------- skin
  v.pallor = approach(v.pallor, appearance.pallor, 4, dt);
  v.cyanosisCentral = approach(v.cyanosisCentral, appearance.cyanosisCentral, 3, dt);
  v.cyanosisPeripheral = approach(v.cyanosisPeripheral, appearance.cyanosisPeripheral, 3, dt);
  v.flushing = approach(v.flushing, appearance.flushing, 3, dt);
  v.urticaria = approach(v.urticaria, appearance.urticaria, 3, dt);
  v.mottling = approach(v.mottling, appearance.mottling, 6, dt);
  v.diaphoresis = approach(v.diaphoresis, appearance.diaphoresis, 5, dt);
  v.angioedema = approach(v.angioedema, appearance.angioedema, 4, dt);

  // ---------------------------------------------------------------- resuscitation
  if (!therapy.cpr.active) v.cprCompression = approach(v.cprCompression, 0, 0.15, dt);
  else if (therapy.cpr.mode === 'mechanical') {
    const phase = (v.clock * 102) / 60;
    v.cprCompression = Math.max(0, Math.sin(phase * Math.PI * 2)) * 0.9;
  }

  // ---------------------------------------------------------------- attachments
  const a = v.attachments;
  const m = therapy.monitoring;
  a.ecgLeads = m.ecg;
  a.spo2Probe = m.spo2;
  a.bpCuff = m.nibp;
  a.ivLeftArm = therapy.access.leftArm;
  a.ivRightArm = therapy.access.rightArm;
  a.ioAccess = therapy.access.io;
  const dev = therapy.oxygen.device;
  a.nasalCannula = dev === 'nasalCannula' || dev === 'highFlowNasal';
  a.faceMask = dev === 'simpleMask';
  a.nonRebreather = dev === 'nonRebreather' && !therapy.bvm.active;
  a.bvm = therapy.bvm.active;
  a.ett = therapy.airway.ett;
  a.opa = therapy.airway.adjunct === 'opa';
  a.defibPads = therapy.defib.padsOn;
  a.tourniquet = (therapy.procedures.tourniquet as Limb | null) ?? null;
  a.chestTube = therapy.procedures.chestTube.left ? 'left' : therapy.procedures.chestTube.right ? 'right' : null;
  a.needleDecompression = therapy.procedures.needleDecompression.left ? 'left' : therapy.procedures.needleDecompression.right ? 'right' : null;
  a.bleeding = appearance.bleeding ? { region: SITE_REGION[appearance.bleeding.site] ?? 'leftLeg', intensity: appearance.bleeding.intensity } : null;
  const running = therapy.infusions.filter((i) => i.kind !== 'drug' && i.stoppedAt === null);
  const bag = running[running.length - 1] ?? therapy.infusions.filter((i) => i.kind !== 'drug').slice(-1)[0];
  a.ivBag = bag
    ? {
        label: FLUID_MAP[bag.agentId]?.label ?? bag.label,
        fraction: bag.totalMl > 0 && Number.isFinite(bag.totalMl) ? clamp(bag.remainingMl / bag.totalMl, 0, 1) : 1,
        running: bag.stoppedAt === null,
        isBlood: bag.kind === 'blood',
      }
    : null;
  a.airwayManoeuvre = therapy.airway.manoeuvre !== 'none';
  a.backrestDeg = therapy.procedures.backrestDeg;

  // ---------------------------------------------------------------- anatomy overlays
  const an = v.anatomy;
  an.lungInflationLeft = resp.lungExpansionLeft;
  an.lungInflationRight = resp.lungExpansionRight;
  an.lungOedema = resp.lungWater;
  an.bronchospasm = clamp((resp.resistance - 1) / 6, 0, 1);
  an.myocardialIschaemia = clamp(Math.max(cv.territoryIschemia.lad, cv.territoryIschemia.lcx, cv.territoryIschemia.rca, cv.globalIschemia), 0, 1);
  an.arterialSat = resp.sao2;
  an.brainPerfusion = clamp(neuro.cerebralO2, 0, 1.2);
  an.renalPerfusion = clamp(phys.renal.perfusion, 0, 1.2);
  an.splanchnicPerfusion = clamp(cv.co / Math.max(1, cv.co + 0.001) * cv.peripheralPerfusion, 0, 1.2);
  an.cardiacContractility = cv.co > 0.3 ? clamp(cv.lvContractility, 0, 1.5) : 0;
  const hemi = 2600;
  an.pleuralAirLeft = clamp(resp.pleuralAirLeft / hemi, 0, 1);
  an.pleuralAirRight = clamp(resp.pleuralAirRight / hemi, 0, 1);
}
