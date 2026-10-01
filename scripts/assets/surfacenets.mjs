// Volumetric helpers for procedurally derived anatomy surfaces:
// exact Euclidean distance transform (Felzenszwalb & Huttenlocher) and
// naive Surface Nets iso-surface extraction, plus Taubin smoothing.

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Squared EDT in voxel units. `seed[i]` true → distance 0. */
export function edt3d(seed, nx, ny, nz) {
  const g = new Float64Array(nx * ny * nz);
  for (let i = 0; i < g.length; i++) g[i] = seed[i] ? 0 : INF;
  const n = Math.max(nx, ny, nz);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const idx = (x, y, zz) => x + nx * (y + ny * zz);
  for (let zz = 0; zz < nz; zz++)
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) f[x] = g[idx(x, y, zz)];
      edt1d(f, nx, d, v, z);
      for (let x = 0; x < nx; x++) g[idx(x, y, zz)] = d[x];
    }
  for (let zz = 0; zz < nz; zz++)
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) f[y] = g[idx(x, y, zz)];
      edt1d(f, ny, d, v, z);
      for (let y = 0; y < ny; y++) g[idx(x, y, zz)] = d[y];
    }
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      for (let zz = 0; zz < nz; zz++) f[zz] = g[idx(x, y, zz)];
      edt1d(f, nz, d, v, z);
      for (let zz = 0; zz < nz; zz++) g[idx(x, y, zz)] = d[zz];
    }
  return g;
}

export class Grid {
  constructor(min, max, voxel, pad) {
    this.voxel = voxel;
    this.min = min.map((m) => m - pad);
    const maxP = max.map((m) => m + pad);
    this.nx = Math.ceil((maxP[0] - this.min[0]) / voxel) + 1;
    this.ny = Math.ceil((maxP[1] - this.min[1]) / voxel) + 1;
    this.nz = Math.ceil((maxP[2] - this.min[2]) / voxel) + 1;
    this.size = this.nx * this.ny * this.nz;
  }
  index(x, y, z) {
    return x + this.nx * (y + this.ny * z);
  }
  cellOf(p) {
    return [
      Math.round((p[0] - this.min[0]) / this.voxel),
      Math.round((p[1] - this.min[1]) / this.voxel),
      Math.round((p[2] - this.min[2]) / this.voxel),
    ];
  }
  /** Seeds a boolean grid from points (and densified triangle edges). */
  seedPoints(positions, indices) {
    const seed = new Uint8Array(this.size);
    const mark = (x, y, z) => {
      const [i, j, k] = this.cellOf([x, y, z]);
      if (i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz) seed[this.index(i, j, k)] = 1;
    };
    for (let i = 0; i < positions.length; i += 3) mark(positions[i], positions[i + 1], positions[i + 2]);
    if (indices) {
      // sample triangle interiors so thin surfaces seal
      for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const la = Math.hypot(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]);
        const lb = Math.hypot(positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]);
        const steps = Math.ceil(Math.max(la, lb) / (this.voxel * 0.7));
        if (steps <= 1) continue;
        for (let u = 0; u <= steps; u++)
          for (let v = 0; v <= steps - u; v++) {
            const s = u / steps, r = v / steps, q = 1 - s - r;
            mark(
              positions[a] * q + positions[b] * s + positions[c] * r,
              positions[a + 1] * q + positions[b + 1] * s + positions[c + 1] * r,
              positions[a + 2] * q + positions[b + 2] * s + positions[c + 2] * r,
            );
          }
      }
    }
    return seed;
  }
  /** Euclidean distance (world units) to the nearest seed. */
  distance(seed) {
    const d2 = edt3d(seed, this.nx, this.ny, this.nz);
    const out = new Float32Array(this.size);
    for (let i = 0; i < this.size; i++) out[i] = Math.sqrt(d2[i]) * this.voxel;
    return out;
  }
  /** Signed distance from a solid (1 = inside) */
  signed(solid) {
    const inside = new Uint8Array(this.size);
    const outside = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) {
      inside[i] = solid[i] ? 0 : 1;
      outside[i] = solid[i] ? 1 : 0;
    }
    const dOut = this.distance(outside); // distance to solid, for outside voxels
    const dIn = this.distance(inside); // distance to empty, for inside voxels
    const s = new Float32Array(this.size);
    for (let i = 0; i < this.size; i++) s[i] = solid[i] ? -dIn[i] + this.voxel * 0.5 : dOut[i] - this.voxel * 0.5;
    return s;
  }
  blur(field, passes = 1) {
    let f = field;
    const { nx, ny, nz } = this;
    for (let p = 0; p < passes; p++)
      for (const axis of [0, 1, 2]) {
        const o = new Float32Array(f.length);
        for (let z = 0; z < nz; z++)
          for (let y = 0; y < ny; y++)
            for (let x = 0; x < nx; x++) {
              const i = this.index(x, y, z);
              const nb = (dx) => {
                const xx = axis === 0 ? Math.min(nx - 1, Math.max(0, x + dx)) : x;
                const yy = axis === 1 ? Math.min(ny - 1, Math.max(0, y + dx)) : y;
                const zz = axis === 2 ? Math.min(nz - 1, Math.max(0, z + dx)) : z;
                return f[this.index(xx, yy, zz)];
              };
              o[i] = 0.25 * nb(-1) + 0.5 * f[i] + 0.25 * nb(1);
            }
        f = o;
      }
    return f;
  }
}

