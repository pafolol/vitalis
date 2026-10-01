#!/usr/bin/env node
/**
 * Builds the anatomy layers from BodyParts3D (© The Database Center for Life
 * Science, CC BY 4.0 per the current licence page; the OBJ headers state
 * CC BY-SA 2.1 JP — see ASSETS.md).
 *
 * For each layer we select structures, merge their element OBJ files, convert
 * them to MakeHuman axes (+Y up, +Z anterior, +X patient-left; metres; BP3D
 * origin), simplify with meshoptimizer and write one meshopt-compressed GLB per
 * layer plus public/assets/anatomy/anatomy-index.json.
 *
 * A few surfaces are *derived* because BodyParts3D 4.0 (part-of) does not
 * contain them as closed meshes:
 *   - lungs: envelope of the real bronchial tree + intrapulmonary vessels
 *   - ventricular myocardium: real cavities dilated by typical wall thickness,
 *     united with the real atrial walls
 *   - spinal cord: real central canal dilated to cord radius
 * These are flagged `derived: true` in the index and documented in ASSETS.md.
 *
 * The runtime (src/three/anatomy) fits everything to each patient's body using
 * the reference landmarks written to the index.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt, quantize, prune, dedup } from '@gltf-transform/functions';
import { Grid, surfaceNets, taubin } from './surfacenets.mjs';
import { fmtBytes } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'assets-src/bp3d');
const OBJ_DIR = path.join(SRC, 'partof_BP3D_4.0_obj_99');
const OUT = path.join(ROOT, 'public/assets/anatomy');
const ZIP_URL = 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/partof_BP3D_4.0_obj_99.zip';

// ------------------------------------------------------------------ element catalogue
function readCatalogue() {
  if (!fs.existsSync(OBJ_DIR)) {
    throw new Error(`BodyParts3D OBJ files not found in ${OBJ_DIR}.\nDownload ${ZIP_URL} and extract it into assets-src/bp3d/.`);
  }
  const byName = new Map();
  for (const f of fs.readdirSync(OBJ_DIR)) {
    if (!f.endsWith('.obj')) continue;
    const fd = fs.openSync(path.join(OBJ_DIR, f), 'r');
    const buf = Buffer.alloc(1200);
    fs.readSync(fd, buf, 0, 1200, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8');
    const name = /# English name : (.*)/.exec(head)?.[1]?.trim();
    const fma = /# Concept ID : (.*)/.exec(head)?.[1]?.trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ file: f, fma });
  }
  return byName;
}

const cache = new Map();
function loadObj(file) {
  if (cache.has(file)) return cache.get(file);
  const text = fs.readFileSync(path.join(OBJ_DIR, file), 'utf8');
  const v = [];
  const f = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      // BP3D: mm, +X left, -Y anterior, +Z up  →  MH axes, metres
      v.push(+p[1] / 1000, +p[3] / 1000, -+p[2] / 1000);
    } else if (line.startsWith('f ')) {
      const p = line.trim().split(/\s+/).slice(1).map((c) => parseInt(c, 10) - 1);
      for (let k = 1; k + 1 < p.length; k++) f.push(p[0], p[k], p[k + 1]);
    }
  }
  const r = { positions: new Float32Array(v), indices: new Uint32Array(f) };
  cache.set(file, r);
  return r;
}

function merge(meshes) {
  let nv = 0;
  let ni = 0;
  for (const m of meshes) {
    nv += m.positions.length;
    ni += m.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let ov = 0;
  let oi = 0;
  for (const m of meshes) {
    positions.set(m.positions, ov);
    for (let i = 0; i < m.indices.length; i++) indices[oi + i] = m.indices[i] + ov / 3;
    ov += m.positions.length;
    oi += m.indices.length;
  }
  return { positions, indices };
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  return { min, max };
}

function weld(mesh, eps = 1e-6) {
  const map = new Map();
  const remap = new Uint32Array(mesh.positions.length / 3);
  const out = [];
  for (let i = 0; i < remap.length; i++) {
    const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
    const k = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let j = map.get(k);
    if (j === undefined) {
      j = out.length / 3;
      map.set(k, j);
      out.push(x, y, z);
    }
    remap[i] = j;
  }
  const idx = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = remap[mesh.indices[t]], b = remap[mesh.indices[t + 1]], c = remap[mesh.indices[t + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(idx) };
}

function compact(positions, indices, extra) {
  const map = new Int32Array(positions.length / 3).fill(-1);
  const pos = [];
  const ex = extra ? [] : null;
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (map[v] < 0) {
      map[v] = pos.length / 3;
      pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
      if (ex) ex.push(extra[v * 3], extra[v * 3 + 1], extra[v * 3 + 2]);
    }
    idx[i] = map[v];
  }
  return { positions: new Float32Array(pos), indices: idx, extra: ex ? new Float32Array(ex) : null };
}

function simplify(mesh, ratio, maxError = 0.0015) {
  const w = weld(mesh);
  const target = Math.max(36, Math.floor((w.indices.length * ratio) / 3) * 3);
  if (target >= w.indices.length) return w;
  const [idx] = MeshoptSimplifier.simplify(w.indices, w.positions, 3, target, maxError, ['LockBorder']);
  const c = compact(w.positions, idx);
  return { positions: c.positions, indices: c.indices };
}

function normalsOf(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const x = e1[1] * e2[2] - e1[2] * e2[1], y = e1[2] * e2[0] - e1[0] * e2[2], z = e1[0] * e2[1] - e1[1] * e2[0];
    for (const v of [a, b, c]) {
      n[v] += x;
      n[v + 1] += y;
      n[v + 2] += z;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

// ------------------------------------------------------------------ derived surfaces
function derivedSurface(sources, opts) {
  const all = merge(sources);
  const b = bounds(all.positions);
  const grid = new Grid(b.min, b.max, opts.voxel, opts.dilate + opts.voxel * 4);
  const seed = grid.seedPoints(all.positions, all.indices);
  let dist = grid.distance(seed);
  // solid = within dilation radius; optional closing (erode) for smooth hulls
  let solid = new Uint8Array(grid.size);
  for (let i = 0; i < grid.size; i++) solid[i] = dist[i] <= opts.dilate ? 1 : 0;
  if (opts.fillHoles) {
    // fill enclosed cavities: flood fill empty space from the border
    const outside = new Uint8Array(grid.size);
    const stack = [];
    const { nx, ny, nz } = grid;
    const push = (x, y, z) => {
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
      const i = grid.index(x, y, z);
      if (outside[i] || solid[i]) return;
      outside[i] = 1;
      stack.push(i);
    };
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
      push(x, y, 0);
      push(x, y, nz - 1);
    }
    for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
      push(x, 0, z);
      push(x, ny - 1, z);
    }
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
      push(0, y, z);
      push(nx - 1, y, z);
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      push(x + 1, y, z);
      push(x - 1, y, z);
      push(x, y + 1, z);
      push(x, y - 1, z);
      push(x, y, z + 1);
      push(x, y, z - 1);
    }
    for (let i = 0; i < grid.size; i++) if (!outside[i]) solid[i] = 1;
  }
  if (opts.erode) {
    // morphological closing: erode the dilated solid (removes lumps between branches)
    const empty = new Uint8Array(grid.size);
    for (let i = 0; i < grid.size; i++) empty[i] = solid[i] ? 0 : 1;
    const dOut = grid.distance(empty);
    for (let i = 0; i < grid.size; i++) solid[i] = dOut[i] > opts.erode ? 1 : 0;
  }
  let sdf = grid.signed(solid);
  sdf = grid.blur(sdf, opts.blur ?? 2);
  const surf = surfaceNets(grid, sdf, 0);
  // orient triangles outward using the SDF gradient
  const sample = (p) => {
    const [i, j, k] = grid.cellOf(p);
    const c = (x, y, z) => sdf[grid.index(Math.min(grid.nx - 1, Math.max(0, x)), Math.min(grid.ny - 1, Math.max(0, y)), Math.min(grid.nz - 1, Math.max(0, z)))];
    return [c(i + 1, j, k) - c(i - 1, j, k), c(i, j + 1, k) - c(i, j - 1, k), c(i, j, k + 1) - c(i, j, k - 1)];
  };
  const P = surf.positions;
  const I = surf.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const cen = [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
    const g = sample(cen);
    if (n[0] * g[0] + n[1] * g[1] + n[2] * g[2] < 0) {
      const tmp = I[t + 1];
      I[t + 1] = I[t + 2];
      I[t + 2] = tmp;
    }
  }
  const smoothed = taubin(P, I, opts.smooth ?? 8);
  return { positions: smoothed, indices: I };
}

// ------------------------------------------------------------------ structure definitions
const LR = (s) => [`Left ${s}`, `Right ${s}`];
const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * mode: how the runtime fits the structure to the patient
 *   torso   – piecewise trunk mapping (rigid, single bone chosen by height)
 *   head    – similarity fit of skull/eyes to the patient's head
 *   neck    – blend of head and torso mapping
 *   seg:<segment> – limb segment mapping (humerus, forearm, hand, thigh, leg, foot, fingerN-k)
 * skin: 'rigid' (single bone) or 'soft' (weights copied from the nearest skin vertex)
 */
