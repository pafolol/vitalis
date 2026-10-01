export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Sigmoid Emax / Hill equation, returns 0..1 of Emax. */
export function hill(c: number, ec50: number, gamma = 1): number {
  if (c <= 0 || ec50 <= 0) return 0;
  const r = Math.pow(c / ec50, gamma);
  return r / (1 + r);
}

/** Smooth ramp: 0 at x<=a, 1 at x>=b, smoothstep in between. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Linear ramp 0..1 between a and b (a may be > b for descending ramps). */
export function ramp(a: number, b: number, x: number): number {
  return clamp01((x - a) / (b - a));
}

/** First-order lag toward target with time constant tau (seconds). */
export function approach(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export const round = (v: number, digits = 0): number => {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
};

/** Stable 32-bit hash of a JSON-able value — used for determinism checks. */
export function stableHash(value: unknown): string {
  const json = JSON.stringify(value, (_k, v) => (typeof v === 'number' ? Number(v.toPrecision(12)) : v));
  let h1 = 0xdeadbeef ^ json.length;
  let h2 = 0x41c6ce57 ^ json.length;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
