import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { AnatomyLayerId } from '../types';

/** Metadata written by scripts/assets/build-anatomy.mjs */
export interface AnatomyStructureMeta {
  id: string;
  name: string;
  layer: AnatomyLayerId;
  system: string;
  fmaId?: string;
  fmaIds?: string[];
  description: string;
  channel?: string;
  derived?: boolean;
  mode: string;
  skin: 'rigid' | 'soft';
  bone?: string;
  cardiac?: boolean;
  bounds: { min: number[]; max: number[] };
}

export interface AnatomyKnot {
  y: number;
  front: number;
  back: number;
  halfWidth: number;
}

export interface AnatomyIndex {
  files: Partial<Record<AnatomyLayerId, string>>;
  landmarks: Record<string, [number, number, number]>;
  knots: Record<'hip' | 'navel' | 'xiphoid' | 'notch', AnatomyKnot>;
  structures: AnatomyStructureMeta[];
}

/** Raw (BodyParts3D-space) geometry of one structure. */
export interface RawStructure {
  meta: AnatomyStructureMeta;
  positions: Float32Array;
  indices: Uint32Array;
  region: Float32Array | null;
}

const BASE = `${import.meta.env?.BASE_URL ?? '/'}assets/anatomy/`;
let indexPromise: Promise<AnatomyIndex> | null = null;
const layerPromises = new Map<AnatomyLayerId, Promise<RawStructure[]>>();

export function loadAnatomyIndex(): Promise<AnatomyIndex> {
  if (!indexPromise) {
    indexPromise = fetch(`${BASE}anatomy-index.json`).then((r) => {
      if (!r.ok) throw new Error('Anatomy index not found — run `npm run assets`.');
      return r.json() as Promise<AnatomyIndex>;
    });
    indexPromise.catch(() => (indexPromise = null));
  }
  return indexPromise;
}

let loader: GLTFLoader | null = null;
function getLoader() {
  if (!loader) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

/** Loads a layer GLB and returns dequantised, world-baked geometry per structure. */
export function loadAnatomyLayer(layer: AnatomyLayerId): Promise<RawStructure[]> {
  let p = layerPromises.get(layer);
  if (!p) {
    p = (async () => {
      const index = await loadAnatomyIndex();
      const file = index.files[layer];
      if (!file) return [];
      const gltf = await getLoader().loadAsync(`${BASE}${file}`);
      const metaById = new Map(index.structures.map((s) => [s.id, s]));
      const out: RawStructure[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const id = mesh.name || mesh.parent?.name || '';
        const meta = metaById.get(id) ?? metaById.get(mesh.parent?.name ?? '');
        if (!meta) return;
        const g = mesh.geometry;
        const pa = g.getAttribute('position');
        const positions = new Float32Array(pa.count * 3);
        const v = new THREE.Vector3();
        for (let i = 0; i < pa.count; i++) {
          v.fromBufferAttribute(pa, i).applyMatrix4(mesh.matrixWorld);
          positions[i * 3] = v.x;
          positions[i * 3 + 1] = v.y;
          positions[i * 3 + 2] = v.z;
        }
        const idx = g.getIndex();
        const indices = idx ? Uint32Array.from(idx.array as ArrayLike<number>) : Uint32Array.from({ length: pa.count }, (_, i) => i);
        const ca = g.getAttribute('color');
        let region: Float32Array | null = null;
        if (ca) {
          region = new Float32Array(ca.count * 3);
          for (let i = 0; i < ca.count; i++) {
            region[i * 3] = ca.getX(i);
            region[i * 3 + 1] = ca.getY(i);
            region[i * 3 + 2] = ca.getZ(i);
          }
        }
        out.push({ meta, positions, indices, region });
        g.dispose();
      });
      return out;
    })();
    p.catch(() => layerPromises.delete(layer));
    layerPromises.set(layer, p);
  }
  return p;
}
