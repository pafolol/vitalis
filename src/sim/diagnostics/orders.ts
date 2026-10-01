import { clamp } from '../core/math';
import type { StepContext } from '../engine/state';
import type { DiagnosticOrder, ResultItem, ResultSource } from './types';
import { RHYTHM_LABEL } from '../types';

export interface TestDef {
  id: string;
  label: string;
  category: 'point-of-care' | 'laboratory' | 'imaging' | 'cardiac' | 'microbiology';
  /** Seconds from order to sample collection/acquisition */
  collectDelay: number;
  /** Seconds from collection to result */
  turnaround: number;
  description: string;
}

export const TESTS: TestDef[] = [
  { id: 'glucose', label: 'Capillary glucose (POC)', category: 'point-of-care', collectDelay: 20, turnaround: 30, description: 'Finger-prick glucose meter' },
  { id: 'vbg', label: 'Venous blood gas + lytes', category: 'point-of-care', collectDelay: 60, turnaround: 120, description: 'pH, pCO2, HCO3, lactate, Na, K, iCa, Hb, glucose' },
  { id: 'abg', label: 'Arterial blood gas', category: 'point-of-care', collectDelay: 90, turnaround: 120, description: 'pH, PaO2, PaCO2, HCO3, BE, lactate, SaO2' },
  { id: 'ketones', label: 'Blood ketones (POC)', category: 'point-of-care', collectDelay: 20, turnaround: 30, description: 'β-hydroxybutyrate' },
  { id: 'ecg12', label: '12-lead ECG', category: 'cardiac', collectDelay: 60, turnaround: 10, description: '12-lead electrocardiogram with automated measurements' },
  { id: 'cbc', label: 'Full blood count', category: 'laboratory', collectDelay: 90, turnaround: 20 * 60, description: 'Hb, Hct, WBC, platelets' },
  { id: 'bmp', label: 'Electrolytes, urea & creatinine', category: 'laboratory', collectDelay: 90, turnaround: 30 * 60, description: 'Na, K, Cl, HCO3, urea, creatinine, glucose, Ca, Mg' },
  { id: 'lft', label: 'Liver function tests', category: 'laboratory', collectDelay: 90, turnaround: 40 * 60, description: 'ALT, bilirubin, albumin' },
  { id: 'coag', label: 'Coagulation screen', category: 'laboratory', collectDelay: 90, turnaround: 30 * 60, description: 'INR, aPTT, fibrinogen' },
  { id: 'troponin', label: 'High-sensitivity troponin', category: 'laboratory', collectDelay: 90, turnaround: 45 * 60, description: 'hs-troponin (ng/L)' },
  { id: 'lactate', label: 'Lactate (POC)', category: 'point-of-care', collectDelay: 60, turnaround: 60, description: 'Venous lactate' },
  { id: 'tox', label: 'Toxicology screen', category: 'laboratory', collectDelay: 120, turnaround: 60 * 60, description: 'Urine drug screen, paracetamol & ethanol levels' },
  { id: 'urinalysis', label: 'Urinalysis (dipstick)', category: 'point-of-care', collectDelay: 300, turnaround: 60, description: 'Glucose, ketones, blood, leukocytes, nitrites' },
  { id: 'cultures', label: 'Blood cultures ×2', category: 'microbiology', collectDelay: 120, turnaround: 18 * 3600, description: 'Aerobic/anaerobic bottles' },
  { id: 'cxr', label: 'Portable chest X-ray', category: 'imaging', collectDelay: 300, turnaround: 180, description: 'AP supine/semi-erect' },
  { id: 'pocus', label: 'Point-of-care ultrasound (eFAST + echo)', category: 'imaging', collectDelay: 60, turnaround: 60, description: 'Lung sliding, B-lines, free fluid, LV/RV function, IVC' },
  { id: 'ctHead', label: 'CT head (non-contrast)', category: 'imaging', collectDelay: 20 * 60, turnaround: 15 * 60, description: 'Requires transfer to CT' },
  { id: 'ctAbdomen', label: 'CT abdomen/pelvis', category: 'imaging', collectDelay: 20 * 60, turnaround: 20 * 60, description: 'Requires transfer to CT' },
];

