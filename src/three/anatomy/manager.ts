import * as THREE from 'three';
import type { AnatomyLayerId, AnatomyLayerSettings, AnatomyStructureInfo, AvatarVisualState } from '../types';
import type { HumanRig } from '../human/buildHuman';
import { loadAnatomyIndex, loadAnatomyLayer, type AnatomyIndex, type RawStructure } from './anatomyAsset';
import { AnatomyFitter } from './fit';
import { createAnatomyMaterial, paletteFor, type AnatomyUniforms } from './materials';

/**
 * Owns the anatomy meshes of one patient rig: lazy per-layer loading, fitting
 * to the patient, skinning to the patient's skeleton, visibility/opacity,
 * selection and physiology overlays. Entirely imperative (no React state).
 */

interface Built {
  mesh: THREE.SkinnedMesh;
  info: AnatomyStructureInfo;
  channel?: string;
  uniforms: AnatomyUniforms;
  material: THREE.MeshPhysicalMaterial;
  center: THREE.Vector3;
  min: THREE.Vector3;
  max: THREE.Vector3;
  baseOpacity: number;
  layer: AnatomyLayerId;
  side: 'l' | 'r' | null;
  cardiac: boolean;
}

const noRaycast = () => {};

export class AnatomyManager {
  private rig: HumanRig;
  private index: AnatomyIndex | null = null;
  private fitter: AnatomyFitter | null = null;
  private built = new Map<AnatomyLayerId, Built[]>();
  private loading = new Set<AnatomyLayerId>();
  private layers: AnatomyLayerSettings | null = null;
  private isolate: AnatomyLayerId | null = null;
  private selected: string | null = null;
  private disposed = false;
  private hash: Map<string, number[]> | null = null;
  private heartCenter = new THREE.Vector3();
  onError: ((e: Error) => void) | null = null;

  constructor(rig: HumanRig) {
    this.rig = rig;
  }

  private async ensureIndex() {
    if (!this.index) {
      this.index = await loadAnatomyIndex();
      this.fitter = new AnatomyFitter(this.rig, this.index);
    }
    return this.index;
  }

  setLayers(layers: AnatomyLayerSettings, isolate: AnatomyLayerId | null) {
    this.layers = layers;
    this.isolate = isolate;
    for (const id of Object.keys(layers) as AnatomyLayerId[]) {
      if (id === 'skin') continue;
      if (this.isLayerVisible(id) && !this.built.has(id) && !this.loading.has(id)) void this.load(id);
    }
    this.applyVisibility();
  }

  setSelected(id: string | null) {
    this.selected = id;
    for (const list of this.built.values()) for (const b of list) b.uniforms.uHighlight.value = b.info.id === id ? 1 : 0;
  }

  private isLayerVisible(id: AnatomyLayerId) {
    if (!this.layers) return false;
    if (this.isolate) return id === this.isolate;
    return this.layers[id]?.visible ?? false;
  }

  private applyVisibility() {
    if (!this.layers) return;
    for (const [layer, list] of this.built) {
      const vis = this.isLayerVisible(layer);
      const op = THREE.MathUtils.clamp(this.layers[layer]?.opacity ?? 1, 0, 1);
      for (const b of list) {
        b.mesh.visible = vis && op > 0.01;
        const opacity = b.baseOpacity * op;
        const transparent = opacity < 0.999;
        if (b.material.transparent !== transparent) {
          b.material.transparent = transparent;
          b.material.needsUpdate = true;
        }
        b.material.opacity = opacity;
        b.material.depthWrite = opacity > 0.6;
        b.mesh.renderOrder = transparent ? 5 : 0;
      }
    }
  }

  // ---------------------------------------------------------------- building
  private buildHash() {
    if (this.hash) return this.hash;
    const pos = this.rig.body.geometry.getAttribute('position') as THREE.BufferAttribute;
    const h = new Map<string, number[]>();
    const c = 0.03;
    for (let i = 0; i < pos.count; i++) {
      const k = `${Math.floor(pos.getX(i) / c)},${Math.floor(pos.getY(i) / c)},${Math.floor(pos.getZ(i) / c)}`;
      let l = h.get(k);
      if (!l) h.set(k, (l = []));
      l.push(i);
    }
    this.hash = h;
    return h;
  }

