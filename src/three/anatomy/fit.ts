import * as THREE from 'three';
import type { HumanRig } from '../human/buildHuman';
import type { AnatomyIndex } from './anatomyAsset';

/**
 * Maps BodyParts3D reference anatomy (one adult male, anatomical position)
 * into a specific patient's MakeHuman rest space.
 *
 *  - trunk: piecewise-linear in height between skeletal/skin landmarks
 *    (hip joints, navel/L3, xiphoid, sternal notch); antero-posterior position
 *    normalised to the trunk's front/back skin; lateral scale from joint
 *    spacing and chest width.
 *  - head: eyes / skull vertex / chin similarity-style fit.
 *  - neck: blend of head and trunk maps.
 *  - limbs: per-segment frame mapping (shoulder→elbow→wrist→knuckles,
 *    hip→knee→ankle→toes), which also converts the reference's anatomical
 *    arm position into the patient's rest (A-pose) arm orientation.
 *
 * This is an approximate, educational fit — organs are placed plausibly for
 * very different body shapes, not patient-accurately.
 */

type V3 = THREE.Vector3;
const v = (a: number[] | V3) => (a instanceof THREE.Vector3 ? a.clone() : new THREE.Vector3(a[0], a[1], a[2]));

interface Segment {
  bpA: V3;
  bpB: V3;
  mhA: V3;
  mhB: V3;
  rot: THREE.Quaternion;
  axialScale: number;
  radialScale: number;
  bone: string;
}

interface TrunkKnot {
  bpY: number;
  mhY: number;
  bpFront: number;
  bpBack: number;
  mhFront: number;
  mhBack: number;
  sx: number;
}

export class AnatomyFitter {
  private knots: TrunkKnot[];
  private head: { bpEye: V3; mhEye: V3; sx: number; syUp: number; syDown: number };
  private neckLo: number;
  private neckHi: number;
  readonly segments: Record<string, Segment> = {};
  private spineBones: { name: string; y: number }[];
  readonly bodyScale: number;

