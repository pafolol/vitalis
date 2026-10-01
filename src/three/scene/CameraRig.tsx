import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { CameraPreset } from '../types';
import type { HumanRig } from '../human/buildHuman';
import type { LandmarkName } from '../human/landmarks';
import type { PatientLayout } from '../human/PatientAvatar';

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

function landmarkWorld(rig: HumanRig, name: LandmarkName) {
  const pt = rig.landmarks.points[name];
  const bone = rig.bones[pt.bone];
  bone.updateWorldMatrix(true, false);
  return pt.p.clone().sub(rig.landmarks.boneHead(pt.bone)).applyMatrix4(bone.matrixWorld);
}

function boneWorld(rig: HumanRig, name: string) {
  const b = rig.bones[name];
  b.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
}

/** Camera presets derived from the current patient's anatomy (clinician stands at the patient's right, +Z). */
export function computeCameraPresets(rig: HumanRig | null, layout: PatientLayout | null): Record<CameraPreset, CameraPose> {
  const top = layout?.mattressTop ?? 0.78;
  const hinge = layout?.hingeX ?? -0.05;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  if (!rig || !layout) {
    return {
      full: { position: v(hinge + 1.2, top + 1.2, 2.2), target: v(hinge + 0.1, top + 0.1, 0) },
      head: { position: v(-0.4, 1.5, 0.6), target: v(-0.8, top + 0.12, 0) },
      chest: { position: v(-0.2, 1.6, 0.8), target: v(-0.4, top + 0.12, 0) },
      abdomen: { position: v(0.1, 1.6, 0.8), target: v(-0.05, top + 0.1, 0) },
      arms: { position: v(0.0, 1.5, 1.0), target: v(-0.1, top + 0.05, 0.25) },
      legs: { position: v(1.0, 1.6, 1.2), target: v(0.5, top + 0.08, 0) },
    };
  }
  rig.root.updateMatrixWorld(true);
  const head = boneWorld(rig, 'head').add(v(0.02, 0.06, 0));
  const chest = landmarkWorld(rig, 'xiphoid').lerp(landmarkWorld(rig, 'sternalNotch'), 0.5);
  const navel = landmarkWorld(rig, 'navel');
  const arm = boneWorld(rig, 'lowerarm01.R').lerp(boneWorld(rig, 'wrist.R'), 0.3);
  const knees = boneWorld(rig, 'lowerleg01.L').lerp(boneWorld(rig, 'lowerleg01.R'), 0.5);
  const body = chest.clone().lerp(knees, 0.45);
  return {
    full: { position: body.clone().add(v(1.05, 1.15, 1.85)), target: body.clone().add(v(-0.1, -0.02, 0)) },
    head: { position: head.clone().add(v(0.42, 0.42, 0.5)), target: head },
    chest: { position: chest.clone().add(v(0.32, 0.62, 0.72)), target: chest },
    abdomen: { position: navel.clone().add(v(0.25, 0.65, 0.78)), target: navel },
    arms: { position: arm.clone().add(v(0.12, 0.55, 0.62)), target: arm },
    legs: { position: knees.clone().add(v(0.75, 0.7, 1.05)), target: knees.clone().add(v(0.05, 0, 0)) },
  };
}

interface CameraRigProps {
  presets: Record<CameraPreset, CameraPose>;
  preset: CameraPreset;
  presetNonce: number;
}

/** Orbit controls with damping, sensible limits and animated preset transitions. */
export function CameraRig({ presets, preset, presetNonce }: CameraRigProps) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const anim = useRef<{ fromP: THREE.Vector3; fromT: THREE.Vector3; to: CameraPose; t: number } | null>(null);
  const first = useRef(true);

  useEffect(() => {
    const to = presets[preset];
    if (!to) return;
    const c = controls.current;
    if (first.current || !c) {
      camera.position.copy(to.position);
      c?.target.copy(to.target);
      c?.update();
      first.current = false;
      return;
    }
    anim.current = { fromP: camera.position.clone(), fromT: c.target.clone(), to, t: 0 };
  }, [preset, presetNonce, presets, camera]);

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __vitalisControls?: unknown }).__vitalisControls = controls.current;
  });

  useFrame((_, dt) => {
    const a = anim.current;
    const c = controls.current;
    if (!a || !c) return;
    a.t = Math.min(1, a.t + dt / 0.9);
    const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
    camera.position.lerpVectors(a.fromP, a.to.position, e);
    c.target.lerpVectors(a.fromT, a.to.target, e);
    c.update();
    if (a.t >= 1) anim.current = null;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={0.22}
      maxDistance={4.2}
      maxPolarAngle={Math.PI * 0.49}
      rotateSpeed={0.6}
      zoomSpeed={0.8}
      panSpeed={0.7}
      screenSpacePanning
      onStart={() => (anim.current = null)}
    />
  );
}