const S = [];
function add(id, label, layer, system, names, o = {}) {
  S.push({ id, label, layer, system, names, mode: 'torso', skin: 'rigid', ratio: 0.35, channel: null, desc: '', ...o });
}

// ---------------- skeleton
add('skull', 'Skull (cranium & facial bones)', 'skeleton', 'Skeletal', [
  'Frontal bone', 'Occipital bone', 'Sphenoid bone', 'Ethmoid', 'Vomer',
  ...LR('parietal bone'), ...LR('temporal bone'), ...LR('zygomatic bone'), ...LR('maxilla'), ...LR('nasal bone'),
  ...LR('lacrimal bone'), ...LR('palatine bone'), ...LR('inferior nasal concha'),
], { mode: 'head', ratio: 0.3, desc: 'Protects the brain and forms the face; the orbit, nasal cavity and jaw attachments are visible.' });
add('mandible', 'Mandible', 'skeleton', 'Skeletal', ['Mandible'], { mode: 'head', ratio: 0.5, desc: 'The lower jaw; jaw thrust lifts it forwards to open an obstructed airway.' });
add('hyoid', 'Hyoid bone', 'skeleton', 'Skeletal', ['Hyoid bone'], { mode: 'neck', ratio: 0.6, desc: 'U-shaped bone anchoring the tongue and larynx.' });
const cervical = [['atlas', 'Atlas'], ['axis', 'Axis'], ...['third', 'fourth', 'fifth', 'sixth', 'seventh'].map((o) => [`c-${o}`, `${cap(o)} cervical vertebra`])];
for (const [id, n] of cervical) add(`vertebra-${id}`, n === 'Atlas' ? 'Atlas (C1)' : n === 'Axis' ? 'Axis (C2)' : n, 'skeleton', 'Skeletal', [n], { mode: 'neck', ratio: 0.35, desc: 'Cervical vertebra; the cervical spine is immobilised when spinal injury is suspected.' });
ordinal.forEach((o, i) => add(`vertebra-t${i + 1}`, `${cap(o)} thoracic vertebra (T${i + 1})`, 'skeleton', 'Skeletal', [`${cap(o)} thoracic vertebra`], { ratio: 0.35, desc: 'Thoracic vertebra articulating with a pair of ribs.' }));
ordinal.slice(0, 5).forEach((o, i) => add(`vertebra-l${i + 1}`, `${cap(o)} lumbar vertebra (L${i + 1})`, 'skeleton', 'Skeletal', [`${cap(o)} lumbar vertebra`], { ratio: 0.35, desc: 'Lumbar vertebra; lumbar puncture is performed below the end of the spinal cord (L3–L5).' }));
add('sacrum', 'Sacrum', 'skeleton', 'Skeletal', ['Sacrum'], { ratio: 0.35, desc: 'Fused sacral vertebrae forming the back of the pelvis.' });
add('intervertebral-discs', 'Intervertebral discs', 'skeleton', 'Skeletal', ['Intervertebral disk', ...[
  'axis', 'third cervical vertebra', 'fourth cervical vertebra', 'fifth cervical vertebra', 'sixth cervical vertebra', 'seventh cervical vertebra',
  ...ordinal.map((o) => `${o} thoracic vertebra`), ...ordinal.slice(0, 5).map((o) => `${o} lumbar vertebra`),
].map((s) => `Intervertebral disk of ${s}`)], { ratio: 0.25, skin: 'soft', desc: 'Fibrocartilaginous discs between vertebral bodies.' });
for (const side of ['Left', 'Right']) {
  ordinal.forEach((o, i) => add(`rib-${side[0].toLowerCase()}${i + 1}`, `${side} ${o} rib`, 'skeleton', 'Skeletal', [`${side} ${o} rib`], { ratio: 0.3, desc: i === 1 ? 'The 2nd intercostal space (below this rib) in the mid-clavicular line is a needle-decompression site.' : 'Rib of the thoracic cage; rib fractures impair ventilation and can injure the lung.' }));
  add(`costal-cartilages-${side[0].toLowerCase()}`, `${side} costal cartilages`, 'skeleton', 'Skeletal', ordinal.slice(0, 7).map((o) => `${side} ${o} costal cartilage`), { ratio: 0.35, desc: 'Cartilage joining the ribs to the sternum; it gives the chest wall its compliance during CPR.' });
}
add('sternum', 'Sternum', 'skeleton', 'Skeletal', ['Manubrium', 'Body of sternum', 'Xiphoid process'], { ratio: 0.5, desc: 'Breastbone. CPR compressions are delivered on the lower half of the sternum, 5–6 cm deep in adults.' });
for (const side of ['Left', 'Right']) {
  const s = side[0].toLowerCase();
  const seg = (n) => `${n}${side === 'Left' ? 'L' : 'R'}`;
  add(`clavicle-${s}`, `${side} clavicle`, 'skeleton', 'Skeletal', [`${side} clavicle`], { ratio: 0.5, bone: `clavicle.${side[0]}`, desc: 'Collarbone; the mid-clavicular line is a landmark for chest procedures.' });
  add(`scapula-${s}`, `${side} scapula`, 'skeleton', 'Skeletal', [`${side} scapula`], { ratio: 0.2, bone: `clavicle.${side[0]}`, desc: 'Shoulder blade.' });
  add(`humerus-${s}`, `${side} humerus`, 'skeleton', 'Skeletal', [`${side} humerus`], { mode: `seg:${seg('upperArm')}`, ratio: 0.3, desc: 'Upper-arm bone; the proximal humerus is an intraosseous access site.' });
  add(`radius-ulna-${s}`, `${side} radius and ulna`, 'skeleton', 'Skeletal', [`${side} radius`, `${side} ulna`], { mode: `seg:${seg('forearm')}`, ratio: 0.5, desc: 'Forearm bones; the radial artery runs along the radius at the wrist.' });
  add(`carpals-${s}`, `${side} carpal bones`, 'skeleton', 'Skeletal', ['scaphoid', 'lunate', 'triquetral', 'pisiform', 'trapezium', 'trapezoid', 'capitate', 'hamate'].map((b) => `${side} ${b}`), { mode: `seg:${seg('hand')}`, ratio: 0.5, desc: 'Wrist bones.' });
  add(`metacarpals-${s}`, `${side} metacarpals`, 'skeleton', 'Skeletal', ['first', 'second', 'third', 'fourth', 'fifth'].map((o) => `${side} ${o} metacarpal bone`), { mode: `seg:${seg('hand')}`, ratio: 0.5, desc: 'Bones of the palm.' });
  const fingers = [['thumb', 1], ['index finger', 2], ['middle finger', 3], ['ring finger', 4], ['little finger', 5]];
  for (const [fname, fi] of fingers) {
    const phal = fi === 1 ? [['Proximal', 2], ['Distal', 3]] : [['Proximal', 1], ['Middle', 2], ['Distal', 3]];
    for (const [pn, k] of phal)
      add(`phalanx-${s}-${fi}-${k}`, `${pn} phalanx of ${side.toLowerCase()} ${fname}`, 'skeleton', 'Skeletal', [`${pn} phalanx of ${side.toLowerCase()} ${fname}`], { mode: `seg:finger${fi}-${k}.${side[0]}`, ratio: 0.6, desc: 'Finger bone.' });
  }
  add(`hip-bone-${s}`, `${side} hip bone`, 'skeleton', 'Skeletal', [`${side} hip bone`], { ratio: 0.35, bone: 'root', desc: 'Pelvic bone (ilium, ischium, pubis). Pelvic fractures can cause life-threatening haemorrhage.' });
  add(`femur-${s}`, `${side} femur`, 'skeleton', 'Skeletal', [`${side} femur`], { mode: `seg:${seg('thigh')}`, ratio: 0.35, desc: 'Thigh bone; a femoral shaft fracture can conceal 1–1.5 L of blood.' });
  add(`patella-${s}`, `${side} patella`, 'skeleton', 'Skeletal', [`${side} patella`], { mode: `seg:${seg('thigh')}`, ratio: 0.7, desc: 'Kneecap.' });
  add(`tibia-fibula-${s}`, `${side} tibia and fibula`, 'skeleton', 'Skeletal', [`${side} tibia`, `${side} fibula`], { mode: `seg:${seg('leg')}`, ratio: 0.4, desc: 'Leg bones; the flat anteromedial proximal tibia is the commonest intraosseous access site.' });
  add(`foot-bones-${s}`, `${side} foot bones`, 'skeleton', 'Skeletal', [
    `${side} talus`, `${side} calcaneus`, `Navicular bone of ${side.toLowerCase()} foot`, `${side} cuboid bone`, `${side} medial cuneiform bone`, `${side} intermediate cuneiform bone`, `${side} lateral cuneiform bone`,
    ...['first', 'second', 'third', 'fourth', 'fifth'].map((o) => `${side} ${o} metatarsal bone`),
    ...['big toe', 'second toe', 'third toe', 'fourth toe', 'little toe'].flatMap((t) => ['Proximal', 'Middle', 'Distal'].map((p) => `${p} phalanx of ${side.toLowerCase()} ${t}`)),
  ], { mode: `seg:${seg('foot')}`, ratio: 0.4, desc: 'Tarsal, metatarsal and toe bones.' });
}

