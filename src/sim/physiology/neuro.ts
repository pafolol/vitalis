import { approach, clamp, hill, ramp, smoothstep } from '../core/math';
import type { StepContext } from '../engine/state';
import { antagonistFactor } from '../pharmacology/pkpd';

/**
 * Thermoregulation: core temperature integrates metabolic heat production
 * (VO2 × 20.1 kJ/L) minus environmental loss (modulated by skin perfusion,
 * exposure, warming devices) and the heat needed to warm infused fluids.
 * A hypothalamic set-point (raised by pyrogens, lowered by antipyretics)
 * drives shivering or sweating.
 */
export function stepThermo(ctx: StepContext, infusionHeatLossW: number): void {
  const { phys, calib: c, ch, mods, therapy, patient, dt } = ctx;
  const { thermo, metab, cv, neuro } = phys;
  const production = metab.vo2 * 0.335;
  const skinFactor = 0.55 + 0.45 * clamp(cv.peripheralPerfusion, 0, 1.3);
  const exposure = therapy.procedures.exposed ? 1.35 : 1;
  const warming = therapy.procedures.warming;
  const sweat = thermo.core > thermo.setpoint + 0.3 ? 1 + 1.2 * clamp(thermo.core - thermo.setpoint - 0.3, 0, 1.5) : 1;
  const ambient = Number(ctx.s.detectors['ambientC'] ?? c.ambientC);
  let loss = c.heatLossK * (thermo.core - ambient) * skinFactor * exposure * (warming ? 0.5 : 1) * sweat;
  if (warming) loss -= 90;
  const net = production - loss - infusionHeatLossW;
  thermo.netHeat = net;
  thermo.core += (net * dt) / (3470 * patient.weightKg);
  thermo.core = clamp(thermo.core, 20, 44);
  const setpointTarget = patient.baseline.temperatureC + mods.feverSetpointAdd * (1 - ch.antipyretic);
  thermo.setpoint = approach(thermo.setpoint, setpointTarget, 20 * 60, dt);
  const shiverDrive = clamp((thermo.setpoint - thermo.core - 0.3) * 0.6, 0, 1);
  thermo.shivering = approach(thermo.shivering, thermo.core > 30.5 ? shiverDrive * (1 - ch.nmBlock) * (1 - 0.7 * neuro.sedation) : 0, 60, dt);
  thermo.skin = clamp(ambient + (thermo.core - ambient) * (0.55 + 0.35 * clamp(cv.peripheralPerfusion, 0, 1.2)), 15, 40);
}

