import * as THREE from 'three';
import type { HumanAsset } from './humanAsset';

/**
 * Anatomical landmarks located on the (patient-specific) baked mesh in
 * MakeHuman rest space. Surface points are found by casting rays against the
 * body vertices; each is associated with the bone that dominates its skinning
 * so props/zones can be parented to that bone and follow the pose.
 */

export interface SurfacePoint {
  p: THREE.Vector3;
  n: THREE.Vector3;
  bone: string;
  vertex: number;
}

export interface LimbSection {
  center: THREE.Vector3;
  axis: THREE.Vector3;
  radius: number;
  bone: string;
}

export type LandmarkName =
  | 'sternalNotch'
  | 'xiphoid'
  | 'navel'
  | 'nippleL'
  | 'nippleR'
  | 'secondICSL'
  | 'secondICSR'
  | 'aortic'
  | 'pulmonic'
  | 'tricuspid'
  | 'mitral'
  | 'v1'
  | 'v2'
  | 'v3'
  | 'v4'
  | 'v5'
  | 'v6'
  | 'ra'
  | 'la'
  | 'rl'
  | 'll'
  | 'padRight'
  | 'padLeft'
  | 'fifthAxL'
  | 'fifthAxR'
  | 'axillaL'
  | 'axillaR'
  | 'lowerChestL'
  | 'lowerChestR'
  | 'upperChestL'
  | 'upperChestR'
  | 'epigastrium'
  | 'ruq'
  | 'luq'
  | 'rlq'
  | 'llq'
  | 'trachea'
  | 'carotidL'
  | 'carotidR'
  | 'radialL'
  | 'radialR'
  | 'femoralL'
  | 'femoralR'
  | 'noseTip'
  | 'mouth'
  | 'chin'
  | 'forehead'
  | 'cheekL'
  | 'cheekR'
  | 'earL'
  | 'earR'
  | 'forearmIVL'
  | 'forearmIVR'
  | 'tibiaIOL'
  | 'tibiaIOR'
  | 'fingerTipL'
  | 'fingerTipR'
  | 'handDorsumL'
  | 'handDorsumR'
  | 'kneeL'
  | 'kneeR'
  | 'thighL'
  | 'thighR'
  | 'upperArmL'
  | 'upperArmR'
  | 'backMid';

export interface HumanLandmarks {
  points: Record<LandmarkName, SurfacePoint>;
  sections: Record<'upperArmL' | 'upperArmR' | 'thighL' | 'thighR' | 'forearmL' | 'forearmR', LimbSection>;
  regionPoints: Record<string, SurfacePoint>;
  boneHead(name: string): THREE.Vector3;
  /** Ray cast against the rest-pose body surface (first hit along `dir`). */
  surfaceRay(origin: THREE.Vector3, dir: THREE.Vector3, r?: number, filter?: (v: number) => boolean): SurfacePoint;
  /** Neighbouring vertex most aligned with `dir` (rest space), for building tangent frames. */
  neighbourToward(vertex: number, dir: THREE.Vector3, maxDist?: number): number;
  eyeY: number;
  browY: number;
  boneTail(name: string): THREE.Vector3;
  /** Bounding info in MH rest space (metres, unscaled) */
  minY: number;
  maxY: number;
  /** Most posterior trunk/head surface (lies on mattress) */
  backZ: number;
  headBackZ: number;
  heelZ: number;
}

