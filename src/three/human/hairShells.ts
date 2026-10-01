import * as THREE from 'three';
import { HAIR_UNIFORMS_GLSL, SKIN_NOISE_GLSL, type SkinUniforms } from './skinMaterial';

/**
 * Short scalp hair rendered as stacked shells (fur-shell technique): copies of
 * the scalp surface offset along the normal, alpha-tested against a strand
 * pattern. The coverage uses exactly the same hairline function as the skin
 * shader so shells and painted hair agree.
 */
export function createHairShells(body: THREE.SkinnedMesh, skin: SkinUniforms, opts: { layers: number; lengthM: number }) {
  const g = body.geometry;
  const idx = g.getIndex()!.array as Uint32Array;
  const maskA = g.getAttribute('masksA') as THREE.BufferAttribute;
  const keep: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (Math.max(maskA.getX(a), maskA.getX(b), maskA.getX(c)) > 0.02) keep.push(a, b, c);
  }
  // compact
  const map = new Map<number, number>();
  const src: number[] = [];
  const index = keep.map((v) => {
    let m = map.get(v);
    if (m === undefined) {
      m = src.length;
      map.set(v, m);
      src.push(v);
    }
    return m;
  });
  const shellGeo = new THREE.BufferGeometry();
  const copy = (name: string, size: number, Ctor: typeof Float32Array | typeof Uint16Array) => {
    const s = g.getAttribute(name) as THREE.BufferAttribute;
    const arr = new Ctor(src.length * size);
    src.forEach((v, i) => {
      for (let k = 0; k < size; k++) arr[i * size + k] = s.array[v * size + k];
    });
    shellGeo.setAttribute(name, new THREE.BufferAttribute(arr, size));
  };
  copy('position', 3, Float32Array);
  copy('normal', 3, Float32Array);
  copy('skinIndex', 4, Uint16Array);
  copy('skinWeight', 4, Float32Array);
  shellGeo.setIndex(index);
  shellGeo.computeBoundingSphere();

  const meshes: THREE.SkinnedMesh[] = [];
  const mats: THREE.Material[] = [];
  for (let i = 0; i < opts.layers; i++) {
    const f = (i + 1) / opts.layers;
    const uShell = { value: opts.lengthM * f };
    const uFrac = { value: f };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, skin, { uShell, uFrac });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uShell;\nvarying vec3 vObjPos;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\nvObjPos = position;\ntransformed += objectNormal * uShell;`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\n${HAIR_UNIFORMS_GLSL}\nuniform float uFrac;\nvarying vec3 vObjPos;\n${SKIN_NOISE_GLSL}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  float cover = vh_hairCover(vObjPos);
  // strands: high-frequency cells; each strand survives up to a random height
  vec2 cell = vh_cells(vObjPos * 1400.0);
  float strandH = vh_hash(floor(vObjPos * 1400.0) + 3.7);
  float inStrand = 1.0 - smoothstep(0.28, 0.42, cell.x);
  float alive = step(uFrac, strandH * 1.15) * inStrand * step(0.35 + uFrac * 0.3, cover);
  if (alive < 0.5) discard;
  vec3 c = uHairColor * mix(0.55, 1.15, uFrac) * (0.8 + 0.4 * strandH);
  diffuseColor.rgb = c;
}`,
        );
    };
    mat.customProgramCacheKey = () => 'vitalis-hair-shell-v1';
    const m = new THREE.SkinnedMesh(shellGeo, mat);
    m.name = `hair-shell-${i}`;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = true;
    m.raycast = () => {};
    m.bindMode = body.bindMode;
    meshes.push(m);
    mats.push(mat);
  }
  return {
    meshes,
    dispose() {
      shellGeo.dispose();
      mats.forEach((m) => m.dispose());
    },
  };
}
