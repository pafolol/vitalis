import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { AvatarVisualState } from '../types';
import type { HumanRig } from './buildHuman';
import type { SurfacePoint, LimbSection } from './landmarks';

/**
 * Clinical equipment on the patient.
 *
 *  - Skin-mounted items (ECG electrodes, defibrillator pads, cannulae, drains,
 *    IO needle) follow a *surface anchor*: the skinned position and tangent
 *    frame of a body vertex, evaluated each frame, so they stay glued to the
 *    deforming skin (breathing, CPR, posture).
 *  - Rigid items (face equipment, BP cuff, tourniquets, finger probe) are
 *    parented to bones.
 *  - Cables and lines are rebuilt in world space when their end points move.
 *
 * Visibility and simple animation are driven by `AvatarVisualState.attachments`.
 */

type PropKey =
  | 'ecgLeads'
  | 'spo2Probe'
  | 'bpCuff'
  | 'ivLeftArm'
  | 'ivRightArm'
  | 'ioAccess'
  | 'nasalCannula'
  | 'faceMask'
  | 'nonRebreather'
  | 'bvm'
  | 'ett'
  | 'opa'
  | 'defibPads'
  | 'needleL'
  | 'needleR'
  | 'chestTubeL'
  | 'chestTubeR'
  | 'tqleftArm'
  | 'tqrightArm'
  | 'tqleftLeg'
  | 'tqrightLeg';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m = new THREE.Matrix4();

function tube(points: THREE.Vector3[], radius: number, mat: THREE.Material, segs = 48) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, radius, 8, false), mat);
  m.castShadow = true;
  return m;
}

/** A tube whose geometry is rebuilt only when its control points move noticeably. */
class DynTube {
  readonly mesh: THREE.Mesh;
  private last: THREE.Vector3[] = [];
  private radius: number;
  private segs: number;
  constructor(radius: number, mat: THREE.Material, segs = 40) {
    this.radius = radius;
    this.segs = segs;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }
  update(pts: THREE.Vector3[], tol = 0.0015) {
    const moved = pts.length !== this.last.length || pts.some((p, i) => p.distanceTo(this.last[i]) > tol);
    if (!moved) return;
    this.last = pts.map((p) => p.clone());
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), this.segs, this.radius, 7, false);
  }
  dispose() {
    this.mesh.geometry.dispose();
  }
}

/** Skinned surface frame of a body vertex: origin on the skin, +Y along the normal. */
class SurfaceAnchor {
  readonly v: number;
  private a: number;
  private b: number;
  private restNormal: THREE.Vector3;
  constructor(v: number, a: number, b: number, restNormalFrame: THREE.Vector3) {
    this.v = v;
    this.a = a;
    this.b = b;
    this.restNormal = restNormalFrame;
  }
  compute(body: THREE.SkinnedMesh, out: THREE.Matrix4, origin = new THREE.Vector3()) {
    body.getVertexPosition(this.v, origin);
    body.getVertexPosition(this.a, _a);
    body.getVertexPosition(this.b, _b);
    body.localToWorld(origin);
    body.localToWorld(_a);
    body.localToWorld(_b);
    const x = _a.sub(origin).normalize();
    const t2 = _b.sub(origin).normalize();
    const y = new THREE.Vector3().crossVectors(t2, x);
    // orient the normal outwards using the rest normal carried through the body's world rotation
    _v.copy(this.restNormal).transformDirection(body.matrixWorld);
    if (y.lengthSq() < 1e-10 || !Number.isFinite(y.x)) y.copy(_v);
    y.normalize();
    if (y.dot(_v) < 0) y.negate();
    if (Math.abs(x.dot(y)) > 0.95 || !Number.isFinite(x.x)) x.set(1, 0, 0).cross(y).normalize();
    const z = new THREE.Vector3().crossVectors(x, y).normalize();
    x.crossVectors(y, z).normalize();
    out.makeBasis(x, y, z).setPosition(origin);
    return origin;
  }
}

function padTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 176;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f2ee';
  g.fillRect(0, 0, 256, 176);
  g.strokeStyle = '#c62828';
  g.lineWidth = 10;
  g.strokeRect(8, 8, 240, 160);
  g.fillStyle = '#c62828';
  g.beginPath();
  g.moveTo(128, 120);
  g.bezierCurveTo(60, 80, 90, 30, 128, 60);
  g.bezierCurveTo(166, 30, 196, 80, 128, 120);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(90, 78);
  g.lineTo(115, 78);
  g.lineTo(124, 60);
  g.lineTo(134, 96);
  g.lineTo(142, 78);
  g.lineTo(166, 78);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface SurfaceProp {
  key: PropKey;
  id: string;
  anchor: SurfaceAnchor;
  obj: THREE.Object3D;
}