  constructor(rig: HumanRig, index: AnatomyIndex) {
    const lm = rig.landmarks;
    const L = index.landmarks;
    const bh = (n: string) => lm.boneHead(n);

    // ---- trunk measurements on the patient's rest mesh (trunk regions only)
    const pos = rig.body.geometry.getAttribute('position') as THREE.BufferAttribute;
    const reg = rig.region;
    const trunkAt = (y: number, band = 0.012) => {
      let front = -Infinity;
      let back = Infinity;
      let half = 0;
      for (let i = 0; i < pos.count; i++) {
        const r = reg[i];
        if (r < 3 || r > 6) continue;
        const py = pos.getY(i);
        if (Math.abs(py - y) > band) continue;
        const x = pos.getX(i);
        const z = pos.getZ(i);
        half = Math.max(half, Math.abs(x));
        if (Math.abs(x) < 0.06) {
          front = Math.max(front, z);
          back = Math.min(back, z);
        }
      }
      return { front, back, half };
    };
    const hipY = (bh('upperleg01.L').y + bh('upperleg01.R').y) / 2;
    const hipHalf = (bh('upperleg01.L').x - bh('upperleg01.R').x) / 2;
    const shoulderHalf = (bh('upperarm01.L').x - bh('upperarm01.R').x) / 2;
    const k = index.knots;
    const xiphY = lm.points.xiphoid.p.y;
    const notchY = lm.points.sternalNotch.p.y;
    const navelY = lm.points.navel.p.y;
    const mhHip = trunkAt(hipY + 0.03);
    const mhNavel = trunkAt(navelY);
    const mhXiph = trunkAt(xiphY);
    const mhNotch = trunkAt(notchY - 0.02);
    const sHip = hipHalf / k.hip.halfWidth;
    const sXiph = mhXiph.half / (k.xiphoid.halfWidth + 0.02);
    const sNotch = shoulderHalf / k.notch.halfWidth;
    this.knots = [
      { bpY: k.hip.y, mhY: hipY, bpFront: k.hip.front, bpBack: k.hip.back, mhFront: mhHip.front, mhBack: mhHip.back, sx: sHip },
      { bpY: k.navel.y, mhY: navelY, bpFront: k.navel.front, bpBack: k.navel.back, mhFront: mhNavel.front, mhBack: mhNavel.back, sx: (sHip + sXiph) / 2 },
      { bpY: k.xiphoid.y, mhY: xiphY, bpFront: k.xiphoid.front, bpBack: k.xiphoid.back, mhFront: mhXiph.front, mhBack: mhXiph.back, sx: sXiph },
      { bpY: k.notch.y, mhY: notchY, bpFront: k.notch.front, bpBack: k.notch.back, mhFront: mhNotch.front, mhBack: mhNotch.back, sx: sNotch },
    ];
    this.bodyScale = (notchY - hipY) / (k.notch.y - k.hip.y);

    // ---- head
    const bpEye = v(L.eyeL).add(v(L.eyeR)).multiplyScalar(0.5);
    const mhEyeL = bh('eye.L');
    const mhEyeR = bh('eye.R');
    const mhEye = mhEyeL.clone().add(mhEyeR).multiplyScalar(0.5);
    const sx = mhEyeL.distanceTo(mhEyeR) / v(L.eyeL).distanceTo(v(L.eyeR));
    const mhTop = lm.maxY - 0.006;
    const syUp = (mhTop - mhEye.y) / (L.skullTop[1] - bpEye.y);
    const syDown = (mhEye.y - (lm.points.chin.p.y + 0.004)) / (bpEye.y - L.chin[1]);
    this.head = { bpEye, mhEye, sx: (sx * 2 + syUp) / 3, syUp, syDown };
    this.neckLo = k.notch.y;
    this.neckHi = L.c1[1];

    // ---- limb segments
    for (const s of ['L', 'R'] as const) {
      this.addSeg(`upperArm${s}`, L[`shoulder${s}`], L[`elbow${s}`], bh(`upperarm01.${s}`), bh(`lowerarm01.${s}`), `upperarm01.${s}`);
      this.addSeg(`forearm${s}`, L[`elbow${s}`], L[`wrist${s}`], bh(`lowerarm01.${s}`), bh(`wrist.${s}`), `lowerarm01.${s}`);
      this.addSeg(`hand${s}`, L[`wrist${s}`], L[`knuckle${s}`], bh(`wrist.${s}`), bh(`finger3-1.${s}`), `wrist.${s}`);
      this.addSeg(`thigh${s}`, L[`hip${s}`], L[`knee${s}`], bh(`upperleg01.${s}`), bh(`lowerleg01.${s}`), `upperleg01.${s}`);
      this.addSeg(`leg${s}`, L[`knee${s}`], L[`ankle${s}`], bh(`lowerleg01.${s}`), bh(`foot.${s}`), `lowerleg01.${s}`);
      this.addSeg(`foot${s}`, L[`ankle${s}`], L[`toe${s}`], bh(`foot.${s}`), bh(`toe2-1.${s}`), `foot.${s}`);
    }

    const spine = ['root', 'spine05', 'spine04', 'spine03', 'spine02', 'spine01', 'neck01', 'neck02', 'neck03', 'head'];
    this.spineBones = spine.map((n) => ({ name: n, y: bh(n).y }));
  }

  private addSeg(key: string, bpA: number[], bpB: number[], mhA: V3, mhB: V3, bone: string) {
    const a = v(bpA);
    const b = v(bpB);
    const da = b.clone().sub(a);
    const dm = mhB.clone().sub(mhA);
    const rot = new THREE.Quaternion().setFromUnitVectors(da.clone().normalize(), dm.clone().normalize());
    const axialScale = dm.length() / da.length();
    this.segments[key] = { bpA: a, bpB: b, mhA: mhA.clone(), mhB: mhB.clone(), rot, axialScale, radialScale: (axialScale + (this.bodyScale || 1)) / 2, bone };
  }

