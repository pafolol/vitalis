import type { SimSnapshot } from '../engine/snapshot';
import type { ScenarioDefinition } from '../scenarios/schema';

/**
 * Physical examination. Findings are *derived from the simulated state* at
 * the moment of examination (tagged `simulated`), with scenario-authored
 * findings (e.g. track marks, seat-belt sign) tagged `authored`.
 * Structured auscultation output also drives the procedural audio.
 */

export type ExamKind =
  | 'general'
  | 'airway'
  | 'breathing'
  | 'auscultation'
  | 'percussion'
  | 'pulses'
  | 'circulation'
  | 'neuro'
  | 'pupils'
  | 'abdomen'
  | 'skin'
  | 'limbs';

export interface Finding {
  label: string;
  text: string;
  abnormal: boolean;
  source: 'simulated' | 'authored';
}

export interface AuscultationResult {
  zone: string;
  kind: 'lung' | 'heart' | 'trachea' | 'abdomen';
  /** 0 = absent, 1 = normal intensity */
  breathIntensity: number;
  breathQuality: 'vesicular' | 'bronchial' | 'diminished' | 'absent';
  wheeze: number;
  crackles: number;
  stridor: number;
  snoring: number;
  heartIntensity: number;
  heartRate: number;
  irregular: boolean;
  s3: boolean;
  bowel: number;
  respRate: number;
  text: string;
}

const LEFT_LUNG = ['leftUpperChest', 'leftLowerChest', 'leftAxilla', 'leftSecondICS', 'leftFifthICSAxillary'];
const RIGHT_LUNG = ['rightUpperChest', 'rightLowerChest', 'rightAxilla', 'rightSecondICS', 'rightFifthICSAxillary'];
const HEART = ['aorticArea', 'pulmonicArea', 'tricuspidArea', 'mitralArea'];
const ABDO = ['epigastrium', 'rightUpperQuadrant', 'leftUpperQuadrant', 'rightLowerQuadrant', 'leftLowerQuadrant'];

export function auscultate(snap: SimSnapshot, zone: string): AuscultationResult {
  const { resp, cv, neuro } = snap.phys;
  const breathing = resp.rr > 0.5 && resp.vt > 40;
  const base: AuscultationResult = {
    zone,
    kind: 'lung',
    breathIntensity: 0,
    breathQuality: 'absent',
    wheeze: 0,
    crackles: 0,
    stridor: 0,
    snoring: resp.snoring ? 0.7 : 0,
    heartIntensity: 0,
    heartRate: cv.hr,
    irregular: cv.rhythm === 'afib',
    s3: cv.lap > 20 && cv.co > 0.5,
    bowel: 0,
    respRate: resp.rr,
    text: '',
  };
  const pulse = cv.co > 0.4 && cv.rhythm !== 'vfib' && cv.rhythm !== 'asystole';

  if (zone === 'trachea') {
    base.kind = 'trachea';
    base.breathIntensity = breathing ? Math.min(1.2, resp.vt / 450) : 0;
    base.breathQuality = breathing ? 'bronchial' : 'absent';
    base.stridor = resp.stridor;
    base.text = !breathing ? 'No airflow heard over the trachea.' : resp.stridor > 0.3 ? 'Harsh inspiratory stridor over the trachea.' : resp.snoring ? 'Coarse snoring upper-airway sounds.' : 'Normal tracheal breath sounds.';
    return base;
  }

  if (HEART.includes(zone)) {
    base.kind = 'heart';
    base.heartIntensity = pulse ? Math.min(1.2, 0.4 + cv.sv / 90) : 0;
    const muffled = resp.pleuralAirLeft > 800;
    if (!pulse) base.text = cv.rhythm === 'vfib' ? 'No heart sounds audible.' : 'No heart sounds audible.';
    else {
      const rate = Math.round(cv.hr);
      const rhythm = cv.rhythm === 'afib' ? 'irregularly irregular' : 'regular';
      base.text = `Heart sounds ${muffled ? 'distant, ' : ''}${rhythm} at about ${rate}/min.${base.s3 ? ' A third heart sound (gallop) is present.' : ''}${cv.hr > 150 ? ' Very rapid.' : ''}`;
    }
    // lungs transmit a little here
    base.breathIntensity = breathing ? 0.3 : 0;
    base.breathQuality = breathing ? 'vesicular' : 'absent';
    return base;
  }

  if (ABDO.includes(zone)) {
    base.kind = 'abdomen';
    base.bowel = cv.co > 2.5 && neuro.consciousness > 0.2 ? 0.6 : 0.2;
    base.text = base.bowel > 0.4 ? 'Normal bowel sounds.' : 'Quiet bowel sounds.';
    return base;
  }

  // lungs
  const left = LEFT_LUNG.includes(zone);
  const right = RIGHT_LUNG.includes(zone);
  const expansion = left ? resp.lungExpansionLeft : right ? resp.lungExpansionRight : 1;
  const pleuralFluid = left ? resp.pleuralBloodLeft : right ? resp.pleuralBloodRight : 0;
  const lower = /Lower|Fifth|Axilla/.test(zone);
  let intensity = breathing ? Math.min(1.25, resp.vt / 450) * Math.pow(expansion, 1.6) : 0;
  if (lower && pleuralFluid > 300) intensity *= 0.2;
  if (resp.resistance > 5 && resp.ve < 4) intensity *= 0.35; // silent chest
  base.breathIntensity = intensity;
  base.breathQuality = intensity < 0.08 ? 'absent' : intensity < 0.45 ? 'diminished' : resp.lungWater > 0.5 && lower ? 'bronchial' : 'vesicular';
  base.wheeze = breathing ? resp.wheeze * Math.pow(expansion, 0.5) : 0;
  base.crackles = breathing ? resp.crackles * (lower ? 1 : 0.5) * expansion : 0;
  const parts: string[] = [];
  if (!breathing) parts.push('No breath sounds (no ventilation).');
  else if (base.breathQuality === 'absent') parts.push('Breath sounds absent.');
  else if (base.breathQuality === 'diminished') parts.push('Markedly reduced air entry.');
  else if (base.breathQuality === 'bronchial') parts.push('Bronchial breathing.');
  else parts.push('Vesicular breath sounds.');
  if (base.wheeze > 0.15) parts.push(base.wheeze > 0.6 ? 'Loud polyphonic expiratory wheeze.' : 'Expiratory wheeze.');
  if (base.crackles > 0.2) parts.push(lower ? 'Fine inspiratory crackles at the base.' : 'Scattered crackles.');
  if (snap.therapy.ventilator.on || snap.therapy.bvm.active) parts.push('(positive-pressure breaths)');
  base.text = parts.join(' ');
  return base;
}

