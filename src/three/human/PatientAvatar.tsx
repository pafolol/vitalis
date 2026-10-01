import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type {
  AnatomyLayerId,
  AnatomyLayerSettings,
  AnatomyStructureInfo,
  AvatarVisualState,
  BodyPointerHit,
  BodyShapeParams,
} from '../types';
import { loadHumanAsset, type HumanAsset } from './humanAsset';
import { buildHuman, type HumanRig } from './buildHuman';
import { HumanAnimator } from './animator';
import { AttachmentProps } from './props';
import { ZoneAnchors } from './zones';
import { regionFromId } from './regions';
import { AnatomyLayers } from '../anatomy/AnatomyLayers';

/** World-space layout of the patient on the bed, reported to the scene. */
export interface PatientLayout {
  /** world X of the top of the head (head of bed is towards -X) */
  headTopX: number;
  /** world X of the soles */
  feetX: number;
  /** world X of the hip joint — the backrest hinge */
  hingeX: number;
  /** world Y of the back of the head at rest (pillow top) */
  headBackY: number;
  /** world X of the back of the head */
  headX: number;
  /** half width of the shoulders */
  shoulderHalfWidth: number;
  /** world Y of the mattress top */
  mattressTop: number;
}

export interface PatientAvatarProps {
  body: BodyShapeParams;
  visual: MutableRefObject<AvatarVisualState>;
  layers: AnatomyLayerSettings;
  onBodyPointer?: (hit: BodyPointerHit, e: ThreeEvent<PointerEvent>) => void;
  onSelectStructure?: (info: AnatomyStructureInfo | null) => void;
  selectedStructureId?: string | null;
  isolateLayer?: AnatomyLayerId | null;
  /** World Y of the mattress top (default 0.78) */
  mattressTop?: number;
  /** World X where the hip joint is placed (default 0.15) */
  hipX?: number;
  /** World position the IV line runs to (IV bag spike) */
  ivPoleAnchor?: [number, number, number] | null;
  onRigReady?: (rig: HumanRig | null, layout: PatientLayout | null) => void;
  onError?: (err: Error) => void;
}

let texturePromise: Promise<THREE.Texture | null> | null = null;
function loadEyeTexture(url: string) {
  if (!texturePromise) {
    texturePromise = new THREE.TextureLoader()
      .loadAsync(url)
      .then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        return t;
      })
      .catch(() => null);
  }
  return texturePromise;
}