// ---------------- muscle
for (const side of ['Left', 'Right']) {
  const s = side[0].toLowerCase();
  add(`pectoralis-major-${s}`, `${side} pectoralis major`, 'muscle', 'Muscular', [`Sternocostal part of ${side.toLowerCase()} pectoralis major`, `Abdominal part of ${side.toLowerCase()} pectoralis major`], { skin: 'soft', ratio: 0.3, desc: 'Large chest muscle; an accessory muscle of inspiration when the arms are fixed.' });
  add(`pectoralis-minor-${s}`, `${side} pectoralis minor`, 'muscle', 'Muscular', [`${side} pectoralis minor`], { skin: 'soft', ratio: 0.3, desc: 'Lifts the ribs during forced inspiration.' });
  add(`serratus-anterior-${s}`, `${side} serratus anterior`, 'muscle', 'Muscular', [`${side} serratus anterior`], { skin: 'soft', ratio: 0.12, desc: 'Protracts the scapula; lies over the ribs at the chest-drain "safe triangle".' });
  add(`external-oblique-${s}`, `${side} external oblique`, 'muscle', 'Muscular', [`${side} external oblique`], { skin: 'soft', ratio: 0.06, desc: 'Abdominal wall muscle; recruited for active (forced) expiration.' });
  add(`rhomboids-${s}`, `${side} rhomboids`, 'muscle', 'Muscular', [`${side} rhomboid major`, `${side} rhomboid minor`], { skin: 'soft', ratio: 0.25, desc: 'Retract the scapula.' });
  add(`levator-scapulae-${s}`, `${side} levator scapulae`, 'muscle', 'Muscular', [`${side} levator scapulae`], { mode: 'neck', skin: 'soft', ratio: 0.3, desc: 'Elevates the scapula.' });
  add(`subclavius-${s}`, `${side} subclavius`, 'muscle', 'Muscular', [`${side} subclavius`], { skin: 'soft', ratio: 0.4, desc: 'Small muscle beneath the clavicle.' });
  add(`transversus-thoracis-${s}`, `${side} transversus thoracis`, 'muscle', 'Muscular', [`${side} transversus thoracis`], { skin: 'soft', ratio: 0.3, desc: 'Thin muscle on the inner anterior chest wall.' });
  add(`psoas-${s}`, `${side} psoas major`, 'muscle', 'Muscular', [`${side} psoas major`], { skin: 'soft', ratio: 0.3, desc: 'Hip flexor running beside the lumbar spine.' });
  add(`piriformis-${s}`, `${side} piriformis`, 'muscle', 'Muscular', [`${side} piriformis`], { skin: 'soft', ratio: 0.5, desc: 'Deep gluteal muscle.' });
  add(`obturator-internus-${s}`, `${side} obturator internus`, 'muscle', 'Muscular', [`${side} obturator internus`], { skin: 'soft', ratio: 0.4, desc: 'Lateral rotator of the hip lining the pelvic wall.' });
  add(`anconeus-${s}`, `${side} anconeus`, 'muscle', 'Muscular', [`${side} anconeus`], { mode: `seg:forearm${side === 'Left' ? 'L' : 'R'}`, skin: 'soft', ratio: 0.5, desc: 'Small elbow extensor.' });
}
add('brachialis-l', 'Left brachialis', 'muscle', 'Muscular', ['Left brachialis'], { mode: 'seg:upperArmL', skin: 'soft', ratio: 0.5, desc: 'Elbow flexor lying under biceps.' });
add('coracobrachialis-l', 'Left coracobrachialis', 'muscle', 'Muscular', ['Left coracobrachialis'], { mode: 'seg:upperArmL', skin: 'soft', ratio: 0.6, desc: 'Flexes and adducts the arm.' });

