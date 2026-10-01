/** Deterministic smooth 1-D value noise (for procedural motion). */
function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

export function noise1(x: number, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i + seed * 57.13) * (1 - u) + hash(i + 1 + seed * 57.13) * u;
}

/** Signed noise in [-1, 1] */
export function snoise1(x: number, seed = 0) {
  return noise1(x, seed) * 2 - 1;
}

export function hash01(n: number) {
  return hash(n);
}
