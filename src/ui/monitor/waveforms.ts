import type { SimSnapshot } from '@/sim/engine/snapshot';

/**
 * Physiologically parameterised waveform synthesis for the bedside monitor.
 *
 * Nothing here is random noise pretending to be physiology: beat timing comes
 * from the simulated ventricular rate/rhythm, ECG morphology from simulated
 * intervals, ST deviation, T/U-wave amplitude, QRS width, VF amplitude and
 * pacing capture; the plethysmogram amplitude from simulated pulse pressure ×
 * peripheral perfusion; the capnogram from simulated respiratory rate,
 * EtCO2 and airway resistance (shark-fin morphology). AF irregularity uses a
 * deterministic sequence scaled by the simulated irregularity.
 */

const g = (t: number, mu: number, sigma: number) => Math.exp(-((t - mu) * (t - mu)) / (2 * sigma * sigma));

/** Deterministic pseudo-irregularity (golden-ratio low-discrepancy sequence). */
function irregular(n: number): number {
  const x = (n * 0.6180339887) % 1;
  return x * 2 - 1;
}

export interface EcgParams {
  rhythm: string;
  hr: number;
  sinusRate: number;
  qrsMs: number;
  prMs: number;
  qtcMs: number;
  st: number;
  tWave: number;
  uWave: number;
  pWave: boolean;
  vfAmp: number;
  irregularity: number;
  paced: boolean;
  capture: boolean;
  pacingRate: number;
  cpr: boolean;
  cprRate: number;
  attached: boolean;
  pause: number;
}

export function ecgParamsFrom(s: SimSnapshot): EcgParams {
  const cv = s.phys.cv;
  return {
    rhythm: cv.rhythm,
    hr: cv.hr,
    sinusRate: cv.sinusRate,
    qrsMs: cv.ecg.qrsMs,
    prMs: cv.ecg.prMs,
    qtcMs: cv.ecg.qtcMs,
    st: cv.ecg.stInferior,
    tWave: cv.ecg.tWave,
    uWave: cv.ecg.uWave,
    pWave: cv.ecg.pWave,
    vfAmp: cv.ecg.vfAmplitude,
    irregularity: cv.rrIrregularity,
    paced: cv.rhythm === 'paced',
    capture: cv.ecg.pacingCapture,
    pacingRate: s.therapy.defib.pacing.rate,
    cpr: s.therapy.cpr.active && (s.therapy.cpr.mode === 'mechanical' || s.therapy.cpr.quality > 0.05),
    cprRate: s.therapy.cpr.mode === 'mechanical' ? 102 : Math.max(60, s.therapy.cpr.rate || 100),
    attached: s.therapy.monitoring.ecg || s.therapy.defib.padsOn,
    pause: cv.pauseRemaining,
  };
}

/** Stateful ECG generator. Call `sample(dt)` at the display sample rate. */
export class EcgGenerator {
  private t = 0;
  private sinceBeat = 10;
  private rr = 1;
  private beatN = 0;
  private sinceP = 10;
  private sinceSpike = 10;
  private wander = 0;
  onBeat?: () => void;

  sample(dt: number, p: EcgParams): number {
    this.t += dt;
    this.sinceBeat += dt;
    this.sinceP += dt;
    this.sinceSpike += dt;
    this.wander = Math.sin(this.t * 0.33) * 0.03 + Math.sin(this.t * 1.1) * 0.012;
    if (!p.attached) return 0;
    let v = this.wander;
    const cprArt = p.cpr ? 0.9 * Math.sin((this.t * p.cprRate * Math.PI * 2) / 60) * (0.7 + 0.3 * Math.sin(this.t * 0.7)) : 0;

    switch (p.rhythm) {
      case 'vfib': {
        const a = 0.15 + 0.55 * p.vfAmp;
        v += a * (0.55 * Math.sin(this.t * 2 * Math.PI * 4.7 + Math.sin(this.t * 1.3) * 2) + 0.35 * Math.sin(this.t * 2 * Math.PI * 6.3 + Math.sin(this.t * 0.7) * 3) + 0.2 * Math.sin(this.t * 2 * Math.PI * 3.1));
        return v + cprArt;
      }
      case 'asystole':
        return v * 0.5 + cprArt;
      default:
        break;
    }

    const organisedPWave = p.pWave && (p.rhythm === 'sinus' || p.rhythm === 'chb' || p.rhythm === 'paced');
    // Atrial activity independent of ventricles in CHB (and during adenosine pause)
    const atrialRate = p.rhythm === 'chb' ? Math.max(50, p.sinusRate) : p.hr;
    if (organisedPWave && (p.rhythm === 'chb' || p.pause > 0)) {
      if (this.sinceP > 60 / Math.max(30, atrialRate)) this.sinceP = 0;
      v += 0.12 * g(this.sinceP, 0.05, 0.022);
    }
    if (p.rhythm === 'afib') v += 0.045 * Math.sin(this.t * 2 * Math.PI * 6.1) + 0.03 * Math.sin(this.t * 2 * Math.PI * 7.9 + 1.3);

    // Pacing spikes
    if (p.paced && p.pacingRate > 0) {
      if (this.sinceSpike > 60 / p.pacingRate) {
        this.sinceSpike = 0;
        if (p.capture) {
          this.sinceBeat = -0.02;
          this.beatN++;
          this.onBeat?.();
        }
      }
      if (this.sinceSpike < 0.004) v += 1.6;
    } else if (p.hr > 1 && p.pause <= 0) {
      if (this.sinceBeat >= this.rr) {
        this.sinceBeat = 0;
        this.beatN++;
        const base = 60 / p.hr;
        this.rr = base * (1 + p.irregularity * 1.4 * irregular(this.beatN));
        this.onBeat?.();
      }
    }

    const tb = this.sinceBeat;
    if (tb > -0.1 && tb < 1.2) {
      const wide = p.qrsMs > 120;
      const qrsScale = p.qrsMs / 90;
      const pr = p.prMs / 1000;
      if (organisedPWave && p.rhythm === 'sinus') v += 0.13 * g(tb, -pr + 0.05, 0.022);
      if (p.rhythm === 'vtach' || (p.paced && p.capture) || (wide && p.rhythm !== 'sinus')) {
        v += 1.0 * g(tb, 0.04 * qrsScale, 0.028 * qrsScale) - 0.55 * g(tb, 0.11 * qrsScale, 0.035 * qrsScale);
        v += -0.35 * g(tb, 0.32, 0.07);
      } else {
        v += -0.09 * g(tb, -0.022 * qrsScale, 0.007 * qrsScale);
        v += 1.05 * g(tb, 0, 0.0095 * qrsScale);
        v += -0.26 * g(tb, 0.024 * qrsScale, 0.009 * qrsScale);
        const qt = (p.qtcMs / 1000) * Math.sqrt(Math.max(0.3, this.rr));
        const st = p.st / 10;
        if (tb > 0.05 && tb < qt * 0.75) v += st * Math.min(1, (tb - 0.05) / 0.03);
        const tAmp = 0.28 * p.tWave;
        const tWidth = p.tWave > 1.6 ? 0.035 : 0.055;
        v += (tAmp + st * 0.4) * g(tb, qt * 0.72, tWidth);
        if (p.uWave > 0.2) v += 0.08 * p.uWave * g(tb, qt * 0.72 + 0.16, 0.04);
      }
    }
    return v + cprArt;
  }
}

