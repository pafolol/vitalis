import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { AvatarVisualState } from '../types';
import type { HumanRig } from '../human/buildHuman';
import type { PatientLayout } from '../human/PatientAvatar';
import type { RoomMaterials } from './materials';

export const BED = {
  length: 2.06,
  width: 0.86,
  mattressThickness: 0.14,
  /** World X of the mattress head end */
  headX: -1.02,
};

interface BedProps {
  mats: RoomMaterials;
  layout: PatientLayout;
  rig: HumanRig | null;
  visual: MutableRefObject<AvatarVisualState>;
}

/**
 * Emergency stretcher: articulated backrest (hinge at the patient's hips),
 * mattress, pillow, side rails, chassis and a sheet draped over the legs whose
 * shape is computed from the patient's posed leg geometry.
 */
export function Bed({ mats, layout, rig, visual }: BedProps) {
  const backRef = useRef<THREE.Group>(null);
  const angle = useRef(15);
  // how far the sheet is folded down to expose the legs for procedures/wounds
  const [exposure, setExposure] = useState(0);
  // settled backrest angle (5° steps): raising the backrest lifts the arms, so the sheet is re-fitted
  const [sheetBackrest, setSheetBackrest] = useState<number | null>(null);
  const top = layout.mattressTop;
  const footX = BED.headX + BED.length;
  const hinge = THREE.MathUtils.clamp(layout.hingeX, BED.headX + 0.4, footX - 0.6);

  const geos = useMemo(() => {
    const t = BED.mattressThickness;
    const backLen = hinge - BED.headX;
    const footLen = footX - hinge;
    return {
      backMattress: new RoundedBoxGeometry(backLen, t, BED.width, 4, 0.05),
      footMattress: new RoundedBoxGeometry(footLen, t, BED.width, 4, 0.05),
      pillow: (() => {
        const g = new RoundedBoxGeometry(0.42, 0.11, 0.58, 6, 0.05);
        const p = g.getAttribute('position') as THREE.BufferAttribute;
        // soft, slightly dented pillow
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i);
          const y = p.getY(i);
          const z = p.getZ(i);
          const bulge = (1 - (x / 0.21) ** 2) * (1 - (z / 0.29) ** 2);
          const dent = Math.exp(-((x / 0.12) ** 2 + (z / 0.14) ** 2)) * 0.035;
          p.setY(i, y * (0.75 + 0.35 * Math.max(0, bulge)) - (y > 0 ? dent : 0));
        }
        g.computeVertexNormals();
        return g;
      })(),
      frameBar: new THREE.CylinderGeometry(0.018, 0.018, 1, 16),
      rail: new RoundedBoxGeometry(1, 0.035, 0.03, 3, 0.012),
      post: new THREE.CylinderGeometry(0.012, 0.012, 0.28, 12),
      wheel: new THREE.CylinderGeometry(0.06, 0.06, 0.04, 24),
      caster: new RoundedBoxGeometry(0.06, 0.08, 0.06, 2, 0.01),
      base: new RoundedBoxGeometry(BED.length * 0.86, 0.1, BED.width * 0.7, 3, 0.03),
      column: new RoundedBoxGeometry(0.18, 0.42, 0.24, 3, 0.03),
      endBoard: new RoundedBoxGeometry(0.035, 0.36, BED.width * 0.92, 3, 0.015),
    };
  }, [hinge, footX]);

  useEffect(() => () => Object.values(geos).forEach((g) => g.dispose()), [geos]);

  // Sheet/blanket draped over the legs (height field from the posed body)
  const sheetGeo = useMemo(() => {
    void sheetBackrest; // re-fit trigger: the posed body is read from the live skeleton
    const x0 = rig ? THREE.MathUtils.lerp(layout.hingeX, layout.feetX, [0.2, 0.56, 0.8][exposure]) : hinge + 0.2;
    const x1 = footX + 0.02;
    const nx = 70;
    const nz = 56;
    let halfW = BED.width / 2 + 0.01;
    if (rig) {
      // widen the cloth to cover hands/hips that rest beyond the mattress edge (broad patients)
      rig.root.updateMatrixWorld(true);
      rig.skeleton.update();
      const v = new THREE.Vector3();
      const pos = rig.body.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const r = rig.region[i];
        if (!(r === 4 || r === 5 || (r >= 7 && r <= 14))) continue; // abdomen, pelvis, arms, hands, legs, feet
        rig.body.getVertexPosition(i, v);
        rig.body.localToWorld(v);
        if (v.x < x0 - 0.05 || v.x > x1) continue;
        halfW = Math.max(halfW, Math.abs(v.z) + 0.03);
      }
    }
    const drop = 0.22;
    const zSpan = halfW + drop;
    const grid = new Float32Array((nx + 1) * (nz + 1)).fill(top);
    if (rig) {
      rig.root.updateMatrixWorld(true);
      rig.skeleton.update();
      const v = new THREE.Vector3();
      const pos = rig.body.geometry.getAttribute('position');
      const cellX = (x1 - x0) / nx;
      const cellZ = (2 * halfW) / nz;
      for (let i = 0; i < pos.count; i++) {
        const r = rig.region[i];
        if (!(r === 4 || r === 5 || (r >= 7 && r <= 14))) continue; // abdomen, pelvis, arms, hands, legs, feet
        rig.body.getVertexPosition(i, v);
        rig.body.localToWorld(v);
        if (v.x < x0 - 0.05 || v.x > x1) continue;
        const gx = Math.round((v.x - x0) / cellX);
        const gz = Math.round((v.z + halfW) / cellZ);
        // thin, rounded limbs (arms/hands) need more clearance so the coarse cloth grid never cuts into them
        const limb = r >= 7 && r <= 10;
        const lift = limb ? 0.02 : 0.008;
        const fall = limb ? 0.0025 : 0.006;
        for (let dx = -2; dx <= 2; dx++)
          for (let dz = -2; dz <= 2; dz++) {
            const ix = gx + dx;
            const iz = gz + dz;
            if (ix < 0 || ix > nx || iz < 0 || iz > nz) continue;
            const falloff = fall * (dx * dx + dz * dz);
            const k = iz * (nx + 1) + ix;
            grid[k] = Math.max(grid[k], v.y + lift - falloff);
          }
      }
      // cloth hull: dilate, blur, then make sure it never dips below the body
      const W = nx + 1;
      const raw = grid.slice();
      const filt = (src: Float32Array, r: number, op: 'max' | 'avg') => {
        const tmp = new Float32Array(src.length);
        const out = new Float32Array(src.length);
        for (let iz = 0; iz <= nz; iz++)
          for (let ix = 0; ix <= nx; ix++) {
            let acc = op === 'max' ? -Infinity : 0;
            let c = 0;
            for (let d = -r; d <= r; d++) {
              const jx = Math.min(nx, Math.max(0, ix + d));
              const v = src[iz * W + jx];
              if (op === 'max') acc = Math.max(acc, v);
              else {
                acc += v;
                c++;
              }
            }
            tmp[iz * W + ix] = op === 'max' ? acc : acc / c;
          }
        for (let iz = 0; iz <= nz; iz++)
          for (let ix = 0; ix <= nx; ix++) {
            let acc = op === 'max' ? -Infinity : 0;
            let c = 0;
            for (let d = -r; d <= r; d++) {
              const jz = Math.min(nz, Math.max(0, iz + d));
              const v = tmp[jz * W + ix];
              if (op === 'max') acc = Math.max(acc, v);
              else {
                acc += v;
                c++;
              }
            }
            out[iz * W + ix] = op === 'max' ? acc : acc / c;
          }
        return out;
      };
      let hull = filt(raw, 2, 'max');
      for (let i = 0; i < 3; i++) hull = filt(hull, 3, 'avg');
      for (let k = 0; k < hull.length; k++) hull[k] = Math.max(hull[k], raw[k] + 0.004, top + 0.004);
      hull = filt(hull, 1, 'avg');
      for (let k = 0; k < hull.length; k++) hull[k] = Math.max(hull[k], raw[k], top + 0.004);
      grid.set(hull);
    }
    // build mesh: u across (−zSpan..zSpan), beyond the mattress edge the sheet hangs down
    const g = new THREE.PlaneGeometry(1, 1, nx, nz + 16);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const rows = nz + 16;
    for (let j = 0; j <= rows; j++) {
      const s = j / rows; // 0..1 across
      const zu = -zSpan + s * 2 * zSpan;
      for (let i = 0; i <= nx; i++) {
        const idx = j * (nx + 1) + i;
        const x = x0 + (i / nx) * (x1 - x0);
        let y: number;
        let z: number;
        const edge = Math.abs(zu) - halfW;
        const wob = 0.003 * Math.sin(x * 19 + zu * 5) + 0.0015 * Math.sin(x * 43 - zu * 11);
        if (edge <= 0) {
          const gz = Math.round(((zu + halfW) / (2 * halfW)) * nz);
          y = grid[gz * (nx + 1) + i] + wob * 0.5;
          z = zu;
        } else {
          const gz = zu > 0 ? nz : 0;
          const yEdge = Math.max(grid[gz * (nx + 1) + i], top + 0.004);
          const a = Math.min(1, edge / 0.05);
          z = Math.sign(zu) * (halfW + 0.03 * Math.sin((a * Math.PI) / 2) + Math.max(0, edge - 0.05) * 0.08) ;
          y = yEdge - edge * (0.4 + 0.6 * a) - wob;
        }
        p.setXYZ(idx, x, y, z);
        uv.setXY(idx, (x - x0) * 2, s * 3);
      }
    }
    g.computeVertexNormals();
    return g;
  }, [rig, layout.hingeX, layout.feetX, hinge, footX, top, exposure, sheetBackrest]);

  useEffect(() => () => sheetGeo.dispose(), [sheetGeo]);

  useFrame((_, dt) => {
    const a = visual.current.attachments;
    const legWound = a.bleeding && ['leftLeg', 'rightLeg', 'pelvis'].includes(a.bleeding.region);
    const footWound = a.bleeding && ['leftFoot', 'rightFoot'].includes(a.bleeding.region);
    const tqLeg = a.tourniquet === 'leftLeg' || a.tourniquet === 'rightLeg';
    const want = a.ioAccess || footWound ? 2 : legWound || tqLeg ? 1 : 0;
    if (want !== exposure) setExposure(want);
    const target = a.backrestDeg;
    angle.current += (target - angle.current) * (1 - Math.exp(-3 * Math.min(dt, 0.1)));
    if (backRef.current) backRef.current.rotation.z = -THREE.MathUtils.degToRad(THREE.MathUtils.clamp(angle.current, 0, 80));
    const settled = Math.round(target / 5) * 5;
    if (rig && Math.abs(angle.current - target) < 0.5 && settled !== sheetBackrest) setSheetBackrest(settled);
  });

  const t = BED.mattressThickness;
  const backLen = hinge - BED.headX;
  const footLen = footX - hinge;
  const railY = top + 0.14;
  const chassisY = top - t - 0.05;
  return (
    <group>
      {/* backrest section (rotates about the hinge) */}
      <group position={[hinge, top - t / 2, 0]} ref={backRef}>
        <mesh geometry={geos.backMattress} material={mats.mattress} position={[-backLen / 2, 0, 0]} castShadow receiveShadow />
        <mesh
          geometry={geos.pillow}
          material={mats.pillow}
          position={[layout.headX - hinge + 0.02, t / 2 + (layout.headBackY - top) / 2 + 0.005, 0]}
          scale={[1, Math.max(0.35, (layout.headBackY - top + 0.02) / 0.11), 1]}
          castShadow
          receiveShadow
        />
        <mesh geometry={geos.endBoard} material={mats.lightPlastic} position={[-backLen - 0.02, 0.1, 0]} castShadow />
      </group>
      {/* seat/leg section */}
      <mesh geometry={geos.footMattress} material={mats.mattress} position={[hinge + footLen / 2, top - t / 2, 0]} castShadow receiveShadow />
      <mesh geometry={sheetGeo} material={mats.blanket} castShadow receiveShadow />
      {/* foot board */}
      <mesh geometry={geos.endBoard} material={mats.lightPlastic} position={[footX + 0.03, top - 0.04, 0]} castShadow />
      {/* side rails: far side up, clinician side down */}
      <group position={[0, railY, -BED.width / 2 - 0.03]}>
        <mesh geometry={geos.rail} material={mats.steel} position={[hinge - 0.35, 0.06, 0]} scale={[0.9, 1, 1]} castShadow />
        <mesh geometry={geos.rail} material={mats.steel} position={[hinge - 0.35, -0.04, 0]} scale={[0.9, 1, 1]} castShadow />
        <mesh geometry={geos.post} material={mats.steel} position={[hinge - 0.72, -0.05, 0]} />
        <mesh geometry={geos.post} material={mats.steel} position={[hinge + 0.02, -0.05, 0]} />
        <mesh geometry={geos.rail} material={mats.steel} position={[hinge + 0.45, 0.06, 0]} scale={[0.75, 1, 1]} castShadow />
        <mesh geometry={geos.rail} material={mats.steel} position={[hinge + 0.45, -0.04, 0]} scale={[0.75, 1, 1]} castShadow />
        <mesh geometry={geos.post} material={mats.steel} position={[hinge + 0.14, -0.05, 0]} />
        <mesh geometry={geos.post} material={mats.steel} position={[hinge + 0.78, -0.05, 0]} />
      </group>
      <group position={[0, top - t - 0.02, BED.width / 2 + 0.03]}>
        <mesh geometry={geos.rail} material={mats.steel} position={[hinge + 0.1, -0.02, 0]} scale={[1.4, 1, 1]} castShadow />
      </group>
      {/* chassis */}
      <mesh geometry={geos.frameBar} material={mats.steel} rotation={[0, 0, Math.PI / 2]} scale={[1, BED.length * 0.98, 1]} position={[BED.headX + BED.length / 2, top - t - 0.03, BED.width / 2 - 0.05]} castShadow />
      <mesh geometry={geos.frameBar} material={mats.steel} rotation={[0, 0, Math.PI / 2]} scale={[1, BED.length * 0.98, 1]} position={[BED.headX + BED.length / 2, top - t - 0.03, -BED.width / 2 + 0.05]} castShadow />
      <mesh geometry={geos.column} material={mats.darkPlastic} position={[BED.headX + 0.45, chassisY - 0.2, 0]} castShadow />
      <mesh geometry={geos.column} material={mats.darkPlastic} position={[footX - 0.45, chassisY - 0.2, 0]} castShadow />
      <mesh geometry={geos.base} material={mats.lightPlastic} position={[BED.headX + BED.length / 2, 0.2, 0]} castShadow receiveShadow />
      {[
        [BED.headX + 0.12, BED.width / 2 - 0.1],
        [BED.headX + 0.12, -BED.width / 2 + 0.1],
        [footX - 0.12, BED.width / 2 - 0.1],
        [footX - 0.12, -BED.width / 2 + 0.1],
      ].map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh geometry={geos.caster} material={mats.darkPlastic} position={[0, 0.14, 0]} />
          <mesh geometry={geos.wheel} material={mats.darkPlastic} position={[0, 0.06, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow />
        </group>
      ))}
    </group>
  );
}
