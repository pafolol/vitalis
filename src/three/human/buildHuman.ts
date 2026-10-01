import * as THREE from 'three';
import type { BodyShapeParams } from '../types';
import type { HumanAsset, SparseTarget } from './humanAsset';
import { createSkinMaterial, type SkinUniforms } from './skinMaterial';
import { createEyeMaterials, type EyeUniforms } from './eyeMaterial';
import { createHairShells } from './hairShells';
import { computeLandmarks, type HumanLandmarks } from './landmarks';
import { computeBasePose, type PoseLibrary } from './pose';
import { buildSubdivTopology, subdivideLinear, subdividePositions, subdivideSkin, type SubdivTopology } from './subdivide';

/**
 * Builds a patient-specific rigged human from the MakeHuman asset.
 *
 * The per-patient body shape (sex x age x muscle x weight) is baked on the CPU
 * following MakeHuman's macro-modifier weighting; the skeleton is then fitted
 * to the morphed mesh by recomputing joint centres from the joint helper
 * vertices. Only expression / breathing / CPR / angio-oedema remain as runtime
 * morph targets.
 */

export interface HumanRig {
  /** Group to position in the world (bed). Contains `frame`. */
  root: THREE.Group;
  /** MakeHuman-space frame: rotated so the patient lies supine, scaled to height. */
  frame: THREE.Group;
  body: THREE.SkinnedMesh;
  helpers: THREE.SkinnedMesh[];
  hairShells: THREE.SkinnedMesh[];
  eyes: { left: THREE.Mesh; right: THREE.Mesh; corneaLeft: THREE.Mesh; corneaRight: THREE.Mesh };
  skeleton: THREE.Skeleton;
  bones: Record<string, THREE.Bone>;
  /** Morph dictionary shared by body & helpers (name → index per mesh stored in mesh.morphTargetDictionary) */
  morphNames: string[];
  skin: { material: THREE.MeshPhysicalMaterial; uniforms: SkinUniforms };
  eyeUniforms: EyeUniforms;
  landmarks: HumanLandmarks;
  pose: PoseLibrary;
  /** Metres per MH unit applied by `frame.scale` */
  heightScale: number;
  /** Baked MH-space vertex positions (all vertices incl. helpers), metres, unscaled */
  positions: Float32Array;
  /** Region id per body-geometry vertex (subdivided) */
  region: Uint8Array;
  params: BodyShapeParams;
  dispose(): void;
}

/** Supine orientation: MH (+X left, +Y up, +Z front) → world (left → -Z, up(head) → -X, front → +Y). */
export const SUPINE_QUATERNION = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1),
);

function macroWeights(params: BodyShapeParams) {
  const gender = params.sex === 'male' ? 1 : 0;
  // MakeHuman age slider: 0.5 = 25 y, 1.0 = 90 y. Younger adults clamp to "young".
  const ageV = THREE.MathUtils.clamp(0.5 + ((params.ageYears - 25) / 65) * 0.5, 0.5, 1);
  const tri = (v: number) => {
    const min = Math.max(0, (0.5 - v) * 2);
    const max = Math.max(0, (v - 0.5) * 2);
    return { min, avg: 1 - min - max, max };
  };
  const m = tri(THREE.MathUtils.clamp(0.5 + 0.5 * params.muscleFactor, 0, 1));
  const w = tri(THREE.MathUtils.clamp(0.5 + 0.5 * params.weightFactor, 0, 1));
  return {
    sex: { male: gender, female: 1 - gender } as Record<string, number>,
    age: { young: 1 - (ageV - 0.5) * 2, old: (ageV - 0.5) * 2 } as Record<string, number>,
    muscle: { minmuscle: m.min, averagemuscle: m.avg, maxmuscle: m.max } as Record<string, number>,
    weight: { minweight: w.min, averageweight: w.avg, maxweight: w.max } as Record<string, number>,
  };
}

