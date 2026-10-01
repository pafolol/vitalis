import { clamp } from '../core/math';

/**
 * Blood-gas relationships.
 * - Oxyhaemoglobin dissociation: Severinghaus (1979) equation with Kelman-style
 *   "virtual PO2" correction for pH, temperature and PCO2 (Bohr/temperature shifts).
 * - O2 content: 1.34·Hb·SaO2 + 0.003·PO2 (mL O2/dL).
 * - Plasma oncotic pressure: Landis–Pappenheimer polynomial of total protein (g/dL).
 */

export function virtualPo2(po2: number, ph: number, tempC: number, pco2: number): number {
  const exp = 0.024 * (37 - tempC) + 0.4 * (ph - 7.4) + 0.06 * Math.log10(40 / Math.max(5, pco2));
  return po2 * Math.pow(10, exp);
}

/** Saturation 0..1 from PO2 (mmHg). */
export function saturation(po2: number, ph = 7.4, tempC = 37, pco2 = 40): number {
  const p = Math.max(0.1, virtualPo2(po2, ph, tempC, pco2));
  return 1 / (23400 / (p * p * p + 150 * p) + 1);
}

export function o2Content(hb: number, sat: number, po2: number): number {
  return 1.34 * hb * sat + 0.003 * po2;
}

/** Inverse: PO2 that yields a given O2 content (bisection). */
export function po2FromContent(content: number, hb: number, ph: number, tempC: number, pco2: number): number {
  let lo = 0.5;
  let hi = 700;
  const maxContent = o2Content(hb, saturation(hi, ph, tempC, pco2), hi);
  if (content >= maxContent) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const c = o2Content(hb, saturation(mid, ph, tempC, pco2), mid);
    if (c < content) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Colloid oncotic pressure (mmHg) from total protein concentration (g/dL). */
export function oncoticPressure(proteinGdL: number): number {
  const c = clamp(proteinGdL, 0, 15);
  return 2.1 * c + 0.16 * c * c + 0.009 * c * c * c;
}

export function phFrom(hco3: number, paco2: number): number {
  return 6.1 + Math.log10(Math.max(0.5, hco3) / (0.0307 * Math.max(2, paco2)));
}

/** Standard base excess (Van Slyke, simplified). */
export function baseExcess(hco3: number, ph: number): number {
  return 0.93 * (hco3 - 24.4 + 14.8 * (ph - 7.4));
}

export const ATM = 760;
export const WATER_VAPOUR = 47;