export function stepNeuro(ctx: StepContext): void {
  const { phys, calib: c, ch, chU, mods, therapy, dt, rng, patient } = ctx;
  const { neuro, cv, resp, chem, thermo, blood } = phys;
  const dtMin = dt / 60;

  // ---------------------------------------------------------------- cerebral oxygen delivery
  const cpp = cv.map - 10;
  const auto = cpp >= 50 ? 1 : Math.pow(Math.max(0, cpp / 50), 1.1);
  const co2Factor = clamp(1 + 0.025 * (resp.paco2 - 40), 0.45, 1.9);
  const cbf = auto * co2Factor;
  const target = cbf * (resp.cao2 / c.cao2_0);
  neuro.cerebralO2 = approach(neuro.cerebralO2, target, 4, dt);

  const fO2 = smoothstep(0.3, 0.72, neuro.cerebralO2);
  const fGlu = smoothstep(1.4, 3.2, chem.glucose) * (1 - 0.5 * smoothstep(330, 385, chem.osmolality));
  const fCO2 = 1 - 0.85 * smoothstep(75, 130, resp.paco2);
  const fTemp = smoothstep(25, 32.5, thermo.core) * (1 - smoothstep(40.5, 42.5, thermo.core));
  const fNa = smoothstep(106, 121, chem.na) * (1 - smoothstep(160, 176, chem.na));
  const uSed = chU.gaba / 1.0 + chU.mu / 3.2 + chU.nmda / 1.0 + ch.h1Block * 0.25;
  neuro.sedation = hill(uSed, 1, 1.6);

  // ---------------------------------------------------------------- seizures
  const anticonvulsant = hill(chU.gaba, 0.35, 1.5);
  if (!neuro.seizure) {
    const hazard =
      (mods.seizureHazard + 0.35 * ramp(1.8, 0.9, chem.glucose) + 0.9 * ramp(121, 112, chem.na) + 0.6 * ramp(0.28, 0.12, neuro.cerebralO2) * (cv.pulsePresent ? 1 : 0)) *
      (1 - 0.95 * anticonvulsant) *
      (neuro.brainInjury > 0.9 ? 0 : 1);
    if (rng.behaviour.hazard(hazard, dt)) {
      neuro.seizure = true;
      neuro.seizureTime = 0;
      ctx.emit({ kind: 'physiology', code: 'neuro.seizure', message: 'Generalised tonic–clonic seizure', severity: 'critical' });
    }
  } else {
    neuro.seizureTime += dt;
    const causeActive = chem.glucose < 2.0 || chem.na < 118;
    const stop = (causeActive ? 0.35 : 0.8) + 8 * anticonvulsant;
    if (rng.behaviour.hazard(stop, dt)) {
      neuro.seizure = false;
      neuro.postictal = 1;
      ctx.emit({ kind: 'physiology', code: 'neuro.seizureEnd', message: `Seizure terminated after ${Math.round(neuro.seizureTime)} s`, severity: 'notice' });
    }
  }
  neuro.postictal = Math.max(0, neuro.postictal - dtMin / 18);

  // ---------------------------------------------------------------- consciousness
  const cTarget = clamp(
    fO2 * fGlu * fCO2 * fTemp * fNa * (1 - neuro.sedation) * (1 - 0.75 * neuro.postictal) * (1 - neuro.brainInjury) * mods.consciousnessFactor * (neuro.seizure ? 0.04 : 1),
    0,
    1,
  );
  // Without spontaneous circulation consciousness is lost within seconds (CPR-induced awareness is rare and not modelled)
  const circulation = cv.pulsePresent ? 1 : 0.03;
  neuro.consciousness = approach(neuro.consciousness, cTarget * circulation, cTarget * circulation < neuro.consciousness ? 5 : 22, dt);
  const C = neuro.consciousness;

  // hypoxic–ischaemic brain injury
  if (neuro.cerebralO2 < 0.25) {
    const protect = thermo.core < 34 ? 0.5 : 1;
    neuro.brainInjury = clamp(neuro.brainInjury + 0.13 * (1 - neuro.cerebralO2 / 0.25) * protect * dtMin, 0, 1);
  }

  // ---------------------------------------------------------------- pain, dyspnoea, affect
  const procPain = Number(ctx.s.detectors['procPain'] ?? 0);
  ctx.s.detectors['procPain'] = Math.max(0, procPain - dt * 0.12);
  let noci = mods.nociception + procPain;
  if (therapy.defib.pacing.on && therapy.defib.padsOn) noci += 7 * clamp(therapy.defib.pacing.mA / 80, 0, 1.2);
  if (therapy.cpr.active && cv.pulsePresent) noci += 6;
  neuro.nociception = clamp(noci, 0, 10);
  const analgesia = 1 - (1 - 0.9 * hill(chU.mu, 1, 1.3)) * (1 - 0.85 * hill(chU.nmda, 0.18, 1.5)) * (1 - 0.2 * ch.antipyretic);
  neuro.pain = clamp(neuro.nociception * (1 - analgesia) * smoothstep(0.25, 0.6, C), 0, 10);

  const hypoxaemia = ramp(92, 78, resp.sao2 * 100);
  const obstruction = 1 - resp.airwayPatency;
  const dysp = 10 * clamp((resp.drive - 1) / 3 + Math.max(0, resp.workOfBreathing - 1) / 5 + hypoxaemia * 0.45 + obstruction * 0.6, 0, 1);
  neuro.dyspnea = approach(neuro.dyspnea, dysp * smoothstep(0.3, 0.7, C), 10, dt);

  // precipitated opioid withdrawal (dependent patient + naloxone on board)
  const dependent = patient.baseline.opioidTolerance > 1.5;
  const naloxoneOn = antagonistFactor(ctx.pharm, 'mu') < 0.75;
  const wTarget = dependent && naloxoneOn ? smoothstep(0.6, 0.1, chU.mu) : 0;
  neuro.withdrawal = approach(neuro.withdrawal, wTarget, wTarget > neuro.withdrawal ? 40 : 600, dt);

  const glucoseAdrenergic = ramp(3.8, 2.6, chem.glucose);
  neuro.confusion = clamp((1 - smoothstep(0.55, 0.93, C)) * (C > 0.3 ? 1 : 0) + mods.confusionAdd + 0.5 * ramp(3.2, 2.2, chem.glucose) * (C > 0.3 ? 1 : 0), 0, 1);
  const delirium = ramp(0.9, 0.62, neuro.cerebralO2) * (C > 0.45 ? 1 : 0);
  neuro.agitation = approach(
    neuro.agitation,
    clamp(0.85 * delirium + 0.9 * neuro.withdrawal + 0.4 * glucoseAdrenergic * (C > 0.45 ? 1 : 0) + 0.05 * neuro.pain + 0.3 * ramp(0.4, 0.9, chem.ketones / 10), 0, 1) * (1 - neuro.sedation) * (1 - ch.nmBlock),
    15,
    dt,
  );
  neuro.anxiety = approach(neuro.anxiety, clamp(0.15 + 0.07 * neuro.dyspnea + 0.04 * neuro.pain + 0.4 * glucoseAdrenergic + (ctx.s.detectors['adenosinePeak'] ? 0.6 : 0), 0, 1) * smoothstep(0.4, 0.8, C) * (1 - 0.8 * neuro.sedation), 8, dt);

  // ---------------------------------------------------------------- GCS / AVPU
  const dissociated = hill(chU.nmda, 0.8, 2) > 0.5;
  neuro.gcsE = dissociated ? 4 : C > 0.85 ? 4 : C > 0.6 ? 3 : C > 0.35 ? 2 : 1;
  const intubated = therapy.airway.ett || !!ctx.s.detectors['surgicalAirway'];
  neuro.gcsV = intubated ? 1 : C > 0.93 && neuro.confusion < 0.15 ? 5 : C > 0.78 ? 4 : C > 0.6 ? 3 : C > 0.42 ? 2 : 1;
  neuro.gcsM = ch.nmBlock > 0.6 ? 1 : C > 0.75 ? 6 : C > 0.55 ? 5 : C > 0.4 ? 4 : C > 0.25 ? 3 : C > 0.12 ? 2 : 1;
  if (neuro.seizure) {
    neuro.gcsE = 1;
    neuro.gcsV = 1;
    neuro.gcsM = 1;
  }
  neuro.gcs = neuro.gcsE + neuro.gcsV + neuro.gcsM;
  neuro.avpu = C > 0.85 ? 'A' : C > 0.6 ? 'V' : C > 0.3 ? 'P' : 'U';
  neuro.airwayReflexes = C > 0.35 && ch.nmBlock < 0.5 && neuro.brainInjury < 0.8;

  // ---------------------------------------------------------------- pupils
  let pupil = 4.2;
  pupil *= 1 - 0.62 * hill(chU.mu, 0.6, 1.5);
  pupil *= 1 + 0.45 * clamp(neuro.sympathetic - c.s0, 0, 1) + 0.35 * ch.muscarinicBlock + 0.3 * neuro.withdrawal;
  pupil = pupil + (7.5 - pupil) * smoothstep(0.55, 0.95, neuro.brainInjury);
  if (!cv.pulsePresent && cv.arrestTime > 45) pupil = pupil + (7 - pupil) * clamp((cv.arrestTime - 45) / 120, 0, 1);
  pupil = clamp(pupil, 1.2, 8.5);
  neuro.pupilLeft = approach(neuro.pupilLeft, pupil, 3, dt);
  neuro.pupilRight = approach(neuro.pupilRight, pupil, 3, dt);
  neuro.pupilsReactive = neuro.brainInjury < 0.6 && thermo.core > 28 && !(neuro.cerebralO2 < 0.15 && cv.arrestTime > 60);

  // ---------------------------------------------------------------- autonomic signs
  neuro.tremor = clamp(0.7 * glucoseAdrenergic * (C > 0.3 ? 1 : 0) + 0.6 * Math.max(0, ch.beta2 - c.eBeta2_0) + 0.7 * neuro.withdrawal + 0.8 * phys.thermo.shivering, 0, 1) * (1 - ch.nmBlock);
  neuro.sweating = clamp(0.8 * ramp(0.45, 0.9, neuro.sympathetic) + 0.7 * glucoseAdrenergic + 0.7 * (phys.thermo.core > phys.thermo.setpoint + 0.3 ? 1 : 0) + 0.6 * neuro.withdrawal, 0, 1) * (1 - 0.8 * ch.muscarinicBlock);
  neuro.nausea = clamp(approach(neuro.nausea, clamp(mods.nausea + 0.45 * neuro.withdrawal + 0.18 * hill(chU.mu, 1.5), 0, 1), 60, dt) * (1 - 0.8 * ch.antiemetic), 0, 1);

  // ---------------------------------------------------------------- vomiting & aspiration
  if (C > 0.08 && ch.nmBlock < 0.5 && !intubated && rng.behaviour.hazard(0.9 * ramp(0.5, 1, neuro.nausea), dt)) {
    neuro.nausea = 0.2;
    const protectedAirway = (neuro.airwayReflexes && C > 0.5) || therapy.airway.recoveryPosition;
    if (protectedAirway) {
      ctx.emit({ kind: 'patient', code: 'patient.vomit', message: 'Patient vomited (airway protected)', severity: 'notice' });
    } else {
      resp.vomitInAirway = true;
      if (!resp.aspirated) {
        resp.aspirated = true;
        ctx.emit({ kind: 'physiology', code: 'resp.aspiration', message: 'Patient vomited with unprotected airway — aspiration of gastric contents', severity: 'critical' });
      }
    }
  }

  // ---------------------------------------------------------------- behaviour: agitated/hypoxic patient removes the mask
  const dev = therapy.oxygen.device;
  if ((dev === 'nonRebreather' || dev === 'simpleMask' || dev === 'nasalCannula') && neuro.agitation > 0.5 && C > 0.45) {
    if (rng.behaviour.hazard(0.35 * neuro.agitation, dt)) {
      therapy.oxygen.device = 'none';
      therapy.oxygen.flowLpm = 0;
      ctx.emit({ kind: 'patient', code: 'patient.removedOxygen', message: 'Agitated patient pulled off the oxygen device', severity: 'warning' });
    }
  }
  void blood;
}