export const TEST_MAP: Record<string, TestDef> = Object.fromEntries(TESTS.map((t) => [t.id, t]));

export function createOrder(ctx: StepContext, testId: string): DiagnosticOrder | null {
  const def = TEST_MAP[testId];
  if (!def) return null;
  ctx.s.counter += 1;
  const order: DiagnosticOrder = {
    id: `ord${ctx.s.counter}`,
    testId,
    label: def.label,
    orderedAt: ctx.t,
    collectedAt: ctx.t + def.collectDelay,
    resultAt: ctx.t + def.collectDelay + def.turnaround,
    status: 'pending',
    items: [],
  };
  ctx.s.diagnostics.orders.push(order);
  return order;
}

export function stepDiagnostics(ctx: StepContext): void {
  for (const o of ctx.s.diagnostics.orders) {
    if (o.status !== 'pending') continue;
    if (o.items.length === 0 && ctx.t >= o.collectedAt && !o.payload?.['collected']) {
      const r = generateResult(ctx, o.testId);
      o.items = r.items;
      o.report = r.report;
      o.payload = { ...(r.payload ?? {}), collected: true };
      if (o.testId === 'ecg12' || o.testId === 'pocus' || o.testId === 'cxr') {
        ctx.emit({ kind: 'action', code: `diagnostic.collected.${o.testId}`, message: `${o.label} acquired`, severity: 'info', data: { orderId: o.id } });
      }
    }
    if (ctx.t >= o.resultAt && o.payload?.['collected']) {
      o.status = 'resulted';
      const abnormal = o.items.filter((i) => i.flag).length;
      ctx.emit({ kind: 'result', code: `result.${o.testId}`, message: `Result available: ${o.label}${abnormal ? ` (${abnormal} abnormal)` : ''}`, severity: abnormal ? 'notice' : 'info', data: { orderId: o.id } });
    }
  }
}

function num(ctx: StepContext, v: number, cv: number): number {
  return v * (1 + ctx.rng.labs.normal(0, cv));
}

function item(key: string, label: string, value: number, digits: number, unit: string, lo: number, hi: number, source: ResultSource = 'simulated', critLo?: number, critHi?: number): ResultItem {
  let flag: ResultItem['flag'] = null;
  if (critLo !== undefined && value < critLo) flag = 'LL';
  else if (critHi !== undefined && value > critHi) flag = 'HH';
  else if (value < lo) flag = 'L';
  else if (value > hi) flag = 'H';
  return { key, label, value: value.toFixed(digits), numeric: +value.toFixed(digits), unit, ref: `${lo}–${hi}`, flag, source };
}

function text(key: string, label: string, value: string, source: ResultSource, abnormal = false): ResultItem {
  return { key, label, value, source, flag: abnormal ? 'abnormal' : null };
}

interface Generated {
  items: ResultItem[];
  report?: string;
  payload?: Record<string, unknown>;
}

function hasPathology(ctx: StepContext, type: string, pred?: (p: Record<string, unknown>) => boolean): boolean {
  return ctx.s.pathologies.some((p) => p.type === type && !p.resolved && Number(p.state['startsAt'] ?? -Infinity) <= ctx.t && (!pred || pred(p.params)));
}