// ---------------- superficial structures
for (const side of ['Left', 'Right']) {
  const s = side[0].toLowerCase();
  const seg = side === 'Left' ? 'L' : 'R';
  add(`cephalic-vein-${s}`, `${side} cephalic vein`, 'superficial', 'Superficial veins', [`${side} cephalic vein`], { mode: `limb:${seg}`, skin: 'soft', ratio: 0.12, channel: 'veins', desc: 'Superficial vein on the lateral forearm and arm; a common peripheral IV site.' });
  add(`basilic-vein-${s}`, `${side} basilic vein`, 'superficial', 'Superficial veins', [`${side} basilic vein`], { mode: `limb:${seg}`, skin: 'soft', ratio: 0.12, channel: 'veins', desc: 'Superficial vein on the medial forearm; with the median cubital vein it forms the antecubital IV/venepuncture site.' });
  add(`superficial-epigastric-${s}`, `${side} superficial epigastric artery`, 'superficial', 'Superficial vessels', [`${side} superficial epigastric artery`], { skin: 'soft', ratio: 0.4, channel: 'arteries', desc: 'Superficial artery of the lower abdominal wall.' });
  add(`iliotibial-tract-${s}`, `${side} iliotibial tract`, 'superficial', 'Fascia', [`${side} iliotibial tract`], { mode: `seg:thigh${seg}`, skin: 'soft', ratio: 0.2, desc: 'Thick band of fascia on the lateral thigh.' });
  add(`flexor-retinaculum-${s}`, `${side} flexor retinaculum`, 'superficial', 'Fascia', [`Flexor retinaculum of ${side.toLowerCase()} wrist`], { mode: `seg:hand${seg}`, ratio: 0.4, desc: 'Roof of the carpal tunnel.' });
}
add('medial-brachial-vein-r', 'Right medial brachial vein', 'superficial', 'Superficial veins', ['Right medial brachial vein'], { mode: 'limb:R', skin: 'soft', ratio: 0.3, channel: 'veins', desc: 'Vein accompanying the brachial artery.' });

// ---------------- cardiovascular
add('heart', 'Heart (myocardium)', 'cardiovascular', 'Cardiovascular', [], {
  derived: 'heart', channel: 'heart', ratio: 1, desc: 'Four-chamber pump. The left ventricle (tinted when ischaemic in the simulation) generates systemic pressure; the right ventricle perfuses the lungs.',
});
add('coronary-arteries', 'Coronary arteries', 'cardiovascular', 'Cardiovascular', [
  'Trunk of left coronary artery', 'Trunk of anterior interventricular branch of left coronary artery', 'Diagonal branch of anterior descending branch of left coronary artery', 'Circumflex branch of left coronary artery',
  'Trunk of right coronary artery', 'Marginal branch of right coronary artery', 'Posterior interventricular branch of right coronary artery', 'First anterior ventricular branch of right coronary artery', 'First posterior ventricular branch of right coronary artery',
  'Conus branch of anterior interventricular branch of left coronary artery', 'Right conus artery',
  'First right anterior branch of anterior interventricular branch of left coronary artery', 'Second right anterior branch of anterior interventricular branch of left coronary artery', 'Third right anterior branch of anterior interventricular branch of left coronary artery',
], { cardiac: true, ratio: 0.25, channel: 'coronary', desc: 'Supply the myocardium. Occlusion of the left anterior descending (LAD) artery causes anterior infarction.' });
add('cardiac-veins', 'Cardiac veins', 'cardiovascular', 'Cardiovascular', ['Coronary sinus', 'Great cardiac vein', 'Middle cardiac vein', 'Small cardiac vein', 'Posterior vein of left ventricle', 'Left marginal vein', 'Right marginal vein'], { cardiac: true, ratio: 0.3, channel: 'veins', desc: 'Drain the myocardium into the right atrium via the coronary sinus.' });
add('aorta', 'Aorta', 'cardiovascular', 'Cardiovascular', ['Ascending aorta', 'Arch of aorta', 'Descending thoracic aorta', 'Descending aorta', 'Abdominal aorta'], { ratio: 0.4, skin: 'soft', channel: 'arteries', desc: 'Main systemic artery. Mean arterial pressure in the simulation refers to pressure here.' });
add('venae-cavae', 'Venae cavae & brachiocephalic veins', 'cardiovascular', 'Cardiovascular', ['Superior vena cava', 'Inferior vena cava', 'Left brachiocephalic vein', 'Right brachiocephalic vein', 'Right internal jugular vein', 'Right subclavian vein'], { ratio: 0.4, skin: 'soft', channel: 'veins', desc: 'Return blood to the right atrium. Raised intrathoracic pressure (tension pneumothorax, high PEEP) impedes venous return.' });
add('azygos', 'Azygos & hemiazygos veins', 'cardiovascular', 'Cardiovascular', ['Azygos vein', 'Hemiazygos vein'], { ratio: 0.15, skin: 'soft', channel: 'veins', desc: 'Drain the posterior thoracic wall into the superior vena cava.' });
add('pulmonary-arteries', 'Pulmonary trunk & arteries', 'cardiovascular', 'Cardiovascular', ['Pulmonary trunk', 'Left pulmonary artery', 'Right pulmonary artery', 'Right upper lobar artery'], { ratio: 0.4, channel: 'pulmonaryArteries', desc: 'Carry deoxygenated blood from the right ventricle to the lungs.' });
add('pulmonary-veins', 'Pulmonary veins', 'cardiovascular', 'Cardiovascular', ['Left superior pulmonary vein', 'Left inferior pulmonary vein', 'Right superior pulmonary vein', 'Right inferior pulmonary vein'], { ratio: 0.5, channel: 'pulmonaryVeins', desc: 'Return oxygenated blood to the left atrium; raised left atrial pressure causes pulmonary oedema.' });
add('neck-arteries', 'Carotid, subclavian & vertebral arteries', 'cardiovascular', 'Cardiovascular', ['Brachiocephalic artery', ...LR('common carotid artery'), ...LR('internal carotid artery'), ...LR('subclavian artery'), ...LR('vertebral artery')], { mode: 'neck', ratio: 0.4, skin: 'soft', channel: 'arteries', desc: 'Supply the brain and upper limbs; the carotid pulse is checked here.' });
for (const side of ['Left', 'Right']) {
  const s = side[0].toLowerCase();
  const seg = side === 'Left' ? 'L' : 'R';
  add(`arm-arteries-${s}`, `${side} upper-limb arteries`, 'cardiovascular', 'Cardiovascular', [
    `${side} brachial artery`, `${side} deep brachial artery`, `${side} radial artery`, `${side} ulnar artery`, `${side} anterior interosseous artery`, `${side} common interosseous artery`,
    `${side} radial recurrent artery`, `${side} anterior ulnar recurrent artery`, `${side} posterior ulnar recurrent artery`, `${side} superior ulnar collateral artery`, `${side} inferior ulnar collateral artery`,
    `${side} anterior circumflex humeral artery`, `${side} posterior circumflex humeral artery`,
  ], { mode: `limb:${seg}`, ratio: 0.2, skin: 'soft', channel: 'arteries', desc: 'Brachial, radial and ulnar arteries. The radial pulse is lost at low systolic pressure; arterial lines are placed in the radial artery.' });
  add(`leg-arteries-${s}`, `${side} iliac & lower-limb arteries`, 'cardiovascular', 'Cardiovascular', [
    `${side} common iliac artery`, `${side} external iliac artery`, `${side} internal iliac artery`, `${side} femoral artery`, `${side} deep femoral artery`, `${side} lateral circumflex femoral artery`,
    `${side} descending genicular artery`, `${side} popliteal artery`, `${side} anterior tibial artery`, `${side} posterior tibial artery`, `${side} dorsalis pedis artery`, `${side} inferior epigastric artery`,
  ], { mode: `limb:${seg}L`, ratio: 0.15, skin: 'soft', channel: 'arteries', desc: 'Iliac, femoral and leg arteries. The femoral pulse is palpated below the inguinal ligament.' });
  add(`iliac-veins-${s}`, `${side} iliac veins`, 'cardiovascular', 'Cardiovascular', [`${side} common iliac vein`, `${side} external iliac vein`, `${side} internal iliac vein`], { ratio: 0.4, skin: 'soft', channel: 'veins', desc: 'Drain the pelvis and lower limb into the inferior vena cava.' });
}
add('visceral-arteries', 'Visceral arteries', 'cardiovascular', 'Cardiovascular', [
  'Celiac trunk', 'Celiac artery', 'Splenic artery', 'Common hepatic artery', 'Hepatic artery proper', 'Left gastric artery', 'Right gastric artery', 'Superior mesenteric artery', 'Trunk of superior mesenteric artery',
  'Inferior mesenteric artery', 'Trunk of right renal artery', 'Trunk of left renal artery', 'Right renal artery', 'Left renal artery', 'Middle colic artery', 'Right colic artery', 'Left colic artery', 'Ileocolic artery', 'Sigmoid artery', 'Marginal artery of colon',
], { ratio: 0.25, skin: 'soft', channel: 'arteries', desc: 'Supply the gut, liver, spleen and kidneys; splanchnic vasoconstriction diverts blood in shock.' });
add('portal-vein', 'Hepatic portal vein', 'cardiovascular', 'Cardiovascular', ['Hepatic portal vein', 'Left portal vein', 'Right portal vein'], { ratio: 0.2, channel: 'veins', desc: 'Carries gut venous blood to the liver (first-pass metabolism of oral drugs).' });

