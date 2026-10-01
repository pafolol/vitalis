#!/usr/bin/env node
/**
 * Builds the runtime human asset from the CC0 MakeHuman base mesh, rig,
 * weights and targets.
 *
 * Output: public/assets/human/human.json (metadata) + human.bin (buffers).
 *
 * What we keep:
 *  - all 19 158 base-mesh vertices (body + helper geometry) so that joints,
 *    proxies (eyes) and helper meshes (teeth, tongue, shorts) can be fitted
 *    to any morphed body at runtime;
 *  - index lists for the body and selected helper meshes (triangulated);
 *  - 36 "universal" macro targets (sex x age x muscle x weight) quantised to
 *    int16, following MakeHuman macro-modifier semantics;
 *  - facial expression units + procedurally generated breathing/CPR targets;
 *  - skeleton (163 bones), joint vertex lists and top-4 skin weights;
 *  - per-vertex region ids and shading masks (hair, brows, lips, ...).
 *
 * Units: metres. Axes: MakeHuman (+Y up, +Z anterior, +X patient's left).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFile, parseObj, parseTarget, BinWriter, quantiseSparse, fmtBytes } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'assets-src/makehuman');
const OUT = path.join(ROOT, 'public/assets/human');
const MH = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data';
const DM_TO_M = 0.1;

const SEXES = ['male', 'female'];
const RACES = ['african', 'asian', 'caucasian'];
const AGES = ['young', 'old'];
const MUSCLES = ['minmuscle', 'averagemuscle', 'maxmuscle'];
const WEIGHTS = ['minweight', 'averageweight', 'maxweight'];
const EXPRESSIONS = [
  'eye-left-closure',
  'eye-right-closure',
  'eye-left-slit',
  'eye-right-slit',
  'eyebrows-left-inner-up',
  'eyebrows-right-inner-up',
  'eyebrows-left-down',
  'eyebrows-right-down',
  'mouth-open',
  'mouth-compression',
  'mouth-retraction',
  'mouth-depression',
  'mouth-upward-retraction',
  'nose-left-dilatation',
  'nose-right-dilatation',
  'nose-compression',
  'neck-platysma',
];

// Region ids (must match src/three/human/regions.ts)
const R = {
  head: 0, face: 1, neck: 2, chest: 3, abdomen: 4, pelvis: 5, back: 6,
  leftArm: 7, rightArm: 8, leftHand: 9, rightHand: 10,
  leftLeg: 11, rightLeg: 12, leftFoot: 13, rightFoot: 14, lips: 15,
};

async function fetchAll() {
  const files = [
    '3dobjs/base.obj',
    'rigs/default.mhskel',
    'rigs/default_weights.mhw',
    'eyes/high-poly/high-poly.obj',
    'eyes/high-poly/high-poly.mhclo',
    'eyes/materials/brown_eye.png',
  ];
  for (const s of SEXES)
    for (const a of AGES)
      for (const m of MUSCLES)
        for (const w of WEIGHTS) files.push(`targets/macrodetails/universal-${s}-${a}-${m}-${w}.target`);
  for (const e of EXPRESSIONS) {
    const local = `targets/expression/${e}.target`;
    await ensureFile(path.join(SRC, local), `${MH}/targets/expression/units/caucasian/${e}.target`);
  }
  for (const r of RACES) for (const s of SEXES) for (const a of AGES) files.push(`targets/macrodetails/${r}-${s}-${a}.target`);
  for (const f of files) await ensureFile(path.join(SRC, f), `${MH}/${f}`);
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (d2, r) => Math.exp(-d2 / (2 * r * r));

async function main() {
  console.log('Building human asset…');
  await fetchAll();
  fs.mkdirSync(OUT, { recursive: true });
  const bin = new BinWriter();

  // ---------------------------------------------------------------- mesh
  const obj = parseObj(fs.readFileSync(path.join(SRC, '3dobjs/base.obj'), 'utf8'));
  const nV = obj.v.length / 3;
  const P = new Float32Array(obj.v.length);
  for (let i = 0; i < P.length; i++) P[i] = obj.v[i] * DM_TO_M;
  const vx = (i) => P[i * 3];
  const vy = (i) => P[i * 3 + 1];
  const vz = (i) => P[i * 3 + 2];

  const triangulate = (faces) => {
    const out = [];
    for (const f of faces) for (let k = 1; k + 1 < f.length; k++) out.push(f[0][0], f[k][0], f[k + 1][0]);
    return new Uint32Array(out);
  };
  const groupTris = (name) => triangulate(obj.groups.get(name) ?? []);
  const bodyTris = groupTris('body');
  const bodyQuads = new Uint32Array(obj.groups.get('body').flatMap((f) => f.map((c) => c[0])));

  // Vertex normals of the base body (for procedural targets)
  const N = new Float32Array(nV * 3);
  for (let t = 0; t < bodyTris.length; t += 3) {
    const a = bodyTris[t], b = bodyTris[t + 1], c = bodyTris[t + 2];
    const e1 = [vx(b) - vx(a), vy(b) - vy(a), vz(b) - vz(a)];
    const e2 = [vx(c) - vx(a), vy(c) - vy(a), vz(c) - vz(a)];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) {
      N[v * 3] += n[0];
      N[v * 3 + 1] += n[1];
      N[v * 3 + 2] += n[2];
    }
  }
  for (let i = 0; i < nV; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
    N[i * 3] /= l;
    N[i * 3 + 1] /= l;
    N[i * 3 + 2] /= l;
  }

  // ---------------------------------------------------------------- skeleton
  const skel = JSON.parse(fs.readFileSync(path.join(SRC, 'rigs/default.mhskel'), 'utf8'));
  const jointNames = Object.keys(skel.joints);
  const jointIndex = new Map(jointNames.map((n, i) => [n, i]));
  const jointOffsets = [0];
  const jointVerts = [];
  for (const n of jointNames) {
    jointVerts.push(...skel.joints[n]);
    jointOffsets.push(jointVerts.length);
  }
  const jointPos = (name) => {
    const vs = skel.joints[name];
    let x = 0, y = 0, z = 0;
    for (const v of vs) {
      x += vx(v);
      y += vy(v);
      z += vz(v);
    }
    return [x / vs.length, y / vs.length, z / vs.length];
  };
  // Topologically sorted bones (parents first)
  const boneNames = [];
  const visit = (n) => {
    if (boneNames.includes(n)) return;
    const p = skel.bones[n].parent;
    if (p) visit(p);
    boneNames.push(n);
  };
  Object.keys(skel.bones).forEach(visit);
  const boneIndex = new Map(boneNames.map((n, i) => [n, i]));
  const bones = boneNames.map((n) => ({
    name: n,
    parent: skel.bones[n].parent ? boneIndex.get(skel.bones[n].parent) : -1,
    head: jointIndex.get(skel.bones[n].head),
    tail: jointIndex.get(skel.bones[n].tail),
  }));
  const bh = (n) => jointPos(skel.bones[n].head);
  const bt = (n) => jointPos(skel.bones[n].tail);

  // ---------------------------------------------------------------- weights (top 4)
  const mhw = JSON.parse(fs.readFileSync(path.join(SRC, 'rigs/default_weights.mhw'), 'utf8'));
  const perVert = Array.from({ length: nV }, () => []);
  for (const [bone, list] of Object.entries(mhw.weights)) {
    const bi = boneIndex.get(bone);
    if (bi === undefined) continue;
    for (const [v, w] of list) perVert[v].push([bi, w]);
  }
  const skinIdx = new Uint8Array(nV * 4);
  const skinW = new Uint8Array(nV * 4);
  const dominant = new Int16Array(nV).fill(-1);
  for (let v = 0; v < nV; v++) {
    const l = perVert[v].sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (!l.length) l.push([boneIndex.get('root'), 1]);
    dominant[v] = l[0][0];
    const sum = l.reduce((s, x) => s + x[1], 0) || 1;
    let acc = 0;
    l.forEach(([bi, w], k) => {
      skinIdx[v * 4 + k] = bi;
      const q = k === l.length - 1 ? 255 - acc : Math.round((w / sum) * 255);
      skinW[v * 4 + k] = Math.max(0, q);
      acc += skinW[v * 4 + k];
    });
  }

  // ---------------------------------------------------------------- landmarks
  const eyeL = bh('eye.L');
  const eyeR = bh('eye.R');
  const eyeY = (eyeL[1] + eyeR[1]) / 2;
  const headC = bh('head');
  const neckBase = bh('neck01');
  const clavL = bh('clavicle.L');
  const nippleL = bt('breast.L');
  const nippleR = bt('breast.R');
  const hipL = bh('upperleg01.L');
  const kneeL = bh('lowerleg01.L');
  const kneeR = bh('lowerleg01.R');
  const wristL = bh('wrist.L');
  const wristR = bh('wrist.R');
  const ankleL = bh('foot.L');
  const ankleR = bh('foot.R');
  const oris = boneNames.filter((n) => n.startsWith('oris')).map(bh);
  const mouthC = oris.reduce((a, p) => [a[0] + p[0] / oris.length, a[1] + p[1] / oris.length, a[2] + p[2] / oris.length], [0, 0, 0]);

  // Body-only helpers
  const bodyVerts = new Set(bodyTris);
  const frontMostNear = (x, y, r) => {
    let best = -1, bz = -Infinity;
    for (const v of bodyVerts) {
      if (Math.abs(vx(v) - x) < r && Math.abs(vy(v) - y) < r && vz(v) > bz) {
        bz = vz(v);
        best = v;
      }
    }
    return best;
  };
  // Mouth: find lip line = front-most vertex near the mouth centre
  const mouthFront = frontMostNear(0, mouthC[1], 0.012);
  const noseTip = (() => {
    let best = -1, bz = -Infinity;
    for (const v of bodyVerts) {
      if (Math.abs(vx(v)) < 0.01 && vy(v) > mouthC[1] && vy(v) < eyeY && vz(v) > bz) {
        bz = vz(v);
        best = v;
      }
    }
    return best;
  })();
  const mouthP = [0, vy(mouthFront), vz(mouthFront)];
  const noseP = [0, vy(noseTip), vz(noseTip)];

  // Brow height from eyebrow expression targets
  const exprData = {};
  for (const e of EXPRESSIONS) exprData[e] = parseTarget(fs.readFileSync(path.join(SRC, `targets/expression/${e}.target`), 'utf8'));
  const browMask = new Float32Array(nV);
  for (const e of ['eyebrows-left-down', 'eyebrows-right-down', 'eyebrows-left-inner-up', 'eyebrows-right-inner-up']) {
    const { idx, d } = exprData[e];
    let mx = 0;
    const mags = idx.map((_, i) => {
      const m = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
      mx = Math.max(mx, m);
      return m;
    });
    idx.forEach((v, i) => (browMask[v] = Math.max(browMask[v], mags[i] / mx)));
  }
  let browY = 0, browN = 0;
  for (let v = 0; v < nV; v++)
    if (browMask[v] > 0.6 && bodyVerts.has(v)) {
      browY += vy(v);
      browN++;
    }
  browY /= browN || 1;

  // Sternal notch & xiphoid & navel
  const notch = frontMostNear(0, clavL[1] + 0.005, 0.01);
  const notchP = [0, vy(notch), vz(notch)];
  const xiphoidY = nippleL[1] - 0.045;
  const navel = (() => {
    // local depression on the midline between xiphoid and hip level
    let best = -1, bz = Infinity;
    for (const v of bodyVerts) {
      if (Math.abs(vx(v)) < 0.004 && vz(v) > 0.05 && vy(v) < xiphoidY - 0.1 && vy(v) > hipL[1] + 0.03) {
        // compare with neighbours along y by penalising depth relative to a line fit
        const zLine = vz(v);
        if (zLine < bz && vy(v) > hipL[1] + 0.08 && vy(v) < hipL[1] + 0.2) {
          bz = zLine;
          best = v;
        }
      }
    }
    return best;
  })();
  const navelP = [0, vy(navel), vz(navel)];

  // ---------------------------------------------------------------- regions
  const region = new Uint8Array(nV);
  const bn = (v) => boneNames[dominant[v]];
  const facial = /^(jaw|special0[3-6]|eye\.|oculi|orbicularis|levator|risorius|oris|tongue|temporalis)/;
  for (let v = 0; v < nV; v++) {
    const b = bn(v);
    const x = vx(v), y = vy(v), z = vz(v);
    const L = x > 0;
    let r;
    if (/^oris/.test(b)) r = R.lips;
    else if (facial.test(b) || b === 'head') {
      // face = anterior surface below the hairline; everything else is scalp/ears/occiput
      const frontal = z > headC[2] + 0.035 && y < browY + 0.05 && Math.abs(x) < 0.068;
      const lowerFace = y < eyeY - 0.01 && z > headC[2] + 0.01 && Math.abs(x) < 0.07;
      r = frontal || lowerFace ? R.face : R.head;
    } else if (/^neck/.test(b)) r = R.neck;
    else if (/^(wrist|finger|metacarpal)/.test(b)) r = L ? R.leftHand : R.rightHand;
    else if (/^(shoulder|upperarm|lowerarm)/.test(b)) r = L ? R.leftArm : R.rightArm;
    else if (/^(foot|toe)/.test(b)) r = L ? R.leftFoot : R.rightFoot;
    else if (/^(upperleg|lowerleg)/.test(b)) r = L ? R.leftLeg : R.rightLeg;
    else if (/^(pelvis|root)/.test(b) || (b === 'spine05' && y < hipL[1] + 0.06)) r = z < hipL[2] - 0.04 ? R.back : R.pelvis;
    else {
      // trunk
      const back = z < bh('spine03')[2] - 0.0 && N[v * 3 + 2] < 0.15;
      if (back) r = R.back;
      else if (y > xiphoidY) r = R.chest;
      else r = R.abdomen;
    }
    region[v] = r;
  }

  // ---------------------------------------------------------------- shading masks (8 x uint8)
  // 0 hair, 1 brows, 2 lips, 3 flush zones, 4 areola, 5 beard, 6 knees/mottling, 7 acral
  const masks = new Uint8Array(nV * 8);
  const headHalfW = Math.max(...[...bodyVerts].filter((v) => Math.abs(vy(v) - eyeY) < 0.01).map((v) => Math.abs(vx(v))));
  for (let v = 0; v < nV; v++) {
    const x = vx(v), y = vy(v), z = vz(v);
    const r = region[v];
    const isHead = r === R.head || r === R.face || r === R.lips;
    // hair: hairline height depends on angle around the head
    let hair = 0;
    if (isHead || (r === R.neck && z < headC[2])) {
      const ang = Math.atan2(x, z - headC[2]); // 0 = front
      const c = Math.cos(ang);
      const front = browY + 0.058;
      const side = eyeY + 0.03;
      const back = eyeY - 0.075;
      const hl = c >= 0 ? side + (front - side) * c : side + (back - side) * -c;
      hair = smoothstep(hl - 0.006, hl + 0.014, y);
      // clear the ears: lateral region near ear height
      const ear = Math.abs(x) > headHalfW * 0.86 && y < eyeY + 0.035 && y > eyeY - 0.07 && Math.abs(z - (headC[2] - 0.01)) < 0.045;
      if (ear) hair *= 0.0;
      // sideburns
      if (Math.abs(x) > headHalfW * 0.8 && y < eyeY + 0.03 && y > eyeY - 0.02 && z > headC[2] - 0.005 && z < headC[2] + 0.04) hair = Math.max(hair, 0.7);
    }
    masks[v * 8 + 0] = Math.round(hair * 255);
    // brows (from target displacement magnitude, sharpened)
    masks[v * 8 + 1] = Math.round(smoothstep(0.25, 0.75, browMask[v]) * (y > eyeY + 0.008 ? 1 : 0) * 255);
    // lips: ellipse around the mouth, front facing
    {
      const dx = x / 0.026;
      const dy = (y - mouthP[1]) / 0.0105;
      const e = dx * dx + dy * dy;
      const lip = (1 - smoothstep(0.55, 1.05, e)) * smoothstep(mouthP[2] - 0.02, mouthP[2] - 0.006, z);
      masks[v * 8 + 2] = Math.round(lip * 255);
    }
    // flush zones: cheeks, nose, ears, chin
    {
      let f = 0;
      for (const s of [1, -1]) {
        const cx = s * 0.035, cy = eyeY - 0.03;
        f = Math.max(f, gauss((x - cx) ** 2 + (y - cy) ** 2, 0.014) * smoothstep(headC[2], headC[2] + 0.06, z));
        const ex = s * headHalfW;
        f = Math.max(f, 0.8 * gauss((x - ex) ** 2 + (y - (eyeY - 0.02)) ** 2 + (z - (headC[2] - 0.01)) ** 2, 0.02));
      }
      f = Math.max(f, 0.9 * gauss((x - noseP[0]) ** 2 + (y - noseP[1]) ** 2 + (z - noseP[2]) ** 2, 0.012));
      if (!(isHead || r === R.neck)) f = 0;
      masks[v * 8 + 3] = Math.round(Math.min(1, f) * 255);
    }
    // areola
    {
      let a = 0;
      for (const n of [nippleL, nippleR]) {
        const d = Math.hypot(x - n[0], y - n[1], z - n[2]);
        a = Math.max(a, 1 - smoothstep(0.012, 0.02, d));
      }
      if (r !== R.chest) a = 0;
      masks[v * 8 + 4] = Math.round(a * 255);
    }
    // beard zone (only used for male patients, faint stubble)
    {
      let b = 0;
      if ((r === R.face || r === R.lips || r === R.neck) && z > headC[2] - 0.02) {
        const under = 1 - smoothstep(noseP[1] - 0.012, noseP[1] + 0.002, y);
        const aboveNeck = smoothstep(neckBase[1] + 0.06, neckBase[1] + 0.1, y);
        const cheek = 1 - smoothstep(eyeY - 0.045, eyeY - 0.025, y);
        b = Math.max(under * aboveNeck, cheek * smoothstep(0.02, 0.045, Math.abs(x)) * aboveNeck * 0.8);
        b *= 1 - masks[v * 8 + 2] / 255;
      }
      masks[v * 8 + 5] = Math.round(Math.min(1, b) * 255);
    }
    // knees / legs mottling
    {
      let k = 0;
      if (r === R.leftLeg || r === R.rightLeg || r === R.leftFoot || r === R.rightFoot) {
        k = 0.45;
        for (const kn of [kneeL, kneeR]) k = Math.max(k, gauss((x - kn[0]) ** 2 + (y - kn[1]) ** 2, 0.07));
      }
      masks[v * 8 + 6] = Math.round(k * 255);
    }
    // acral (hands/feet, stronger distally)
    {
      let a = 0;
      if (r === R.leftHand || r === R.rightHand) {
        const w = x > 0 ? wristL : wristR;
        a = smoothstep(0.0, 0.14, Math.hypot(x - w[0], y - w[1], z - w[2]));
        a = 0.35 + 0.65 * a;
      } else if (r === R.leftFoot || r === R.rightFoot) {
        const w = x > 0 ? ankleL : ankleR;
        a = 0.35 + 0.65 * smoothstep(0.05, 0.2, Math.hypot(x - w[0], y - w[1], z - w[2]));
      }
      masks[v * 8 + 7] = Math.round(a * 255);
    }
  }

  // ---------------------------------------------------------------- macro targets
  const macroTargets = [];
  for (const s of SEXES)
    for (const a of AGES)
      for (const m of MUSCLES)
        for (const w of WEIGHTS) {
          const name = `universal-${s}-${a}-${m}-${w}`;
          const t = parseTarget(fs.readFileSync(path.join(SRC, `targets/macrodetails/${name}.target`), 'utf8'));
          const d = t.d.map((x) => x * DM_TO_M);
          macroTargets.push({ name, sex: s, age: a, muscle: m, weight: w, ...quantiseSparse(bin, t.idx, d, 2e-6) });
        }

  // Race targets: MakeHuman applies race × gender × age targets with race weights
  // (default 1/3 each). We bake the equal-weight average so facial morphology
  // is not tied to the patient's skin tone.
  for (const s of SEXES)
    for (const a of AGES) {
      const acc = new Map();
      for (const r of RACES) {
        const t = parseTarget(fs.readFileSync(path.join(SRC, `targets/macrodetails/${r}-${s}-${a}.target`), 'utf8'));
        t.idx.forEach((v, i) => {
          const e = acc.get(v) ?? [0, 0, 0];
          e[0] += (t.d[i * 3] * DM_TO_M) / 3;
          e[1] += (t.d[i * 3 + 1] * DM_TO_M) / 3;
          e[2] += (t.d[i * 3 + 2] * DM_TO_M) / 3;
          acc.set(v, e);
        });
      }
      const idx = [...acc.keys()];
      const d = idx.flatMap((v) => acc.get(v));
      macroTargets.push({ name: `race-average-${s}-${a}`, sex: s, age: a, muscle: 'any', weight: 'any', ...quantiseSparse(bin, idx, d, 2e-6) });
    }

  // ---------------------------------------------------------------- expression targets
  const morphTargets = [];
  for (const e of EXPRESSIONS) {
    const t = exprData[e];
    morphTargets.push({ name: e, ...quantiseSparse(bin, t.idx, t.d.map((x) => x * DM_TO_M), 2e-6) });
  }

  // ---------------------------------------------------------------- procedural targets
  const spine3 = bh('spine03');
  const proc = { 'breath-chest-left': [], 'breath-chest-right': [], 'breath-abdomen': [], 'cpr-compression': [] };
  const push = (name, v, dx, dy, dz) => {
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-6) return;
    proc[name].push([v, dx, dy, dz]);
  };
  const chestTop = notchP[1];
  const pubisY = hipL[1] - 0.02;
  for (const v of bodyVerts) {
    const x = vx(v), y = vy(v), z = vz(v);
    const r = region[v];
    const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
    const trunk = r === R.chest || r === R.abdomen || r === R.back || r === R.pelvis || r === R.neck;
    if (!trunk) continue;
    const anterior = smoothstep(spine3[2] - 0.05, spine3[2] + 0.06, z) * smoothstep(-0.3, 0.3, nz + Math.abs(nx) * 0.4);
    // --- chest: from notch down to costal margin, including lateral walls
    // ramps up below the sternal notch, fades out below the costal margin
    const chestWeight =
      smoothstep(chestTop - 0.01, chestTop - 0.07, y) * smoothstep(xiphoidY - 0.1, xiphoidY - 0.02, y) * anterior;
    if (chestWeight > 0.001) {
      const sideL = smoothstep(-0.035, 0.035, x);
      const amp = 0.011 * chestWeight;
      const dx = nx * amp, dy = ny * amp + 0.003 * chestWeight, dz = nz * amp;
      push('breath-chest-left', v, dx * sideL, dy * sideL, dz * sideL);
      push('breath-chest-right', v, dx * (1 - sideL), dy * (1 - sideL), dz * (1 - sideL));
    }
    // --- abdomen: diaphragmatic excursion
    const ay = smoothstep(xiphoidY + 0.02, xiphoidY - 0.06, y) * smoothstep(pubisY, pubisY + 0.12, y);
    const aw = ay * anterior * (1 - smoothstep(0.1, 0.17, Math.abs(x)));
    if (aw > 0.001) {
      const amp = 0.016 * aw;
      push('breath-abdomen', v, nx * amp * 0.5, ny * amp * 0.2, Math.max(nz, 0.2) * amp);
    }
    // --- CPR: lower half of sternum depressed ~5 cm with soft falloff
    const sy = (notchP[1] + xiphoidY) / 2 - 0.035;
    const g = gauss(x * x / 1.0 + ((y - sy) * 0.8) ** 2, 0.055) * anterior;
    if (g > 0.003) push('cpr-compression', v, 0, 0, -0.05 * g);
  }
  // --- angio-oedema: lip eversion/swelling + periorbital swelling (along normals)
  proc.angioedema = [];
  {
    const lid = new Float32Array(nV);
    for (const e of ['eye-left-closure', 'eye-right-closure']) {
      const { idx, d } = exprData[e];
      let mx = 0;
      const mags = idx.map((_, i) => {
        const m = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
        mx = Math.max(mx, m);
        return m;
      });
      idx.forEach((v, i) => (lid[v] = Math.max(lid[v], mags[i] / mx)));
    }
    for (const v of bodyVerts) {
      const lip = masks[v * 8 + 2] / 255;
      const w = 0.0045 * smoothstep(0.1, 0.7, lip) + 0.0022 * smoothstep(0.05, 0.6, lid[v]);
      if (w > 1e-5) proc.angioedema.push([v, N[v * 3] * w, N[v * 3 + 1] * w, N[v * 3 + 2] * w]);
    }
  }
  for (const [name, list] of Object.entries(proc)) {
    const idx = list.map((e) => e[0]);
    const d = list.flatMap((e) => [e[1], e[2], e[3]]);
    morphTargets.push({ name, ...quantiseSparse(bin, idx, d, 1e-7) });
  }

  // ---------------------------------------------------------------- helper meshes
  const helpers = {};
  // shorts: crop tights to the pelvis region
  {
    const faces = obj.groups.get('helper-tights');
    const waistY = navelP[1] - 0.03;
    const legCut = hipL[1] - 0.2 * (hipL[1] - kneeL[1]) - 0.01;
    const keep = faces.filter((f) => f.every(([v]) => vy(v) < waistY && vy(v) > legCut));
    helpers.shorts = bin.add(triangulate(keep));
  }
  helpers.upperTeeth = bin.add(groupTris('helper-upper-teeth'));
  helpers.lowerTeeth = bin.add(groupTris('helper-lower-teeth'));
  helpers.tongue = bin.add(groupTris('helper-tongue'));
  helpers.hair = bin.add(groupTris('helper-hair'));
  helpers.lashesL = bin.add(new Uint32Array([...groupTris('helper-l-eyelashes-1'), ...groupTris('helper-l-eyelashes-2')]));
  helpers.lashesR = bin.add(new Uint32Array([...groupTris('helper-r-eyelashes-1'), ...groupTris('helper-r-eyelashes-2')]));

  // ---------------------------------------------------------------- eyes (proxy bound via mhclo)
  const eyeObj = parseObj(fs.readFileSync(path.join(SRC, 'eyes/high-poly/high-poly.obj'), 'utf8'));
  const mhclo = fs.readFileSync(path.join(SRC, 'eyes/high-poly/high-poly.mhclo'), 'utf8').split(/\r?\n/);
  const scaleRefs = {};
  const binding = [];
  let inVerts = false;
  for (const line of mhclo) {
    const p = line.trim().split(/\s+/);
    if (/^[xyz]_scale$/.test(p[0])) scaleRefs[p[0][0]] = [+p[1], +p[2], +p[3] * DM_TO_M];
    if (p[0] === 'verts') {
      inVerts = true;
      continue;
    }
    if (inVerts) {
      if (p.length === 9) binding.push(p.map(Number));
      else if (p.length === 1 && p[0] !== '' && isNaN(+p[0])) inVerts = false;
      else if (p.length === 1 && p[0] !== '' && !isNaN(+p[0])) binding.push([+p[0], +p[0], +p[0], 1, 0, 0, 0, 0, 0]);
    }
  }
  if (binding.length !== eyeObj.v.length / 3) throw new Error(`Eye binding mismatch ${binding.length} vs ${eyeObj.v.length / 3}`);
  // split by (v, vt) so each output vertex has one uv
  const key = new Map();
  const eyeSrc = [];
  const eyeUv = [];
  const eyeIdx = [];
  const corneaIdx = [];
  const isCorneaUV = (u, vv) => (u - 0.935) ** 2 + (vv - 0.065) ** 2 < 0.07 ** 2;
  for (const f of eyeObj.groups.values())
    for (const face of f) {
      const ids = face.map(([v, t]) => {
        const k = `${v}/${t}`;
        if (!key.has(k)) {
          key.set(k, eyeSrc.length);
          eyeSrc.push(v);
          eyeUv.push(eyeObj.vt[t * 2], eyeObj.vt[t * 2 + 1]);
        }
        return key.get(k);
      });
      const u = face.reduce((s, [, t]) => s + eyeObj.vt[t * 2], 0) / face.length;
      const w = face.reduce((s, [, t]) => s + eyeObj.vt[t * 2 + 1], 0) / face.length;
      const target = isCorneaUV(u, w) ? corneaIdx : eyeIdx;
      for (let k = 1; k + 1 < ids.length; k++) target.push(ids[0], ids[k], ids[k + 1]);
    }
  const eb = new Uint16Array(eyeSrc.length * 3);
  const ew = new Float32Array(eyeSrc.length * 3);
  const ed = new Float32Array(eyeSrc.length * 3);
  eyeSrc.forEach((s, i) => {
    const b = binding[s];
    eb.set([b[0], b[1], b[2]], i * 3);
    ew.set([b[3], b[4], b[5]], i * 3);
    ed.set([b[6] * DM_TO_M, b[7] * DM_TO_M, b[8] * DM_TO_M], i * 3);
  });
  const eyes = {
    count: eyeSrc.length,
    bindIdx: bin.add(eb),
    bindW: bin.add(ew),
    bindD: bin.add(ed),
    uv: bin.add(new Float32Array(eyeUv)),
    index: bin.add(new Uint32Array(eyeIdx)),
    corneaIndex: bin.add(new Uint32Array(corneaIdx)),
    scaleRefs,
    // iris centres in texture space (texture is 1024^2, v flipped: v = 1 - py/1024)
    irisUv: [
      [720 / 1024, 1 - 305 / 1024],
      [295 / 1024, 1 - 725 / 1024],
    ],
    irisRadiusUv: 118 / 1024,
    pupilRadiusUv: 38 / 1024,
  };
  fs.copyFileSync(path.join(SRC, 'eyes/materials/brown_eye.png'), path.join(OUT, 'eye_brown.png'));

  // ---------------------------------------------------------------- write
  const meta = {
    version: 1,
    generator: 'scripts/assets/build-human.mjs',
    units: 'm',
    axes: '+Y up, +Z anterior, +X patient left (MakeHuman)',
    license: 'CC0 1.0 (MakeHuman community assets); see ASSETS.md',
    vertexCount: nV,
    regionIds: R,
    buffers: {
      positions: bin.add(P),
      skinIndex: bin.add(skinIdx),
      skinWeight: bin.add(skinW),
      region: bin.add(region),
      masks: bin.add(masks),
      bodyIndex: bin.add(bodyTris),
      bodyQuads: bin.add(bodyQuads),
      jointVerts: bin.add(new Uint16Array(jointVerts)),
      jointOffsets: bin.add(new Uint32Array(jointOffsets)),
    },
    helpers,
    joints: jointNames,
    bones,
    macroTargets,
    morphTargets,
    eyes,
    landmarkVerts: { sternalNotch: notch, navel, mouth: mouthFront, noseTip },
    reference: { browY, eyeY },
  };
  const buf = bin.toBuffer();
  fs.writeFileSync(path.join(OUT, 'human.bin'), buf);
  fs.writeFileSync(path.join(OUT, 'human.json'), JSON.stringify(meta));
  console.log(`  human.bin ${fmtBytes(buf.length)}, human.json ${fmtBytes(JSON.stringify(meta).length)}`);
  console.log(`  bones ${bones.length}, joints ${jointNames.length}, macro ${macroTargets.length}, morph ${morphTargets.length}`);
  for (const t of morphTargets) console.log(`    morph ${t.name}: ${t.count} verts`);
  const hist = {};
  for (const r of region) hist[r] = (hist[r] ?? 0) + 1;
  console.log('  region histogram', JSON.stringify(hist));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