export function generateResult(ctx: StepContext, testId: string): Generated {
  const { phys, s } = ctx;
  const { chem, blood, resp, renal } = phys;
  const authored = s.scenario.authoredFindings;
  switch (testId) {
    case 'glucose':
      return { items: [item('glucose', 'Glucose', clamp(num(ctx, chem.glucose, 0.04), 0.6, 33.3), 1, 'mmol/L', 4, 7.8, 'simulated', 2.8, 20)] };
    case 'ketones':
      return { items: [item('bhb', 'β-hydroxybutyrate', num(ctx, chem.ketones, 0.05), 1, 'mmol/L', 0, 0.6, 'simulated', undefined, 3)] };
    case 'lactate':
      return { items: [item('lactate', 'Lactate', num(ctx, chem.lactate, 0.03), 1, 'mmol/L', 0.5, 2, 'simulated', undefined, 4)] };
    case 'abg':
    case 'vbg': {
      const arterial = testId === 'abg';
      const venousPco2 = resp.pvco2;
      const pco2 = arterial ? resp.paco2 : venousPco2;
      const hco3 = chem.hco3;
      const ph = 6.1 + Math.log10(hco3 / (0.0307 * pco2));
      const po2 = arterial ? resp.pao2 : clamp(resp.svo2 * 40 + 5, 15, 60);
      const items: ResultItem[] = [
        item('ph', 'pH', num(ctx, ph, 0.0008), 2, '', arterial ? 7.35 : 7.32, arterial ? 7.45 : 7.42, 'simulated', 7.2, 7.6),
        item('pco2', arterial ? 'PaCO2' : 'PvCO2', num(ctx, pco2 * 0.1333, 0.02), 1, 'kPa', arterial ? 4.7 : 5.5, arterial ? 6.0 : 6.8),
        item('po2', arterial ? 'PaO2' : 'PvO2', num(ctx, po2 * 0.1333, 0.02), 1, 'kPa', arterial ? 10.5 : 4, arterial ? 13.5 : 6, 'simulated', arterial ? 8 : undefined),
        item('hco3', 'HCO3−', num(ctx, hco3, 0.02), 1, 'mmol/L', 22, 28, 'simulated', 12, 40),
        item('be', 'Base excess', chem.baseExcess + ctx.rng.labs.normal(0, 0.3), 1, 'mmol/L', -2, 2),
        item('lactate', 'Lactate', num(ctx, chem.lactate, 0.03), 1, 'mmol/L', 0.5, 2, 'simulated', undefined, 4),
      ];
      if (arterial) items.push(item('sao2', 'SaO2', clamp(resp.sao2 * 100 + ctx.rng.labs.normal(0, 0.4), 0, 100), 0, '%', 94, 100));
      items.push(
        item('na', 'Na+', num(ctx, chem.na, 0.005), 0, 'mmol/L', 135, 145, 'simulated', 120, 160),
        item('k', 'K+', num(ctx, chem.k, 0.015), 1, 'mmol/L', 3.5, 5.0, 'simulated', 2.8, 6.2),
        item('ica', 'iCa2+', num(ctx, chem.ica, 0.01), 2, 'mmol/L', 1.12, 1.32, 'simulated', 0.9),
        item('hb', 'Hb', num(ctx, blood.hb * 10, 0.015), 0, 'g/L', 120, 170, 'simulated', 70),
        item('glucose', 'Glucose', num(ctx, chem.glucose, 0.02), 1, 'mmol/L', 4, 7.8, 'simulated', 2.8, 20),
      );
      items.push({ key: 'fio2', label: 'FiO2 at sampling', value: `${Math.round(resp.fio2 * 100)}%`, source: 'simulated', flag: null });
      return { items };
    }
    case 'cbc':
      return {
        items: [
          item('hb', 'Haemoglobin', num(ctx, blood.hb * 10, 0.015), 0, 'g/L', s.patient.sex === 'male' ? 130 : 115, s.patient.sex === 'male' ? 175 : 160, 'simulated', 70),
          item('hct', 'Haematocrit', num(ctx, blood.hct, 0.015), 2, '', s.patient.sex === 'male' ? 0.4 : 0.36, s.patient.sex === 'male' ? 0.52 : 0.47),
          item('wbc', 'White cells', num(ctx, blood.wbc, 0.03), 1, '×10⁹/L', 4, 11, 'simulated', 1, 30),
          item('plt', 'Platelets', num(ctx, blood.platelets, 0.03), 0, '×10⁹/L', 150, 400, 'simulated', 50),
        ],
      };
    case 'bmp': {
      const gap = chem.na - chem.cl - chem.hco3;
      return {
        items: [
          item('na', 'Sodium', num(ctx, chem.na, 0.005), 0, 'mmol/L', 135, 145, 'simulated', 120, 160),
          item('k', 'Potassium', num(ctx, chem.k, 0.015), 1, 'mmol/L', 3.5, 5.2, 'simulated', 2.8, 6.2),
          item('cl', 'Chloride', num(ctx, chem.cl, 0.008), 0, 'mmol/L', 95, 108),
          item('hco3', 'Bicarbonate', num(ctx, chem.hco3, 0.02), 0, 'mmol/L', 22, 29, 'simulated', 12),
          item('gap', 'Anion gap (calc)', gap, 0, 'mmol/L', 8, 16),
          item('urea', 'Urea', num(ctx, chem.bun / 2.8, 0.02), 1, 'mmol/L', 2.5, 7.8),
          item('creat', 'Creatinine', num(ctx, chem.creatinine * 88.4, 0.02), 0, 'µmol/L', 45, 110),
          item('glucose', 'Glucose', num(ctx, chem.glucose, 0.02), 1, 'mmol/L', 4, 7.8, 'simulated', 2.8, 20),
          item('ca', 'Calcium (corrected)', num(ctx, chem.ica * 1.95, 0.01), 2, 'mmol/L', 2.2, 2.6),
          item('mg', 'Magnesium', num(ctx, chem.mg, 0.02), 2, 'mmol/L', 0.7, 1.0),
          item('osm', 'Osmolality (calc)', chem.osmolality, 0, 'mOsm/kg', 275, 295),
        ],
      };
    }
    case 'lft':
      return {
        items: [
          item('alt', 'ALT', num(ctx, chem.alt, 0.04), 0, 'U/L', 7, 40),
          item('bili', 'Bilirubin', num(ctx, chem.bilirubin * 17.1, 0.04), 0, 'µmol/L', 3, 21),
          item('alb', 'Albumin', num(ctx, blood.albumin * 10, 0.02), 0, 'g/L', 35, 50),
        ],
      };
    case 'coag':
      return {
        items: [
          item('inr', 'INR', num(ctx, blood.inr, 0.02), 1, '', 0.9, 1.2, 'simulated', undefined, 2),
          item('aptt', 'aPTT', num(ctx, blood.aptt, 0.03), 0, 's', 25, 38),
          item('fib', 'Fibrinogen', num(ctx, blood.fibrinogen, 0.03), 1, 'g/L', 1.5, 4, 'simulated', 1),
        ],
      };
    case 'troponin':
      return { items: [item('trop', 'hs-Troponin', Math.max(2, num(ctx, chem.troponin, 0.04)), 0, 'ng/L', 0, 14)] };
    case 'tox': {
      const opioid = hasPathology(ctx, 'opioidToxicity') || Object.keys(ctx.pharm.drugs).some((d) => ['morphine', 'fentanyl', 'heroin', 'methadone'].includes(d));
      const items: ResultItem[] = [
        text('opiates', 'Opiates (urine)', opioid ? 'POSITIVE' : 'Negative', 'derived', opioid),
        text('paracetamol', 'Paracetamol level', 'Not detected', 'authored'),
        text('ethanol', 'Ethanol', 'Not detected', 'authored'),
      ];
      if (authored.toxScreen) items.push(text('tox-note', 'Toxicology comment', authored.toxScreen, 'authored', true));
      return { items };
    }
    case 'urinalysis': {
      const gl = chem.glucose > 10;
      const ket = chem.ketones > 1;
      const uti = hasPathology(ctx, 'sepsis', (p) => p['source'] === 'urinary');
      const items = [
        text('uglu', 'Glucose', gl ? (chem.glucose > 20 ? '+++' : '++') : 'Negative', 'derived', gl),
        text('uket', 'Ketones', ket ? (chem.ketones > 3 ? '+++' : '+') : 'Negative', 'derived', ket),
        text('unit', 'Nitrites', uti ? 'Positive' : 'Negative', 'derived', uti),
        text('uleu', 'Leukocytes', uti ? '+++' : 'Negative', 'derived', uti),
        text('uvol', 'Urine output since arrival', `${Math.round(renal.urineTotal)} mL`, 'simulated'),
      ];
      if (authored.urinalysis) items.push(text('ua-note', 'Comment', authored.urinalysis, 'authored', true));
      return { items };
    }
    case 'cultures':
      return { items: [text('bc', 'Blood cultures', authored.bloodCulture ?? 'Incubating — no growth reported during the case', 'authored', !!authored.bloodCulture)] };
    case 'ecg12':
      return ecg12(ctx);
    case 'cxr':
      return cxr(ctx);
    case 'pocus':
      return pocus(ctx);
    case 'ctHead':
      return { items: [text('cth', 'CT head', authored.ctHead ?? 'No acute intracranial abnormality.', 'authored', !!authored.ctHead)], report: authored.ctHead ?? 'No acute intracranial haemorrhage, mass effect or established infarct.' };
    case 'ctAbdomen': {
      const bleed = s.pathologies.find((p) => p.type === 'hemorrhage' && ['abdomen', 'pelvis'].includes(String(p.params['site'])));
      const report = authored.ctAbdomen ?? (bleed ? `Large-volume haemoperitoneum with active contrast extravasation (${String(bleed.params['site'])}).` : 'No acute intra-abdominal pathology identified.');
      return { items: [text('cta', 'CT abdomen/pelvis', report, authored.ctAbdomen ? 'authored' : 'derived', !!bleed || !!authored.ctAbdomen)], report };
    }
    default:
      return { items: [] };
  }
}

