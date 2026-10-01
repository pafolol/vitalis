import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { AvatarVisualState } from '../types';
import type { RoomMaterials } from './materials';
import { BED } from './Bed';

export const IV_POLE = { x: -0.62, z: -0.66, hookY: 1.98 };

/** World position of the IV bag spike (where the giving set leaves the bag). */
export const IV_BAG_SPIKE: [number, number, number] = [IV_POLE.x + 0.1, IV_POLE.hookY - 0.34, IV_POLE.z];

function labelTexture(text: string, isBlood: boolean) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 160);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillRect(14, 30, 100, 70);
  g.fillStyle = isBlood ? '#8b0000' : '#1c4f8f';
  g.fillRect(14, 30, 100, 12);
  g.fillStyle = '#111';
  g.font = 'bold 15px sans-serif';
  g.textAlign = 'center';
  const words = text.split(' ');
  let line = '';
  let y = 62;
  for (const w of words) {
    if ((line + ' ' + w).length > 11) {
      g.fillText(line.trim(), 64, y);
      y += 17;
      line = w;
    } else line += ' ' + w;
  }
  g.fillText(line.trim(), 64, y);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function IVPole({ mats, visual }: { mats: RoomMaterials; visual: MutableRefObject<AvatarVisualState> }) {
  const bagRef = useRef<THREE.Group>(null);
  const fluidRef = useRef<THREE.Mesh>(null);
  const dripRef = useRef<THREE.Mesh>(null);
  const labelRef = useRef<THREE.Mesh>(null);
  const lastLabel = useRef('');
  const fluidMat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: 0xdfeef5, roughness: 0.05, transparent: true, opacity: 0.55, transmission: 0.0, clearcoat: 1 }),
    [],
  );
  const bagMat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.15, transparent: true, opacity: 0.28, depthWrite: false, clearcoat: 1, side: THREE.DoubleSide }), []);
  const labelMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true }), []);
  const geos = useMemo(
    () => ({
      pole: new THREE.CylinderGeometry(0.013, 0.013, IV_POLE.hookY, 16),
      hookBar: new THREE.CylinderGeometry(0.007, 0.007, 0.3, 8),
      base: new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8),
      bag: (() => {
        const g = new RoundedBoxGeometry(0.15, 0.24, 0.045, 4, 0.02);
        return g;
      })(),
      fluid: new RoundedBoxGeometry(0.135, 0.22, 0.035, 4, 0.016),
      chamber: new THREE.CylinderGeometry(0.012, 0.012, 0.06, 16, 1, true),
      drop: new THREE.SphereGeometry(0.0035, 8, 6),
      label: new THREE.PlaneGeometry(0.1, 0.125),
      wheel: new THREE.SphereGeometry(0.025, 12, 8),
    }),
    [],
  );
  useEffect(
    () => () => {
      Object.values(geos).forEach((g) => g.dispose());
      fluidMat.dispose();
      bagMat.dispose();
      labelMat.map?.dispose();
      labelMat.dispose();
    },
    [geos, fluidMat, bagMat, labelMat],
  );

  useFrame((state) => {
    const bag = visual.current.attachments.ivBag;
    if (bagRef.current) bagRef.current.visible = !!bag;
    if (!bag) return;
    const f = THREE.MathUtils.clamp(bag.fraction, 0.02, 1);
    if (fluidRef.current) {
      fluidRef.current.scale.y = f;
      fluidRef.current.position.y = -0.11 * (1 - f);
    }
    fluidMat.color.set(bag.isBlood ? 0x7a0c10 : 0xdcebf2);
    fluidMat.opacity = bag.isBlood ? 0.92 : 0.5;
    if (dripRef.current) {
      const period = bag.isBlood ? 0.7 : 0.45;
      const tt = (state.clock.elapsedTime % period) / period;
      dripRef.current.visible = bag.running;
      dripRef.current.position.y = -0.155 - tt * 0.035;
      (dripRef.current.material as THREE.MeshPhysicalMaterial).color.set(bag.isBlood ? 0x7a0c10 : 0xdcebf2);
    }
    const key = `${bag.label}|${bag.isBlood}`;
    if (key !== lastLabel.current && labelRef.current) {
      lastLabel.current = key;
      labelMat.map?.dispose();
      labelMat.map = labelTexture(bag.label, bag.isBlood);
      labelMat.needsUpdate = true;
    }
  });

  return (
    <group position={[IV_POLE.x, 0, IV_POLE.z]}>
      <mesh geometry={geos.pole} material={mats.steel} position={[0, IV_POLE.hookY / 2, 0]} castShadow />
      <mesh geometry={geos.hookBar} material={mats.steel} position={[0, IV_POLE.hookY, 0]} rotation={[0, 0, Math.PI / 2]} />
      {[0, 1, 2, 3, 4].map((i) => (
        <group key={i} rotation={[0, (i / 5) * Math.PI * 2, 0]}>
          <mesh geometry={geos.base} material={mats.steel} position={[0.23, 0.05, 0]} rotation={[0, 0, Math.PI / 2 - 0.1]} scale={[1, 1, 1]} />
          <mesh geometry={geos.wheel} material={mats.darkPlastic} position={[0.46, 0.025, 0]} />
        </group>
      ))}
      <group ref={bagRef} position={[0.1, IV_POLE.hookY - 0.16, 0]}>
        <mesh geometry={geos.bag} material={bagMat} renderOrder={4} />
        <mesh ref={fluidRef} geometry={geos.fluid} material={fluidMat} renderOrder={3} />
        <mesh ref={labelRef} geometry={geos.label} material={labelMat} position={[0, 0.02, 0.026]} renderOrder={5} />
        <mesh geometry={geos.chamber} material={bagMat} position={[0, -0.16, 0]} />
        <mesh ref={dripRef} geometry={geos.drop} position={[0, -0.155, 0]}>
          <meshPhysicalMaterial color={0xdcebf2} roughness={0.05} transparent opacity={0.8} />
        </mesh>
      </group>
    </group>
  );
}

