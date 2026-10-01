import * as THREE from 'three';

/**
 * Physically-based skin material with procedural micro detail and
 * physiology-driven appearance (pallor, cyanosis, flushing, urticaria,
 * mottling, diaphoresis, bleeding).
 *
 * No photographic skin texture is used (none with a suitable licence was
 * available). Albedo variation, hair, brows, lips, areolae and stubble are
 * generated per fragment from patient-specific landmark positions (rest
 * space, so they follow skinning) plus coarse per-vertex masks computed by
 * scripts/assets/build-human.mjs.
 */

export interface SkinLandmarkUniforms {
  eyeL: THREE.Vector3;
  eyeR: THREE.Vector3;
  mouth: THREE.Vector3;
  nippleL: THREE.Vector3;
  nippleR: THREE.Vector3;
  earL: THREE.Vector3;
  earR: THREE.Vector3;
  headCenter: THREE.Vector3;
  browY: number;
  hipL: THREE.Vector3;
  hipR: THREE.Vector3;
  kneeL: THREE.Vector3;
  kneeR: THREE.Vector3;
  waistY: number;
}

export interface SkinUniforms {
  uSkinBase: { value: THREE.Color };
  uSkinTone: { value: number };
  uHairColor: { value: THREE.Color };
  uHairDensity: { value: number };
  uRecession: { value: number };
  uBeard: { value: number };
  uFemale: { value: number };
  uAge: { value: number };
  uPallor: { value: number };
  uCyanC: { value: number };
  uCyanP: { value: number };
  uFlush: { value: number };
  uUrticaria: { value: number };
  uMottling: { value: number };
  uDiaphoresis: { value: number };
  uXray: { value: number };
  uXrayOpacity: { value: number };
  uSSSWrap: { value: number };
  uSSSColor: { value: THREE.Color };
  uHighlight: { value: number };
  uWoundPos: { value: THREE.Vector3 };
  uWound: { value: number };
  uEyeL: { value: THREE.Vector3 };
  uEyeR: { value: THREE.Vector3 };
  uMouth: { value: THREE.Vector3 };
  uNippleL: { value: THREE.Vector3 };
  uNippleR: { value: THREE.Vector3 };
  uEarL: { value: THREE.Vector3 };
  uEarR: { value: THREE.Vector3 };
  uHeadC: { value: THREE.Vector3 };
  uBrowY: { value: number };
  uHipL: { value: THREE.Vector3 };
  uHipR: { value: THREE.Vector3 };
  uKneeL: { value: THREE.Vector3 };
  uKneeR: { value: THREE.Vector3 };
  uWaistY: { value: number };
  uGarment: { value: THREE.Color };
}

const NOISE = /* glsl */ `
float vh_hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vh_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vh_hash(i + vec3(0,0,0)), vh_hash(i + vec3(1,0,0)), f.x),
                 mix(vh_hash(i + vec3(0,1,0)), vh_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(vh_hash(i + vec3(0,0,1)), vh_hash(i + vec3(1,0,1)), f.x),
                 mix(vh_hash(i + vec3(0,1,1)), vh_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// band-limited noise: fades to its mean when the pattern is finer than a pixel
float vh_aa(vec3 p) {
  float fw = length(fwidth(p));
  return mix(vh_noise(p), 0.5, smoothstep(0.35, 0.9, fw));
}
float vh_fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vh_noise(p); p *= 2.03; a *= 0.5; }
  return s;
}
vec2 vh_cells(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = vec3(vh_hash(i + g), vh_hash(i + g + 17.3), vh_hash(i + g + 41.9));
    vec3 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return vec2(sqrt(d1), sqrt(d2) - sqrt(d1));
}
// scalp hair coverage (0..1) at rest-space position P
float vh_hairCover(vec3 P) {
  float eyeY = 0.5 * (uEyeL.y + uEyeR.y);
  vec3 q = P - uHeadC;
  float ang = atan(q.x, q.z);
  float c = cos(ang);
  float front = uBrowY + 0.04 + uRecession * 0.02 * smoothstep(0.25, 0.7, abs(ang)) * (1.0 - smoothstep(0.9, 1.3, abs(ang)));
  float side = eyeY + 0.028;
  float back = eyeY - 0.085;
  float hl = c >= 0.0 ? mix(side, front, pow(c, 1.3)) : mix(side, back, pow(-c, 1.1));
  float edgeN = (vh_fbm(P * 160.0) - 0.5) * 0.008;
  float hair = smoothstep(hl - 0.003, hl + 0.006, P.y + edgeN);
  float earD = min(length(P - uEarL), length(P - uEarR));
  hair *= smoothstep(0.022, 0.034, earD);
  float lateral = abs(P.x) / max(abs(uEarL.x), 0.05);
  float sideburn = step(0.84, lateral) * smoothstep(eyeY - 0.02, eyeY - 0.008, P.y) * (1.0 - smoothstep(eyeY + 0.02, eyeY + 0.03, P.y))
      * step(uEarL.z - 0.002, P.z) * (1.0 - step(uEarL.z + 0.02, P.z));
  hair = max(hair, sideburn * 0.85);
  hair *= step(eyeY - 0.12, P.y) * uHairDensity;
  float crown = length((P - (uHeadC + vec3(0.0, 0.11, -0.01))).xz);
  hair *= 1.0 - (1.0 - uHairDensity) * 1.6 * (1.0 - smoothstep(0.02, 0.07, crown)) * (1.0 - uFemale);
  return clamp(hair, 0.0, 1.0);
}
// eyebrow coverage for one side (rest space, metres)
float vh_brow(vec3 P, vec3 eye, float side) {
  float u = (P.x - eye.x) * side;             // + lateral
  float along = clamp((u + 0.018) / 0.047, 0.0, 1.0);
  float ends = smoothstep(-0.02, -0.014, u) * (1.0 - smoothstep(0.024, 0.031, u));
  float yc = eye.y + 0.0175 + 0.0045 * sin(along * 3.1416) - 0.002 * along;
  float th = mix(0.0046, 0.0022, along);
  float d = abs(P.y - yc);
  float front = smoothstep(eye.z - 0.012, eye.z - 0.004, P.z);
  return (1.0 - smoothstep(th * 0.6, th + 0.0012, d)) * ends * front;
}
`;

