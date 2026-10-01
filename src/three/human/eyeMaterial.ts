import * as THREE from 'three';
import type { HumanAssetMeta } from './humanAsset';

export interface EyeUniforms {
  uPupilFrac: { value: number };
  uIrisA: { value: THREE.Vector2 };
  uIrisB: { value: THREE.Vector2 };
  uIrisR: { value: number };
  uPupilTexR: { value: number };
  uScleraTint: { value: THREE.Color };
  uIrisTint: { value: THREE.Color };
}

/**
 * Eyeball material using the CC0 MakeHuman iris texture. Pupil diameter is
 * driven procedurally by radially re-mapping the iris texture coordinates, so
 * miosis/mydriasis from the simulation are visible without extra textures.
 */
export function createEyeMaterials(texture: THREE.Texture | null, eyes: HumanAssetMeta['eyes']) {
  const uniforms: EyeUniforms = {
    uPupilFrac: { value: 4 / 11.5 },
    uIrisA: { value: new THREE.Vector2(...eyes.irisUv[0]) },
    uIrisB: { value: new THREE.Vector2(...eyes.irisUv[1]) },
    uIrisR: { value: eyes.irisRadiusUv },
    uPupilTexR: { value: eyes.pupilRadiusUv },
    uScleraTint: { value: new THREE.Color(1, 1, 1) },
    uIrisTint: { value: new THREE.Color(0.55, 0.5, 0.42) },
  };
  const eyeball = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: texture,
    roughness: 0.25,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    specularIntensity: 0.6,
  });
  eyeball.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uPupilFrac;
uniform vec2 uIrisA;
uniform vec2 uIrisB;
uniform float uIrisR;
uniform float uPupilTexR;
uniform vec3 uScleraTint;
uniform vec3 uIrisTint;
vec2 vitalisPupil(vec2 uv, vec2 c) {
  vec2 d = uv - c;
  float r = length(d);
  if (r >= uIrisR || r < 1e-5) return uv;
  float rpNew = clamp(uPupilFrac, 0.1, 0.8) * uIrisR;
  float rs = r < rpNew ? r * uPupilTexR / rpNew : uPupilTexR + (r - rpNew) * (uIrisR - uPupilTexR) / (uIrisR - rpNew);
  return c + d / r * rs;
}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#ifdef USE_MAP
  vec2 euv = vMapUv;
  euv = distance(euv, uIrisA) < uIrisR ? vitalisPupil(euv, uIrisA) : euv;
  euv = distance(euv, uIrisB) < uIrisR ? vitalisPupil(euv, uIrisB) : euv;
  vec4 sampledDiffuseColor = texture2D( map, euv );
  diffuseColor *= sampledDiffuseColor;
  float irisDist = min(distance(vMapUv, uIrisA), distance(vMapUv, uIrisB));
  diffuseColor.rgb *= mix(vec3(1.0), uScleraTint, smoothstep(uIrisR, uIrisR * 1.15, irisDist));
  diffuseColor.rgb *= mix(uIrisTint, vec3(1.0), smoothstep(uIrisR * 0.95, uIrisR * 1.05, irisDist));
#endif`,
      );
  };
  eyeball.customProgramCacheKey = () => 'vitalis-eye-v1';

  const cornea = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.02,
    metalness: 0,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    clearcoat: 1,
    clearcoatRoughness: 0.0,
    ior: 1.376,
    specularIntensity: 1,
  });
  return { eyeball, cornea, uniforms };
}