function Headwall({ mats }: { mats: RoomMaterials }) {
  const geos = useMemo(
    () => ({
      panel: new RoundedBoxGeometry(0.16, 1.1, 1.6, 3, 0.02),
      outlet: new THREE.CylinderGeometry(0.028, 0.028, 0.03, 20),
      flow: new THREE.CylinderGeometry(0.022, 0.018, 0.12, 20),
      socket: new RoundedBoxGeometry(0.02, 0.07, 0.1, 2, 0.01),
      arm: new RoundedBoxGeometry(0.5, 0.05, 0.05, 2, 0.015),
      monitor: new RoundedBoxGeometry(0.06, 0.32, 0.44, 3, 0.02),
      screen: new THREE.PlaneGeometry(0.4, 0.28),
      light: new THREE.CylinderGeometry(0.28, 0.32, 0.06, 40),
      lightFace: new THREE.CircleGeometry(0.27, 40),
      lightArm: new THREE.CylinderGeometry(0.02, 0.02, 0.9, 10),
      rail: new RoundedBoxGeometry(0.03, 0.04, 3.4, 2, 0.01),
    }),
    [],
  );
  useEffect(() => () => Object.values(geos).forEach((g) => g.dispose()), [geos]);
  const wallX = BED.headX - 0.42;
  return (
    <group>
      {/* bed-head service panel */}
      <mesh geometry={geos.panel} material={mats.headwall} position={[wallX + 0.08, 1.35, 0]} castShadow receiveShadow />
      {(
        [
          [mats.o2, 0.52],
          [mats.air, 0.35],
          [mats.vac, 0.18],
          [mats.o2, -0.52],
        ] as const
      ).map(([m, z], i) => (
        <mesh key={i} geometry={geos.outlet} material={m} position={[wallX + 0.17, 1.55, z]} rotation={[0, 0, Math.PI / 2]} />
      ))}
      <mesh geometry={geos.flow} material={mats.o2} position={[wallX + 0.2, 1.42, 0.52]} />
      <mesh geometry={geos.flow} material={mats.vac} position={[wallX + 0.2, 1.42, 0.18]} />
      {[-0.3, -0.12, 0.06].map((z, i) => (
        <mesh key={i} geometry={geos.socket} material={mats.lightPlastic} position={[wallX + 0.17, 1.12, z - 0.25]} />
      ))}
      <mesh geometry={geos.rail} material={mats.steel} position={[wallX + 0.18, 1.0, 0]} />
      {/* wall-mounted monitor arm (patient's left, head end) */}
      <group position={[wallX + 0.1, 1.72, -0.72]}>
        <mesh geometry={geos.arm} material={mats.darkPlastic} position={[0.25, 0, 0]} />
        <group position={[0.52, -0.02, 0.05]} rotation={[0, -0.7, 0]}>
          <mesh geometry={geos.monitor} material={mats.darkPlastic} castShadow />
          <mesh geometry={geos.screen} material={mats.screen} position={[0.031, 0, 0]} rotation={[0, Math.PI / 2, 0]} />
        </group>
      </group>
      {/* ceiling examination light */}
      <group position={[-0.25, 2.55, 0.1]}>
        <mesh geometry={geos.lightArm} material={mats.steel} position={[0, 0.45, 0]} />
        <mesh geometry={geos.light} material={mats.lightPlastic} castShadow />
        <mesh geometry={geos.lightFace} position={[0, -0.031, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color={'#fffaf0'} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/** Room shell, lighting and local environment (no network HDRIs). */
export function ERRoom({ mats, visual }: { mats: RoomMaterials; visual: MutableRefObject<AvatarVisualState> }) {
  const geos = useMemo(
    () => ({
      floor: new THREE.PlaneGeometry(14, 14),
      wall: new THREE.PlaneGeometry(14, 3.2),
      band: new THREE.PlaneGeometry(14, 0.12),
      skirting: new THREE.BoxGeometry(14, 0.1, 0.02),
      curtainTrack: new THREE.TorusGeometry(1.7, 0.012, 6, 64, Math.PI),
    }),
    [],
  );
  useEffect(() => () => Object.values(geos).forEach((g) => g.dispose()), [geos]);
  const keyRef = useRef<THREE.SpotLight>(null);
  const targetObj = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    targetObj.position.set(-0.1, 0.8, 0);
    if (keyRef.current) keyRef.current.target = targetObj;
  }, [targetObj]);

  const headWallX = BED.headX - 0.42;
  return (
    <group>
      <color attach="background" args={['#aeb8bd']} />
      <fog attach="fog" args={['#aeb8bd', 7, 16]} />
      <hemisphereLight args={['#f2f5f7', '#6d6a64', 0.28]} />
      <spotLight
        ref={keyRef}
        position={[-0.25, 2.5, 0.1]}
        angle={0.72}
        penumbra={0.85}
        intensity={34}
        decay={1.4}
        color={'#fff6ea'}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.00012}
        shadow-normalBias={0.02}
        shadow-radius={6}
      />
      <primitive object={targetObj} />
      <directionalLight position={[2.5, 2.8, 3.5]} intensity={0.55} color={'#e8f0ff'} />
      <directionalLight position={[-2.5, 2.2, -3]} intensity={0.55} color={'#fff1e0'} />
      <Environment resolution={256} frames={1} environmentIntensity={0.65}>
        <Lightformer form="rect" intensity={2.2} color="#ffffff" position={[0, 4, 0]} rotation-x={Math.PI / 2} scale={[4, 2, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#f4f8ff" position={[3, 2, 3]} rotation-y={-Math.PI / 4} scale={[3, 2, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#fff4e6" position={[-4, 2, -2]} rotation-y={Math.PI / 3} scale={[3, 2, 1]} />
        <Lightformer form="ring" intensity={1.5} color="#ffffff" position={[-0.25, 3, 0]} rotation-x={Math.PI / 2} scale={1.2} />
        <mesh scale={30}>
          <sphereGeometry args={[1, 32, 16]} />
          <meshBasicMaterial color="#6e7a80" side={THREE.BackSide} />
        </mesh>
      </Environment>

      <mesh geometry={geos.floor} material={mats.floor} rotation={[-Math.PI / 2, 0, 0]} receiveShadow />
      {/* back wall (patient's left) and head wall */}
      <mesh geometry={geos.wall} material={mats.wall} position={[0, 1.6, -2.1]} receiveShadow />
      <mesh geometry={geos.band} material={mats.wallAccent} position={[0, 1.0, -2.095]} />
      <mesh geometry={geos.skirting} material={mats.wallAccent} position={[0, 0.05, -2.09]} />
      <mesh geometry={geos.wall} material={mats.wall} position={[headWallX, 1.6, 0]} rotation={[0, Math.PI / 2, 0]} receiveShadow />
      <mesh geometry={geos.band} material={mats.wallAccent} position={[headWallX + 0.005, 1.0, 0]} rotation={[0, Math.PI / 2, 0]} />
      <mesh geometry={geos.curtainTrack} material={mats.steel} position={[0.2, 2.7, 0]} rotation={[Math.PI / 2, 0, Math.PI / 2]} />
      <Headwall mats={mats} />
      <IVPole mats={mats} visual={visual} />
    </group>
  );
}
