import * as THREE from 'three';
import type { ExamZone } from '../types';
import type { HumanRig } from './buildHuman';
import type { LandmarkName } from './landmarks';

/** Examination zones anchored to anatomical landmarks (bone-attached markers). */
const ZONE_LANDMARK: [ExamZone, LandmarkName, number][] = [
  // auscultation first so they win ties with procedure sites
  ['trachea', 'trachea', 0.05],
  ['aorticArea', 'aortic', 0.035],
  ['pulmonicArea', 'pulmonic', 0.035],
  ['tricuspidArea', 'tricuspid', 0.035],
  ['mitralArea', 'mitral', 0.04],
  ['rightUpperChest', 'upperChestR', 0.07],
  ['leftUpperChest', 'upperChestL', 0.07],
  ['rightLowerChest', 'lowerChestR', 0.07],
  ['leftLowerChest', 'lowerChestL', 0.07],
  ['rightAxilla', 'axillaR', 0.07],
  ['leftAxilla', 'axillaL', 0.07],
  ['rightFifthICSAxillary', 'fifthAxR', 0.06],
  ['leftFifthICSAxillary', 'fifthAxL', 0.06],
  ['rightSecondICS', 'secondICSR', 0.03],
  ['leftSecondICS', 'secondICSL', 0.03],
  ['epigastrium', 'epigastrium', 0.07],
  ['rightUpperQuadrant', 'ruq', 0.08],
  ['leftUpperQuadrant', 'luq', 0.08],
  ['rightLowerQuadrant', 'rlq', 0.08],
  ['leftLowerQuadrant', 'llq', 0.08],
  ['rightRadial', 'radialR', 0.06],
  ['leftRadial', 'radialL', 0.06],
  ['rightCarotid', 'carotidR', 0.04],
  ['leftCarotid', 'carotidL', 0.04],
  ['rightFemoral', 'femoralR', 0.07],
  ['leftFemoral', 'femoralL', 0.07],
];

export class ZoneAnchors {
  private markers: { zone: ExamZone; obj: THREE.Object3D; radius: number }[] = [];
  private tmp = new THREE.Vector3();

  constructor(rig: HumanRig) {
    for (const [zone, lmName, radius] of ZONE_LANDMARK) {
      const pt = rig.landmarks.points[lmName];
      const bone = rig.bones[pt.bone];
      const o = new THREE.Object3D();
      o.name = `zone:${zone}`;
      o.position.copy(pt.p).sub(rig.landmarks.boneHead(pt.bone));
      bone.add(o);
      this.markers.push({ zone, obj: o, radius });
    }
  }

  /** World position of a zone anchor. */
  position(zone: ExamZone, out = new THREE.Vector3()) {
    const m = this.markers.find((x) => x.zone === zone);
    if (!m) return null;
    return m.obj.getWorldPosition(out);
  }

  all() {
    return this.markers.map((m) => ({ zone: m.zone, position: m.obj.getWorldPosition(new THREE.Vector3()) }));
  }

  /** Nearest zone to a world point (within the zone's capture radius, scaled by body size). */
  nearest(p: THREE.Vector3, scale = 1): ExamZone | null {
    let best: ExamZone | null = null;
    let bestScore = Infinity;
    for (const m of this.markers) {
      m.obj.getWorldPosition(this.tmp);
      const d = this.tmp.distanceTo(p);
      const r = m.radius * scale;
      if (d < r && d / r < bestScore) {
        bestScore = d / r;
        best = m.zone;
      }
    }
    return best;
  }

  dispose() {
    for (const m of this.markers) m.obj.removeFromParent();
  }
}