function addSparse(out: Float32Array, t: SparseTarget, w: number) {
  const s = t.scale * w;
  for (let i = 0; i < t.idx.length; i++) {
    const v = t.idx[i] * 3;
    out[v] += t.delta[i * 3] * s;
    out[v + 1] += t.delta[i * 3 + 1] * s;
    out[v + 2] += t.delta[i * 3 + 2] * s;
  }
}

export function bakeShape(asset: HumanAsset, params: BodyShapeParams): Float32Array {
  const pos = asset.positions.slice();
  const mw = macroWeights(params);
  for (const t of asset.macroTargets) {
    const w = mw.sex[t.sex] * mw.age[t.age] * (t.muscle === 'any' ? 1 : mw.muscle[t.muscle]) * (t.weight === 'any' ? 1 : mw.weight[t.weight]);
    if (w > 1e-4) addSparse(pos, t, w);
  }
  return pos;
}

export function computeJoints(asset: HumanAsset, pos: Float32Array): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let j = 0; j < asset.meta.joints.length; j++) {
    const a = asset.jointOffsets[j];
    const b = asset.jointOffsets[j + 1];
    const v = new THREE.Vector3();
    for (let k = a; k < b; k++) {
      const i = asset.jointVerts[k] * 3;
      v.x += pos[i];
      v.y += pos[i + 1];
      v.z += pos[i + 2];
    }
    out.push(v.multiplyScalar(1 / Math.max(1, b - a)));
  }
  return out;
}

/** Compact a triangle list over the global vertex array into a skinned geometry. */
function buildSkinnedGeometry(
  asset: HumanAsset,
  pos: Float32Array,
  tris: Uint32Array,
  opts: { masks?: boolean; morphs?: boolean; identity?: boolean },
) {
  let map: Map<number, number>;
  let verts: number[];
  if (opts.identity) {
    const n = tris.reduce((m, v) => Math.max(m, v), 0) + 1;
    verts = Array.from({ length: n }, (_, i) => i);
    map = new Map(verts.map((v) => [v, v]));
  } else {
    map = new Map();
    verts = [];
    for (const v of tris) if (!map.has(v)) {
      map.set(v, verts.length);
      verts.push(v);
    }
  }
  const n = verts.length;
  const p = new Float32Array(n * 3);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const mA = new Uint8Array(n * 4);
  const mB = new Uint8Array(n * 4);
  verts.forEach((v, i) => {
    p[i * 3] = pos[v * 3];
    p[i * 3 + 1] = pos[v * 3 + 1];
    p[i * 3 + 2] = pos[v * 3 + 2];
    for (let k = 0; k < 4; k++) {
      si[i * 4 + k] = asset.skinIndex[v * 4 + k];
      sw[i * 4 + k] = asset.skinWeight[v * 4 + k] / 255;
      mA[i * 4 + k] = asset.masks[v * 8 + k];
      mB[i * 4 + k] = asset.masks[v * 8 + 4 + k];
    }
  });
  const index = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i++) index[i] = map.get(tris[i])!;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  if (opts.masks) {
    g.setAttribute('masksA', new THREE.BufferAttribute(mA, 4, true));
    g.setAttribute('masksB', new THREE.BufferAttribute(mB, 4, true));
  }
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();

  const dict: Record<string, number> = {};
  if (opts.morphs) {
    const morphs: THREE.BufferAttribute[] = [];
    for (const t of asset.morphTargets) {
      let any = false;
      const d = new Float32Array(n * 3);
      for (let i = 0; i < t.idx.length; i++) {
        const local = map.get(t.idx[i]);
        if (local === undefined) continue;
        any = true;
        d[local * 3] = t.delta[i * 3] * t.scale;
        d[local * 3 + 1] = t.delta[i * 3 + 1] * t.scale;
        d[local * 3 + 2] = t.delta[i * 3 + 2] * t.scale;
      }
      if (!any) continue;
      dict[t.name] = morphs.length;
      const attr = new THREE.BufferAttribute(d, 3);
      attr.name = t.name;
      morphs.push(attr);
    }
    if (morphs.length) {
      g.morphAttributes.position = morphs;
      g.morphTargetsRelative = true;
    }
  }
  g.computeBoundingSphere();
  return { geometry: g, dict };
}