function ecg12(ctx: StepContext): Generated {
  const { cv, chem } = ctx.phys;
  const e = cv.ecg;
  const rate = Math.round(cv.hr);
  const findings: string[] = [];
  const rhythm = cv.rhythm === 'sinus' ? (rate > 100 ? 'Sinus tachycardia' : rate < 60 ? 'Sinus bradycardia' : 'Sinus rhythm') : RHYTHM_LABEL[cv.rhythm];
  if (!cv.pulsePresent && (cv.rhythm === 'sinus' || cv.rhythm === 'chb')) findings.push('Organised electrical activity — correlate with pulse check');
  const stDesc = (v: number, leads: string) => (v >= 1 ? `ST elevation ${v.toFixed(1)} mm in ${leads}` : v <= -0.8 ? `ST depression ${Math.abs(v).toFixed(1)} mm in ${leads}` : null);
  for (const d of [stDesc(e.stAnterior, 'V1–V4'), stDesc(e.stInferior, 'II, III, aVF'), stDesc(e.stLateral, 'I, aVL, V5–V6')]) if (d) findings.push(d);
  if (e.qWaves.anterior) findings.push('Q waves V1–V3');
  if (e.qWaves.inferior) findings.push('Q waves II, III, aVF');
  if (e.tWave > 1.5) findings.push('Tall, peaked T waves');
  if (e.qrsMs > 120 && cv.rhythm !== 'vtach' && cv.rhythm !== 'paced') findings.push(`Broad QRS (${Math.round(e.qrsMs)} ms)`);
  if (!e.pWave && cv.rhythm === 'sinus') findings.push('P waves flattened/absent');
  if (e.uWave > 0.3) findings.push('Prominent U waves, flattened T waves');
  if (e.qtcMs > 480) findings.push(`Prolonged QTc (${Math.round(e.qtcMs)} ms)`);
  if (cv.rhythm === 'chb') findings.push('AV dissociation with broad ventricular escape');
  if (findings.length === 0) findings.push('No acute ST changes');
  const report = `${rhythm}, ventricular rate ${rate}/min. PR ${cv.rhythm === 'sinus' ? Math.round(e.prMs) + ' ms' : '—'}, QRS ${Math.round(e.qrsMs)} ms, QTc ${Math.round(e.qtcMs)} ms. ${findings.join('. ')}.`;
  return {
    items: [
      text('rhythm', 'Rhythm', rhythm, 'simulated', cv.rhythm !== 'sinus' || rate > 100 || rate < 50),
      text('rate', 'Ventricular rate', `${rate} /min`, 'simulated', rate > 100 || rate < 50),
      text('intervals', 'Intervals', `PR ${Math.round(e.prMs)} · QRS ${Math.round(e.qrsMs)} · QTc ${Math.round(e.qtcMs)} ms`, 'simulated', e.qrsMs > 120 || e.qtcMs > 480),
      text('findings', 'Interpretation (automated)', findings.join('; '), 'derived', findings[0] !== 'No acute ST changes'),
    ],
    report,
    payload: { ecg: { ...e }, rhythm: cv.rhythm, rate, k: chem.k },
  };
}

