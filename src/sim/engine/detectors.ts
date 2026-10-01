import type { StepContext } from './state';

interface Threshold {
  key: string;
  /** returns true when the abnormal condition is present */
  on: (ctx: StepContext) => boolean;
  /** returns true when it has clearly resolved (hysteresis) */
  off: (ctx: StepContext) => boolean;
  /** seconds the condition must persist */
  hold: number;
  onMsg: (ctx: StepContext) => string;
  offMsg?: (ctx: StepContext) => string;
  severity: 'warning' | 'critical' | 'notice';
  /** Whether a clinician at the bedside could observe this with current monitoring */
  observable: (ctx: StepContext) => boolean;
}

const pct = (x: number) => Math.round(x * 100);

const THRESHOLDS: Threshold[] = [
  {
    key: 'arrest',
    on: (c) => !c.phys.cv.pulsePresent,
    off: (c) => c.phys.cv.pulsePresent,
    hold: 4,
    onMsg: (c) => (c.phys.cv.rhythm === 'vfib' || c.phys.cv.rhythm === 'asystole' || c.phys.cv.rhythm === 'vtach' ? `Loss of cardiac output — ${c.phys.cv.rhythm === 'vfib' ? 'VF' : c.phys.cv.rhythm === 'vtach' ? 'pulseless VT' : 'asystole'}` : 'Loss of palpable pulse with organised electrical activity (PEA)'),
    offMsg: () => 'Return of spontaneous circulation (palpable pulse)',
    severity: 'critical',
    observable: () => true,
  },
  {
    key: 'hypoxaemia',
    on: (c) => c.phys.resp.sao2 < 0.9,
    off: (c) => c.phys.resp.sao2 > 0.93,
    hold: 10,
    onMsg: (c) => `SpO2 fell below 90% (${pct(c.phys.resp.sao2)}%)`,
    offMsg: (c) => `Oxygen saturation recovered (${pct(c.phys.resp.sao2)}%)`,
    severity: 'warning',
    observable: (c) => c.therapy.monitoring.spo2,
  },
  {
    key: 'severeHypoxaemia',
    on: (c) => c.phys.resp.sao2 < 0.8,
    off: (c) => c.phys.resp.sao2 > 0.86,
    hold: 10,
    onMsg: (c) => `Severe hypoxaemia (SpO2 ${pct(c.phys.resp.sao2)}%)`,
    severity: 'critical',
    observable: (c) => c.therapy.monitoring.spo2,
  },
  {
    key: 'hypotension',
    on: (c) => c.phys.cv.pulsePresent && c.phys.cv.map < 65,
    off: (c) => c.phys.cv.map > 70,
    hold: 20,
    onMsg: (c) => `Hypotension: MAP ${Math.round(c.phys.cv.map)} mmHg (${Math.round(c.phys.cv.sbp)}/${Math.round(c.phys.cv.dbp)})`,
    offMsg: (c) => `MAP restored to ${Math.round(c.phys.cv.map)} mmHg`,
    severity: 'warning',
    observable: (c) => c.therapy.monitoring.nibp || c.therapy.monitoring.arterialLine,
  },
  {
    key: 'tachycardia',
    on: (c) => c.phys.cv.hr > 130,
    off: (c) => c.phys.cv.hr < 115,
    hold: 20,
    onMsg: (c) => `Heart rate ${Math.round(c.phys.cv.hr)}/min`,
    offMsg: (c) => `Heart rate settled to ${Math.round(c.phys.cv.hr)}/min`,
    severity: 'notice',
    observable: (c) => c.therapy.monitoring.ecg || c.therapy.monitoring.spo2,
  },
  {
    key: 'bradycardia',
    on: (c) => c.phys.cv.pulsePresent && c.phys.cv.hr < 45,
    off: (c) => c.phys.cv.hr > 55,
    hold: 10,
    onMsg: (c) => `Bradycardia ${Math.round(c.phys.cv.hr)}/min`,
    offMsg: (c) => `Heart rate increased to ${Math.round(c.phys.cv.hr)}/min`,
    severity: 'warning',
    observable: (c) => c.therapy.monitoring.ecg || c.therapy.monitoring.spo2,
  },
  {
    key: 'apnoea',
    on: (c) => c.phys.resp.apneaTime > 20 && c.phys.cv.pulsePresent,
    off: (c) => c.phys.resp.apneaTime === 0,
    hold: 0,
    onMsg: () => 'Apnoea — no effective breaths for >20 s',
    offMsg: () => 'Breathing/ventilation resumed',
    severity: 'critical',
    observable: () => true,
  },
  {
    key: 'coma',
    on: (c) => c.phys.neuro.gcs <= 8,
    off: (c) => c.phys.neuro.gcs >= 11,
    hold: 15,
    onMsg: (c) => `Level of consciousness fell (GCS ${c.phys.neuro.gcs})`,
    offMsg: (c) => `Level of consciousness improved (GCS ${c.phys.neuro.gcs})`,
    severity: 'warning',
    observable: () => true,
  },
  {
    key: 'obstruction',
    on: (c) => c.phys.resp.airway === 'obstructed' && c.phys.resp.drive > 0.2,
    off: (c) => c.phys.resp.airway === 'patent' || c.phys.resp.airway === 'secured',
    hold: 5,
    onMsg: () => 'Upper airway obstruction',
    offMsg: () => 'Airway patency improved',
    severity: 'critical',
    observable: () => true,
  },
  {
    key: 'hypoglycaemia',
    on: (c) => c.phys.chem.glucose < 3,
    off: (c) => c.phys.chem.glucose > 4,
    hold: 10,
    onMsg: (c) => `Blood glucose ${c.phys.chem.glucose.toFixed(1)} mmol/L`,
    offMsg: (c) => `Blood glucose recovered (${c.phys.chem.glucose.toFixed(1)} mmol/L)`,
    severity: 'warning',
    observable: () => false,
  },
  {
    key: 'hyperkalaemia',
    on: (c) => c.phys.chem.k > 6.5,
    off: (c) => c.phys.chem.k < 6,
    hold: 10,
    onMsg: (c) => `Potassium ${c.phys.chem.k.toFixed(1)} mmol/L`,
    offMsg: (c) => `Potassium fell to ${c.phys.chem.k.toFixed(1)} mmol/L`,
    severity: 'warning',
    observable: () => false,
  },
  {
    key: 'hypokalaemia',
    on: (c) => c.phys.chem.k < 3,
    off: (c) => c.phys.chem.k > 3.4,
    hold: 10,
    onMsg: (c) => `Potassium ${c.phys.chem.k.toFixed(1)} mmol/L`,
    offMsg: (c) => `Potassium recovered to ${c.phys.chem.k.toFixed(1)} mmol/L`,
    severity: 'warning',
    observable: () => false,
  },
  {
    key: 'acidaemia',
    on: (c) => c.phys.chem.ph < 7.15,
    off: (c) => c.phys.chem.ph > 7.22,
    hold: 20,
    onMsg: (c) => `Severe acidaemia (pH ${c.phys.chem.ph.toFixed(2)})`,
    offMsg: (c) => `pH improved to ${c.phys.chem.ph.toFixed(2)}`,
    severity: 'warning',
    observable: () => false,
  },
  {
    key: 'hypothermia',
    on: (c) => c.phys.thermo.core < 35,
    off: (c) => c.phys.thermo.core > 35.5,
    hold: 30,
    onMsg: (c) => `Core temperature ${c.phys.thermo.core.toFixed(1)} °C`,
    offMsg: (c) => `Core temperature ${c.phys.thermo.core.toFixed(1)} °C`,
    severity: 'notice',
    observable: (c) => c.therapy.monitoring.temp,
  },
  {
    key: 'fever',
    on: (c) => c.phys.thermo.core > 38.5,
    off: (c) => c.phys.thermo.core < 38,
    hold: 30,
    onMsg: (c) => `Fever ${c.phys.thermo.core.toFixed(1)} °C`,
    offMsg: (c) => `Temperature ${c.phys.thermo.core.toFixed(1)} °C`,
    severity: 'notice',
    observable: (c) => c.therapy.monitoring.temp,
  },
  {
    key: 'pulmOedema',
    on: (c) => c.phys.resp.lungWater > 0.35,
    off: (c) => c.phys.resp.lungWater < 0.25,
    hold: 20,
    onMsg: () => 'Pulmonary oedema developing (crackles)',
    offMsg: () => 'Pulmonary oedema improving',
    severity: 'warning',
    observable: () => false,
  },
];