  /** Adds a custom segment (e.g. for an individual phalanx) and returns its key. */
  addCustomSegment(key: string, bpA: V3, bpB: V3, mhA: V3, mhB: V3, bone: string) {
    this.addSeg(key, [bpA.x, bpA.y, bpA.z], [bpB.x, bpB.y, bpB.z], mhA, mhB, bone);
    return key;
  }

  mapSegment(key: string, p: V3, out = new THREE.Vector3()) {
    const s = this.segments[key];
    const axis = s.bpB.clone().sub(s.bpA).normalize();
    const d = p.clone().sub(s.bpA);
    const along = d.dot(axis);
    const radial = d.sub(axis.clone().multiplyScalar(along));
    const local = axis.multiplyScalar(along * s.axialScale).add(radial.multiplyScalar(s.radialScale));
    return out.copy(local.applyQuaternion(s.rot)).add(s.mhA);
  }

  mapTrunk(p: V3, out = new THREE.Vector3()) {
    const K = this.knots;
    let i = 0;
    while (i < K.length - 2 && p.y > K[i + 1].bpY) i++;
    const a = K[i];
    const b = K[i + 1];
    const t = (p.y - a.bpY) / (b.bpY - a.bpY);
    const tc = THREE.MathUtils.clamp(t, 0, 1);
    const lerp = (x: number, y: number) => x + (y - x) * tc;
    const mhY = a.mhY + (b.mhY - a.mhY) * t; // extrapolates beyond the end knots
    const bpF = lerp(a.bpFront, b.bpFront);
    const bpB = lerp(a.bpBack, b.bpBack);
    const mhF = lerp(a.mhFront, b.mhFront);
    const mhB = lerp(a.mhBack, b.mhBack);
    const u = (p.z - bpB) / (bpF - bpB);
    const sx = lerp(a.sx, b.sx);
    return out.set(p.x * sx, mhY, mhB + u * (mhF - mhB));
  }

  mapHead(p: V3, out = new THREE.Vector3()) {
    const h = this.head;
    const dy = p.y - h.bpEye.y;
    return out.set(p.x * h.sx, h.mhEye.y + dy * (dy > 0 ? h.syUp : h.syDown), h.mhEye.z + (p.z - h.bpEye.z) * h.sx);
  }

  mapNeck(p: V3, out = new THREE.Vector3()) {
    const w = THREE.MathUtils.smoothstep(p.y, this.neckLo, this.neckHi);
    const a = this.mapTrunk(p, new THREE.Vector3());
    const b = this.mapHead(p, new THREE.Vector3());
    return out.copy(a.lerp(b, w));
  }

  /** Limb chains: choose the nearest segment along the chain (above the root → trunk). */
  mapLimb(p: V3, chain: string[], rootSeg: string, out = new THREE.Vector3()) {
    const first = this.segments[chain[0]];
    const axis0 = first.bpB.clone().sub(first.bpA).normalize();
    const proj = p.clone().sub(first.bpA).dot(axis0);
    // blend trunk and limb maps across the limb root so vessels stay continuous
    const w = THREE.MathUtils.smoothstep(proj, -0.05, 0.03);
    if (w <= 0) return this.mapTrunk(p, out);
    let best = chain[0];
    let bestD = Infinity;
    for (const key of chain) {
      const s = this.segments[key];
      const ab = s.bpB.clone().sub(s.bpA);
      const t = THREE.MathUtils.clamp(p.clone().sub(s.bpA).dot(ab) / ab.lengthSq(), 0, 1);
      const d = s.bpA.clone().addScaledVector(ab, t).distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    this.mapSegment(best, p, out);
    if (w < 1) out.lerp(this.mapTrunk(p, new THREE.Vector3()), 1 - w);
    void rootSeg;
    return out;
  }

  /** Spine bone whose segment contains the given rest-space height. */
  spineBoneAt(y: number) {
    let best = this.spineBones[0].name;
    for (const b of this.spineBones) if (b.y <= y) best = b.name;
    return best;
  }
}