export const SKIN_NOISE_GLSL = NOISE;
export const HAIR_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uHairColor;
uniform float uHairDensity;
uniform float uRecession;
uniform float uFemale;
uniform vec3 uEyeL;
uniform vec3 uEyeR;
uniform vec3 uEarL;
uniform vec3 uEarR;
uniform vec3 uHeadC;
uniform float uBrowY;
`;

export function createSkinMaterial(opts: {
  skinTone: number;
  female: boolean;
  ageYears: number;
  hairColor: THREE.Color;
  hairDensity: number;
  recession: number;
  landmarks: SkinLandmarkUniforms;
}) {
  const light = new THREE.Color().setRGB(0.83, 0.63, 0.52, THREE.SRGBColorSpace);
  const mid = new THREE.Color().setRGB(0.66, 0.46, 0.33, THREE.SRGBColorSpace);
  const dark = new THREE.Color().setRGB(0.34, 0.22, 0.155, THREE.SRGBColorSpace);
  const t = THREE.MathUtils.clamp(opts.skinTone, 0, 1);
  const base = t < 0.5 ? light.clone().lerp(mid, t * 2) : mid.clone().lerp(dark, (t - 0.5) * 2);
  const lm = opts.landmarks;

  const uniforms: SkinUniforms = {
    uSkinBase: { value: base },
    uSkinTone: { value: t },
    uHairColor: { value: opts.hairColor.clone() },
    uHairDensity: { value: opts.hairDensity },
    uRecession: { value: opts.recession },
    uBeard: { value: opts.female ? 0 : 0.6 },
    uFemale: { value: opts.female ? 1 : 0 },
    uAge: { value: opts.ageYears },
    uPallor: { value: 0 },
    uCyanC: { value: 0 },
    uCyanP: { value: 0 },
    uFlush: { value: 0 },
    uUrticaria: { value: 0 },
    uMottling: { value: 0 },
    uDiaphoresis: { value: 0 },
    uXray: { value: 0 },
    uXrayOpacity: { value: 1 },
    uSSSWrap: { value: 0.38 },
    uSSSColor: { value: new THREE.Color(0.85, 0.26, 0.16) },
    uHighlight: { value: 0 },
    uWoundPos: { value: new THREE.Vector3() },
    uWound: { value: 0 },
    uEyeL: { value: lm.eyeL.clone() },
    uEyeR: { value: lm.eyeR.clone() },
    uMouth: { value: lm.mouth.clone() },
    uNippleL: { value: lm.nippleL.clone() },
    uNippleR: { value: lm.nippleR.clone() },
    uEarL: { value: lm.earL.clone() },
    uEarR: { value: lm.earR.clone() },
    uHeadC: { value: lm.headCenter.clone() },
    uBrowY: { value: lm.browY },
    uHipL: { value: lm.hipL.clone() },
    uHipR: { value: lm.hipR.clone() },
    uKneeL: { value: lm.kneeL.clone() },
    uKneeR: { value: lm.kneeR.clone() },
    uWaistY: { value: lm.waistY },
    uGarment: { value: new THREE.Color().setRGB(0.1, 0.13, 0.2, THREE.SRGBColorSpace) },
  };

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.52,
    metalness: 0,
    specularIntensity: 0.5,
    specularColor: new THREE.Color(1, 1, 1),
    sheen: 0.12,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0.4, 0.2, 0.15),
    clearcoat: 0,
    clearcoatRoughness: 0.2,
    ior: 1.4,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec4 masksA;
attribute vec4 masksB;
attribute float cavity;
varying float vCavity;
varying vec4 vMasksA;
varying vec4 vMasksB;
varying vec3 vObjPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
vMasksA = masksA;
vMasksB = masksB;
vCavity = cavity;
vObjPos = position;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying vec4 vMasksA; // coarse hair region, brows, lips, flush zones
varying vec4 vMasksB; // areola, beard zone, knees, acral
varying vec3 vObjPos;
varying float vCavity;
uniform vec3 uSkinBase;
uniform float uSkinTone;
uniform vec3 uHairColor;
uniform float uHairDensity;
uniform float uRecession;
uniform float uBeard;
uniform float uFemale;
uniform float uAge;
uniform float uPallor;
uniform float uCyanC;
uniform float uCyanP;
uniform float uFlush;
uniform float uUrticaria;
uniform float uMottling;
uniform float uDiaphoresis;
uniform float uXray;
uniform float uXrayOpacity;
uniform float uSSSWrap;
uniform vec3 uSSSColor;
uniform float uHighlight;
uniform vec3 uWoundPos;
uniform float uWound;
uniform vec3 uEyeL;
uniform vec3 uEyeR;
uniform vec3 uMouth;
uniform vec3 uNippleL;
uniform vec3 uNippleR;
uniform vec3 uEarL;
uniform vec3 uEarR;
uniform vec3 uHeadC;
uniform float uBrowY;
uniform vec3 uHipL;
uniform vec3 uHipR;
uniform vec3 uKneeL;
uniform vec3 uKneeR;
uniform float uWaistY;
uniform vec3 uGarment;
${NOISE}
float gSweat = 0.0;
float gHair = 0.0;
float gBump = 0.0;
float gLip = 0.0;
float gCloth = 0.0;
`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  vec3 P = vObjPos;
  float flushZ = vMasksA.w;
  float beardM = vMasksB.y;
  float kneeM = vMasksB.z;
  float acral = vMasksB.w;
  float eyeY = 0.5 * (uEyeL.y + uEyeR.y);

  // ---------- per-fragment anatomical features
  // lips (vermilion) — superellipse around the stomion with a cupid's bow
  vec3 m = uMouth;
  float lx = P.x / 0.0245;
  float bow = 0.0012 * (1.0 - smoothstep(0.0, 0.006, abs(abs(P.x) - 0.004)));
  float ly = (P.y - m.y - 0.0003) / (P.y > m.y ? (0.0078 + bow) : 0.0098);
  float lipE = pow(abs(lx), 2.4) + ly * ly;
  float lipFront = smoothstep(m.z - 0.022, m.z - 0.008, P.z);
  float lip = (1.0 - smoothstep(0.78, 1.0, lipE)) * lipFront;
  gLip = lip;
  // brows
  float brow = max(vh_brow(P, uEyeL, 1.0), vh_brow(P, uEyeR, -1.0));
  // areolae
  float areR = mix(0.0125, 0.019, uFemale);
  float dN = min(length(P - uNippleL), length(P - uNippleR));
  float areola = (1.0 - smoothstep(areR * 0.8, areR * 1.05, dN)) * step(0.0, P.z - uHeadC.z + 0.2);
  float nipple = 1.0 - smoothstep(0.0035, 0.0055, dN);
  float hair = vh_hairCover(P);

  // ---------- base albedo: melanin/haemoglobin variation
  float lf = vh_fbm(P * 7.0);
  float mf = vh_aa(P * 60.0);
  vec3 skin = uSkinBase * (0.92 + 0.14 * lf);
  skin = mix(skin, skin * vec3(1.07, 0.87, 0.85), flushZ * 0.55);           // cheeks, nose, ears
  skin = mix(skin, skin * vec3(1.3, 1.2, 1.12), acral * uSkinTone * 0.22);   // palms/soles lighter
  skin *= 1.0 - 0.06 * smoothstep(0.6, 0.92, mf);                             // pigment speckle
  // periorbital slight darkening
  float dEye = min(length(P.xy - uEyeL.xy), length(P.xy - uEyeR.xy));
  skin *= 1.0 - 0.08 * (1.0 - smoothstep(0.012, 0.025, dEye)) * step(uEyeL.z - 0.02, P.z);
  // areola / nipple
  skin = mix(skin, skin * vec3(0.74, 0.56, 0.5), areola * 0.85);
  skin = mix(skin, skin * vec3(0.64, 0.48, 0.44), nipple * 0.6);
  // lips with darker vermilion border
  vec3 lipC = mix(vec3(0.62, 0.3, 0.28), uSkinBase * vec3(0.78, 0.52, 0.5), 0.3 + 0.55 * uSkinTone);
  skin = mix(skin, lipC, lip * 0.9);
  skin *= 1.0 - 0.1 * (smoothstep(0.7, 0.95, lipE) - smoothstep(0.95, 1.1, lipE)) * lipFront;

  // ---------- physiology
  float flushArea = max(flushZ, 0.45);
  skin = mix(skin, skin * vec3(1.17, 0.73, 0.69), uFlush * flushArea * (1.0 - uSkinTone * 0.6));
  if (uUrticaria > 0.001) {
    float w = vh_fbm(P * 18.0 + 3.1);
    float wheal = smoothstep(0.56 - 0.12 * uUrticaria, 0.62 - 0.1 * uUrticaria, w) * (1.0 - hair) * (1.0 - lip);
    float flare = smoothstep(0.46 - 0.12 * uUrticaria, 0.6 - 0.1 * uUrticaria, w);
    skin = mix(skin, skin * vec3(1.2, 0.7, 0.68), flare * uUrticaria * (1.0 - uSkinTone * 0.5));
    skin = mix(skin, skin * vec3(1.1, 1.02, 0.98), wheal * uUrticaria * 0.6);
    gBump += wheal * uUrticaria * 0.9;
  }
  if (uMottling > 0.001) {
    vec2 cc = vh_cells(P * 30.0);
    float net = 1.0 - smoothstep(0.02, 0.15, cc.y);
    float mm = net * uMottling * (0.35 + 0.65 * kneeM) * (1.0 - hair);
    skin = mix(skin, skin * vec3(0.7, 0.56, 0.82), mm);
  }
  vec3 pale = mix(vec3(dot(skin, vec3(0.3, 0.55, 0.15))) * vec3(1.03, 1.0, 0.93), skin, 0.35) * (1.0 + 0.16 * (1.0 - uSkinTone));
  skin = mix(skin, pale, uPallor * 0.85);
  vec3 cyan = skin * vec3(0.6, 0.68, 1.06);
  float cyanW = uCyanC * (lip * 0.95 + 0.3 * flushZ + 0.12) + uCyanP * acral * 0.9;
  skin = mix(skin, cyan, clamp(cyanW, 0.0, 1.0));

  // ---------- hair, brows, stubble
  float strand = vh_aa(vec3(P.x * 700.0, P.y * 220.0, P.z * 700.0));
  float cover = hair * (0.82 + 0.18 * vh_fbm(P * 35.0));
  vec3 hairC = uHairColor * (0.6 + 0.55 * strand);
  gHair = cover;
  skin = mix(skin, hairC, clamp(cover * 1.05, 0.0, 0.96));
  float browStrand = vh_aa(vec3(P.x * 500.0, P.y * 1600.0, P.z * 500.0));
  skin = mix(skin, uHairColor * (0.35 + 0.35 * browStrand), brow * 0.92);
  float stub = smoothstep(0.52, 0.8, vh_aa(P * 1200.0));
  skin = mix(skin, uHairColor * 0.8, beardM * uBeard * (0.25 + 0.5 * stub) * (1.0 - lip));
  gBump += cover * (strand - 0.5) * 0.8 + brow * (browStrand - 0.5) * 0.5;

  // ---------- underwear (modesty garment), painted with crisp analytic edges
  {
    vec3 hip = P.x > 0.0 ? uHipL : uHipR;
    vec3 knee = P.x > 0.0 ? uKneeL : uKneeR;
    vec3 dir = normalize(knee - hip);
    float t = dot(P - hip, dir);
    float legCut = 0.085;
    float waist = smoothstep(uWaistY + 0.002, uWaistY - 0.002, P.y + 0.006 * P.z);
    float leg = 1.0 - smoothstep(legCut - 0.002, legCut + 0.002, t + 0.02 * (P.z - hip.z) * sign(P.x) * 0.0);
    float notArm = 1.0 - step(0.25, abs(P.x));
    float cloth = waist * leg * notArm;
    if (cloth > 0.001) {
      float weave = vh_aa(vec3(P.x * 1800.0, P.y * 1800.0, P.z * 1800.0));
      float band = smoothstep(uWaistY - 0.03, uWaistY - 0.024, P.y);
      vec3 cc = uGarment * (0.9 + 0.15 * weave) * (1.0 + 0.25 * band);
      skin = mix(skin, cc, cloth);
      gCloth = cloth;
      gBump += cloth * ((weave - 0.5) * 0.4 + band * 0.6);
    }
  }

  // ---------- bleeding wound
  if (uWound > 0.001) {
    float wd = length(P - uWoundPos);
    float n = vh_fbm(P * 90.0);
    float core = 1.0 - smoothstep(0.006, 0.012 + 0.006 * n, wd);
    float smear = (1.0 - smoothstep(0.01, 0.03 + 0.06 * uWound * (0.6 + 0.8 * n), wd + 0.01 * (n - 0.5))) * uWound;
    skin = mix(skin, vec3(0.28, 0.02, 0.02), clamp(smear * 0.9, 0.0, 0.9));
    skin = mix(skin, vec3(0.12, 0.01, 0.01), core);
    gSweat = max(gSweat, smear);
    gBump -= core * 1.5;
  }
  // cavity occlusion (eye sockets, nostrils, ears, skin folds)
  skin *= mix(1.0, 0.55, vCavity) ;
  diffuseColor.rgb = skin;
  gSweat = max(gSweat, uDiaphoresis);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.25, 0.75, 1.0), uHighlight * 0.25);
}
`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
{
  float pore = vh_aa(vObjPos * 650.0);
  roughnessFactor = mix(0.44, 0.6, pore);
  roughnessFactor = mix(roughnessFactor, 0.32, gLip * 0.85);
  roughnessFactor = mix(roughnessFactor, 0.72, gHair);
  roughnessFactor = mix(roughnessFactor, 0.85, vCavity * 0.8);
  roughnessFactor = mix(roughnessFactor, 0.95, gCloth);
  vec2 dc = vh_cells(vObjPos * 260.0);
  float drop = 1.0 - smoothstep(0.1, 0.32, dc.x);
  roughnessFactor = mix(roughnessFactor, 0.12 + 0.2 * (1.0 - drop), gSweat * 0.85);
  gBump += drop * gSweat * 0.5;
}
`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
{
  // procedural micro relief (pores, fine wrinkles, wheals, hair, sweat beads)
  float h = (vh_aa(vObjPos * 800.0) - 0.5) * 0.3 + (vh_aa(vObjPos * 240.0) - 0.5) * 0.35 + gBump;
  vec3 sx = dFdx(-vViewPosition);
  vec3 sy = dFdy(-vViewPosition);
  vec2 dh = vec2(dFdx(h), dFdy(h)) * 0.0003;
  vec3 r1 = cross(sy, normal);
  vec3 r2 = cross(normal, sx);
  float det = dot(sx, r1) * faceDirection;
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  normal = normalize(abs(det) * normal - grad);
}
`,
      )
      .replace(
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
        /* glsl */ `{
    float ndlRaw = dot( geometryNormal, directLight.direction );
    float wrapNL = saturate( ( ndlRaw + uSSSWrap ) / ( 1.0 + uSSSWrap ) );
    vec3 sss = max( wrapNL - saturate( ndlRaw ), 0.0 ) * directLight.color * uSSSColor;
    reflectedLight.directDiffuse += ( irradiance * ( 1.0 - F ) + sss ) * BRDF_Lambert( material.diffuseContribution );
  }`,
      )
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
if (uXray > 0.5) {
  float fres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 2.2);
  gl_FragColor.a = clamp(uXrayOpacity * (0.16 + 0.84 * fres), 0.0, 1.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.6 + vec3(0.12, 0.16, 0.2), fres * (1.0 - uXrayOpacity));
}
`,
      );
  };
  mat.customProgramCacheKey = () => 'vitalis-skin-v2';

  return { material: mat, uniforms };
}

/** Clear-coat is driven from JS each frame so a sweat film shows up in reflections. */
export function applySkinPhysiology(mat: THREE.MeshPhysicalMaterial, u: SkinUniforms) {
  mat.clearcoat = u.uDiaphoresis.value * 0.55;
}