function cxr(ctx: StepContext): Generated {
  const { resp } = ctx.phys;
  const s = ctx.s;
  const parts: { text: string; source: ResultSource; abnormal: boolean }[] = [];
  const hemi = 2600 * (s.patient.heightCm / 175) ** 2;
  for (const side of ['left', 'right'] as const) {
    const air = side === 'left' ? resp.pleuralAirLeft : resp.pleuralAirRight;
    const blood = side === 'left' ? resp.pleuralBloodLeft : resp.pleuralBloodRight;
    if (air > 150) {
      const pct = Math.round(clamp(air / hemi, 0, 1) * 100);
      const shift = air > hemi * 0.55 ? ' with mediastinal shift to the contralateral side and flattened hemidiaphragm' : '';
      parts.push({ text: `${side === 'left' ? 'Left' : 'Right'} pneumothorax, ~${pct}% of the hemithorax${shift}.`, source: 'simulated', abnormal: true });
    }
    if (blood > 250) parts.push({ text: `${side === 'left' ? 'Left' : 'Right'} pleural opacity consistent with fluid/haemothorax (~${Math.round(blood / 100) * 100} mL).`, source: 'simulated', abnormal: true });
  }
  if (resp.lungWater > 0.25) {
    const pneumonia = s.pathologies.some((p) => p.type === 'sepsis' && p.params['source'] === 'pneumonia');
    parts.push({ text: pneumonia ? 'Bilateral airspace opacities in addition to focal consolidation.' : 'Bilateral perihilar airspace shadowing, upper-lobe diversion — pulmonary oedema pattern.', source: 'simulated', abnormal: true });
  }
  if (s.pathologies.some((p) => p.type === 'sepsis' && p.params['source'] === 'pneumonia')) parts.push({ text: 'Right lower lobe consolidation with air bronchograms.', source: 'derived', abnormal: true });
  if (resp.resistance > 3) parts.push({ text: 'Hyperinflated lung fields.', source: 'simulated', abnormal: true });
  if (resp.aspirated) parts.push({ text: 'Patchy right basal opacity — possible aspiration.', source: 'simulated', abnormal: true });
  if (ctx.therapy.airway.ett) parts.push({ text: 'Endotracheal tube tip ~4 cm above the carina.', source: 'simulated', abnormal: false });
  if (ctx.therapy.procedures.chestTube.left || ctx.therapy.procedures.chestTube.right) parts.push({ text: 'Intercostal drain in situ.', source: 'simulated', abnormal: false });
  if (s.scenario.authoredFindings.chestXray) parts.push({ text: s.scenario.authoredFindings.chestXray, source: 'authored', abnormal: true });
  if (parts.length === 0) parts.push({ text: 'Lungs clear. No pneumothorax. Normal cardiomediastinal contour.', source: 'simulated', abnormal: false });
  return {
    items: parts.map((p, i) => text(`cxr${i}`, 'Finding', p.text, p.source, p.abnormal)),
    report: parts.map((p) => p.text).join(' '),
    payload: { pleuralAirLeft: resp.pleuralAirLeft, pleuralAirRight: resp.pleuralAirRight, lungWater: resp.lungWater },
  };
}