// ---------------- respiratory
add('trachea', 'Trachea', 'respiratory', 'Respiratory', ['Trachea'], { mode: 'neck', ratio: 0.4, skin: 'soft', channel: 'airways', desc: 'Windpipe; an endotracheal tube cuff sits in the mid-trachea. Tracheal deviation is a late sign of tension pneumothorax.' });
add('main-bronchi', 'Main bronchi', 'respiratory', 'Respiratory', ['Left main bronchus', 'Right main bronchus proper'], { ratio: 0.4, channel: 'airways', desc: 'The right main bronchus is steeper — a tube advanced too far enters it.' });
const segTrees = (side) => {
  const l = side === 'Left';
  const names = l
    ? ['Left apical segmental bronchial tree', 'Left posterior segmental bronchial tree', 'Left anterior segmental bronchial tree', 'Superior lingular bronchial tree', 'Inferior lingular bronchial tree', 'Left superior segmental bronchial tree', 'Left medial basal segmental bronchial tree', 'Left anterior basal segmental bronchial tree', 'Left lateral basal segmental bronchial tree', 'Left posterior basal segmental bronchial tree']
    : ['Right apical segmental bronchial tree', 'Right posterior segmental bronchial tree', 'Right anterior segmental bronchial tree', 'Lateral segmental bronchial tree', 'Medial segmental bronchial tree', 'Right superior segmental bronchial tree', 'Right medial basal segmental bronchial tree', 'Right anterior basal segmental bronchial tree', 'Right lateral basal segmental bronchial tree', 'Right posterior basal segmental bronchial tree'];
  return names;
};
add('bronchial-tree-l', 'Left bronchial tree', 'respiratory', 'Respiratory', segTrees('Left'), { ratio: 0.12, channel: 'airways', desc: 'Conducting airways; bronchospasm narrows them (wheeze, prolonged expiration).' });
add('bronchial-tree-r', 'Right bronchial tree', 'respiratory', 'Respiratory', segTrees('Right'), { ratio: 0.12, channel: 'airways', desc: 'Conducting airways; bronchospasm narrows them (wheeze, prolonged expiration).' });
add('lung-l', 'Left lung', 'respiratory', 'Respiratory', [], { derived: 'lung-l', channel: 'lungLeft', ratio: 1, desc: 'Two lobes plus the lingula. In the simulation it collapses as pleural air accumulates on this side.' });
add('lung-r', 'Right lung', 'respiratory', 'Respiratory', [], { derived: 'lung-r', channel: 'lungRight', ratio: 1, desc: 'Three lobes. In the simulation it collapses as pleural air accumulates on this side.' });
add('diaphragm', 'Diaphragm', 'respiratory', 'Respiratory', ['Diaphragm'], { ratio: 0.06, skin: 'soft', channel: 'diaphragm', desc: 'Principal muscle of inspiration; it descends with each breath (animated from the simulated tidal volume).' });

// ---------------- digestive
add('esophagus', 'Oesophagus', 'digestive', 'Digestive', ['Esophagus'], { mode: 'neck', skin: 'soft', ratio: 0.8, desc: 'Lies behind the trachea — oesophageal intubation produces no chest rise and no end-tidal CO₂.' });
add('stomach', 'Stomach', 'digestive', 'Digestive', ['Stomach'], { skin: 'soft', ratio: 0.8, desc: 'Gastric insufflation during bag-mask ventilation raises aspiration risk.' });
add('duodenum', 'Duodenum', 'digestive', 'Digestive', ['Duodenum'], { skin: 'soft', ratio: 0.7, desc: 'First part of the small intestine.' });
add('jejunum', 'Jejunum', 'digestive', 'Digestive', ['Proximal part of jejunum', 'Middle part of jejunum', 'Distal part of jejunum'], { skin: 'soft', ratio: 0.5, desc: 'Absorptive small intestine.' });
add('ileum', 'Ileum', 'digestive', 'Digestive', ['Proximal part of ileum', 'Middle part of ileum', 'Distal part of ileum', 'Ileocecal junction'], { skin: 'soft', ratio: 0.5, desc: 'Terminal small intestine.' });
add('appendix', 'Appendix', 'digestive', 'Digestive', ['Appendix'], { ratio: 0.8, desc: 'Vermiform appendix (right iliac fossa).' });
add('colon', 'Colon', 'digestive', 'Digestive', ['Ascending colon', 'Transverse colon', 'Descending colon'], { skin: 'soft', ratio: 0.35, desc: 'Large intestine.' });
add('rectum', 'Rectum', 'digestive', 'Digestive', ['Rectum'], { ratio: 0.6, desc: 'Terminal large intestine.' });
add('liver', 'Liver', 'digestive', 'Digestive', ['Hepatovenous segment II', 'Hepatovenous segment III', 'Hepatovenous segment IV', 'Hepatovenous segment V', 'Hepatovenous segment VI', 'Hepatovenous segment VII', 'Hepatovenous segment VIII', 'Caudate lobe of liver'], {
  ratio: 0.12, channel: 'liver', desc: 'Metabolises lactate and many drugs; hepatic clearance in the simulation falls with liver blood flow and hepatic impairment.',
});
add('gallbladder', 'Gallbladder', 'digestive', 'Digestive', ['Gallbladder'], { ratio: 0.5, desc: 'Stores bile beneath the liver.' });
add('pancreas', 'Pancreas', 'digestive', 'Digestive', ['Pancreas'], { ratio: 0.5, desc: 'Endocrine β-cells secrete insulin; absent insulin secretion drives diabetic ketoacidosis in the simulation.' });

