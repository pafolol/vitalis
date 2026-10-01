import * as THREE from 'three';
import type { AnatomyStructureMeta } from './anatomyAsset';

/** Anatomy-atlas palette (sRGB). */
export interface AnatomyPalette {
  color: string;
  roughness: number;
  opacity?: number;
  sheen?: number;
  clearcoat?: number;
  doubleSided?: boolean;
}

export function paletteFor(meta: AnatomyStructureMeta): AnatomyPalette {
  const id = meta.id;
  if (meta.layer === 'skeleton') {
    if (id.includes('disc') || id.includes('cartilage')) return { color: '#b9ccd3', roughness: 0.45, clearcoat: 0.3 };
    return { color: '#e6dcc3', roughness: 0.62 };
  }
  if (meta.layer === 'muscle') return { color: '#9a2f2c', roughness: 0.55, sheen: 0.5, doubleSided: true };
  if (id === 'heart') return { color: '#a83a30', roughness: 0.45, clearcoat: 0.4 };
  if (id.startsWith('lung')) return { color: '#e7a6a3', roughness: 0.6, opacity: 0.55, sheen: 0.4 };
  if (id === 'diaphragm') return { color: '#9e3b35', roughness: 0.55, sheen: 0.4, opacity: 0.85, doubleSided: true };
  if (id === 'pulmonary-arteries') return { color: '#3f63b5', roughness: 0.4, clearcoat: 0.4 };
  if (id === 'pulmonary-veins') return { color: '#c9433a', roughness: 0.4, clearcoat: 0.4 };
  if (meta.channel === 'veins') return { color: '#3552a3', roughness: 0.42, clearcoat: 0.4 };
  if (meta.channel === 'arteries' || meta.channel === 'coronary') return { color: '#c8322c', roughness: 0.4, clearcoat: 0.4 };
  if (meta.channel === 'airways') return { color: '#e8cbb6', roughness: 0.5 };
  if (id === 'liver') return { color: '#7b2f27', roughness: 0.4, clearcoat: 0.5 };
  if (id === 'gallbladder') return { color: '#4f7a3c', roughness: 0.35, clearcoat: 0.5 };
  if (id === 'pancreas') return { color: '#e3c07d', roughness: 0.6 };
  if (['colon', 'rectum', 'appendix'].includes(id)) return { color: '#c98276', roughness: 0.45, clearcoat: 0.4 };
  if (meta.layer === 'digestive') return { color: '#dc9f90', roughness: 0.45, clearcoat: 0.4 };
  if (id === 'spinal-cord') return { color: '#f0d58e', roughness: 0.5 };
  if (id === 'cerebellum') return { color: '#d8aea3', roughness: 0.55 };
  if (meta.layer === 'nervous') return { color: '#e5c4b9', roughness: 0.55, sheen: 0.3 };
  if (id.startsWith('kidney')) return { color: '#8c3a2f', roughness: 0.4, clearcoat: 0.4 };
  if (id === 'ureters') return { color: '#e3c07d', roughness: 0.5 };
  if (id === 'bladder') return { color: '#d9a08c', roughness: 0.45 };
  if (id === 'adrenals') return { color: '#d9a441', roughness: 0.5 };
  if (meta.layer === 'superficial') {
    if (meta.system === 'Fascia') return { color: '#ddd6c6', roughness: 0.5, opacity: 0.8, doubleSided: true };
    return { color: meta.channel === 'arteries' ? '#c8322c' : '#3a58ab', roughness: 0.42, clearcoat: 0.3 };
  }
  return { color: '#d4a898', roughness: 0.5 };
}

export interface AnatomyUniforms {
  uCenter: { value: THREE.Vector3 };
  uScale: { value: THREE.Vector3 };
  uOffset: { value: THREE.Vector3 };
  uTint: { value: THREE.Color };
  uTintAmt: { value: number };
  uIsch: { value: number };
  uHighlight: { value: number };
}

/**
 * Physical material with state-driven deformation (heart beat, lung
 * inflation/collapse, diaphragm descent — applied in bind space before
 * skinning) and physiology tints (ischaemia, desaturation, hypoperfusion).
 */
export function createAnatomyMaterial(p: AnatomyPalette, hasRegion: boolean, layerOf = '') {
  const uniforms: AnatomyUniforms = {
    uCenter: { value: new THREE.Vector3() },
    uScale: { value: new THREE.Vector3(1, 1, 1) },
    uOffset: { value: new THREE.Vector3() },
    uTint: { value: new THREE.Color(0, 0, 0) },
    uTintAmt: { value: 0 },
    uIsch: { value: 0 },
    uHighlight: { value: 0 },
  };
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.color),
    roughness: p.roughness,
    metalness: 0,
    sheen: p.sheen ?? 0,
    sheenColor: new THREE.Color(p.color).lerp(new THREE.Color(1, 1, 1), 0.4),
    clearcoat: p.clearcoat ?? 0,
    clearcoatRoughness: 0.3,
    transparent: (p.opacity ?? 1) < 1,
    opacity: p.opacity ?? 1,
    depthWrite: (p.opacity ?? 1) > 0.6,
    side: p.doubleSided || /cardiovascular|superficial/.test(layerOf) ? THREE.DoubleSide : THREE.FrontSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uCenter;
uniform vec3 uScale;
uniform vec3 uOffset;
${hasRegion ? 'attribute vec3 region;\nvarying vec3 vRegion;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
transformed = uCenter + (transformed - uCenter) * uScale + uOffset;
${hasRegion ? 'vRegion = region;' : ''}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uTint;
uniform float uTintAmt;
uniform float uIsch;
uniform float uHighlight;
${hasRegion ? 'varying vec3 vRegion;' : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, uTint, uTintAmt);
${
  hasRegion
    ? `// heart: slightly darker right heart, pale atria; ischaemic LV turns dusky
diffuseColor.rgb *= mix(vec3(1.0), vec3(0.85, 0.78, 0.8), vRegion.g);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 0.95, 0.95), vRegion.b * 0.6);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.16, 0.3), clamp(uIsch, 0.0, 1.0) * vRegion.r * 0.8);`
    : ''
}
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.25, 0.8, 1.0), uHighlight * 0.45);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.05, 0.18, 0.25) * uHighlight;`,
      );
  };
  material.customProgramCacheKey = () => `vitalis-anatomy-${hasRegion ? 'r' : 'n'}`;
  return { material, uniforms };
}