/** Naive surface nets on a scalar field; iso-surface where field == iso (negative = inside). */
export function surfaceNets(grid, field, iso = 0) {
  const { nx, ny, nz, voxel, min } = grid;
  const vIndex = new Int32Array(grid.size).fill(-1);
  const pos = [];
  const corner = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        const vals = corner.map(([a, b, c]) => field[grid.index(x + a, y + b, z + c)] - iso);
        let mask = 0;
        vals.forEach((v, i) => (mask |= (v < 0 ? 1 : 0) << i));
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
          const va = vals[a], vb = vals[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
          sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
          sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
          n++;
        }
        vIndex[grid.index(x, y, z)] = pos.length / 3;
        pos.push(min[0] + (x + sx / n) * voxel, min[1] + (y + sy / n) * voxel, min[2] + (z + sz / n) * voxel);
      }
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let z = 1; z < nz - 1; z++)
    for (let y = 1; y < ny - 1; y++)
      for (let x = 1; x < nx - 1; x++) {
        const f0 = field[grid.index(x, y, z)] - iso < 0;
        // edge along +x
        if (x < nx - 1) {
          const f1 = field[grid.index(x + 1, y, z)] - iso < 0;
          if (f0 !== f1)
            quad(vIndex[grid.index(x, y - 1, z - 1)], vIndex[grid.index(x, y, z - 1)], vIndex[grid.index(x, y, z)], vIndex[grid.index(x, y - 1, z)], f0);
        }
        if (y < ny - 1) {
          const f1 = field[grid.index(x, y + 1, z)] - iso < 0;
          if (f0 !== f1)
            quad(vIndex[grid.index(x - 1, y, z - 1)], vIndex[grid.index(x - 1, y, z)], vIndex[grid.index(x, y, z)], vIndex[grid.index(x, y, z - 1)], f0);
        }
        if (z < nz - 1) {
          const f1 = field[grid.index(x, y, z + 1)] - iso < 0;
          if (f0 !== f1)
            quad(vIndex[grid.index(x - 1, y - 1, z)], vIndex[grid.index(x, y - 1, z)], vIndex[grid.index(x, y, z)], vIndex[grid.index(x - 1, y, z)], f0);
        }
      }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Taubin λ|μ smoothing (volume preserving-ish). */
export function taubin(positions, indices, iterations = 10, lambda = 0.5, mu = -0.53) {
  const n = positions.length / 3;
  const nb = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    nb[a].add(b).add(c);
    nb[b].add(a).add(c);
    nb[c].add(a).add(b);
  }
  const lists = nb.map((s) => [...s]);
  let p = positions;
  const step = (factor) => {
    const out = new Float32Array(p.length);
    for (let i = 0; i < n; i++) {
      const l = lists[i];
      if (!l.length) {
        out.set(p.subarray(i * 3, i * 3 + 3), i * 3);
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (const j of l) {
        x += p[j * 3];
        y += p[j * 3 + 1];
        z += p[j * 3 + 2];
      }
      x = x / l.length - p[i * 3];
      y = y / l.length - p[i * 3 + 1];
      z = z / l.length - p[i * 3 + 2];
      out[i * 3] = p[i * 3] + factor * x;
      out[i * 3 + 1] = p[i * 3 + 1] + factor * y;
      out[i * 3 + 2] = p[i * 3 + 2] + factor * z;
    }
    p = out;
  };
  for (let i = 0; i < iterations; i++) {
    step(lambda);
    step(mu);
  }
  return p;
}