const topoCache = new WeakMap<HumanAsset, SubdivTopology>();

/**
 * Multi-scale concavity ("cavity map") used as a cheap ambient-occlusion term:
 * how far each vertex lies below its Laplacian-smoothed neighbourhood.
 */
function computeCavity(quads: Uint32Array, pos: Float32Array, normals: Float32Array, n: number): Float32Array {
  const nbrCount = new Uint16Array(n);
  const pairs: number[] = [];
  for (let q = 0; q < quads.length; q += 4)
    for (let k = 0; k < 4; k++) {
      const a = quads[q + k];
      const b = quads[q + ((k + 1) % 4)];
      pairs.push(a, b);
      nbrCount[a]++;
      nbrCount[b]++;
    }
  let cur = pos.slice(0, n * 3);
  const out = new Float32Array(n);
  const scales = [3, 10];
  let iter = 0;
  for (const target of scales) {
    for (; iter < target; iter++) {
      const acc = new Float32Array(n * 3);
      for (let i = 0; i < pairs.length; i += 2) {
        const a = pairs[i] * 3;
        const b = pairs[i + 1] * 3;
        acc[a] += cur[b];
        acc[a + 1] += cur[b + 1];
        acc[a + 2] += cur[b + 2];
        acc[b] += cur[a];
        acc[b + 1] += cur[a + 1];
        acc[b + 2] += cur[a + 2];
      }
      const next = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) {
        const c = nbrCount[v] || 1;
        for (let k = 0; k < 3; k++) next[v * 3 + k] = cur[v * 3 + k] * 0.4 + (acc[v * 3 + k] / c) * 0.6;
      }
      cur = next;
    }
    const lo = target === 3 ? 0.0006 : 0.002;
    const hi = target === 3 ? 0.004 : 0.012;
    for (let v = 0; v < n; v++) {
      const d =
        (cur[v * 3] - pos[v * 3]) * normals[v * 3] +
        (cur[v * 3 + 1] - pos[v * 3 + 1]) * normals[v * 3 + 1] +
        (cur[v * 3 + 2] - pos[v * 3 + 2]) * normals[v * 3 + 2];
      out[v] = Math.max(out[v], THREE.MathUtils.smoothstep(d, lo, hi) * (target === 3 ? 0.6 : 0.8));
    }
  }
  return out;
}

/** Body geometry with one level of Catmull–Clark subdivision (smooth silhouettes). */
function buildBodyGeometry(asset: HumanAsset, pos: Float32Array) {
  const nSrc = asset.meta.buffers.skinIndex.length / 4;
  let nBody = 0;
  for (let i = 0; i < asset.bodyQuads.length; i++) nBody = Math.max(nBody, asset.bodyQuads[i] + 1);
  let topo = topoCache.get(asset);
  if (!topo) {
    topo = buildSubdivTopology(asset.bodyQuads, nBody);
    topoCache.set(asset, topo);
  }
  void nSrc;
  const p = subdividePositions(topo, pos);
  const skin = subdivideSkin(topo, asset.skinIndex, asset.skinWeight, 1 / 255);
  const masks = subdivideLinear(topo, asset.masks, 8);
  const mA = new Float32Array(topo.nOut * 4);
  const mB = new Float32Array(topo.nOut * 4);
  for (let i = 0; i < topo.nOut; i++) {
    for (let k = 0; k < 4; k++) {
      mA[i * 4 + k] = masks[i * 8 + k] / 255;
      mB[i * 4 + k] = masks[i * 8 + 4 + k] / 255;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.idx, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skin.w, 4));
  g.setAttribute('masksA', new THREE.BufferAttribute(mA, 4));
  g.setAttribute('masksB', new THREE.BufferAttribute(mB, 4));
  g.setIndex(new THREE.BufferAttribute(topo.tris, 1));
  g.computeVertexNormals();
  g.setAttribute('cavity', new THREE.BufferAttribute(computeCavity(topo.quads, p, g.getAttribute('normal').array as Float32Array, topo.nOut), 1));
  const dict: Record<string, number> = {};
  const morphs: THREE.BufferAttribute[] = [];
  const dense = new Float32Array(nBody * 3);
  for (const t of asset.morphTargets) {
    dense.fill(0);
    let any = false;
    for (let i = 0; i < t.idx.length; i++) {
      const v = t.idx[i];
      if (v >= nBody) continue;
      any = true;
      dense[v * 3] = t.delta[i * 3] * t.scale;
      dense[v * 3 + 1] = t.delta[i * 3 + 1] * t.scale;
      dense[v * 3 + 2] = t.delta[i * 3 + 2] * t.scale;
    }
    if (!any) continue;
    const attr = new THREE.BufferAttribute(subdivideLinear(topo, dense, 3), 3);
    attr.name = t.name;
    dict[t.name] = morphs.length;
    morphs.push(attr);
  }
  g.morphAttributes.position = morphs;
  g.morphTargetsRelative = true;
  g.computeBoundingSphere();
  const region = new Uint8Array(topo.nOut);
  for (let i = 0; i < topo.nOut; i++) region[i] = asset.region[topo.primary[i]];
  return { geometry: g, dict, region };
}

