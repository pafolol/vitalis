import * as THREE from 'three';
import type { HumanAssetMeta } from './humanAsset';
import type { HumanLandmarks } from './landmarks';

/**
 * Static poses computed once per patient body:
 *  - `base`: supine anatomical position (arms at the sides, legs straight,
 *    relaxed fingers and feet, slight neck flexion on the pillow)
 *  - `handToChestR`: right hand resting over the sternum (two-bone IK),
 *    blended in when the patient clutches the chest (ischaemic pain).
 *
 * All quaternions are bone-local. Bones start with identity rest rotations
 * (MakeHuman axes), so world-space deltas are converted to local ones.
 */

export interface PoseLibrary {
  base: Map<string, THREE.Quaternion>;
  handToChestR: Map<string, THREE.Quaternion>;
  /** Tuned twist of the forearms so that palms rest on the mattress/thighs */
  animatedBones: string[];
}

const _q = new THREE.Quaternion();
const _p = new THREE.Quaternion();

function frameQuat(bone: THREE.Object3D | null, out = new THREE.Quaternion()) {
  out.identity();
  let b: THREE.Object3D | null = bone;
  while (b && (b as THREE.Bone).isBone) {
    out.premultiply(b.quaternion);
    b = b.parent;
  }
  return out;
}

/** Apply a rotation expressed in frame (MakeHuman) space to a bone. */
export function applyFrameDelta(bone: THREE.Bone, delta: THREE.Quaternion) {
  frameQuat(bone.parent, _p);
  _q.copy(_p).invert().multiply(delta).multiply(_p);
  bone.quaternion.premultiply(_q);
}

export function posInFrame(bone: THREE.Bone, frame: THREE.Object3D, out = new THREE.Vector3()) {
  bone.updateWorldMatrix(true, false);
  out.setFromMatrixPosition(bone.matrixWorld);
  return frame.worldToLocal(out);
}

export function computeBasePose(
  _meta: HumanAssetMeta,
  _joints: THREE.Vector3[],
  bones: Record<string, THREE.Bone>,
  lm: HumanLandmarks,
): PoseLibrary {
  const rootBone = bones['root'];
  const frame = rootBone.parent!;
  const pos = (n: string) => posInFrame(bones[n], frame);
  const aim = (n: string, end: string, target: THREE.Vector3) => {
    const cur = pos(end).sub(pos(n)).normalize();
    const d = new THREE.Quaternion().setFromUnitVectors(cur, target.clone().normalize());
    applyFrameDelta(bones[n], d);
  };
  const twist = (n: string, end: string, angle: number) => {
    const axis = pos(end).sub(pos(n)).normalize();
    applyFrameDelta(bones[n], new THREE.Quaternion().setFromAxisAngle(axis, angle));
  };
  const rotFrame = (n: string, axis: THREE.Vector3, angle: number) =>
    applyFrameDelta(bones[n], new THREE.Quaternion().setFromAxisAngle(axis, angle));

  // ---- arms at the sides (anatomical-ish position, slight abduction)
  for (const [s, sign] of [
    ['L', 1],
    ['R', -1],
  ] as const) {
    aim(`upperarm01.${s}`, `lowerarm01.${s}`, new THREE.Vector3(sign * 0.1, -1, -0.12));
    aim(`lowerarm01.${s}`, `wrist.${s}`, new THREE.Vector3(sign * 0.02, -1, 0.1));
    // forearm supination/pronation so the palm faces the thigh
    twist(`lowerarm02.${s}`, `wrist.${s}`, sign * THREE.MathUtils.degToRad(-55));
    // wrist slightly extended and relaxed
    aim(`wrist.${s}`, `finger3-1.${s}`, new THREE.Vector3(sign * 0.12, -1, 0.02));
  }

  // ---- relaxed finger curl
  for (const s of ['L', 'R'] as const) {
    const across = pos(`finger5-1.${s}`).sub(pos(`finger2-1.${s}`)).normalize();
    for (let f = 2; f <= 5; f++) {
      const angles = [0.18, 0.32, 0.22];
      for (let k = 1; k <= 3; k++) {
        const n = `finger${f}-${k}.${s}`;
        const end = k < 3 ? `finger${f}-${k + 1}.${s}` : null;
        const dir = end ? pos(end).sub(pos(n)).normalize() : pos(n).sub(pos(`finger${f}-${k - 1}.${s}`)).normalize();
        // palm normal ~ dir × across; pick the curl axis so tips move towards the palm
        const axis = new THREE.Vector3().crossVectors(across, dir).normalize();
        rotFrame(n, axis, (s === 'L' ? -1 : 1) * angles[k - 1] * -1);
      }
    }
    // thumb gently flexed
    for (let k = 1; k <= 3; k++) {
      const n = `finger1-${k}.${s}`;
      if (bones[n]) rotFrame(n, across, (s === 'L' ? 1 : -1) * 0.12);
    }
  }

  // ---- legs straight, slightly apart, feet externally rotated & plantar-flexed
  for (const [s, sign] of [
    ['L', 1],
    ['R', -1],
  ] as const) {
    aim(`upperleg01.${s}`, `lowerleg01.${s}`, new THREE.Vector3(sign * 0.055, -1, 0));
    aim(`lowerleg01.${s}`, `foot.${s}`, new THREE.Vector3(sign * 0.03, -1, -0.01));
    twist(`upperleg01.${s}`, `lowerleg01.${s}`, sign * THREE.MathUtils.degToRad(-10));
    rotFrame(`foot.${s}`, new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(28));
  }

  // ---- head on pillow
  rotFrame('neck01', new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(6));
  rotFrame('head', new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(4));

  const snapshot = () => {
    const m = new Map<string, THREE.Quaternion>();
    for (const [n, b] of Object.entries(bones)) m.set(n, b.quaternion.clone());
    return m;
  };
  const base = snapshot();

  // ---- right hand over the sternum (two-bone IK)
  {
    const S = pos('upperarm01.R');
    const E = pos('lowerarm01.R');
    const W = pos('wrist.R');
    const a = S.distanceTo(E);
    const b = E.distanceTo(W);
    const chest = lm.points.xiphoid.p.clone().lerp(lm.points.sternalNotch.p, 0.35);
    const T = chest.add(new THREE.Vector3(-0.085, -0.03, 0.03));
    const toT = T.clone().sub(S);
    const d = Math.min(toT.length(), a + b - 0.005);
    const u = toT.normalize();
    const pole = new THREE.Vector3(-1, -0.4, -0.35).normalize();
    const v = pole.sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const elbow = S.clone().add(u.clone().multiplyScalar(a * cosA)).add(v.multiplyScalar(a * sinA));
    aim('upperarm01.R', 'lowerarm01.R', elbow.clone().sub(S));
    aim('lowerarm01.R', 'wrist.R', S.clone().add(u.clone().multiplyScalar(d)).sub(elbow));
    twist('lowerarm02.R', 'wrist.R', THREE.MathUtils.degToRad(-35));
    // hand laid across the sternum, fingers pointing to the patient's left
    aim('wrist.R', 'finger3-1.R', new THREE.Vector3(1, 0.25, -0.35));
  }
  const handToChestR = new Map<string, THREE.Quaternion>();
  for (const n of ['upperarm01.R', 'upperarm02.R', 'lowerarm01.R', 'lowerarm02.R', 'wrist.R']) handToChestR.set(n, bones[n].quaternion.clone());

  // restore base pose
  for (const [n, q] of base) bones[n].quaternion.copy(q);

  return {
    base,
    handToChestR,
    animatedBones: Object.keys(bones),
  };
}
