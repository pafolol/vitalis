/**
 * Loader for the compact human asset produced by scripts/assets/build-human.mjs
 * (MakeHuman CC0 base mesh, rig, weights and targets).
 */

export interface BufRef {
  offset: number;
  length: number;
  type: string;
}

export interface SparseTargetMeta {
  name: string;
  idx: BufRef;
  delta: BufRef;
  scale: number;
  count: number;
}

export interface MacroTargetMeta extends SparseTargetMeta {
  sex: 'male' | 'female';
  age: 'young' | 'old';
  muscle: 'minmuscle' | 'averagemuscle' | 'maxmuscle' | 'any';
  weight: 'minweight' | 'averageweight' | 'maxweight' | 'any';
}

export interface HumanAssetMeta {
  version: number;
  vertexCount: number;
  regionIds: Record<string, number>;
  buffers: Record<
    'positions' | 'skinIndex' | 'skinWeight' | 'region' | 'masks' | 'bodyIndex' | 'bodyQuads' | 'jointVerts' | 'jointOffsets',
    BufRef
  >;
  helpers: Record<'shorts' | 'upperTeeth' | 'lowerTeeth' | 'tongue' | 'hair' | 'lashesL' | 'lashesR', BufRef>;
  joints: string[];
  bones: { name: string; parent: number; head: number; tail: number }[];
  macroTargets: MacroTargetMeta[];
  morphTargets: SparseTargetMeta[];
  eyes: {
    count: number;
    bindIdx: BufRef;
    bindW: BufRef;
    bindD: BufRef;
    uv: BufRef;
    index: BufRef;
    corneaIndex: BufRef;
    scaleRefs: Record<'x' | 'y' | 'z', [number, number, number]>;
    irisUv: [number, number][];
    irisRadiusUv: number;
    pupilRadiusUv: number;
  };
  landmarkVerts: Record<'sternalNotch' | 'navel' | 'mouth' | 'noseTip', number>;
  reference: { browY: number; eyeY: number };
}

export interface SparseTarget {
  name: string;
  idx: Uint16Array;
  delta: Int16Array;
  scale: number;
}

export interface HumanAsset {
  meta: HumanAssetMeta;
  positions: Float32Array;
  skinIndex: Uint8Array;
  skinWeight: Uint8Array;
  region: Uint8Array;
  masks: Uint8Array;
  bodyIndex: Uint32Array;
  bodyQuads: Uint32Array;
  jointVerts: Uint16Array;
  jointOffsets: Uint32Array;
  helpers: Record<keyof HumanAssetMeta['helpers'], Uint32Array>;
  macroTargets: (SparseTarget & Pick<MacroTargetMeta, 'sex' | 'age' | 'muscle' | 'weight'>)[];
  morphTargets: SparseTarget[];
  eyes: {
    bindIdx: Uint16Array;
    bindW: Float32Array;
    bindD: Float32Array;
    uv: Float32Array;
    index: Uint32Array;
    corneaIndex: Uint32Array;
  };
  eyeTextureUrl: string;
}

type TypedCtor =
  | Float32ArrayConstructor
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Int16ArrayConstructor
  | Uint32ArrayConstructor;

const CTORS: Record<string, TypedCtor> = {
  Float32Array,
  Uint8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
};

function view<T>(buf: ArrayBuffer, ref: BufRef): T {
  const C = CTORS[ref.type];
  if (!C) throw new Error(`Unsupported buffer type ${ref.type}`);
  return new C(buf, ref.offset, ref.length) as unknown as T;
}

export function parseHumanAsset(meta: HumanAssetMeta, buf: ArrayBuffer, eyeTextureUrl: string): HumanAsset {
  const sparse = (t: SparseTargetMeta): SparseTarget => ({
    name: t.name,
    idx: view<Uint16Array>(buf, t.idx),
    delta: view<Int16Array>(buf, t.delta),
    scale: t.scale,
  });
  const b = meta.buffers;
  const h = meta.helpers;
  return {
    meta,
    positions: view<Float32Array>(buf, b.positions),
    skinIndex: view<Uint8Array>(buf, b.skinIndex),
    skinWeight: view<Uint8Array>(buf, b.skinWeight),
    region: view<Uint8Array>(buf, b.region),
    masks: view<Uint8Array>(buf, b.masks),
    bodyIndex: view<Uint32Array>(buf, b.bodyIndex),
    bodyQuads: view<Uint32Array>(buf, b.bodyQuads),
    jointVerts: view<Uint16Array>(buf, b.jointVerts),
    jointOffsets: view<Uint32Array>(buf, b.jointOffsets),
    helpers: {
      shorts: view<Uint32Array>(buf, h.shorts),
      upperTeeth: view<Uint32Array>(buf, h.upperTeeth),
      lowerTeeth: view<Uint32Array>(buf, h.lowerTeeth),
      tongue: view<Uint32Array>(buf, h.tongue),
      hair: view<Uint32Array>(buf, h.hair),
      lashesL: view<Uint32Array>(buf, h.lashesL),
      lashesR: view<Uint32Array>(buf, h.lashesR),
    },
    macroTargets: meta.macroTargets.map((t) => ({
      ...sparse(t),
      sex: t.sex,
      age: t.age,
      muscle: t.muscle,
      weight: t.weight,
    })),
    morphTargets: meta.morphTargets.map(sparse),
    eyes: {
      bindIdx: view<Uint16Array>(buf, meta.eyes.bindIdx),
      bindW: view<Float32Array>(buf, meta.eyes.bindW),
      bindD: view<Float32Array>(buf, meta.eyes.bindD),
      uv: view<Float32Array>(buf, meta.eyes.uv),
      index: view<Uint32Array>(buf, meta.eyes.index),
      corneaIndex: view<Uint32Array>(buf, meta.eyes.corneaIndex),
    },
    eyeTextureUrl,
  };
}

const BASE = `${import.meta.env?.BASE_URL ?? '/'}assets/human/`;
let cache: Promise<HumanAsset> | null = null;

export function loadHumanAsset(): Promise<HumanAsset> {
  if (!cache) {
    cache = (async () => {
      const [metaRes, binRes] = await Promise.all([fetch(`${BASE}human.json`), fetch(`${BASE}human.bin`)]);
      if (!metaRes.ok || !binRes.ok) throw new Error('Human asset not found — run `npm run assets`.');
      const meta = (await metaRes.json()) as HumanAssetMeta;
      const buf = await binRes.arrayBuffer();
      return parseHumanAsset(meta, buf, `${BASE}eye_brown.png`);
    })();
    cache.catch(() => {
      cache = null;
    });
  }
  return cache;
}
