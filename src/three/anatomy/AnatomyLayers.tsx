import { useEffect, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type { AnatomyLayerId, AnatomyLayerSettings, AnatomyStructureInfo, AvatarVisualState } from '../types';
import type { HumanRig } from '../human/buildHuman';
import { AnatomyManager } from './manager';

export interface AnatomyLayersProps {
  rig: HumanRig;
  visual: MutableRefObject<AvatarVisualState>;
  layers: AnatomyLayerSettings;
  isolateLayer: AnatomyLayerId | null;
  selectedStructureId: string | null;
  onSelectStructure?: (info: AnatomyStructureInfo | null) => void;
  onError?: (e: Error) => void;
}

/**
 * Anatomy layers for a patient rig. Meshes are created imperatively by
 * AnatomyManager (lazy per layer) and skinned to the patient's skeleton;
 * selection is resolved by PatientAvatar's pointer handler via
 * `mesh.userData.anatomyInfo`.
 */
export function AnatomyLayers({ rig, visual, layers, isolateLayer, selectedStructureId, onError }: AnatomyLayersProps) {
  const mgr = useRef<AnatomyManager | null>(null);

  useEffect(() => {
    const m = new AnatomyManager(rig);
    m.onError = (e) => onError?.(e);
    mgr.current = m;
    if (import.meta.env.DEV) (window as unknown as { __vitalisAnatomy?: AnatomyManager }).__vitalisAnatomy = m;
    return () => {
      m.dispose();
      mgr.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rig]);

  useEffect(() => {
    mgr.current?.setLayers(layers, isolateLayer);
  }, [layers, isolateLayer, rig]);

  useEffect(() => {
    mgr.current?.setSelected(selectedStructureId);
  }, [selectedStructureId, rig]);

  useFrame(() => {
    mgr.current?.update(visual.current);
  });

  return null;
}