// ---------------- nervous
const hemisphere = (side) => [
  'superior frontal gyrus', 'middle frontal gyrus', 'inferior frontal gyrus', 'precentral gyrus', 'postcentral gyrus', 'supramarginal gyrus', 'angular gyrus', 'superior parietal lobule',
  'middle temporal gyrus', 'inferior temporal gyrus', 'fusiform gyrus', 'parahippocampal gyrus', 'cingulate gyrus', 'insula', 'occipital lobe', 'hippocampus',
].map((g) => `${side} ${g}`).concat([`White matter of ${side.toLowerCase()} cerebral hemisphere`]);
add('cerebrum-l', 'Left cerebral hemisphere', 'nervous', 'Nervous', hemisphere('Left'), { mode: 'head', ratio: 0.12, channel: 'brain', desc: 'Cerebral cortex and white matter; consciousness falls with cerebral hypoperfusion, hypoxaemia, hypoglycaemia and sedative drugs.' });
add('cerebrum-r', 'Right cerebral hemisphere', 'nervous', 'Nervous', hemisphere('Right'), { mode: 'head', ratio: 0.12, channel: 'brain', desc: 'Cerebral cortex and white matter; consciousness falls with cerebral hypoperfusion, hypoxaemia, hypoglycaemia and sedative drugs.' });
add('cerebellum', 'Cerebellum', 'nervous', 'Nervous', ['Cerebellum'], { mode: 'head', ratio: 0.15, channel: 'brain', desc: 'Coordinates movement and balance.' });
add('brainstem', 'Brainstem', 'nervous', 'Nervous', ['Midbrain', 'Pons', 'Medulla oblongata'], { mode: 'head', ratio: 0.2, channel: 'brainstem', desc: 'Contains the respiratory centres; opioids depress the medullary response to CO₂.' });
add('diencephalon', 'Hypothalamus & pineal', 'nervous', 'Nervous', ['Hypothalamus', 'Tuber cinereum', 'Pineal body', 'Habenula'], { mode: 'head', ratio: 0.5, channel: 'brain', desc: 'The hypothalamus sets the thermoregulatory set-point (raised by pyrogens in sepsis).' });
add('spinal-cord', 'Spinal cord', 'nervous', 'Nervous', [], { derived: 'spinal-cord', skin: 'soft', ratio: 1, desc: 'Conducts motor and sensory signals; it ends at about L1–L2 in adults.' });

// ---------------- urinary & endocrine
add('kidney-l', 'Left kidney', 'organs', 'Urinary', ['Left kidney'], { ratio: 0.6, channel: 'kidney', desc: 'Filters plasma; glomerular filtration in the simulation falls when renal perfusion pressure drops below autoregulation.' });
add('kidney-r', 'Right kidney', 'organs', 'Urinary', ['Right kidney'], { ratio: 0.6, channel: 'kidney', desc: 'Filters plasma; glomerular filtration in the simulation falls when renal perfusion pressure drops below autoregulation.' });
add('ureters', 'Ureters', 'organs', 'Urinary', ['Left ureter', 'Right ureter'], { skin: 'soft', ratio: 0.5, desc: 'Carry urine to the bladder.' });
add('bladder', 'Urinary bladder', 'organs', 'Urinary', ['Urinary bladder'], { ratio: 1, channel: 'bladder', desc: 'Urine output is a key marker of end-organ perfusion.' });
add('adrenals', 'Adrenal glands', 'organs', 'Endocrine', ['Left adrenal gland', 'Right adrenal gland'], { ratio: 0.5, desc: 'Secrete adrenaline and cortisol — the endogenous stress response.' });
add('thymus', 'Thymus', 'organs', 'Endocrine / Lymphoid', ['Left lobe of thymus', 'Right lobe of thymus'], { ratio: 0.8, desc: 'Lymphoid organ in the anterior mediastinum (small in adults).' });
add('pituitary', 'Pituitary gland', 'organs', 'Endocrine', ['Pituitary gland'], { mode: 'head', ratio: 1, desc: 'Releases ADH (conserves water in hypovolaemia) and ACTH.' });