function hairColorFor(params: BodyShapeParams): THREE.Color {
  // darker hair for darker skin tones; greys with age
  const dark = new THREE.Color().setRGB(0.05, 0.035, 0.025, THREE.SRGBColorSpace);
  const brown = new THREE.Color().setRGB(0.2, 0.13, 0.08, THREE.SRGBColorSpace);
  const grey = new THREE.Color().setRGB(0.52, 0.5, 0.48, THREE.SRGBColorSpace);
  const base = params.skinTone > 0.45 ? dark : brown.clone().lerp(dark, params.skinTone);
  const greyT = THREE.MathUtils.smoothstep(params.ageYears, 45, 80) * 0.85;
  return base.lerp(grey, greyT);
}

export function buildHuman(asset: HumanAsset, params: BodyShapeParams, eyeTexture: THREE.Texture | null): HumanRig {
  const pos = bakeShape(asset, params);
  const joints = computeJoints(asset, pos);
  const meta = asset.meta;

  // ---------------------------------------------------------------- skeleton
  const bones: THREE.Bone[] = [];
  const byName: Record<string, THREE.Bone> = {};
  for (const b of meta.bones) {
    const bone = new THREE.Bone();
    bone.name = b.name;
    const head = joints[b.head];
    if (b.parent >= 0) {
      const ph = joints[meta.bones[b.parent].head];
      bone.position.copy(head).sub(ph);
      bones[b.parent].add(bone);
    } else {
      bone.position.copy(head);
    }
    bones.push(bone);
    byName[b.name] = bone;
  }
  const rootBone = bones[meta.bones.findIndex((b) => b.parent < 0)];
  const skeleton = new THREE.Skeleton(bones);

  // ---------------------------------------------------------------- frame
  const root = new THREE.Group();
  root.name = 'patient-root';
  const frame = new THREE.Group();
  frame.name = 'patient-frame';
  frame.quaternion.copy(SUPINE_QUATERNION);
  root.add(frame);
  frame.add(rootBone);

  // height: top of head to soles (baked, unscaled)
  let minY = Infinity;
  let maxY = -Infinity;
  const nBody = meta.buffers.positions.length / 3;
  for (let i = 0; i < asset.bodyIndex.length; i++) {
    const y = pos[asset.bodyIndex[i] * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  void nBody;
  const heightScale = params.heightM / (maxY - minY);
  frame.scale.setScalar(heightScale);

  // ---------------------------------------------------------------- landmarks & materials
  const landmarks = computeLandmarks(asset, pos, joints);
  const earL = landmarks.points.earL.p;
  const earR = landmarks.points.earR.p;
  const eyeLp = landmarks.boneHead('eye.L');
  const eyeRp = landmarks.boneHead('eye.R');
  const male = params.sex === 'male';
  const skin = createSkinMaterial({
    skinTone: params.skinTone,
    female: !male,
    ageYears: params.ageYears,
    hairColor: hairColorFor(params),
    hairDensity: male ? 1 - THREE.MathUtils.smoothstep(params.ageYears, 45, 85) * 0.45 : 1,
    recession: male ? THREE.MathUtils.smoothstep(params.ageYears, 25, 70) : 0,
    landmarks: {
      eyeL: eyeLp,
      eyeR: eyeRp,
      mouth: landmarks.points.mouth.p,
      nippleL: landmarks.boneTail('breast.L'),
      nippleR: landmarks.boneTail('breast.R'),
      earL,
      earR,
      headCenter: new THREE.Vector3(0, (eyeLp.y + eyeRp.y) / 2, (earL.z + earR.z) / 2 + 0.005),
      browY: landmarks.browY,
      hipL: landmarks.boneHead('upperleg01.L'),
      hipR: landmarks.boneHead('upperleg01.R'),
      kneeL: landmarks.boneHead('lowerleg01.L'),
      kneeR: landmarks.boneHead('lowerleg01.R'),
      waistY: landmarks.points.navel.p.y - 0.035,
    },
  });
  const eyeMats = createEyeMaterials(eyeTexture, meta.eyes);

  // ---------------------------------------------------------------- body
  const bodyGeo = buildBodyGeometry(asset, pos);
  const body = new THREE.SkinnedMesh(bodyGeo.geometry, skin.material);
  body.name = 'patient-body';
  body.morphTargetDictionary = bodyGeo.dict;
  body.morphTargetInfluences = new Array(Object.keys(bodyGeo.dict).length).fill(0);
  body.castShadow = true;
  body.receiveShadow = true;
  body.frustumCulled = false;
  frame.add(body);

  // ---------------------------------------------------------------- helpers (shorts, teeth, tongue, lashes)
  const helpers: THREE.SkinnedMesh[] = [];
  const shortsMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(0.12, 0.16, 0.24, THREE.SRGBColorSpace),
    roughness: 0.92,
    sheen: 0.6,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0.25, 0.3, 0.4),
  });
  const teethMat = new THREE.MeshPhysicalMaterial({ color: 0xe8e1cf, roughness: 0.3, clearcoat: 0.3 });
  const tongueMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(0.6, 0.25, 0.25, THREE.SRGBColorSpace), roughness: 0.45 });
  const lashMat = new THREE.MeshStandardMaterial({ color: 0x120c08, roughness: 0.9, side: THREE.DoubleSide });
  const addHelper = (name: string, tris: Uint32Array, mat: THREE.Material, pushOut = 0) => {
    if (!tris.length) return;
    const { geometry, dict } = buildSkinnedGeometry(asset, pos, tris, { morphs: true });
    if (pushOut) {
      const p = geometry.getAttribute('position') as THREE.BufferAttribute;
      const n = geometry.getAttribute('normal') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        p.setXYZ(i, p.getX(i) + n.getX(i) * pushOut, p.getY(i) + n.getY(i) * pushOut, p.getZ(i) + n.getZ(i) * pushOut);
      }
    }
    const m = new THREE.SkinnedMesh(geometry, mat);
    m.name = name;
    m.morphTargetDictionary = dict;
    m.morphTargetInfluences = new Array(Object.keys(dict).length).fill(0);
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    frame.add(m);
    helpers.push(m);
  };
  addHelper('upper-teeth', asset.helpers.upperTeeth, teethMat);
  addHelper('lower-teeth', asset.helpers.lowerTeeth, teethMat);
  addHelper('tongue', asset.helpers.tongue, tongueMat);
  void lashMat;

  // bind everything with rest pose (identity rotations)
  root.updateMatrixWorld(true);
  body.bind(skeleton);
  for (const h of helpers) h.bind(skeleton);
  const hair = createHairShells(body, skin.uniforms, { layers: 7, lengthM: male ? 0.0055 : 0.011 });
  for (const m of hair.meshes) {
    frame.add(m);
    m.bind(skeleton, body.bindMatrix);
  }

  // ---------------------------------------------------------------- eyes (proxy fitted via mhclo)
  const e = meta.eyes;
  const ref = (k: 'x' | 'y' | 'z', axis: number) => {
    const [a, b, dist] = e.scaleRefs[k];
    return Math.abs(pos[a * 3 + axis] - pos[b * 3 + axis]) / dist;
  };
  const sx = ref('x', 0);
  const sy = ref('y', 1);
  const sz = ref('z', 2);
  const eyePos = new Float32Array(e.count * 3);
  for (let i = 0; i < e.count; i++) {
    for (let ax = 0; ax < 3; ax++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += asset.eyes.bindW[i * 3 + k] * pos[asset.eyes.bindIdx[i * 3 + k] * 3 + ax];
      s += asset.eyes.bindD[i * 3 + ax] * (ax === 0 ? sx : ax === 1 ? sy : sz);
      eyePos[i * 3 + ax] = s;
    }
  }
  const eyeL = byName['eye.L'];
  const eyeR = byName['eye.R'];
  const eyeHeadL = joints[meta.bones.find((b) => b.name === 'eye.L')!.head];
  const eyeHeadR = joints[meta.bones.find((b) => b.name === 'eye.R')!.head];
  const makeEye = (indices: Uint32Array, left: boolean, mat: THREE.Material) => {
    const center = left ? eyeHeadL : eyeHeadR;
    const keep: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const x = eyePos[indices[t] * 3];
      if (left ? x > 0 : x < 0) keep.push(indices[t], indices[t + 1], indices[t + 2]);
    }
    const map = new Map<number, number>();
    const pArr: number[] = [];
    const uvArr: number[] = [];
    const idx = keep.map((v) => {
      if (!map.has(v)) {
        map.set(v, pArr.length / 3);
        pArr.push(eyePos[v * 3] - center.x, eyePos[v * 3 + 1] - center.y, eyePos[v * 3 + 2] - center.z);
        uvArr.push(asset.eyes.uv[v * 2], asset.eyes.uv[v * 2 + 1]);
      }
      return map.get(v)!;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pArr, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.name = left ? 'eye-left' : 'eye-right';
    (left ? eyeL : eyeR).add(m);
    return m;
  };
  const eyes = {
    left: makeEye(asset.eyes.index, true, eyeMats.eyeball),
    right: makeEye(asset.eyes.index, false, eyeMats.eyeball),
    corneaLeft: makeEye(asset.eyes.corneaIndex, true, eyeMats.cornea),
    corneaRight: makeEye(asset.eyes.corneaIndex, false, eyeMats.cornea),
  };
  eyes.corneaLeft.renderOrder = eyes.corneaRight.renderOrder = 2;

  // ---------------------------------------------------------------- pose library
  const pose = computeBasePose(meta, joints, byName, landmarks);

  const dispose = () => {
    body.geometry.dispose();
    for (const h of helpers) h.geometry.dispose();
    for (const m of Object.values(eyes)) m.geometry.dispose();
    skin.material.dispose();
    hair.dispose();
    shortsMat.dispose();
    teethMat.dispose();
    tongueMat.dispose();
    lashMat.dispose();
    eyeMats.eyeball.dispose();
    eyeMats.cornea.dispose();
    skeleton.dispose();
  };

  return {
    root,
    frame,
    body,
    helpers,
    hairShells: hair.meshes,
    eyes,
    skeleton,
    bones: byName,
    morphNames: Object.keys(bodyGeo.dict),
    skin,
    eyeUniforms: eyeMats.uniforms,
    landmarks,
    pose,
    heightScale,
    positions: pos,
    region: bodyGeo.region,
    params,
    dispose,
  };
}