export function PatientAvatar({
  body,
  visual,
  layers,
  onBodyPointer,
  onSelectStructure,
  selectedStructureId = null,
  isolateLayer = null,
  mattressTop = 0.78,
  hipX = 0.15,
  ivPoleAnchor = null,
  onRigReady,
  onError,
}: PatientAvatarProps) {
  const [asset, setAsset] = useState<{ asset: HumanAsset; eye: THREE.Texture | null } | null>(null);
  const [rig, setRig] = useState<HumanRig | null>(null);
  const animRef = useRef<HumanAnimator | null>(null);
  const propsRef = useRef<AttachmentProps | null>(null);
  const zonesRef = useRef<ZoneAnchors | null>(null);
  const bodyKey = JSON.stringify(body);

  useEffect(() => {
    let alive = true;
    loadHumanAsset()
      .then(async (a) => {
        const eye = await loadEyeTexture(a.eyeTextureUrl);
        if (alive) setAsset({ asset: a, eye });
      })
      .catch((e: Error) => onError?.(e));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build the rig for this body (heavy: once per patient)
  useEffect(() => {
    if (!asset) return;
    const params = JSON.parse(bodyKey) as BodyShapeParams;
    let r: HumanRig;
    try {
      r = buildHuman(asset.asset, params, asset.eye);
    } catch (e) {
      onError?.(e as Error);
      return;
    }
    const anim = new HumanAnimator(r);
    const props = new AttachmentProps(r, mattressTop);
    r.root.add(props.group);
    const zones = new ZoneAnchors(r);
    animRef.current = anim;
    propsRef.current = props;
    zonesRef.current = zones;
    setRig(r);
    if (import.meta.env.DEV) (window as unknown as { __vitalisRig?: HumanRig }).__vitalisRig = r;
    return () => {
      zones.dispose();
      props.dispose();
      r.root.removeFromParent();
      r.dispose();
      animRef.current = null;
      propsRef.current = null;
      zonesRef.current = null;
      setRig(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, bodyKey]);

  // Placement on the bed
  const layout = useMemo<PatientLayout | null>(() => {
    if (!rig) return null;
    const lm = rig.landmarks;
    const s = rig.heightScale;
    const hipY = (lm.boneHead('upperleg01.L').y + lm.boneHead('upperleg01.R').y) / 2;
    const rootX = hipX + s * hipY;
    const rootY = mattressTop - s * lm.backZ - 0.012;
    rig.root.position.set(rootX, rootY, 0);
    animRef.current?.setRestRootPosition(rig.root.position);
    const hinge = lm.boneHead('spine04');
    return {
      headTopX: rootX - s * lm.maxY,
      feetX: rootX - s * lm.minY,
      hingeX: rootX - s * hinge.y,
      headBackY: rootY + s * lm.headBackZ,
      headX: rootX - s * lm.boneHead('head').y,
      shoulderHalfWidth: s * Math.abs(lm.boneHead('upperarm01.L').x) + 0.05,
      mattressTop,
    };
  }, [rig, hipX, mattressTop]);

  useEffect(() => {
    onRigReady?.(rig, layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rig, layout]);

  useEffect(() => {
    propsRef.current?.setIvPoleAnchor(ivPoleAnchor ? new THREE.Vector3(...ivPoleAnchor) : null);
  }, [ivPoleAnchor, rig]);

  // Skin layer: visibility & x-ray translucency
  useEffect(() => {
    if (!rig) return;
    const skinSetting = layers.skin;
    const isolated = isolateLayer && isolateLayer !== 'skin';
    const visible = skinSetting.visible && !isolated;
    const xray = visible && skinSetting.opacity < 0.995;
    const mat = rig.skin.material;
    rig.skin.uniforms.uXray.value = xray ? 1 : 0;
    rig.skin.uniforms.uXrayOpacity.value = skinSetting.opacity;
    if (mat.transparent !== xray) {
      mat.transparent = xray;
      mat.depthWrite = !xray;
      mat.needsUpdate = true;
    }
    rig.body.visible = visible;
    rig.body.castShadow = !xray;
    rig.body.renderOrder = xray ? 10 : 0;
    for (const h of rig.helpers) {
      h.visible = visible && !(xray && h.name === 'shorts' ? skinSetting.opacity < 0.35 : false);
      if (h.name !== 'shorts') h.visible = visible && !xray;
    }
    for (const e of Object.values(rig.eyes)) e.visible = visible;
    for (const h of rig.hairShells) h.visible = visible && !xray;
    // With translucent/hidden skin, clicks go through to anatomy.
    rig.body.raycast = visible && skinSetting.opacity > 0.6 ? THREE.SkinnedMesh.prototype.raycast : () => {};
  }, [rig, layers.skin, isolateLayer]);

  useFrame((state, dt) => {
    const anim = animRef.current;
    if (!anim || !rig) return;
    const vs = visual.current;
    anim.update(vs, dt, state.camera);
    // bleeding wound on the skin (rest-space position)
    const b = vs.attachments.bleeding;
    const u = rig.skin.uniforms;
    if (b && b.intensity > 0) {
      const sp = rig.landmarks.regionPoints[b.region];
      if (sp) u.uWoundPos.value.copy(sp.p);
      u.uWound.value = Math.min(1, b.intensity);
    } else u.uWound.value = 0;
    propsRef.current?.update(vs, THREE.MathUtils.clamp(vs.breathPhase, 0, 1));
  });

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!rig) return;
    const obj = e.object;
    const anatomyInfo = obj.userData?.anatomyInfo as AnatomyStructureInfo | undefined;
    if (anatomyInfo) {
      e.stopPropagation();
      onSelectStructure?.(anatomyInfo);
      return;
    }
    if (obj !== rig.body && !rig.helpers.includes(obj as THREE.SkinnedMesh)) return;
    e.stopPropagation();
    const face = e.face;
    const regionId = face ? rig.region[face.a] : 3;
    const zone = zonesRef.current?.nearest(e.point, rig.heightScale) ?? null;
    onBodyPointer?.(
      {
        region: regionFromId(regionId),
        zone,
        point: [e.point.x, e.point.y, e.point.z],
        screen: [e.nativeEvent.clientX, e.nativeEvent.clientY],
      },
      e,
    );
  };

  if (!rig) return null;
  return (
    <>
      <primitive object={rig.root} onPointerDown={handlePointerDown} />
      <AnatomyLayers
        rig={rig}
        visual={visual}
        layers={layers}
        isolateLayer={isolateLayer}
        selectedStructureId={selectedStructureId}
        onSelectStructure={onSelectStructure}
        onError={onError}
      />
    </>
  );
}

export type { HumanRig };