function authored(scenario: ScenarioDefinition, zones: string[]): Finding[] {
  return (scenario.authoredFindings.exam ?? []).filter((f) => zones.includes(f.zone)).map((f) => ({ label: 'Finding', text: f.finding, abnormal: true, source: 'authored' as const }));
}

export function examine(snap: SimSnapshot, scenario: ScenarioDefinition, kind: ExamKind, zone?: string): Finding[] {
  const { phys, therapy, appearance, derived } = snap;
  const { resp, cv, neuro, thermo, blood } = phys;
  const f = (label: string, text: string, abnormal: boolean): Finding => ({ label, text, abnormal, source: 'simulated' });
  const out: Finding[] = [];
  switch (kind) {
    case 'general': {
      const colour: string[] = [];
      if (appearance.cyanosisCentral > 0.35) colour.push('centrally cyanosed (blue lips)');
      else if (appearance.cyanosisPeripheral > 0.4) colour.push('peripherally cyanosed');
      if (appearance.pallor > 0.45) colour.push('pale');
      if (appearance.flushing > 0.35) colour.push('flushed');
      if (appearance.mottling > 0.35) colour.push('mottled');
      if (appearance.diaphoresis > 0.45) colour.push('sweaty/clammy');
      out.push(f('Appearance', colour.length ? `Looks unwell: ${colour.join(', ')}.` : 'Colour normal.', colour.length > 0));
      const loc = neuro.seizure ? 'Generalised tonic–clonic seizure in progress.' : neuro.avpu === 'A' ? (neuro.confusion > 0.3 ? 'Awake but confused.' : neuro.agitation > 0.5 ? 'Awake, agitated and restless.' : 'Awake and alert.') : neuro.avpu === 'V' ? 'Drowsy, rouses to voice.' : neuro.avpu === 'P' ? 'Responds only to pain.' : 'Unresponsive.';
      out.push(f('Responsiveness', loc, neuro.avpu !== 'A' || neuro.confusion > 0.3 || neuro.seizure));
      const wob = appearance.accessoryMuscles > 0.4 ? 'Marked work of breathing with accessory muscle use' : resp.rr > 24 ? 'Tachypnoeic' : resp.rr < 8 && resp.rr > 0 ? 'Slow, shallow respirations' : resp.rr === 0 ? 'Not breathing' : 'Breathing comfortably';
      out.push(f('Breathing effort', `${wob}.`, appearance.accessoryMuscles > 0.4 || resp.rr > 24 || resp.rr < 8));
      if (derived.canSpeak) out.push(f('Speech', derived.speechQuality === 'sentences' ? 'Speaking in full sentences.' : derived.speechQuality === 'phrases' ? 'Speaking in short phrases.' : 'Able to say single words only.', derived.speechQuality !== 'sentences'));
      if (appearance.urticaria > 0.25) out.push(f('Skin', 'Widespread raised urticarial wheals.', true));
      if (neuro.tremor > 0.4) out.push(f('Movement', 'Fine tremor of the hands.', true));
      if (appearance.bleeding) out.push(f('Bleeding', `Active bleeding from a wound on the ${appearance.bleeding.site.replace(/([A-Z])/g, ' $1').toLowerCase()}${appearance.bleeding.intensity > 0.6 ? ' — pulsatile, soaking through dressings' : ''}.`, true));
      break;
    }
    case 'airway': {
      if (therapy.airway.ett) out.push(f('Airway', 'Endotracheal tube in situ.', false));
      else if (resp.stridor > 0.3) out.push(f('Airway', 'Inspiratory stridor; voice hoarse. Swollen lips and tongue.', true));
      else if (resp.snoring) out.push(f('Airway', 'Snoring/gurgling respirations — partial upper-airway obstruction.', true));
      else if (resp.airway === 'obstructed') out.push(f('Airway', 'Obstructed: paradoxical chest movement, no airflow.', true));
      else if (derived.canSpeak) out.push(f('Airway', 'Patent — talking.', false));
      else out.push(f('Airway', 'Patent, no added sounds.', false));
      if (resp.vomitInAirway) out.push(f('Mouth', 'Vomitus in the oropharynx.', true));
      if (appearance.angioedema > 0.3) out.push(f('Oedema', 'Lip and tongue swelling.', true));
      out.push(f('Gag / cough', neuro.airwayReflexes ? 'Airway reflexes present.' : 'No gag or cough reflex.', !neuro.airwayReflexes));
      break;
    }
    case 'breathing': {
      out.push(f('Respiratory rate', resp.rr < 1 ? 'Apnoeic.' : `${Math.round(resp.rr)} breaths/min${resp.vt < 250 && resp.rr > 0 ? ', shallow' : resp.vt > 700 ? ', deep' : ''}.`, resp.rr > 22 || resp.rr < 10));
      const asym = Math.abs(resp.lungExpansionLeft - resp.lungExpansionRight) > 0.25;
      const reducedSide = resp.lungExpansionLeft < resp.lungExpansionRight ? 'left' : 'right';
      out.push(f('Chest movement', asym ? `Reduced expansion on the ${reducedSide}.` : resp.rr > 0 ? 'Symmetrical expansion.' : 'No chest movement.', asym || resp.rr === 0));
      const shift = Math.max(resp.pleuralAirLeft, resp.pleuralAirRight) > 1600;
      out.push(f('Trachea', shift ? `Deviated away from the ${resp.pleuralAirLeft > resp.pleuralAirRight ? 'left' : 'right'}.` : 'Central.', shift));
      if (appearance.accessoryMuscles > 0.3) out.push(f('Accessory muscles', 'Sternocleidomastoid and intercostal recession.', true));
      if (resp.autoPeep > 5 && cv.co > 0.5) out.push(f('Pulsus paradoxus', 'Marked respiratory variation in pulse volume.', true));
      break;
    }
    case 'auscultation': {
      const z = zone ?? 'rightUpperChest';
      const a = auscultate(snap, z);
      out.push(f(`Auscultation (${z})`, a.text, a.breathQuality !== 'vesicular' || a.wheeze > 0.15 || a.crackles > 0.2 || a.stridor > 0.3 || (a.kind === 'heart' && (a.s3 || a.heartIntensity === 0))));
      break;
    }
    case 'percussion': {
      const z = zone ?? 'rightUpperChest';
      const left = LEFT_LUNG.includes(z);
      const air = left ? resp.pleuralAirLeft : resp.pleuralAirRight;
      const fluid = left ? resp.pleuralBloodLeft : resp.pleuralBloodRight;
      const lower = /Lower|Fifth|Axilla/.test(z);
      const txt = air > 500 ? 'Hyper-resonant.' : fluid > 400 && lower ? 'Stony dull.' : resp.lungWater > 0.5 && lower ? 'Dull.' : 'Resonant.';
      out.push(f(`Percussion (${z})`, txt, txt !== 'Resonant.'));
      break;
    }
    case 'pulses':
    case 'circulation': {
      const central = derived.centralPulse;
      const radial = derived.radialPulse;
      const rate = Math.round(cv.hr);
      const vol = cv.sbp - cv.dbp < 25 ? 'thready' : cv.sbp - cv.dbp > 70 ? 'bounding' : 'normal volume';
      if (!central) out.push(f('Central pulse', 'No carotid or femoral pulse palpable.', true));
      else out.push(f('Carotid pulse', `Present, ${rate}/min, ${cv.rhythm === 'afib' ? 'irregularly irregular' : 'regular'}, ${vol}.`, rate > 110 || rate < 50 || vol !== 'normal volume'));
      out.push(f('Radial pulse', radial ? `Palpable${cv.peripheralPerfusion < 0.4 ? ', weak' : ''}.` : 'Not palpable.', !radial || cv.peripheralPerfusion < 0.4));
      out.push(f('Capillary refill', `${cv.capRefill.toFixed(1)} s.`, cv.capRefill > 3));
      out.push(f('Peripheries', thermo.skin < 30 ? 'Cold peripheries.' : thermo.skin < 32 ? 'Cool peripheries.' : 'Warm peripheries.', thermo.skin < 32));
      const jvp = cv.rap > 12 ? 'Raised JVP, distended neck veins.' : cv.rap < 2 ? 'JVP not visible (flat neck veins).' : 'JVP normal.';
      out.push(f('Neck veins', jvp, cv.rap > 12 || cv.rap < 2));
      if (kind === 'circulation') out.push(...authored(scenario, ['leftArm', 'rightArm']));
      break;
    }
    case 'neuro': {
      const g = neuro;
      const intub = therapy.airway.ett;
      out.push(f('GCS', `E${g.gcsE} V${intub ? 'T' : g.gcsV} M${g.gcsM} = ${intub ? `${g.gcsE + g.gcsM}T` : g.gcs}`, g.gcs < 15));
      out.push(f('AVPU', { A: 'Alert', V: 'Responds to voice', P: 'Responds to pain', U: 'Unresponsive' }[g.avpu], g.avpu !== 'A'));
      if (g.seizure) out.push(f('Motor', 'Rhythmic jerking of all four limbs.', true));
      else if (g.paralysis > 0.6) out.push(f('Motor', 'No movement (neuromuscular blockade).', true));
      else out.push(f('Motor', g.gcsM >= 6 ? 'Moves all four limbs to command.' : g.gcsM >= 4 ? 'Withdraws all limbs to pain.' : g.gcsM >= 2 ? 'Abnormal posturing to pain.' : 'No motor response.', g.gcsM < 6));
      if (g.agitation > 0.5) out.push(f('Behaviour', 'Agitated, pulling at lines and mask.', true));
      break;
    }
    case 'pupils': {
      const size = (neuro.pupilLeft + neuro.pupilRight) / 2;
      const desc = size < 2 ? 'Pinpoint' : size > 6 ? 'Dilated' : 'Mid-size';
      out.push(f('Pupils', `${desc}, ${size.toFixed(1)} mm, equal, ${neuro.pupilsReactive ? 'reactive to light' : 'fixed — no reaction to light'}.`, size < 2.2 || size > 6 || !neuro.pupilsReactive));
      break;
    }
    case 'abdomen': {
      const site = derived.painSite;
      const tender = /abdom/.test(site) ? 'Diffusely tender with guarding.' : /flank/.test(site) ? 'Tender over the renal angle.' : 'Soft, non-tender.';
      out.push(f('Palpation', tender, tender !== 'Soft, non-tender.'));
      const distended = blood.cumulativeLoss > 1200 && scenario.pathologies.some((p) => p.type === 'hemorrhage' && (p.params as { site: string }).site === 'abdomen');
      if (distended) out.push(f('Inspection', 'Increasingly distended abdomen.', true));
      out.push(...authored(scenario, ['abdomen']));
      break;
    }
    case 'skin': {
      out.push(f('Temperature to touch', thermo.core > 38.3 ? 'Hot to touch.' : thermo.core < 35 ? 'Cold to touch.' : 'Normal temperature to touch.', thermo.core > 38.3 || thermo.core < 35));
      if (appearance.urticaria > 0.2) out.push(f('Rash', 'Raised, blanching urticarial wheals over trunk and limbs.', true));
      if (appearance.mottling > 0.3) out.push(f('Mottling', 'Mottled skin over the knees.', true));
      if (appearance.diaphoresis > 0.4) out.push(f('Sweating', 'Cold, clammy, sweaty skin.', true));
      if (therapy.procedures.exposed === false) out.push(f('Exposure', 'Patient is covered — expose for a full examination.', false));
      out.push(...authored(scenario, ['arms', 'chest', 'legs', 'back', 'skin']));
      break;
    }
    case 'limbs': {
      out.push(...authored(scenario, ['arms', 'legs', 'leftArm', 'rightArm']));
      if (appearance.bleeding) out.push(f('Wound', `Actively bleeding wound (${appearance.bleeding.site}).`, true));
      if (out.length === 0) out.push(f('Limbs', 'No deformity, wounds or swelling.', false));
      break;
    }
  }
  if (kind === 'general') out.push(...authored(scenario, ['general']));
  if (kind === 'breathing') out.push(...authored(scenario, ['chest']));
  return out;
}

export const AUSCULTATION_ZONES = [...['trachea'], ...LEFT_LUNG, ...RIGHT_LUNG, ...HEART, ...ABDO];
