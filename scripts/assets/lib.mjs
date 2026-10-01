// Shared helpers for the asset build scripts (Node, no dependencies beyond the stdlib).
import fs from 'node:fs';
import path from 'node:path';

export async function ensureFile(localPath, url) {
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) return;
  if (!url) throw new Error(`Missing required asset: ${localPath}`);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  fs.writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
}

/** Minimal OBJ parser keeping group membership and per-corner vt indices. */
export function parseObj(text) {
  const v = [];
  const vt = [];
  const groups = new Map();
  let current = 'default';
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('v ')) {
      const p = line.trim().split(/\s+/);
      v.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('vt ')) {
      const p = line.trim().split(/\s+/);
      vt.push(+p[1], +p[2]);
    } else if (line.startsWith('g ') || line.startsWith('o ')) {
      current = line.trim().split(/\s+/)[1] ?? 'default';
      if (!groups.has(current)) groups.set(current, []);
    } else if (line.startsWith('f ')) {
      const corners = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((c) => {
          const [a, b] = c.split('/');
          return [parseInt(a, 10) - 1, b ? parseInt(b, 10) - 1 : -1];
        });
      if (!groups.has(current)) groups.set(current, []);
      groups.get(current).push(corners);
    }
  }
  return { v: new Float32Array(v), vt: new Float32Array(vt), groups };
}

/** MakeHuman .target: lines "index dx dy dz" */
export function parseTarget(text) {
  const idx = [];
  const d = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    idx.push(parseInt(p[0], 10));
    d.push(+p[1], +p[2], +p[3]);
  }
  return { idx, d };
}

/** Collects typed arrays into a single binary blob with 4-byte alignment. */
export class BinWriter {
  constructor() {
    this.chunks = [];
    this.offset = 0;
  }
  add(typed) {
    const pad = (4 - (this.offset % 4)) % 4;
    if (pad) {
      this.chunks.push(Buffer.alloc(pad));
      this.offset += pad;
    }
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const ref = { offset: this.offset, length: typed.length, type: typed.constructor.name };
    this.chunks.push(buf);
    this.offset += buf.byteLength;
    return ref;
  }
  toBuffer() {
    return Buffer.concat(this.chunks);
  }
}

/** Quantise a sparse delta list into Uint16 indices + Int16 deltas with a per-target scale. */
export function quantiseSparse(bin, idx, d, minAbs = 1e-6) {
  const keepIdx = [];
  const keepD = [];
  let maxAbs = 0;
  for (let i = 0; i < idx.length; i++) {
    const x = d[i * 3];
    const y = d[i * 3 + 1];
    const z = d[i * 3 + 2];
    if (Math.abs(x) < minAbs && Math.abs(y) < minAbs && Math.abs(z) < minAbs) continue;
    keepIdx.push(idx[i]);
    keepD.push(x, y, z);
    maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y), Math.abs(z));
  }
  const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
  const qi = new Uint16Array(keepIdx);
  const qd = new Int16Array(keepD.length);
  for (let i = 0; i < keepD.length; i++) qd[i] = Math.round(keepD[i] / scale);
  return { idx: bin.add(qi), delta: bin.add(qd), scale, count: keepIdx.length };
}

export function fmtBytes(n) {
  return n > 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} kB`;
}