export function detectEvents(ctx: StepContext): void {
  const d = ctx.s.detectors;
  for (const th of THRESHOLDS) {
    const stateKey = `th_${th.key}`;
    const sinceKey = `th_${th.key}_since`;
    const active = d[stateKey] === true;
    if (!active) {
      if (th.on(ctx)) {
        const since = typeof d[sinceKey] === 'number' ? (d[sinceKey] as number) : ctx.t;
        d[sinceKey] = since;
        if (ctx.t - since >= th.hold) {
          d[stateKey] = true;
          d[`${stateKey}_at`] = ctx.t;
          ctx.emit({ kind: 'physiology', code: `phys.${th.key}`, message: th.onMsg(ctx), severity: th.severity, data: { observable: th.observable(ctx), detector: th.key } });
        }
      } else {
        delete d[sinceKey];
      }
    } else if (th.off(ctx)) {
      d[stateKey] = false;
      delete d[sinceKey];
      if (th.offMsg) {
        const duration = ctx.t - Number(d[`${stateKey}_at`] ?? ctx.t);
        ctx.emit({ kind: 'physiology', code: `phys.${th.key}.resolved`, message: th.offMsg(ctx), severity: th.key === 'arrest' ? 'good' : 'good', data: { observable: th.observable(ctx), detector: th.key, duration } });
        if (th.key === 'arrest') ctx.s.status.rosc = true;
      }
    }
  }
}