function pocus(ctx: StepContext): Generated {
  const { resp, cv } = ctx.phys;
  const s = ctx.s;
  const items: ResultItem[] = [];
  items.push(text('slidingL', 'Lung sliding — left', resp.pleuralAirLeft > 150 ? 'ABSENT (lung point seen)' : 'Present', 'simulated', resp.pleuralAirLeft > 150));
  items.push(text('slidingR', 'Lung sliding — right', resp.pleuralAirRight > 150 ? 'ABSENT (lung point seen)' : 'Present', 'simulated', resp.pleuralAirRight > 150));
  items.push(text('blines', 'B-lines', resp.lungWater > 0.2 ? 'Diffuse bilateral B-lines' : 'A-line pattern', 'simulated', resp.lungWater > 0.2));
  const pleuralFluid = resp.pleuralBloodLeft > 250 || resp.pleuralBloodRight > 250;
  items.push(text('pleural', 'Pleural fluid', pleuralFluid ? `Anechoic collection ${resp.pleuralBloodLeft > resp.pleuralBloodRight ? 'left' : 'right'} base` : 'None', 'simulated', pleuralFluid));
  const intraAbd = s.pathologies.some((p) => p.type === 'hemorrhage' && ['abdomen', 'pelvis'].includes(String(p.params['site'])) && ctx.phys.blood.cumulativeLoss > 300);
  items.push(text('fast', 'FAST (Morison / splenorenal / pelvis)', s.scenario.authoredFindings.fast ?? (intraAbd ? 'Free fluid in Morison’s pouch and pelvis' : 'No free fluid'), s.scenario.authoredFindings.fast ? 'authored' : 'derived', intraAbd || !!s.scenario.authoredFindings.fast));
  let cardiac: string;
  if (cv.rhythm === 'vfib') cardiac = 'Fibrillating myocardium, no coordinated contraction';
  else if (cv.co < 0.3) cardiac = cv.rhythm === 'asystole' ? 'Cardiac standstill' : 'Minimal/no organised ventricular contraction';
  else {
    const ef = Math.round(cv.ejectionFraction * 100);
    cardiac = `LV function ${ef >= 50 ? 'normal' : ef >= 35 ? 'mildly–moderately reduced' : 'severely reduced'} (EF ~${ef}%)${cv.rvContractility < 0.6 ? '; dilated, hypokinetic RV' : ''}${cv.lap < 4 && cv.co > 0 ? '; small, hyperdynamic ventricles' : ''}`;
  }
  items.push(text('heart', 'Cardiac', cardiac, 'simulated', cv.co < 0.3 || cv.ejectionFraction < 0.45 || cv.rvContractility < 0.6));
  items.push(text('pericardium', 'Pericardial effusion', 'None', 'simulated'));
  const ivc = cv.rap < 3 ? 'Small (<1.5 cm) with >50% inspiratory collapse' : cv.rap > 12 ? 'Plethoric (>2.5 cm), no respiratory variation' : 'Normal calibre with partial collapse';
  items.push(text('ivc', 'IVC', ivc, 'simulated', cv.rap < 3 || cv.rap > 12));
  return { items, report: items.map((i) => `${i.label}: ${i.value}`).join('. ') };
}