export interface PlethParams {
  attached: boolean;
  amplitude: number;
  reliable: boolean;
  hr: number;
  pulse: boolean;
  cpr: boolean;
  cprRate: number;
}

export class PlethGenerator {
  private t = 0;
  private sinceBeat = 10;
  private pendingDelay = -1;
  sample(dt: number, p: PlethParams): number {
    this.t += dt;
    this.sinceBeat += dt;
    if (this.pendingDelay >= 0) {
      this.pendingDelay -= dt;
      if (this.pendingDelay < 0) this.sinceBeat = 0;
    }
    if (!p.attached) return 0;
    let v = 0;
    if (p.pulse) {
      const tb = this.sinceBeat;
      if (tb < 1.5) {
        const up = tb < 0.12 ? Math.sin(((tb / 0.12) * Math.PI) / 2) : Math.exp(-(tb - 0.12) / 0.32);
        const notch = 0.18 * g(tb, 0.34, 0.035);
        v = (up + notch) * p.amplitude;
      }
    } else if (p.cpr) {
      v = 0.18 * Math.max(0, Math.sin((this.t * p.cprRate * 2 * Math.PI) / 60));
    }
    return v;
  }
  /** Called on each QRS; the pulse wave arrives after transit time. */
  beat(): void {
    this.pendingDelay = 0.22;
  }
}

export interface CapnoParams {
  attached: boolean;
  rr: number;
  etco2: number;
  resistance: number;
  ventilated: boolean;
}

export class CapnoGenerator {
  private phase = 0;
  sample(dt: number, p: CapnoParams): number {
    if (!p.attached || p.rr < 0.5 || p.etco2 < 1) {
      this.phase = 0;
      return 0;
    }
    this.phase = (this.phase + (dt * p.rr) / 60) % 1;
    const insp = 0.35;
    if (this.phase < insp) {
      // inspiration: CO2 falls to zero quickly
      const x = this.phase / insp;
      return x < 0.12 ? p.etco2 * (1 - x / 0.12) : 0;
    }
    const x = (this.phase - insp) / (1 - insp);
    const tau = 0.05 + 0.08 * Math.max(0, p.resistance - 1);
    const rise = 1 - Math.exp(-x / tau);
    const slope = 0.92 + 0.08 * x;
    return p.etco2 * rise * slope;
  }
}

/** Arterial line waveform generated from simulated SBP/DBP and rate. */
export class ArtGenerator {
  private sinceBeat = 10;
  private pending = -1;
  sample(dt: number, sbp: number, dbp: number, pulse: boolean): number {
    this.sinceBeat += dt;
    if (this.pending >= 0) {
      this.pending -= dt;
      if (this.pending < 0) this.sinceBeat = 0;
    }
    if (!pulse) return (sbp + dbp) / 2;
    const tb = this.sinceBeat;
    const pp = sbp - dbp;
    const up = tb < 0.1 ? Math.sin(((tb / 0.1) * Math.PI) / 2) : Math.exp(-(tb - 0.1) / 0.42);
    const notch = 0.12 * g(tb, 0.3, 0.025);
    return dbp + pp * Math.min(1.05, up + notch);
  }
  beat(): void {
    this.pending = 0.08;
  }
}