export function computeLandmarks(asset: HumanAsset, pos: Float32Array, joints: THREE.Vector3[]): HumanLandmarks {
  const meta = asset.meta;
  const boneMeta = new Map(meta.bones.map((b) => [b.name, b]));
  const boneHead = (n: string) => joints[boneMeta.get(n)!.head].clone();
  const boneTail = (n: string) => joints[boneMeta.get(n)!.tail].clone();

  // body vertex set and normals
  const tris = asset.bodyIndex;
  let nBody = 0;
  for (let i = 0; i < tris.length; i++) nBody = Math.max(nBody, tris[i] + 1);
  const normals = new Float32Array(nBody * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < tris.length; t += 3) {
    a.fromArray(pos, tris[t] * 3);
    b.fromArray(pos, tris[t + 1] * 3);
    c.fromArray(pos, tris[t + 2] * 3);
    b.sub(a);
    c.sub(a);
    b.cross(c);
    for (let k = 0; k < 3; k++) {
      const v = tris[t + k] * 3;
      normals[v] += b.x;
      normals[v + 1] += b.y;
      normals[v + 2] += b.z;
    }
  }
  const boneNames = meta.bones.map((bb) => bb.name);
  const V = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const N = (i: number) => new THREE.Vector3(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]).normalize();
  const dom = (i: number) => boneNames[asset.skinIndex[i * 4]];

  const tmp = new THREE.Vector3();
  const ray = (origin: THREE.Vector3, dir: THREE.Vector3, r = 0.012, filter?: (v: number) => boolean): SurfacePoint => {
    const d = dir.clone().normalize();
    let best = -1;
    let bestT = Infinity;
    let rr = r;
    for (let attempt = 0; attempt < 4 && best < 0; attempt++, rr *= 2) {
      for (let i = 0; i < nBody; i++) {
        if (filter && !filter(i)) continue;
        tmp.fromArray(pos, i * 3).sub(origin);
        const t = tmp.dot(d);
        if (t <= 0) continue;
        const perp2 = tmp.lengthSq() - t * t;
        if (perp2 < rr * rr && t < bestT) {
          // outward facing wrt ray
          if (normals[i * 3] * d.x + normals[i * 3 + 1] * d.y + normals[i * 3 + 2] * d.z > 0) continue;
          bestT = t;
          best = i;
        }
      }
    }
    if (best < 0) best = 0;
    return { p: V(best), n: N(best), bone: dom(best), vertex: best };
  };
  const front = (x: number, y: number, r?: number, filter?: (v: number) => boolean) =>
    ray(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1), r, filter);
  const fromSide = (side: 1 | -1, y: number, z: number, r?: number) =>
    ray(new THREE.Vector3(side * 1, y, z), new THREE.Vector3(-side, 0, 0), r, (v) => asset.region[v] >= 3 && asset.region[v] <= 6);
  const vertexPoint = (i: number): SurfacePoint => ({ p: V(i), n: N(i), bone: dom(i), vertex: i });

  const lv = meta.landmarkVerts;
  // patient-specific eye/brow heights (reference values are from the unmorphed base mesh)
  const eyeY = (boneHead('eye.L').y + boneHead('eye.R').y) / 2;
  const browY = eyeY + (meta.reference.browY - meta.reference.eyeY);
  const notch = vertexPoint(lv.sternalNotch);
  const navel = vertexPoint(lv.navel);
  const nipL = boneTail('breast.L');
  const nipR = boneTail('breast.R');
  const nipY = (nipL.y + nipR.y) / 2;
  const clavMidX = (boneHead('clavicle.L').x + boneTail('clavicle.L').x) / 2;
  const icsStep = (notch.p.y - (nipY - 0.03)) / 3.5; // approx intercostal spacing along sternum
  const ics = (n: number) => notch.p.y - icsStep * (n - 0.6);
  const spine3 = boneHead('spine03');
  const trunkOnly = (v: number) => asset.region[v] >= 3 && asset.region[v] <= 6;
  const neckOnly = (v: number) => asset.region[v] === 2;
  const faceOnly = (v: number) => asset.region[v] === 1 || asset.region[v] === 15 || asset.region[v] === 0;
  const xiphoidY = nipY - 0.045;
  const hipL = boneHead('upperleg01.L');
  const hipR = boneHead('upperleg01.R');

  const points = {} as Record<LandmarkName, SurfacePoint>;
  points.sternalNotch = notch;
  points.xiphoid = front(0, xiphoidY, 0.01, trunkOnly);
  points.navel = navel;
  points.nippleL = front(nipL.x, nipL.y, 0.01, trunkOnly);
  points.nippleR = front(nipR.x, nipR.y, 0.01, trunkOnly);
  points.secondICSL = front(clavMidX, ics(2), 0.012, trunkOnly);
  points.secondICSR = front(-clavMidX, ics(2), 0.012, trunkOnly);
  points.aortic = front(-0.025, ics(2), 0.01, trunkOnly);
  points.pulmonic = front(0.025, ics(2), 0.01, trunkOnly);
  points.tricuspid = front(0.018, ics(4.5), 0.01, trunkOnly);
  points.mitral = front(clavMidX * 0.95, ics(5), 0.012, trunkOnly);
  points.v1 = front(-0.025, ics(4), 0.01, trunkOnly);
  points.v2 = front(0.025, ics(4), 0.01, trunkOnly);
  points.v4 = front(clavMidX * 0.95, ics(5), 0.012, trunkOnly);
  points.v3 = front((0.025 + clavMidX * 0.95) / 2, (ics(4) + ics(5)) / 2, 0.012, trunkOnly);
  points.v5 = fromSide(1, ics(5), spine3.z + 0.07);
  points.v6 = fromSide(1, ics(5), spine3.z + 0.015);
  points.ra = front(-clavMidX * 1.2, notch.p.y - 0.035, 0.012, trunkOnly);
  points.la = front(clavMidX * 1.2, notch.p.y - 0.035, 0.012, trunkOnly);
  points.rl = front(-0.085, navel.p.y - 0.02, 0.012, trunkOnly);
  points.ll = front(0.085, navel.p.y - 0.02, 0.012, trunkOnly);
  points.padRight = front(-clavMidX * 0.9, notch.p.y - 0.065, 0.012, trunkOnly);
  points.padLeft = fromSide(1, ics(5.5), spine3.z + 0.03);
  points.fifthAxL = fromSide(1, ics(5), spine3.z + 0.02);
  points.fifthAxR = fromSide(-1, ics(5), spine3.z + 0.02);
  points.axillaL = fromSide(1, ics(3.5), spine3.z + 0.02);
  points.axillaR = fromSide(-1, ics(3.5), spine3.z + 0.02);
  points.upperChestL = points.secondICSL;
  points.upperChestR = points.secondICSR;
  points.lowerChestL = front(clavMidX * 1.15, xiphoidY - 0.01, 0.012, trunkOnly);
  points.lowerChestR = front(-clavMidX * 1.15, xiphoidY - 0.01, 0.012, trunkOnly);
  points.epigastrium = front(0, xiphoidY - 0.05, 0.012, trunkOnly);
  points.ruq = front(-0.075, (xiphoidY + navel.p.y) / 2 - 0.01, 0.012, trunkOnly);
  points.luq = front(0.075, (xiphoidY + navel.p.y) / 2 - 0.01, 0.012, trunkOnly);
  points.rlq = front(-0.075, (navel.p.y + hipR.y) / 2, 0.012, trunkOnly);
  points.llq = front(0.075, (navel.p.y + hipL.y) / 2, 0.012, trunkOnly);
  points.trachea = front(0, notch.p.y + 0.035, 0.01, neckOnly);
  points.carotidL = front(0.032, notch.p.y + 0.06, 0.01, neckOnly);
  points.carotidR = front(-0.032, notch.p.y + 0.06, 0.01, neckOnly);

  // wrists: use joints; volar/dorsal surfaces resolved by nearest vertex
  const nearest = (p: THREE.Vector3, filter?: (v: number) => boolean) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < nBody; i++) {
      if (filter && !filter(i)) continue;
      const d = tmp.fromArray(pos, i * 3).distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return vertexPoint(best);
  };
  const wristL = boneHead('wrist.L');
  const wristR = boneHead('wrist.R');
  points.radialL = nearest(wristL.clone().add(new THREE.Vector3(0, 0, 0.03)));
  points.radialR = nearest(wristR.clone().add(new THREE.Vector3(0, 0, 0.03)));
  points.femoralL = front(hipL.x * 0.75, hipL.y - 0.035, 0.012);
  points.femoralR = front(hipR.x * 0.75, hipR.y - 0.035, 0.012);
  points.noseTip = vertexPoint(lv.noseTip);
  points.mouth = vertexPoint(lv.mouth);
  points.chin = front(0, points.mouth.p.y - 0.045, 0.008, faceOnly);
  points.forehead = front(0, browY + 0.035, 0.01, faceOnly);
  points.cheekL = front(0.042, points.noseTip.p.y - 0.005, 0.01, faceOnly);
  points.cheekR = front(-0.042, points.noseTip.p.y - 0.005, 0.01, faceOnly);
  const headC = boneHead('head');
  points.earL = ray(new THREE.Vector3(1, eyeY - 0.02, headC.z - 0.01), new THREE.Vector3(-1, 0, 0), 0.012, faceOnly);
  points.earR = ray(new THREE.Vector3(-1, eyeY - 0.02, headC.z - 0.01), new THREE.Vector3(1, 0, 0), 0.012, faceOnly);

  // forearm dorsum (MakeHuman rest arms are pronated: dorsum faces up/+y)
  const forearmPoint = (side: 'L' | 'R') => {
    const e = boneHead(`lowerarm01.${side}`);
    const w = boneHead(`wrist.${side}`);
    const m = e.clone().lerp(w, 0.62);
    const reg = side === 'L' ? 7 : 8;
    return ray(m.clone().add(new THREE.Vector3(0, 0.5, 0)), new THREE.Vector3(0, -1, 0), 0.012, (v) => asset.region[v] === reg);
  };
  points.forearmIVL = forearmPoint('L');
  points.forearmIVR = forearmPoint('R');
  const tibia = (side: 'L' | 'R') => {
    const k = boneHead(`lowerleg01.${side}`);
    const an = boneHead(`foot.${side}`);
    const m = k.clone().lerp(an, 0.1);
    const reg = side === 'L' ? 11 : 12;
    return ray(m.clone().add(new THREE.Vector3(side === 'L' ? -0.01 : 0.01, 0, 0.5)), new THREE.Vector3(0, 0, -1), 0.012, (v) => asset.region[v] === reg);
  };
  points.tibiaIOL = tibia('L');
  points.tibiaIOR = tibia('R');
  points.kneeL = front(boneHead('lowerleg01.L').x, boneHead('lowerleg01.L').y, 0.012, (v) => asset.region[v] === 11);
  points.kneeR = front(boneHead('lowerleg01.R').x, boneHead('lowerleg01.R').y, 0.012, (v) => asset.region[v] === 12);
  points.fingerTipL = nearest(boneTail('finger2-3.L'));
  points.fingerTipR = nearest(boneTail('finger2-3.R'));
  const handDorsum = (side: 'L' | 'R') => {
    const m = boneHead(`metacarpal2.${side}`).lerp(boneHead(`metacarpal3.${side}`), 0.5).lerp(boneHead(`finger3-1.${side}`), 0.35);
    const reg = side === 'L' ? 9 : 10;
    return ray(m.clone().add(new THREE.Vector3(0, 0.5, 0)), new THREE.Vector3(0, -1, 0), 0.012, (v) => asset.region[v] === reg);
  };
  points.handDorsumL = handDorsum('L');
  points.handDorsumR = handDorsum('R');
  points.thighL = front(hipL.x, hipL.y - 0.18, 0.015, (v) => asset.region[v] === 11);
  points.thighR = front(hipR.x, hipR.y - 0.18, 0.015, (v) => asset.region[v] === 12);
  const uaMid = (side: 'L' | 'R') => boneHead(`upperarm01.${side}`).lerp(boneHead(`lowerarm01.${side}`), 0.45);
  points.upperArmL = nearest(uaMid('L').add(new THREE.Vector3(0, 0.02, 0.04)), (v) => asset.region[v] === 7);
  points.upperArmR = nearest(uaMid('R').add(new THREE.Vector3(0, 0.02, 0.04)), (v) => asset.region[v] === 8);
  points.backMid = ray(new THREE.Vector3(0, spine3.y, -1), new THREE.Vector3(0, 0, 1), 0.02, trunkOnly);

  // limb cross sections
  const section = (a: THREE.Vector3, b: THREE.Vector3, t: number, bone: string, reg: number): LimbSection => {
    const center = a.clone().lerp(b, t);
    const axis = b.clone().sub(a).normalize();
    let sum = 0;
    let n = 0;
    for (let i = 0; i < nBody; i++) {
      if (asset.region[i] !== reg) continue;
      tmp.fromArray(pos, i * 3).sub(center);
      const along = tmp.dot(axis);
      if (Math.abs(along) > 0.015) continue;
      sum += Math.sqrt(Math.max(0, tmp.lengthSq() - along * along));
      n++;
    }
    return { center, axis, radius: n ? sum / n : 0.045, bone };
  };
  const sections = {
    upperArmL: section(boneHead('upperarm01.L'), boneHead('lowerarm01.L'), 0.5, 'upperarm02.L', 7),
    upperArmR: section(boneHead('upperarm01.R'), boneHead('lowerarm01.R'), 0.5, 'upperarm02.R', 8),
    thighL: section(boneHead('upperleg01.L'), boneHead('lowerleg01.L'), 0.28, 'upperleg01.L', 11),
    thighR: section(boneHead('upperleg01.R'), boneHead('lowerleg01.R'), 0.28, 'upperleg01.R', 12),
    forearmL: section(boneHead('lowerarm01.L'), boneHead('wrist.L'), 0.55, 'lowerarm02.L', 7),
    forearmR: section(boneHead('lowerarm01.R'), boneHead('wrist.R'), 0.55, 'lowerarm02.R', 8),
  };

  // region points for wounds (front surface near the region centroid)
  const regionPoints: Record<string, SurfacePoint> = {};
  const regionNames = ['head', 'face', 'neck', 'chest', 'abdomen', 'pelvis', 'back', 'leftArm', 'rightArm', 'leftHand', 'rightHand', 'leftLeg', 'rightLeg', 'leftFoot', 'rightFoot'];
  regionNames.forEach((name, id) => {
    const cen = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < nBody; i++)
      if (asset.region[i] === id) {
        cen.add(tmp.fromArray(pos, i * 3));
        n++;
      }
    if (!n) return;
    cen.multiplyScalar(1 / n);
    if (name === 'leftLeg' || name === 'rightLeg') cen.y += 0.12; // thigh rather than knee
    const dir = name === 'back' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 0, -1);
    const o = cen.clone().addScaledVector(dir, -1);
    if (name === 'leftArm' || name === 'rightArm' || name === 'leftHand' || name === 'rightHand') {
      o.copy(cen).add(new THREE.Vector3(0, 0.5, 0));
      regionPoints[name] = ray(o, new THREE.Vector3(0, -1, 0), 0.015, (v) => asset.region[v] === id);
    } else regionPoints[name] = ray(o, dir, 0.015, (v) => asset.region[v] === id || (id === 1 && asset.region[v] === 15));
  });

  let minY = Infinity;
  let maxY = -Infinity;
  let backZ = Infinity;
  let headBackZ = Infinity;
  let heelZ = Infinity;
  for (let i = 0; i < nBody; i++) {
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    const r = asset.region[i];
    if (r === 6 || r === 5) backZ = Math.min(backZ, z);
    if (r === 0) headBackZ = Math.min(headBackZ, z);
    if (r === 13 || r === 14) heelZ = Math.min(heelZ, z);
  }

  const neighbourToward = (vertex: number, dir: THREE.Vector3, maxDist = 0.03) => {
    const p0 = V(vertex);
    const d = dir.clone().normalize();
    let best = vertex;
    let bestScore = -Infinity;
    for (let i = 0; i < nBody; i++) {
      if (i === vertex) continue;
      tmp.fromArray(pos, i * 3).sub(p0);
      const len = tmp.length();
      if (len < 0.004 || len > maxDist) continue;
      const score = tmp.dot(d) / len - len * 5;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  };
  return { points, sections, regionPoints, boneHead, boneTail, surfaceRay: ray, neighbourToward, eyeY, browY, minY, maxY, backZ, headBackZ, heelZ };
}
