/**
 * Deterministic pseudo-random number generation.
 *
 * All stochastic behaviour in the simulator (patient generation, arrhythmia
 * hazards, defibrillation outcomes, measurement noise) draws from named,
 * seeded streams whose state is part of the serialisable engine state. The
 * same seed + the same action log therefore reproduces a run exactly.
 * `Math.random()` is never used inside src/sim.
 */

/** 32-bit FNV-1a hash of a string. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** sfc32 state (four 32-bit words). */
export type RngState = [number, number, number, number];

export function seedState(seed: string, stream: string): RngState {
  const a = hashString(`${seed}::${stream}::a`);
  const b = hashString(`${seed}::${stream}::b`);
  const c = hashString(`${seed}::${stream}::c`);
  const d = hashString(`${seed}::${stream}::d`) | 1;
  const s: RngState = [a, b, c, d];
  // warm up
  for (let i = 0; i < 12; i++) nextUint(s);
  return s;
}

function nextUint(s: RngState): number {
  let [a, b, c, d] = s;
  a >>>= 0;
  b >>>= 0;
  c >>>= 0;
  d >>>= 0;
  let t = (a + b) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  d = (d + 1) | 0;
  t = (t + d) | 0;
  c = (c + t) | 0;
  s[0] = a >>> 0;
  s[1] = b >>> 0;
  s[2] = c >>> 0;
  s[3] = d >>> 0;
  return t >>> 0;
}

/** A seeded random stream. Mutates its (serialisable) state array in place. */
export class Rng {
  constructor(public state: RngState) {}

  static from(seed: string, stream: string): Rng {
    return new Rng(seedState(seed, stream));
  }

  /** Uniform in [0, 1). */
  next(): number {
    return nextUint(this.state) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box-Muller. */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Normal truncated to [min, max] by clamping (adequate for parameter generation). */
  normalClamped(mean: number, sd: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, this.normal(mean, sd)));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  weighted<T>(items: readonly { value: T; weight: number }[]): T {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = this.next() * total;
    for (const item of items) {
      r -= item.weight;
      if (r <= 0) return item.value;
    }
    return items[items.length - 1]!.value;
  }

  /**
   * Probability of at least one event in dt seconds for a Poisson hazard
   * given as events per minute.
   */
  hazard(perMinute: number, dtSeconds: number): boolean {
    if (perMinute <= 0) return false;
    const p = 1 - Math.exp(-perMinute * (dtSeconds / 60));
    return this.next() < p;
  }
}

/** Generates a short human-friendly seed such as "K7Q2-MX4P". */
export function makeSeedFromNumber(n: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let x = n >>> 0;
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[x % alphabet.length];
    x = Math.floor(x / alphabet.length) ^ Math.imul(x, 2654435761) >>> 7;
    x >>>= 0;
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