export class AttachmentProps {
  readonly group = new THREE.Group();
  private rig: HumanRig;
  private boneProps = new Map<PropKey, THREE.Object3D>();
  private surface: SurfaceProp[] = [];
  private tubes = new Map<string, DynTube>();
  private disposables: { dispose(): void }[] = [];
  private mats: Record<string, THREE.Material>;
  private nrbBag: THREE.Object3D | null = null;
  private nrbBase = new THREE.Vector3(1, 1, 1);
  private bvmBag: THREE.Object3D | null = null;
  private ivPoleAnchor: THREE.Vector3 | null = null;
  private bloodPool: THREE.Mesh;
  private drain: THREE.Mesh;
  private mattressTop: number;

  constructor(rig: HumanRig, mattressTop: number) {
    this.rig = rig;
    this.mattressTop = mattressTop;
    const std = (color: number | string, rough = 0.6, extra: THREE.MeshPhysicalMaterialParameters = {}) =>
      new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), roughness: rough, ...extra });
    this.mats = {
      foam: std(0xf2f0ea, 0.85),
      gel: std(0xd9d4c4, 0.4),
      snap: std(0xb9bec4, 0.3, { metalness: 0.9 }),
      wireWhite: std(0xeeeeee, 0.45),
      wireBlack: std(0x1d1d1f, 0.45),
      wireGreen: std(0x2e8b3d, 0.45),
      wireRed: std(0xc8302c, 0.45),
      wireBrown: std(0x7a4a2a, 0.45),
      greyCable: std(0x9aa3ab, 0.5),
      probe: std(0x2c3440, 0.5),
      led: new THREE.MeshBasicMaterial({ color: 0xff2a2a }),
      cuff: std(0x1f3d6b, 0.9, { sheen: 0.5, sheenColor: new THREE.Color(0x4466aa), side: THREE.DoubleSide }),
      cuffTube: std(0x2b2f36, 0.5),
      hubPink: std(0xf08aa8, 0.35),
      hubOrange: std(0xff8a1f, 0.35),
      hubBlue: std(0x2a6fdb, 0.35),
      hubYellow: std(0xf2c230, 0.4),
      dressing: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.25, transparent: true, opacity: 0.4, depthWrite: false }),
      clearTube: new THREE.MeshPhysicalMaterial({ color: 0xdff3ee, roughness: 0.15, transparent: true, opacity: 0.65, clearcoat: 1 }),
      greenTube: new THREE.MeshPhysicalMaterial({ color: 0xbfe8d0, roughness: 0.15, transparent: true, opacity: 0.75, clearcoat: 1 }),
      maskClear: new THREE.MeshPhysicalMaterial({ color: 0xe9f7f1, roughness: 0.08, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide, clearcoat: 1 }),
      maskGreen: new THREE.MeshPhysicalMaterial({ color: 0xbfe8cf, roughness: 0.1, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, clearcoat: 1 }),
      cushion: std(0x2a2f36, 0.35),
      bag: std(0x3a6ea5, 0.55, { sheen: 0.3 }),
      reservoir: new THREE.MeshPhysicalMaterial({ color: 0xa8d8c0, roughness: 0.2, transparent: true, opacity: 0.55, depthWrite: false }),
      ett: new THREE.MeshPhysicalMaterial({ color: 0xe8f4fb, roughness: 0.1, transparent: true, opacity: 0.85, clearcoat: 1 }),
      ettLine: std(0x1f5fbf, 0.4),
      tape: std(0xf3efe6, 0.9),
      opa: std(0x3cb371, 0.4),
      tq: std(0x1a1a1a, 0.85, { side: THREE.DoubleSide }),
      tqRod: std(0x333333, 0.6),
      chestDrain: new THREE.MeshPhysicalMaterial({ color: 0xf2e9e9, roughness: 0.15, transparent: true, opacity: 0.8 }),
      drainBox: std(0xe8ecef, 0.4, { clearcoat: 0.3 }),
    };
    this.mats.pad = new THREE.MeshPhysicalMaterial({ map: padTexture(), roughness: 0.75 });
    this.disposables.push(...Object.values(this.mats));

    this.buildBoneProps();
    this.buildSurfaceProps();

    // blood pool on the sheet under a bleeding wound
    const poolGeo = new THREE.CircleGeometry(1, 40);
    const pp = poolGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 1; i < pp.count; i++) {
      const ang = Math.atan2(pp.getY(i), pp.getX(i));
      const r = 1 + 0.18 * Math.sin(ang * 3 + 1) + 0.12 * Math.sin(ang * 7 + 2) + 0.06 * Math.sin(ang * 13);
      pp.setXY(i, pp.getX(i) * r, pp.getY(i) * r);
    }
    poolGeo.rotateX(-Math.PI / 2);
    this.bloodPool = new THREE.Mesh(
      poolGeo,
      new THREE.MeshPhysicalMaterial({ color: 0x5a0a0a, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    this.bloodPool.visible = false;
    this.bloodPool.renderOrder = 1;
    this.group.add(this.bloodPool);
    this.disposables.push(poolGeo, this.bloodPool.material as THREE.Material);

    // chest drainage unit on the floor
    this.drain = new THREE.Mesh(new RoundedBoxGeometry(0.28, 0.3, 0.12, 3, 0.02), this.mats.drainBox);
    this.drain.visible = false;
    this.drain.castShadow = true;
    this.group.add(this.drain);
    this.disposables.push(this.drain.geometry);
  }

  setIvPoleAnchor(p: THREE.Vector3 | null) {
    this.ivPoleAnchor = p ? p.clone() : null;
  }

  // ------------------------------------------------------------------ helpers
  /** Parent `obj` to `bone`, given a rest-space (MakeHuman frame) position/orientation. */
  private attach(obj: THREE.Object3D, bone: string, restPos: THREE.Vector3, restQuat?: THREE.Quaternion) {
    const b = this.rig.bones[bone] ?? this.rig.bones['spine02'];
    const head = this.rig.landmarks.boneHead(b.name);
    obj.position.copy(restPos).sub(head);
    if (restQuat) obj.quaternion.copy(restQuat);
    b.add(obj);
    return obj;
  }

  private collect(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        this.disposables.push(m.geometry);
      }
    });
  }

  private regBone(key: PropKey, obj: THREE.Object3D) {
    obj.visible = false;
    this.collect(obj);
    this.boneProps.set(key, obj);
  }

  private regParts(key: PropKey, parts: THREE.Object3D[]) {
    const holder = new THREE.Object3D();
    holder.userData.parts = parts;
    for (const p of parts) {
      p.visible = false;
      this.collect(p);
    }
    this.boneProps.set(key, holder);
  }

  private anchorFor(pt: SurfacePoint) {
    const lm = this.rig.landmarks;
    const n = pt.n.clone().normalize();
    // tangent directions in rest space: cranial (+Y) and a perpendicular direction
    const t1 = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y);
    const t2 = new THREE.Vector3().crossVectors(n, t1.lengthSq() > 1e-4 ? t1.normalize() : new THREE.Vector3(1, 0, 0));
    let a = lm.neighbourToward(pt.vertex, t1.lengthSq() > 1e-4 ? t1 : new THREE.Vector3(1, 0, 0));
    let b = lm.neighbourToward(pt.vertex, t2);
    if (a === pt.vertex) a = b;
    if (b === pt.vertex) b = a;
    return new SurfaceAnchor(pt.vertex, a, b, n);
  }

  private regSurface(key: PropKey, pt: SurfacePoint, obj: THREE.Object3D, id: string = key) {
    obj.visible = false;
    obj.matrixAutoUpdate = false;
    this.collect(obj);
    this.group.add(obj);
    this.surface.push({ key, id, anchor: this.anchorFor(pt), obj });
  }

  private tube(key: string, radius: number, mat: THREE.Material, segs = 40) {
    let t = this.tubes.get(key);
    if (!t) {
      t = new DynTube(radius, mat, segs);
      t.mesh.visible = false;
      this.group.add(t.mesh);
      this.tubes.set(key, t);
    }
    return t;
  }

  /**
   * Pad geometry conformed to the rest-pose chest surface around `pt`, expressed
   * in the same tangent frame the surface anchor produces (+X cranial, +Y normal).
   */
  private conformedPad(pt: SurfacePoint, w: number, h: number) {
    const lm = this.rig.landmarks;
    const n = pt.n.clone().normalize();
    const tx = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const tz = new THREE.Vector3().crossVectors(tx, n).normalize();
    const g = new THREE.PlaneGeometry(w, h, 10, 8);
    g.rotateX(-Math.PI / 2); // XZ plane, +Y normal
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const trunk = (v: number) => this.rig.landmarks.points && v >= 0;
    const hs: (number | null)[] = [];
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i);
      const v = p.getZ(i);
      const o = pt.p.clone().addScaledVector(tx, u).addScaledVector(tz, v).addScaledVector(n, 0.05);
      const hit = lm.surfaceRay(o, n.clone().negate(), 0.007, trunk);
      const d = hit.p.distanceTo(o);
      const hgt = hit.p.clone().sub(pt.p).dot(n);
      hs.push(d < 0.12 && Math.abs(hgt) < 0.035 ? hgt : null);
    }
    // fill misses from valid neighbours, then smooth
    const cols = 11;
    const get = (i: number) => hs[i];
    for (let pass = 0; pass < 4; pass++)
      for (let i = 0; i < hs.length; i++) {
        if (hs[i] !== null) continue;
        const nb = [i - 1, i + 1, i - cols, i + cols].filter((j) => j >= 0 && j < hs.length).map(get).filter((x): x is number => x !== null);
        if (nb.length) hs[i] = nb.reduce((a, b) => a + b, 0) / nb.length;
      }
    const hv = hs.map((x) => x ?? 0);
    for (let pass = 0; pass < 2; pass++) {
      const cp = hv.slice();
      for (let i = 0; i < hv.length; i++) {
        const nb = [i - 1, i + 1, i - cols, i + cols].filter((j) => j >= 0 && j < hv.length);
        hv[i] = Math.max(cp[i], nb.reduce((a, j) => a + cp[j], cp[i] * 2) / (nb.length + 2));
      }
    }
    for (let i = 0; i < p.count; i++) p.setY(i, hv[i] + 0.003);
    g.computeVertexNormals();
    return g;
  }

  // ------------------------------------------------------------------ bone-attached props
  private buildBoneProps() {
    const lm = this.rig.landmarks;
    const P = lm.points;
    const M = this.mats;

    // SpO2 finger probe (right index finger)
    {
      const g = new THREE.Group();
      const tipB = 'finger2-3.R';
      const tip = lm.boneTail(tipB);
      const base = lm.boneHead(tipB);
      const along = tip.clone().sub(base).normalize();
      const clip = new THREE.Mesh(new RoundedBoxGeometry(0.02, 0.034, 0.024, 3, 0.006), M.probe);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.0025, 8, 6), M.led);
      led.position.set(0, 0, 0.013);
      clip.add(led);
      g.add(clip);
      this.attach(g, tipB, base.clone().lerp(tip, 0.55), new THREE.Quaternion().setFromUnitVectors(UP, along));
      const wrist = lm.boneHead('wrist.R');
      const cable = tube(
        [base.clone().lerp(tip, 0.1), lm.boneHead('finger2-1.R').add(new THREE.Vector3(0, 0.012, 0)), wrist.clone().add(new THREE.Vector3(0, 0.02, 0)), wrist.clone().add(new THREE.Vector3(0.02, 0.1, 0.01))].map((p) =>
          p.sub(wrist),
        ),
        0.0022,
        M.greyCable,
      );
      this.attach(cable, 'wrist.R', wrist);
      this.regParts('spo2Probe', [g, cable]);
    }

    // BP cuff (left upper arm)
    {
      const s = lm.sections.upperArmL;
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(s.radius + 0.01, s.radius + 0.01, 0.13, 40, 1, true), M.cuff));
      g.add(tube([new THREE.Vector3(0, 0.05, s.radius + 0.01), new THREE.Vector3(0, 0.12, s.radius + 0.04), new THREE.Vector3(0.05, 0.25, s.radius + 0.06)], 0.003, M.cuffTube, 24));
      this.attach(g, 'upperarm01.L', s.center, new THREE.Quaternion().setFromUnitVectors(UP, s.axis.clone().negate()));
      this.regBone('bpCuff', g);
    }

    // ---- face equipment (rigid on the head bone; authored in rest-space coordinates)
    const nose = P.noseTip.p;
    const mouth = P.mouth.p.clone();
    const chin = P.chin.p;
    const faceW = Math.min(0.15, Math.abs(P.earL.p.x - P.earR.p.x));
    const bridgeY = nose.y + 0.028;
    const chinY = Math.min(chin.y, mouth.y - 0.03);
    const maskH = (bridgeY - chinY) / 2 + 0.006;
    const maskW = Math.min(0.048, faceW * 0.3);
    const faceC = new THREE.Vector3(0, (bridgeY + chinY) / 2, (nose.z + chin.z) / 2 - 0.012);
    const atHead = (g: THREE.Object3D) => this.attach(g, 'head', new THREE.Vector3());

    // nasal cannula
    {
      const pts = (s: 1 | -1) => {
        const ear = s > 0 ? P.earL.p : P.earR.p;
        return [
          nose.clone().add(new THREE.Vector3(s * 0.007, -0.011, -0.012)),
          nose.clone().add(new THREE.Vector3(s * 0.011, -0.017, -0.004)),
          nose.clone().add(new THREE.Vector3(s * 0.03, -0.02, -0.012)),
          new THREE.Vector3(s * Math.abs(ear.x) * 0.8, nose.y - 0.012, nose.z - 0.045),
          ear.clone().add(new THREE.Vector3(s * 0.008, 0.028, 0.012)),
          ear.clone().add(new THREE.Vector3(s * 0.014, 0.02, -0.022)),
          ear.clone().add(new THREE.Vector3(s * 0.006, -0.035, -0.012)),
          new THREE.Vector3(s * 0.04, chinY - 0.035, chin.z - 0.06),
          new THREE.Vector3(0, chinY - 0.06, chin.z - 0.055),
        ];
      };
      const g = new THREE.Group();
      g.add(tube(pts(1), 0.0022, M.greenTube, 64));
      g.add(tube(pts(-1), 0.0022, M.greenTube, 64));
      g.add(tube([pts(1)[1], nose.clone().add(new THREE.Vector3(0, -0.02, -0.002)), pts(-1)[1]], 0.0026, M.greenTube, 12));
      g.add(tube([new THREE.Vector3(0, chinY - 0.06, chin.z - 0.055), new THREE.Vector3(0.03, chinY - 0.16, chin.z - 0.05), new THREE.Vector3(0.18, chinY - 0.25, chin.z - 0.12)], 0.0026, M.greenTube, 24));
      atHead(g);
      this.regBone('nasalCannula', g);
    }

    // mask shell (dome), rim on the face, apex anterior (+Z)
    const maskGeo = (depth: number) => {
      const prof: THREE.Vector2[] = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 0.5;
        prof.push(new THREE.Vector2(Math.sin(a), 1 - Math.cos(a)));
      }
      const g = new THREE.LatheGeometry(prof.reverse(), 40);
      g.rotateX(Math.PI / 2);
      g.scale(maskW, maskH, -depth);
      g.translate(0, 0, depth);
      return g;
    };
    const buildMask = (mat: THREE.Material, withCushion: boolean) => {
      const inner = new THREE.Group();
      inner.position.copy(faceC);
      const shell = new THREE.Mesh(maskGeo(0.05), mat);
      shell.renderOrder = 3;
      inner.add(shell);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, withCushion ? 0.1 : 0.05, 10, 48), withCushion ? M.cushion : mat);
      ring.scale.set(maskW, maskH, maskW * 0.8);
      inner.add(ring);
      const port = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.022, 20), withCushion ? M.cushion : mat);
      port.rotation.x = Math.PI / 2;
      port.position.set(0, -maskH * 0.2, 0.058);
      inner.add(port);
      const outer = new THREE.Group();
      outer.add(inner);
      return { outer, inner };
    };
    // simple face mask + strap + tubing
    {
      const { outer, inner } = buildMask(M.maskClear, false);
      const strap = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 6, 64), M.greenTube);
      strap.scale.set(faceW * 0.62, faceW * 0.55, faceW * 0.62);
      strap.rotation.y = Math.PI / 2;
      strap.position.set(0, 0, -faceW * 0.5);
      inner.add(strap);
      inner.add(tube([new THREE.Vector3(0, -maskH * 0.2, 0.07), new THREE.Vector3(0, -maskH - 0.03, 0.08), new THREE.Vector3(0.14, -0.25, 0.02)], 0.004, M.greenTube, 24));
      atHead(outer);
      this.regBone('faceMask', outer);
    }
    // non-rebreather: mask + reservoir bag resting on the upper chest
    {
      const { outer, inner } = buildMask(M.maskGreen, false);
      const bag = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), M.reservoir);
      bag.scale.set(0.055, 0.085, 0.026);
      bag.position.set(0, -maskH - 0.1, -0.03);
      inner.add(bag);
      inner.add(tube([new THREE.Vector3(0, -maskH * 0.2, 0.06), new THREE.Vector3(0, -maskH - 0.02, 0.03), new THREE.Vector3(0, -maskH - 0.03, -0.01)], 0.009, M.maskGreen, 12));
      this.nrbBag = bag;
      this.nrbBase = bag.scale.clone();
      atHead(outer);
      this.regBone('nonRebreather', outer);
    }
    // bag-valve-mask: the bag extends towards the head of the bed (operator position)
    {
      const { outer, inner } = buildMask(M.maskClear, true);
      const dir = new THREE.Vector3(0, 0.93, 0.36).normalize();
      const valvePos = new THREE.Vector3(0, 0.0, 0.07);
      const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.05, 20), M.cushion);
      valve.position.copy(valvePos);
      valve.quaternion.setFromUnitVectors(UP, new THREE.Vector3(0, 0.6, 1).normalize());
      const bag = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.13, 8, 24), M.bag);
      bag.position.copy(valvePos).addScaledVector(dir, 0.16);
      bag.quaternion.setFromUnitVectors(UP, dir);
      const res = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), M.reservoir);
      res.scale.set(0.045, 0.085, 0.035);
      res.position.copy(valvePos).addScaledVector(dir, 0.36);
      res.quaternion.copy(bag.quaternion);
      inner.add(valve, bag, res);
      this.bvmBag = bag;
      atHead(outer);
      this.regBone('bvm', outer);
    }
    // endotracheal tube (oral, secured at the right corner of the mouth)
    {
      const g = new THREE.Group();
      const stomion = mouth.clone().add(new THREE.Vector3(0, -0.005, -0.004));
      const corner = stomion.clone().add(new THREE.Vector3(-0.013, 0, -0.002));
      const pts = [
        stomion.clone().add(new THREE.Vector3(-0.004, -0.01, -0.07)),
        stomion.clone().add(new THREE.Vector3(-0.008, -0.004, -0.03)),
        corner,
        corner.clone().add(new THREE.Vector3(-0.002, 0.004, 0.03)),
        corner.clone().add(new THREE.Vector3(0.0, 0.03, 0.065)),
        corner.clone().add(new THREE.Vector3(0.004, 0.07, 0.075)),
      ];
      g.add(tube(pts, 0.0048, M.ett, 48));
      g.add(tube(pts.slice(2).map((p) => p.clone().add(new THREE.Vector3(0.0045, 0, 0))), 0.0008, M.ettLine, 24));
      const conn = new THREE.Mesh(new THREE.CylinderGeometry(0.0078, 0.0078, 0.025, 20), M.cushion);
      conn.position.copy(pts[5]).add(new THREE.Vector3(0.001, 0.014, 0.002));
      conn.quaternion.setFromUnitVectors(UP, pts[5].clone().sub(pts[4]).normalize());
      g.add(conn);
      const tape = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.012, 0.003, 2, 0.0015), M.tape);
      tape.position.copy(stomion).add(new THREE.Vector3(0, 0.0115, 0.003));
      g.add(tape);
      g.add(tube([corner.clone().add(new THREE.Vector3(0, 0.02, 0.03)), corner.clone().add(new THREE.Vector3(0.03, 0.03, 0.05)), corner.clone().add(new THREE.Vector3(0.05, 0.01, 0.07))], 0.001, M.ett, 12));
      atHead(g);
      this.regBone('ett', g);
    }
    // oropharyngeal airway flange at the lips
    {
      const g = new THREE.Group();
      const flange = new THREE.Mesh(new RoundedBoxGeometry(0.034, 0.012, 0.005, 2, 0.002), M.opa);
      flange.position.copy(mouth).add(new THREE.Vector3(0, -0.004, 0.004));
      g.add(flange);
      atHead(g);
      this.regBone('opa', g);
    }

    // tourniquets
    const tq = (section: LimbSection, t: number, key: PropKey, limbBone: string) => {
      const c = section.center.clone().addScaledVector(section.axis, -t);
      const g = new THREE.Group();
      const band = new THREE.Mesh(new THREE.CylinderGeometry(section.radius + 0.007, section.radius + 0.007, 0.038, 36, 1, true), M.tq);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.1, 10), M.tqRod);
      rod.rotation.z = Math.PI / 2;
      rod.position.set(0, 0, section.radius + 0.016);
      const clip = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.04, 0.012, 2, 0.003), M.tqRod);
      clip.position.set(0, 0, section.radius + 0.01);
      g.add(band, rod, clip);
      this.attach(g, limbBone, c, new THREE.Quaternion().setFromUnitVectors(UP, section.axis.clone().negate()));
      this.regBone(key, g);
    };
    tq(lm.sections.upperArmL, 0.06, 'tqleftArm', 'upperarm01.L');
    tq(lm.sections.upperArmR, 0.06, 'tqrightArm', 'upperarm01.R');
    tq(lm.sections.thighL, 0.06, 'tqleftLeg', 'upperleg01.L');
    tq(lm.sections.thighR, 0.06, 'tqrightLeg', 'upperleg01.R');
  }

  // ------------------------------------------------------------------ skin-mounted props
  private buildSurfaceProps() {
    const P = this.rig.landmarks.points;
    const M = this.mats;

    // ECG electrodes (5-lead: RA white, LA black, RL green, LL red, V brown)
    const leads: [string, SurfacePoint][] = [
      ['ra', P.ra],
      ['la', P.la],
      ['rl', P.rl],
      ['ll', P.ll],
      ['v', P.v1],
    ];
    for (const [id, pt] of leads) {
      const e = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.0018, 28), M.foam);
      disc.position.y = 0.0012;
      const gel = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.002, 20), M.gel);
      gel.position.y = 0.0014;
      const snap = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 12, 8), M.snap);
      snap.position.y = 0.0035;
      e.add(disc, gel, snap);
      this.regSurface('ecgLeads', pt, e, `lead-${id}`);
    }

    // defibrillator pads: right infraclavicular + left mid-axillary (apex), conformed to the chest
    [P.padRight, P.padLeft].forEach((pt, i) => {
      const o = new THREE.Group();
      o.add(new THREE.Mesh(this.conformedPad(pt, 0.12, 0.085), M.pad));
      this.regSurface('defibPads', pt, o, `pad-${i}`);
    });

    // needle decompression (14G, 2nd ICS MCL)
    for (const [key, pt] of [
      ['needleL', P.secondICSL],
      ['needleR', P.secondICSR],
    ] as const) {
      const g = new THREE.Group();
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.0055, 0.022, 16), M.hubOrange);
      hub.position.y = 0.014;
      const cath = new THREE.Mesh(new THREE.CylinderGeometry(0.0011, 0.0011, 0.012, 8), M.snap);
      cath.position.y = 0.002;
      const flash = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.01, 12), M.dressing);
      flash.position.y = 0.029;
      g.add(hub, cath, flash);
      this.regSurface(key, pt, g);
    }

    // chest drain insertion (5th ICS, mid-axillary) with dressing
    for (const [key, pt] of [
      ['chestTubeL', P.fifthAxL],
      ['chestTubeR', P.fifthAxR],
    ] as const) {
      const g = new THREE.Group();
      const dress = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.004, 0.07, 2, 0.002), M.tape);
      dress.position.y = 0.002;
      const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.03, 16), M.chestDrain);
      stub.position.y = 0.015;
      g.add(dress, stub);
      this.regSurface(key, pt, g);
    }

    // IV cannulae (dorsal forearm)
    for (const [key, pt] of [
      ['ivLeftArm', P.forearmIVL],
      ['ivRightArm', P.forearmIVR],
    ] as const) {
      const g = new THREE.Group();
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0055, 0.022, 16), M.hubPink);
      hub.position.set(0, 0.006, 0);
      hub.rotation.z = Math.PI / 2 - 0.25;
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.0015, 0.02), M.hubPink);
      wing.position.set(-0.004, 0.004, 0);
      const dressing = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.05), M.dressing);
      dressing.rotation.x = -Math.PI / 2;
      dressing.position.y = 0.0022;
      g.add(hub, wing, dressing);
      this.regSurface(key, pt, g);
    }

    // intraosseous needle (proximal tibia)
    {
      const g = new THREE.Group();
      const stab = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.003, 20), M.hubYellow);
      stab.position.y = 0.0015;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.006, 0.02, 16), M.hubBlue);
      hub.position.y = 0.012;
      g.add(stab, hub);
      this.regSurface('ioAccess', P.tibiaIOR, g);
    }
  }

  // ------------------------------------------------------------------ per frame
  update(vs: AvatarVisualState, breath: number) {
    const a = vs.attachments;
    const on: Record<PropKey, boolean> = {
      ecgLeads: a.ecgLeads,
      spo2Probe: a.spo2Probe,
      bpCuff: a.bpCuff,
      ivLeftArm: a.ivLeftArm,
      ivRightArm: a.ivRightArm,
      ioAccess: a.ioAccess,
      bvm: a.bvm,
      nonRebreather: a.nonRebreather && !a.bvm,
      faceMask: a.faceMask && !a.nonRebreather && !a.bvm,
      nasalCannula: a.nasalCannula && !a.bvm,
      ett: a.ett,
      opa: a.opa && !a.ett,
      defibPads: a.defibPads,
      needleL: a.needleDecompression === 'left',
      needleR: a.needleDecompression === 'right',
      chestTubeL: a.chestTube === 'left',
      chestTubeR: a.chestTube === 'right',
      tqleftArm: a.tourniquet === 'leftArm',
      tqrightArm: a.tourniquet === 'rightArm',
      tqleftLeg: a.tourniquet === 'leftLeg',
      tqrightLeg: a.tourniquet === 'rightLeg',
    };
    for (const [k, obj] of this.boneProps) {
      const parts = obj.userData.parts as THREE.Object3D[] | undefined;
      if (parts) for (const p of parts) p.visible = on[k];
      else obj.visible = on[k];
    }

    // surface props follow the skinned skin
    this.group.updateWorldMatrix(true, false);
    const inv = _m.copy(this.group.matrixWorld).invert();
    const anchors = new Map<string, { p: THREE.Vector3; n: THREE.Vector3 }>();
    const world = new THREE.Matrix4();
    for (const sp of this.surface) {
      const vis = on[sp.key];
      sp.obj.visible = vis;
      if (!vis) continue;
      const p = sp.anchor.compute(this.rig.body, world);
      sp.obj.matrix.multiplyMatrices(inv, world);
      sp.obj.matrixWorldNeedsUpdate = true;
      anchors.set(sp.id, { p: p.clone(), n: new THREE.Vector3().setFromMatrixColumn(world, 1) });
    }

    const W2L = (p: THREE.Vector3) => p.clone().applyMatrix4(inv);
    const top = this.mattressTop;
    const setTube = (key: string, visible: boolean, radius: number, mat: THREE.Material, pts: () => THREE.Vector3[]) => {
      if (!visible && !this.tubes.has(key)) return;
      const t = this.tube(key, radius, mat);
      t.mesh.visible = visible;
      if (visible) t.update(pts().map(W2L));
    };

    // ECG leads converge beside the left shoulder and leave the bed towards the monitor
    const la = anchors.get('lead-la');
    const hub = la ? la.p.clone().add(new THREE.Vector3(0.03, -0.03, -0.17)) : new THREE.Vector3();
    const exit = hub.clone().add(new THREE.Vector3(-0.25, 0, -0.28));
    exit.y = top - 0.02;
    const leadMats: Record<string, THREE.Material> = { ra: this.mats.wireWhite, la: this.mats.wireBlack, rl: this.mats.wireGreen, ll: this.mats.wireRed, v: this.mats.wireBrown };
    for (const id of ['ra', 'la', 'rl', 'll', 'v']) {
      const ap = anchors.get(`lead-${id}`);
      setTube(`lead-${id}`, a.ecgLeads && !!ap, 0.0016, leadMats[id], () => {
        const s = ap!.p.clone().addScaledVector(ap!.n, 0.005);
        // run over the skin towards the patient's left, then to the shoulder hub
        const lift = s.clone().addScaledVector(ap!.n, 0.02);
        const across = new THREE.Vector3(s.x, s.y + 0.03, THREE.MathUtils.lerp(s.z, hub.z, 0.5));
        const mid = new THREE.Vector3(THREE.MathUtils.lerp(s.x, hub.x, 0.6), Math.max(s.y, hub.y) + 0.02, hub.z + 0.04);
        return [s, lift, across, mid, hub, exit];
      });
    }

    // defibrillator cables towards the defibrillator at the patient's right side
    for (let i = 0; i < 2; i++) {
      const ap = anchors.get(`pad-${i}`);
      setTube(`pad-${i}`, a.defibPads && !!ap, 0.0028, this.mats.wireBlack, () => {
        const s = ap!.p.clone().addScaledVector(ap!.n, 0.01);
        const mid = s.clone().addScaledVector(ap!.n, 0.04).add(new THREE.Vector3(0.08, 0, 0.1));
        // over the mattress edge, then drooping down the side of the bed towards the defibrillator cart
        const edge = new THREE.Vector3(s.x + 0.14 + 0.03 * i, top + 0.015, 0.47);
        const side = new THREE.Vector3(s.x + 0.2 + 0.03 * i, top - 0.12, 0.53);
        const floor = new THREE.Vector3(s.x + 0.32 + 0.04 * i, 0.06, 0.68);
        return [s, mid, edge, side, floor];
      });
    }

    // chest drains run off the bed to a drainage unit on the floor
    let drainOn = false;
    for (const [key, sign] of [
      ['chestTubeL', -1],
      ['chestTubeR', 1],
    ] as const) {
      const ap = anchors.get(key);
      const vis = on[key] && !!ap;
      setTube(`drain-${key}`, vis, 0.0048, this.mats.chestDrain, () => {
        const s = ap!.p.clone().addScaledVector(ap!.n, 0.02);
        const out = ap!.p.clone().addScaledVector(ap!.n, 0.08);
        const edge = new THREE.Vector3(s.x + 0.15, top + 0.02, sign * 0.5);
        const floor = new THREE.Vector3(s.x + 0.25, 0.3, sign * 0.62);
        return [s, out, edge, floor];
      });
      if (vis && ap) {
        drainOn = true;
        this.drain.position.copy(W2L(new THREE.Vector3(ap.p.x + 0.25, 0.15, sign * 0.62)));
      }
    }
    this.drain.visible = drainOn;

    // IV giving set from the cannula to the bag on the pole
    for (const key of ['ivLeftArm', 'ivRightArm'] as const) {
      const ap = anchors.get(key);
      const vis = on[key] && !!ap && !!this.ivPoleAnchor && !!a.ivBag;
      setTube(`iv-${key}`, vis, 0.0022, this.mats.clearTube, () => {
        const s = ap!.p.clone().addScaledVector(ap!.n, 0.008);
        const end = this.ivPoleAnchor!;
        const up = s.clone().addScaledVector(ap!.n, 0.06);
        const mid = s.clone().lerp(end, 0.55);
        mid.y = Math.max(s.y + 0.05, end.y - 0.45);
        return [s, up, mid, end.clone().add(new THREE.Vector3(0, -0.12, 0)), end];
      });
    }

    // reservoir bag deflates on inspiration; BVM bag squeezed on assisted breaths
    if (this.nrbBag) {
      const s = 1 - 0.35 * breath;
      this.nrbBag.scale.set(this.nrbBase.x * (0.85 + 0.15 * s), this.nrbBase.y * (0.9 + 0.1 * s), this.nrbBase.z * s);
    }
    if (this.bvmBag) {
      const sq = vs.passiveVentilation ? breath : 0;
      this.bvmBag.scale.set(1 - 0.45 * sq, 1 + 0.05 * sq, 1 - 0.35 * sq);
    }

    // blood pool on the sheet under a bleeding wound
    const b = a.bleeding;
    if (b && b.intensity > 0.02) {
      const sp = this.rig.landmarks.regionPoints[b.region] ?? this.rig.landmarks.regionPoints.chest;
      const bone = this.rig.bones[sp.bone];
      const w = sp.p.clone().sub(this.rig.landmarks.boneHead(sp.bone));
      bone.updateWorldMatrix(true, false);
      w.applyMatrix4(bone.matrixWorld);
      w.z += w.z >= 0 ? 0.08 : -0.08;
      w.y = top + 0.012;
      this.bloodPool.position.copy(W2L(w));
      const r = 0.05 + 0.2 * Math.min(1, b.intensity);
      this.bloodPool.scale.set(r * 1.4, 1, r);
      this.bloodPool.visible = true;
    } else this.bloodPool.visible = false;
  }

  dispose() {
    for (const obj of this.boneProps.values()) {
      obj.removeFromParent();
      for (const p of (obj.userData.parts as THREE.Object3D[] | undefined) ?? []) p.removeFromParent();
    }
    for (const t of this.tubes.values()) t.dispose();
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