// ------------------------------------------------------------------ build
async function main() {
  console.log('Building anatomy layers…');
  const cat = readCatalogue();
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  fs.mkdirSync(OUT, { recursive: true });

  const gather = (names) => {
    const files = [];
    const missing = [];
    for (const n of names) {
      const e = cat.get(n);
      if (!e) missing.push(n);
      else files.push(...e);
    }
    return { meshes: files.map((f) => loadObj(f.file)), fma: [...new Set(files.map((f) => f.fma))], missing };
  };

  // ---------------- reference landmarks (BP3D space, MH axes, metres)
  const meshOf = (n) => merge(gather([n]).meshes);
  const extreme = (m, axis, dir, frac = 0.02) => {
    // centroid of vertices within `frac` metres of the extreme along axis
    let ext = dir > 0 ? -Infinity : Infinity;
    for (let i = axis; i < m.positions.length; i += 3) ext = dir > 0 ? Math.max(ext, m.positions[i]) : Math.min(ext, m.positions[i]);
    const c = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + axis] - ext) <= frac) {
        c[0] += m.positions[i];
        c[1] += m.positions[i + 1];
        c[2] += m.positions[i + 2];
        n++;
      }
    }
    return c.map((x) => x / n);
  };
  const centroid = (m) => {
    const c = [0, 0, 0];
    for (let i = 0; i < m.positions.length; i += 3) {
      c[0] += m.positions[i];
      c[1] += m.positions[i + 1];
      c[2] += m.positions[i + 2];
    }
    return c.map((x) => (x * 3) / m.positions.length);
  };
  const lm = {};
  for (const [side, s] of [['Left', 'L'], ['Right', 'R']]) {
    const hum = meshOf(`${side} humerus`);
    lm[`shoulder${s}`] = extreme(hum, 1, 1, 0.025);
    lm[`elbow${s}`] = extreme(hum, 1, -1, 0.02);
    const rad = merge([meshOf(`${side} radius`), meshOf(`${side} ulna`)]);
    lm[`wrist${s}`] = extreme(rad, 1, -1, 0.02);
    const mc3 = meshOf(`${side} third metacarpal bone`);
    lm[`knuckle${s}`] = extreme(mc3, 1, -1, 0.01);
    const fem = meshOf(`${side} femur`);
    // femoral head: medial-superior part of the proximal femur
    const top = extreme(fem, 1, 1, 0.03);
    lm[`hip${s}`] = top;
    lm[`knee${s}`] = extreme(fem, 1, -1, 0.02);
    const tib = meshOf(`${side} tibia`);
    lm[`ankle${s}`] = extreme(tib, 1, -1, 0.015);
    const mt2 = meshOf(`${side} second metatarsal bone`);
    lm[`toe${s}`] = extreme(mt2, 2, 1, 0.01);
    lm[`eye${s}`] = centroid(meshOf(`${side} sclera`));
    // finger phalanges: endpoints along the long axis
  }
  const manubrium = meshOf('Manubrium');
  lm.sternalNotch = extreme(manubrium, 1, 1, 0.006);
  const xiph = meshOf('Xiphoid process');
  lm.xiphoid = extreme(xiph, 1, -1, 0.006);
  const skullTop = merge([meshOf('Frontal bone'), meshOf('Left parietal bone'), meshOf('Right parietal bone')]);
  lm.skullTop = extreme(skullTop, 1, 1, 0.01);
  lm.chin = extreme(meshOf('Mandible'), 1, -1, 0.01);
  lm.c1 = centroid(meshOf('Atlas'));
  lm.t1 = centroid(meshOf('First thoracic vertebra'));
  lm.l3 = centroid(meshOf('Third lumbar vertebra'));
  // AP extents of the trunk skin at key heights (|x| < 6 cm to exclude the arms)
  const skin = meshOf('Skin');
  const apAt = (y, band = 0.012) => {
    let front = -Infinity;
    let back = Infinity;
    let half = 0;
    for (let i = 0; i < skin.positions.length; i += 3) {
      const py = skin.positions[i + 1];
      if (Math.abs(py - y) > band) continue;
      const x = skin.positions[i];
      const z = skin.positions[i + 2];
      if (Math.abs(x) < 0.06) {
        front = Math.max(front, z);
        back = Math.min(back, z);
      }
    }
    return { front, back, half };
  };
  const ribs = merge(['Left', 'Right'].flatMap((sd) => ordinal.map((o) => meshOf(`${sd} ${o} rib`))));
  const ribHalfWidthAt = (y, band = 0.015) => {
    let m = 0;
    for (let i = 0; i < ribs.positions.length; i += 3) if (Math.abs(ribs.positions[i + 1] - y) < band) m = Math.max(m, Math.abs(ribs.positions[i]));
    return m;
  };
  const knots = {
    hip: { y: (lm.hipL[1] + lm.hipR[1]) / 2, ...apAt((lm.hipL[1] + lm.hipR[1]) / 2 + 0.03), halfWidth: (lm.hipL[0] - lm.hipR[0]) / 2 },
    navel: { y: lm.l3[1], ...apAt(lm.l3[1]), halfWidth: ribHalfWidthAt(lm.xiphoid[1] - 0.04) },
    xiphoid: { y: lm.xiphoid[1], ...apAt(lm.xiphoid[1]), halfWidth: ribHalfWidthAt(lm.xiphoid[1]) },
    notch: { y: lm.sternalNotch[1], ...apAt(lm.sternalNotch[1] - 0.02), halfWidth: (lm.shoulderL[0] - lm.shoulderR[0]) / 2 },
  };
  console.log('  landmarks', JSON.stringify(knots));

  // ---------------- derived surface sources
  // concept -> element files (BodyParts3D part-of membership)
  const conceptFiles = new Map();
  for (const line of fs.readFileSync(path.join(SRC, 'partof_element_parts.txt'), 'utf8').split(/\r?\n/).slice(1)) {
    const [c, , f] = line.split('\t');
    if (!c || !f) continue;
    if (!conceptFiles.has(c)) conceptFiles.set(c, []);
    conceptFiles.get(c).push(`${f.trim()}.obj`);
  }
  const concept = (fma) => (conceptFiles.get(fma) ?? []).filter((f) => fs.existsSync(path.join(OBJ_DIR, f))).map(loadObj);

  // spinal cord centre line: largest empty circle on the midline through each vertebral foramen
  const canalCentre = (name) => {
    const m = meshOf(name);
    const b = bounds(m.positions);
    const yMid = (b.min[1] + b.max[1]) / 2;
    const band = Math.max(0.004, (b.max[1] - b.min[1]) * 0.18);
    const pts = [];
    for (let i = 0; i < m.positions.length; i += 3) if (Math.abs(m.positions[i + 1] - yMid) < band) pts.push([m.positions[i], m.positions[i + 2]]);
    // the vertebral body is also hollow in the mesh, so take the most posterior
    // enclosed empty region (the foramen lies behind the body)
    const prof = [];
    for (let z = b.min[2]; z <= b.max[2]; z += 0.0005) {
      let front = false, back = false;
      let d = Infinity;
      for (const [x, pz] of pts) {
        d = Math.min(d, Math.hypot(x, pz - z));
        if (Math.abs(x) < 0.006) {
          if (pz > z) front = true;
          else back = true;
        }
      }
      prof.push({ z, d: front && back ? d : 0 });
    }
    let best = null;
    for (let k = 1; k < prof.length - 1; k++) {
      const p = prof[k];
      if (p.d > 0.0045 && p.d >= prof[k - 1].d && p.d >= prof[k + 1].d) {
        best = [0, yMid, p.z];
        break;
      }
    }
    return best;
  };

  const derivedSources = {
    'lung-l': () => concept('FMA7310'),
    'lung-r': () => concept('FMA7309'),
    heart: () => gather(['Cavity of left ventricle', 'Cavity of right ventricle', 'Wall of left atrium', 'Wall of right atrium']).meshes,
    'spinal-cord': () => [],
  };
  const cordLine = [
    'Atlas', 'Axis', ...['Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh'].map((o) => `${o} cervical vertebra`),
    ...ordinal.map((o) => `${cap(o)} thoracic vertebra`), 'First lumbar vertebra',
  ].map(canalCentre).filter(Boolean);
  // median-filter the antero-posterior coordinate to reject misdetections
  const zs = cordLine.map((p) => p[2]);
  for (let i = 1; i < cordLine.length - 1; i++) cordLine[i][2] = [zs[i - 1], zs[i], zs[i + 1]].sort((a, b) => a - b)[1];
  // extend to the brainstem above C1
  cordLine.unshift([0, cordLine[0][1] + 0.025, cordLine[0][2] + 0.004]);
  if (process.env.DEBUG_CORD) console.log(cordLine.map((p) => p.map((x) => x.toFixed(3)).join(",")).join(" | "));

  const layers = new Map();
  const index = [];
  for (const s of S) {
    let mesh;
    let color = null;
    let fma = [];
    if (s.derived) {
      const src = derivedSources[s.derived]();
      if (s.derived === 'heart') {
        // build separately-dilated solids per chamber so wall thickness differs
        const lv = gather(['Cavity of left ventricle']).meshes;
        const rv = gather(['Cavity of right ventricle']).meshes;
        const atria = gather(['Wall of left atrium', 'Wall of right atrium', 'Cavity of left atrium', 'Cavity of right atrium']).meshes;
        const all = merge([...lv, ...rv, ...atria]);
        const b = bounds(all.positions);
        const grid = new Grid(b.min, b.max, 0.0025, 0.02);
        const dLV = grid.distance(grid.seedPoints(merge(lv).positions, merge(lv).indices));
        const dRV = grid.distance(grid.seedPoints(merge(rv).positions, merge(rv).indices));
        const dA = grid.distance(grid.seedPoints(merge(atria).positions, merge(atria).indices));
        const solid = new Uint8Array(grid.size);
        for (let i = 0; i < grid.size; i++) solid[i] = dLV[i] <= 0.011 || dRV[i] <= 0.0055 || dA[i] <= 0.003 ? 1 : 0;
        let sdf = grid.signed(solid);
        sdf = grid.blur(sdf, 2);
        const surf = surfaceNets(grid, sdf, 0);
        // orient + smooth
        const P = surf.positions;
        const I = surf.indices;
        const samp = (p) => {
          const [i, j, k] = grid.cellOf(p);
          const c = (x, y, z) => sdf[grid.index(Math.min(grid.nx - 1, Math.max(0, x)), Math.min(grid.ny - 1, Math.max(0, y)), Math.min(grid.nz - 1, Math.max(0, z)))];
          return [c(i + 1, j, k) - c(i - 1, j, k), c(i, j + 1, k) - c(i, j - 1, k), c(i, j, k + 1) - c(i, j, k - 1)];
        };
        for (let t = 0; t < I.length; t += 3) {
          const a = I[t] * 3, bb = I[t + 1] * 3, c = I[t + 2] * 3;
          const e1 = [P[bb] - P[a], P[bb + 1] - P[a + 1], P[bb + 2] - P[a + 2]];
          const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
          const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          const g = samp([(P[a] + P[bb] + P[c]) / 3, (P[a + 1] + P[bb + 1] + P[c + 1]) / 3, (P[a + 2] + P[bb + 2] + P[c + 2]) / 3]);
          if (n[0] * g[0] + n[1] * g[1] + n[2] * g[2] < 0) {
            const tmp = I[t + 1];
            I[t + 1] = I[t + 2];
            I[t + 2] = tmp;
          }
        }
        mesh = { positions: taubin(P, I, 10), indices: I };
        mesh = simplify(mesh, 0.45, 0.0006);
        // region colours: R = left ventricle, G = right ventricle, B = atria
        color = new Float32Array(mesh.positions.length);
        const at = (arr, p) => {
          const [i, j, k] = grid.cellOf(p);
          return arr[grid.index(Math.min(grid.nx - 1, Math.max(0, i)), Math.min(grid.ny - 1, Math.max(0, j)), Math.min(grid.nz - 1, Math.max(0, k)))];
        };
        for (let v = 0; v < mesh.positions.length; v += 3) {
          const p = [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]];
          const l = at(dLV, p) - 0.011;
          const r = at(dRV, p) - 0.0055;
          const a = at(dA, p) - 0.003;
          const m = Math.min(l, r, a);
          const w = (x) => Math.exp(-(x - m) / 0.003);
          const sum = w(l) + w(r) + w(a);
          color[v] = w(l) / sum;
          color[v + 1] = w(r) / sum;
          color[v + 2] = w(a) / sum;
        }
        fma = ['FMA7088'];
      } else if (s.derived.startsWith('lung')) {
        mesh = derivedSurface(src, { voxel: 0.004, dilate: 0.022, erode: 0.008, fillHoles: true, blur: 3, smooth: 10 });
        mesh = simplify(mesh, 0.35, 0.001);
        fma = [s.derived === 'lung-l' ? 'FMA7310' : 'FMA7309'];
      } else if (s.derived === 'spinal-cord') {
        // tube along the canal centre line, tapering to the conus medullaris
        const pts = [];
        const idx = [];
        const rings = 72;
        const seg = 14;
        const P = (t) => {
          const f = t * (cordLine.length - 1);
          const i = Math.min(cordLine.length - 2, Math.floor(f));
          const u = f - i;
          const p0 = cordLine[Math.max(0, i - 1)], p1 = cordLine[i], p2 = cordLine[i + 1], p3 = cordLine[Math.min(cordLine.length - 1, i + 2)];
          return [0, 1, 2].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u * u + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u * u * u));
        };
        for (let r = 0; r <= rings; r++) {
          const t = r / rings;
          const c = P(t);
          const n = P(Math.min(1, t + 0.01));
          const pv = P(Math.max(0, t - 0.01));
          const dir = [n[0] - pv[0], n[1] - pv[1], n[2] - pv[2]];
          const dl = Math.hypot(...dir) || 1;
          const d = dir.map((x) => x / dl);
          // basis perpendicular to the cord
          const ax = [1, 0, 0];
          const bz = [d[1] * ax[2] - d[2] * ax[1], d[2] * ax[0] - d[0] * ax[2], d[0] * ax[1] - d[1] * ax[0]];
          const bl = Math.hypot(...bz) || 1;
          const b2 = bz.map((x) => x / bl);
          const cervical = Math.exp(-(((t - 0.18) / 0.1) ** 2));
          const lumbar = Math.exp(-(((t - 0.85) / 0.06) ** 2));
          const radius = (0.0045 + 0.0018 * cervical + 0.0012 * lumbar) * (t > 0.93 ? 1 - (t - 0.93) / 0.08 : 1) + 0.0004;
          for (let k = 0; k < seg; k++) {
            const a = (k / seg) * Math.PI * 2;
            const ca = Math.cos(a) * radius * 1.25;
            const sa = Math.sin(a) * radius;
            pts.push(c[0] + ax[0] * ca + b2[0] * sa, c[1] + ax[1] * ca + b2[1] * sa, c[2] + ax[2] * ca + b2[2] * sa);
          }
        }
        for (let r = 0; r < rings; r++)
          for (let k = 0; k < seg; k++) {
            const a = r * seg + k, b = r * seg + ((k + 1) % seg), c = (r + 1) * seg + k, d = (r + 1) * seg + ((k + 1) % seg);
            idx.push(a, c, b, b, c, d);
          }
        mesh = { positions: new Float32Array(pts), indices: new Uint32Array(idx) };
        fma = ['FMA7647'];
      }
    } else {
      const g = gather(s.names);
      if (g.missing.length) console.warn(`  ! ${s.id}: missing ${g.missing.join(', ')}`);
      if (!g.meshes.length) continue;
      mesh = simplify(merge(g.meshes), s.ratio, s.layer === 'skeleton' ? 0.0008 : 0.0012);
      fma = g.fma;
    }
    const nrm = normalsOf(mesh.positions, mesh.indices);
    const b = bounds(mesh.positions);
    if (!layers.has(s.layer)) layers.set(s.layer, []);
    layers.get(s.layer).push({ id: s.id, positions: mesh.positions, normals: nrm, indices: mesh.indices, color });
    index.push({
      id: s.id,
      name: s.label,
      layer: s.layer,
      system: s.system,
      fmaId: fma.length === 1 ? fma[0] : undefined,
      fmaIds: fma.length > 1 ? fma : undefined,
      description: s.desc,
      channel: s.channel ?? undefined,
      derived: s.derived ? true : undefined,
      mode: s.mode,
      skin: s.skin,
      bone: s.bone,
      cardiac: s.cardiac || s.id === 'heart' || undefined,
      bounds: b,
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
    });
  }

  // ---------------- write GLBs
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const files = {};
  let total = 0;
  for (const [layer, items] of layers) {
    const doc = new Document();
    const buf = doc.createBuffer();
    const scene = doc.createScene(layer);
    for (const it of items) {
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(it.positions).setBuffer(buf))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(it.normals).setBuffer(buf))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(it.indices.length / 3 < 21845 && it.positions.length / 3 < 65535 ? new Uint16Array(it.indices) : it.indices).setBuffer(buf));
      if (it.color) prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(it.color).setBuffer(buf));
      const m = doc.createMesh(it.id).addPrimitive(prim);
      scene.addChild(doc.createNode(it.id).setMesh(m));
    }
    await doc.transform(dedup(), prune(), quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeColor: 8 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const glb = await io.writeBinary(doc);
    const file = `${layer}.glb`;
    fs.writeFileSync(path.join(OUT, file), glb);
    files[layer] = file;
    total += glb.byteLength;
    console.log(`  ${file.padEnd(20)} ${fmtBytes(glb.byteLength).padStart(10)}  ${items.length} structures, ${items.reduce((s, i) => s + i.indices.length / 3, 0)} tris`);
  }
  const meta = {
    version: 1,
    generator: 'scripts/assets/build-anatomy.mjs',
    source: 'BodyParts3D 4.0 (part-of), The Database Center for Life Science',
    license: 'CC BY 4.0 (see ASSETS.md; OBJ headers state CC BY-SA 2.1 JP)',
    units: 'm',
    axes: '+Y up, +Z anterior, +X patient left (BodyParts3D origin)',
    files,
    landmarks: lm,
    knots,
    structures: index,
  };
  fs.writeFileSync(path.join(OUT, 'anatomy-index.json'), JSON.stringify(meta, null, 1));
  console.log(`  total ${fmtBytes(total)}, ${index.length} structures`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