  private nearestBodyVertex(p: THREE.Vector3) {
    const h = this.buildHash();
    const pos = this.rig.body.geometry.getAttribute('position') as THREE.BufferAttribute;
    const c = 0.03;
    const cx = Math.floor(p.x / c);
    const cy = Math.floor(p.y / c);
    const cz = Math.floor(p.z / c);
    let best = 0;
    let bestD = Infinity;
    for (let r = 0; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const l = h.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!l) continue;
            for (const i of l) {
              const d = (pos.getX(i) - p.x) ** 2 + (pos.getY(i) - p.y) ** 2 + (pos.getZ(i) - p.z) ** 2;
              if (d < bestD) {
                bestD = d;
                best = i;
              }
            }
          }
      if (bestD < ((r + 1) * c) ** 2) break;
    }
    return best;
  }

  private async load(layer: AnatomyLayerId) {
    this.loading.add(layer);
    try {
      await this.ensureIndex();
      const raws = await loadAnatomyLayer(layer);
      if (this.disposed) return;
      const list: Built[] = [];
      for (const raw of raws) {
        try {
          const b = this.buildStructure(raw);
          if (b.info.id === 'heart') this.heartCenter.copy(b.center);
          list.push(b);
        } catch (e) {
          console.warn(`anatomy: failed to fit ${raw.meta.id}`, e);
        }
      }
      this.built.set(layer, list);
      if (layer === 'cardiovascular') {
        const heart = list.find((b) => b.info.id === 'heart');
        if (heart) this.heartCenter.copy(heart.center);
        for (const b of list) if (b.cardiac) b.uniforms.uCenter.value.copy(this.heartCenter);
      }
      this.applyVisibility();
      this.setSelected(this.selected);
    } catch (e) {
      this.onError?.(e as Error);
    } finally {
      this.loading.delete(layer);
    }
  }

  private mapPoint(mode: string, p: THREE.Vector3, custom: string | null, out: THREE.Vector3) {
    const f = this.fitter!;
    if (custom) return f.mapSegment(custom, p, out);
    if (mode === 'head') return f.mapHead(p, out);
    if (mode === 'neck') return f.mapNeck(p, out);
    if (mode.startsWith('seg:')) return f.mapSegment(mode.slice(4), p, out);
    if (mode.startsWith('limb:')) {
      const s = mode.slice(5);
      if (s === 'L' || s === 'R') return f.mapLimb(p, [`upperArm${s}`, `forearm${s}`, `hand${s}`], `upperArm${s}`, out);
      const side = s[0];
      return f.mapLimb(p, [`thigh${side}`, `leg${side}`, `foot${side}`], `thigh${side}`, out);
    }
    return f.mapTrunk(p, out);
  }

  private buildStructure(raw: RawStructure): Built {
    const f = this.fitter!;
    const meta = raw.meta;
    const n = raw.positions.length / 3;
    const src = new THREE.Vector3();
    const dst = new THREE.Vector3();

    // phalanges: per-bone segment between the element's proximal/distal extremes
    let custom: string | null = null;
    if (meta.mode.startsWith('seg:finger')) {
      const bone = meta.mode.slice(4);
      const side = bone.endsWith('.L') ? 'L' : 'R';
      const hand = f.segments[`hand${side}`];
      const axis = hand.bpB.clone().sub(hand.bpA).normalize();
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const t = src.fromArray(raw.positions, i * 3).dot(axis);
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      let na = 0;
      let nb = 0;
      const band = (hi - lo) * 0.12;
      for (let i = 0; i < n; i++) {
        src.fromArray(raw.positions, i * 3);
        const t = src.dot(axis);
        if (t < lo + band) {
          a.add(src);
          na++;
        } else if (t > hi - band) {
          b.add(src);
          nb++;
        }
      }
      a.multiplyScalar(1 / Math.max(1, na));
      b.multiplyScalar(1 / Math.max(1, nb));
      custom = f.addCustomSegment(`custom:${meta.id}`, a, b, this.rig.landmarks.boneHead(bone), this.rig.landmarks.boneTail(bone), bone);
    }

    const pos = new Float32Array(n * 3);
    const cen = new THREE.Vector3();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < n; i++) {
      src.fromArray(raw.positions, i * 3);
      this.mapPoint(meta.mode, src, custom, dst);
      dst.toArray(pos, i * 3);
      cen.add(dst);
      min.min(dst);
      max.max(dst);
    }
    cen.multiplyScalar(1 / n);
    // coronary vessels lie on the epicardium; the derived myocardium is a little
    // thicker than reality, so lift them just outside it
    if (meta.cardiac && meta.id !== 'heart' && this.heartCenter.lengthSq() > 0) {
      for (let i = 0; i < n; i++) {
        dst.fromArray(pos, i * 3).sub(this.heartCenter).multiplyScalar(1.08).add(this.heartCenter);
        dst.toArray(pos, i * 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(raw.indices, 1));
    geo.computeVertexNormals();
    if (raw.region) geo.setAttribute('region', new THREE.BufferAttribute(raw.region, 3));

    // skinning
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const boneIndex = (name: string) => this.rig.skeleton.bones.findIndex((b) => b.name === name);
    if (meta.skin === 'soft') {
      const bi = this.rig.body.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
      const bw = this.rig.body.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
      for (let i = 0; i < n; i++) {
        const j = this.nearestBodyVertex(dst.fromArray(pos, i * 3));
        for (let k = 0; k < 4; k++) {
          si[i * 4 + k] = bi.getComponent(j, k);
          sw[i * 4 + k] = bw.getComponent(j, k);
        }
      }
    } else {
      let bone = meta.bone;
      if (!bone) {
        if (custom) bone = f.segments[custom].bone;
        else if (meta.mode.startsWith('seg:')) bone = f.segments[meta.mode.slice(4)]?.bone;
        else if (meta.mode === 'head') bone = 'head';
        else if (meta.mode === 'neck') bone = 'neck02';
        else bone = f.spineBoneAt(cen.y);
      }
      const b = Math.max(0, boneIndex(bone ?? 'spine03'));
      for (let i = 0; i < n; i++) {
        si[i * 4] = b;
        sw[i * 4] = 1;
      }
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    geo.computeBoundingSphere();

    const pal = paletteFor(meta);
    const { material, uniforms } = createAnatomyMaterial(pal, !!raw.region, meta.id === 'heart' ? '' : meta.layer);
    uniforms.uCenter.value.copy(cen);
    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.name = `anatomy:${meta.id}`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    const info: AnatomyStructureInfo = { id: meta.id, name: meta.name, layer: meta.layer, system: meta.system, fmaId: meta.fmaId ?? meta.fmaIds?.[0], description: meta.description };
    mesh.userData.anatomyId = meta.id;
    mesh.userData.anatomyInfo = info;
    // hidden meshes must not intercept pointer rays
    mesh.raycast = function (this: THREE.SkinnedMesh, rc: THREE.Raycaster, hits: THREE.Intersection[]) {
      if (!this.visible) return;
      THREE.SkinnedMesh.prototype.raycast.call(this, rc, hits);
    } as THREE.SkinnedMesh['raycast'];
    this.rig.frame.add(mesh);
    mesh.bind(this.rig.skeleton, this.rig.body.bindMatrix);
    mesh.visible = false;
    const side = /-l$/.test(meta.id) ? 'l' : /-r$/.test(meta.id) ? 'r' : null;
    return {
      mesh,
      info,
      channel: meta.channel,
      uniforms,
      material,
      center: cen,
      min,
      max,
      baseOpacity: pal.opacity ?? 1,
      layer: meta.layer,
      side,
      cardiac: !!meta.cardiac,
    };
  }

  // ---------------------------------------------------------------- per frame
  update(vs: AvatarVisualState) {
    const an = vs.anatomy;
    const p = vs.cardiacPhase;
    const systole = p < 0.38 ? Math.sin((p / 0.38) * Math.PI) : 0;
    const beat = 1 - 0.05 * systole * THREE.MathUtils.clamp(an.cardiacContractility, 0, 1.3);
    const v = THREE.MathUtils.clamp(vs.breathPhase, 0, 1) * Math.max(0, vs.breathDepth);
    const satTint = THREE.MathUtils.clamp((0.97 - an.arterialSat) * 3.5, 0, 0.85);
    for (const [, list] of this.built) {
      for (const b of list) {
        if (!b.mesh.visible) continue;
        const u = b.uniforms;
        u.uTintAmt.value = 0;
        u.uScale.value.set(1, 1, 1);
        u.uOffset.value.set(0, 0, 0);
        if (b.cardiac) u.uScale.value.setScalar(beat);
        if (b.info.id === 'heart') u.uIsch.value = an.myocardialIschaemia;
        const lungSide = b.info.id === 'lung-l' || b.info.id === 'bronchial-tree-l' ? 'l' : b.info.id === 'lung-r' || b.info.id === 'bronchial-tree-r' ? 'r' : null;
        if (lungSide) {
          const inf = THREE.MathUtils.clamp(lungSide === 'l' ? an.lungInflationLeft : an.lungInflationRight, 0, 1.2);
          const collapse = 0.3 + 0.7 * inf;
          const breath = 1 + 0.035 * v * inf;
          u.uScale.value.set(collapse * breath, collapse * (1 + 0.06 * v * inf), collapse * breath);
          // pivot at the hilum: medial, upper third of the lung
          const c = u.uCenter.value;
          c.set(b.center.x * 0.35, b.max.y - (b.max.y - b.min.y) * 0.38, b.center.z);
          if (b.info.id.startsWith('lung')) {
            u.uTint.value.setRGB(0.55, 0.12, 0.18);
            u.uTintAmt.value = 0.65 * an.lungOedema;
          }
        }
        switch (b.channel) {
          case 'airways':
            u.uTint.value.setRGB(0.95, 0.5, 0.15);
            u.uTintAmt.value = Math.max(u.uTintAmt.value, 0.6 * an.bronchospasm);
            break;
          case 'diaphragm':
            u.uOffset.value.set(0, -0.02 * v, 0);
            break;
          case 'arteries':
          case 'coronary':
          case 'pulmonaryVeins':
            u.uTint.value.setRGB(0.32, 0.08, 0.28);
            u.uTintAmt.value = satTint;
            break;
          case 'brain':
          case 'brainstem':
            u.uTint.value.setRGB(0.42, 0.48, 0.62);
            u.uTintAmt.value = THREE.MathUtils.clamp((1 - an.brainPerfusion) * 0.9, 0, 0.9);
            break;
          case 'kidney':
            u.uTint.value.setRGB(0.3, 0.24, 0.32);
            u.uTintAmt.value = THREE.MathUtils.clamp((1 - an.renalPerfusion) * 0.8, 0, 0.8);
            break;
          case 'liver':
            u.uTint.value.setRGB(0.3, 0.24, 0.3);
            u.uTintAmt.value = THREE.MathUtils.clamp((1 - an.splanchnicPerfusion) * 0.7, 0, 0.7);
            break;
        }
      }
    }
  }

  /** Structures currently loaded (for UI lists). */
  structures(): AnatomyStructureInfo[] {
    return [...this.built.values()].flat().map((b) => b.info);
  }

  /** World-space centre of a structure (for camera focus). */
  structureCenter(id: string, out = new THREE.Vector3()) {
    for (const list of this.built.values())
      for (const b of list)
        if (b.info.id === id) {
          b.mesh.updateWorldMatrix(true, false);
          return out.copy(b.center).applyMatrix4(b.mesh.matrixWorld);
        }
    return null;
  }

  dispose() {
    this.disposed = true;
    for (const list of this.built.values())
      for (const b of list) {
        b.mesh.removeFromParent();
        b.mesh.geometry.dispose();
        b.material.dispose();
        b.mesh.raycast = noRaycast;
      }
    this.built.clear();
  }
}
