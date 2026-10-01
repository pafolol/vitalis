import { Component, Suspense, useCallback, useEffect, useMemo, useState, type MutableRefObject, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import type {
  AnatomyLayerId,
  AnatomyLayerSettings,
  AnatomyStructureInfo,
  AvatarVisualState,
  BodyPointerHit,
  BodyShapeParams,
  CameraPreset,
} from '../types';
import { PatientAvatar, type PatientLayout } from '../human/PatientAvatar';
import type { HumanRig } from '../human/buildHuman';
import { Bed } from './Bed';
import { ERRoom, IV_BAG_SPIKE } from './ERRoom';
import { CameraRig, computeCameraPresets } from './CameraRig';
import { createRoomMaterials } from './materials';

export type ToolCursor = 'default' | 'pointer' | 'crosshair' | 'stethoscope' | 'palpate' | 'procedure';

export interface ERStageProps {
  body: BodyShapeParams;
  visual: MutableRefObject<AvatarVisualState>;
  layers: AnatomyLayerSettings;
  preset: CameraPreset;
  /** Increment to re-apply the same preset (e.g. clicking "Chest" twice) */
  presetNonce?: number;
  onBodyPointer?: (hit: BodyPointerHit, e: ThreeEvent<PointerEvent>) => void;
  onSelectStructure?: (info: AnatomyStructureInfo | null) => void;
  selectedStructureId?: string | null;
  isolateLayer?: AnatomyLayerId | null;
  toolCursor?: ToolCursor;
  /** Called once the patient has been built and placed */
  onReady?: () => void;
  className?: string;
}

const CURSORS: Record<ToolCursor, string> = {
  default: 'grab',
  pointer: 'pointer',
  crosshair: 'crosshair',
  stethoscope: 'cell',
  palpate: 'pointer',
  procedure: 'crosshair',
};

class StageErrorBoundary extends Component<{ children: ReactNode; onError: (e: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function StageContent(props: ERStageProps & { onLayout: (rig: HumanRig | null, l: PatientLayout | null) => void; onAssetError: (e: Error) => void; layout: PatientLayout | null; rig: HumanRig | null }) {
  const mats = useMemo(() => createRoomMaterials(), []);
  useEffect(() => () => mats.dispose(), [mats]);
  const presets = useMemo(() => computeCameraPresets(props.rig, props.layout), [props.rig, props.layout]);
  const fallbackLayout: PatientLayout = {
    headTopX: -0.8,
    feetX: 0.95,
    hingeX: -0.05,
    headBackY: 0.84,
    headX: -0.7,
    shoulderHalfWidth: 0.22,
    mattressTop: 0.78,
  };
  return (
    <>
      <ERRoom mats={mats} visual={props.visual} />
      <Bed mats={mats} layout={props.layout ?? fallbackLayout} rig={props.rig} visual={props.visual} />
      <PatientAvatar
        body={props.body}
        visual={props.visual}
        layers={props.layers}
        onBodyPointer={props.onBodyPointer}
        onSelectStructure={props.onSelectStructure}
        selectedStructureId={props.selectedStructureId}
        isolateLayer={props.isolateLayer}
        mattressTop={0.78}
        hipX={0.04}
        ivPoleAnchor={IV_BAG_SPIKE}
        onRigReady={props.onLayout}
        onError={props.onAssetError}
      />
      <CameraRig presets={presets} preset={props.preset} presetNonce={props.presetNonce ?? 0} />
    </>
  );
}

/**
 * The emergency-room stage: room, stretcher, patient (with anatomy layers and
 * equipment) and camera. Drop-in component for the application.
 */
export function ERStage(props: ERStageProps) {
  const [rig, setRig] = useState<HumanRig | null>(null);
  const [layout, setLayout] = useState<PatientLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { onReady } = props;

  const onLayout = useCallback(
    (r: HumanRig | null, l: PatientLayout | null) => {
      setRig(r);
      setLayout(l);
      if (r && l) onReady?.();
    },
    [onReady],
  );
  const onAssetError = useCallback((e: Error) => setError(e.message || 'Failed to load the 3D patient'), []);

  return (
    <div className={props.className} style={{ position: 'relative', width: '100%', height: '100%', cursor: CURSORS[props.toolCursor ?? 'default'] }} data-testid="er-stage">
      <Canvas
        shadows="soft"
        dpr={[1, 2]}
        camera={{ fov: 32, near: 0.02, far: 40, position: [1.2, 2, 2.4] }}
        gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false }}
        onPointerMissed={() => props.onSelectStructure?.(null)}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.AgXToneMapping;
          gl.toneMappingExposure = 1.05;
        }}
      >
        <StageErrorBoundary onError={(e) => setError(e.message)}>
          <Suspense fallback={null}>
            <StageContent {...props} onLayout={onLayout} onAssetError={onAssetError} layout={layout} rig={rig} />
          </Suspense>
        </StageErrorBoundary>
      </Canvas>
      {!rig && !error && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }} data-testid="er-stage-loading">
          <div style={{ padding: '10px 16px', borderRadius: 8, background: 'rgba(15,20,26,0.72)', color: '#dfe7ec', font: '500 13px system-ui, sans-serif', letterSpacing: 0.2 }}>
            Preparing patient…
          </div>
        </div>
      )}
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }} data-testid="er-stage-error">
          <div style={{ maxWidth: 420, padding: '14px 18px', borderRadius: 10, background: 'rgba(40,12,12,0.85)', color: '#ffe3e3', font: '13px system-ui, sans-serif', lineHeight: 1.5 }}>
            <strong>3D patient unavailable.</strong>
            <div style={{ opacity: 0.85, marginTop: 4 }}>{error}</div>
            <div style={{ opacity: 0.7, marginTop: 6 }}>The simulation continues to run; monitors and panels remain fully functional.</div>
          </div>
        </div>
      )}
    </div>
  );
}
