import { useEffect, useMemo, useRef, useState } from 'react';
import { ERStage } from '@/three/scene/ERStage';
import {
  ANATOMY_LAYERS,
  createDefaultLayerSettings,
  createDefaultVisualState,
  type AnatomyLayerSettings,
  type AnatomyStructureInfo,
  type AvatarVisualState,
  type BodyPointerHit,
  type BodyShapeParams,
  type CameraPreset,
  type Limb,
  type BodyRegion,
} from '@/three/types';

/**
 * Developer harness for the 3D layer (/?lab=avatar). Every visual-state field
 * can be driven by hand; query parameters allow scripted screenshots, e.g.
 * ?lab=avatar&sex=female&age=72&weight=0.6&preset=chest&att=ecg,spo2,nrb&skinOpacity=0.3&layers=cardiovascular,respiratory
 */

type NumKey = {
  [K in keyof AvatarVisualState]: AvatarVisualState[K] extends number ? K : never;
}[keyof AvatarVisualState];

const SLIDERS: { key: NumKey; min: number; max: number; step?: number }[] = [
  { key: 'breathDepth', min: 0, max: 2.5 },
  { key: 'chestRiseLeft', min: 0, max: 1.5 },
  { key: 'chestRiseRight', min: 0, max: 1.5 },
  { key: 'abdominalFraction', min: 0, max: 1 },
  { key: 'accessoryMuscles', min: 0, max: 1 },
  { key: 'nasalFlare', min: 0, max: 1 },
  { key: 'pulseStrength', min: 0, max: 1 },
  { key: 'eyesOpen', min: 0, max: 1 },
  { key: 'gazeFollow', min: 0, max: 1 },
  { key: 'headTurn', min: -1, max: 1 },
  { key: 'jawOpen', min: 0, max: 1 },
  { key: 'painExpression', min: 0, max: 1 },
  { key: 'agitation', min: 0, max: 1 },
  { key: 'tremor', min: 0, max: 1 },
  { key: 'seizure', min: 0, max: 1 },
  { key: 'speaking', min: 0, max: 1 },
  { key: 'handToChest', min: 0, max: 1 },
  { key: 'pupilMm', min: 1.5, max: 8, step: 0.1 },
  { key: 'pallor', min: 0, max: 1 },
  { key: 'cyanosisCentral', min: 0, max: 1 },
  { key: 'cyanosisPeripheral', min: 0, max: 1 },
  { key: 'flushing', min: 0, max: 1 },
  { key: 'urticaria', min: 0, max: 1 },
  { key: 'mottling', min: 0, max: 1 },
  { key: 'diaphoresis', min: 0, max: 1 },
  { key: 'angioedema', min: 0, max: 1 },
];

const ATT_FLAGS = [
  'ecgLeads',
  'spo2Probe',
  'bpCuff',
  'ivLeftArm',
  'ivRightArm',
  'ioAccess',
  'nasalCannula',
  'faceMask',
  'nonRebreather',
  'bvm',
  'ett',
  'opa',
  'defibPads',
  'airwayManoeuvre',
] as const;

const ATT_ALIASES: Record<string, (typeof ATT_FLAGS)[number]> = {
  ecg: 'ecgLeads',
  spo2: 'spo2Probe',
  bp: 'bpCuff',
  ivl: 'ivLeftArm',
  ivr: 'ivRightArm',
  io: 'ioAccess',
  nc: 'nasalCannula',
  mask: 'faceMask',
  nrb: 'nonRebreather',
  bvm: 'bvm',
  ett: 'ett',
  opa: 'opa',
  pads: 'defibPads',
  airway: 'airwayManoeuvre',
};

function initialFromQuery() {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const body: BodyShapeParams = {
    sex: q.get('sex') === 'female' ? 'female' : 'male',
    ageYears: num('age', 42),
    heightM: num('height', q.get('sex') === 'female' ? 1.64 : 1.78),
    weightFactor: num('weight', 0.1),
    muscleFactor: num('muscle', 0),
    skinTone: num('tone', 0.25),
  };
  const vs = createDefaultVisualState();
  for (const s of SLIDERS) if (q.has(s.key)) (vs[s.key] as number) = Number(q.get(s.key));
  for (const a of (q.get('att') ?? '').split(',').filter(Boolean)) {
    const flag = ATT_ALIASES[a] ?? (a as (typeof ATT_FLAGS)[number]);
    if ((ATT_FLAGS as readonly string[]).includes(flag)) (vs.attachments[flag] as boolean) = true;
  }
  for (const k of Object.keys(vs.anatomy) as (keyof AvatarVisualState['anatomy'])[]) if (q.has(`an.${k}`)) vs.anatomy[k] = Number(q.get(`an.${k}`));
  if (q.has('backrest')) vs.attachments.backrestDeg = num('backrest', 15);
  if (q.has('tq')) vs.attachments.tourniquet = q.get('tq') as Limb;
  if (q.has('chestTube')) vs.attachments.chestTube = q.get('chestTube') as 'left' | 'right';
  if (q.has('needle')) vs.attachments.needleDecompression = q.get('needle') as 'left' | 'right';
  if (q.has('bleed')) vs.attachments.bleeding = { region: q.get('bleed') as BodyRegion, intensity: num('bleedI', 0.7) };
  if (q.has('iv')) vs.attachments.ivBag = { label: q.get('iv')!, fraction: 0.7, running: true, isBlood: q.get('iv')!.toLowerCase().includes('blood') };
  const layers = createDefaultLayerSettings();
  for (const l of (q.get('layers') ?? '').split(',').filter(Boolean)) if (l in layers) layers[l as keyof AnatomyLayerSettings].visible = true;
  if (q.has('skinOpacity')) layers.skin.opacity = num('skinOpacity', 1);
  if (q.get('skin') === 'off') layers.skin.visible = false;
  return {
    body,
    vs,
    layers,
    preset: (q.get('preset') as CameraPreset) ?? 'full',
    rr: num('rr', 14),
    hr: num('hr', 78),
    compact: q.has('compact'),
  };
}

export default function AvatarLab() {
  const init = useMemo(initialFromQuery, []);
  const visual = useRef<AvatarVisualState>(init.vs);
  const [, force] = useState(0);
  const [body, setBody] = useState<BodyShapeParams>(init.body);
  const [layers, setLayers] = useState<AnatomyLayerSettings>(init.layers);
  const [preset, setPreset] = useState<CameraPreset>(init.preset);
  const [nonce, setNonce] = useState(0);
  const [rr, setRr] = useState(init.rr);
  const [hr, setHr] = useState(init.hr);
  const [lastHit, setLastHit] = useState<BodyPointerHit | null>(null);
  const [selected, setSelected] = useState<AnatomyStructureInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [cpr, setCpr] = useState(false);
  const [passive, setPassive] = useState(false);
  const rrRef = useRef(rr);
  const hrRef = useRef(hr);
  const cprRef = useRef(cpr);
  rrRef.current = rr;
  hrRef.current = hr;
  cprRef.current = cpr;

  // simple lab driver for breathing / cardiac phase / CPR
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let bPhase = 0;
    let cPhase = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const v = visual.current;
      v.clock += dt;
      bPhase = (bPhase + (dt * rrRef.current) / 60) % 1;
      // inspiration ~40% of the cycle, then passive expiration
      v.breathPhase = rrRef.current > 0 ? (bPhase < 0.4 ? Math.sin((bPhase / 0.4) * Math.PI * 0.5) : Math.exp(-((bPhase - 0.4) / 0.6) * 5) * (1 - (bPhase - 0.4) / 0.6)) : 0;
      cPhase = (cPhase + (dt * hrRef.current) / 60) % 1;
      v.cardiacPhase = cPhase;
      v.heartRate = hrRef.current;
      v.cprCompression = cprRef.current ? Math.max(0, Math.sin(v.clock * Math.PI * 2 * (110 / 60))) : 0;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const setVs = <K extends NumKey>(k: K, value: number) => {
    (visual.current[k] as number) = value;
    force((n) => n + 1);
  };
  const setAtt = (k: (typeof ATT_FLAGS)[number], v: boolean) => {
    (visual.current.attachments[k] as boolean) = v;
    force((n) => n + 1);
  };
  const vs = visual.current;
  const a = vs.attachments;

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0e1216', color: '#dfe6ea', font: '12px system-ui, sans-serif' }}>
      {!init.compact && (
        <aside style={{ width: 300, overflowY: 'auto', padding: 12, borderRight: '1px solid #232b33' }} data-testid="lab-controls">
          <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Avatar lab</h2>
          <fieldset style={{ border: '1px solid #2b343d', padding: 8, marginBottom: 8 }}>
            <legend>Body</legend>
            <label>
              Sex{' '}
              <select value={body.sex} onChange={(e) => setBody({ ...body, sex: e.target.value as 'male' | 'female' })}>
                <option value="male">male</option>
                <option value="female">female</option>
              </select>
            </label>
            {(
              [
                ['ageYears', 18, 95, 1],
                ['heightM', 1.45, 2.0, 0.01],
                ['weightFactor', -1, 1, 0.05],
                ['muscleFactor', -1, 1, 0.05],
                ['skinTone', 0, 1, 0.05],
              ] as const
            ).map(([k, min, max, step]) => (
              <div key={k}>
                {k} {body[k].toFixed(2)}
                <input type="range" min={min} max={max} step={step} value={body[k]} onChange={(e) => setBody({ ...body, [k]: Number(e.target.value) })} style={{ width: '100%' }} />
              </div>
            ))}
          </fieldset>
          <fieldset style={{ border: '1px solid #2b343d', padding: 8, marginBottom: 8 }}>
            <legend>Drivers</legend>
            RR {rr}
            <input type="range" min={0} max={45} value={rr} onChange={(e) => setRr(Number(e.target.value))} style={{ width: '100%' }} />
            HR {hr}
            <input type="range" min={0} max={180} value={hr} onChange={(e) => setHr(Number(e.target.value))} style={{ width: '100%' }} />
            backrest {a.backrestDeg}
            <input
              type="range"
              min={0}
              max={70}
              value={a.backrestDeg}
              onChange={(e) => {
                a.backrestDeg = Number(e.target.value);
                force((n) => n + 1);
              }}
              style={{ width: '100%' }}
            />
            <label>
              <input type="checkbox" checked={cpr} onChange={(e) => setCpr(e.target.checked)} /> CPR compressions
            </label>
            <br />
            <label>
              <input
                type="checkbox"
                checked={passive}
                onChange={(e) => {
                  setPassive(e.target.checked);
                  vs.passiveVentilation = e.target.checked;
                }}
              />{' '}
              passive ventilation
            </label>
            <br />
            <button onClick={() => (vs.lastShockAt = vs.clock)}>Shock (jolt)</button>
          </fieldset>
          <fieldset style={{ border: '1px solid #2b343d', padding: 8, marginBottom: 8 }}>
            <legend>Visual state</legend>
            {SLIDERS.map((s) => (
              <div key={s.key}>
                {s.key} {(vs[s.key] as number).toFixed(2)}
                <input type="range" min={s.min} max={s.max} step={s.step ?? 0.01} value={vs[s.key] as number} onChange={(e) => setVs(s.key, Number(e.target.value))} style={{ width: '100%' }} />
              </div>
            ))}
          </fieldset>
          <fieldset style={{ border: '1px solid #2b343d', padding: 8, marginBottom: 8 }}>
            <legend>Anatomy overlays</legend>
            {(Object.keys(vs.anatomy) as (keyof AvatarVisualState['anatomy'])[]).map((k) => (
              <div key={k}>
                {k} {vs.anatomy[k].toFixed(2)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={vs.anatomy[k]}
                  onChange={(e) => {
                    vs.anatomy[k] = Number(e.target.value);
                    force((n) => n + 1);
                  }}
                  style={{ width: '100%' }}
                />
              </div>
            ))}
          </fieldset>
          <fieldset style={{ border: '1px solid #2b343d', padding: 8, marginBottom: 8 }}>
            <legend>Attachments</legend>
            {ATT_FLAGS.map((f) => (
              <label key={f} style={{ display: 'block' }}>
                <input type="checkbox" checked={!!a[f]} onChange={(e) => setAtt(f, e.target.checked)} /> {f}
              </label>
            ))}
            tourniquet{' '}
            <select
              value={a.tourniquet ?? ''}
              onChange={(e) => {
                a.tourniquet = (e.target.value || null) as Limb | null;
                force((n) => n + 1);
              }}
            >
              <option value="">none</option>
              <option value="leftArm">leftArm</option>
              <option value="rightArm">rightArm</option>
              <option value="leftLeg">leftLeg</option>
              <option value="rightLeg">rightLeg</option>
            </select>
            <br />
            chest tube{' '}
            <select
              value={a.chestTube ?? ''}
              onChange={(e) => {
                a.chestTube = (e.target.value || null) as 'left' | 'right' | null;
                force((n) => n + 1);
              }}
            >
              <option value="">none</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </select>
            <br />
            needle{' '}
            <select
              value={a.needleDecompression ?? ''}
              onChange={(e) => {
                a.needleDecompression = (e.target.value || null) as 'left' | 'right' | null;
                force((n) => n + 1);
              }}
            >
              <option value="">none</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </select>
            <br />
            bleeding{' '}
            <select
              value={a.bleeding?.region ?? ''}
              onChange={(e) => {
                a.bleeding = e.target.value ? { region: e.target.value as BodyRegion, intensity: 0.7 } : null;
                force((n) => n + 1);
              }}
            >
              <option value="">none</option>
              {['leftLeg', 'rightLeg', 'abdomen', 'chest', 'leftArm', 'rightArm', 'head'].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <br />
            IV bag{' '}
            <select
              value={a.ivBag?.label ?? ''}
              onChange={(e) => {
                a.ivBag = e.target.value ? { label: e.target.value, fraction: 0.8, running: true, isBlood: e.target.value.includes('RBC') } : null;
                force((n) => n + 1);
              }}
            >
              <option value="">none</option>
              <option value="0.9% NaCl 1000 mL">NaCl 0.9%</option>
              <option value="Lactated Ringer's">LR</option>
              <option value="Packed RBC 1 unit">PRBC</option>
            </select>
          </fieldset>
          <fieldset style={{ border: '1px solid #2b343d', padding: 8, marginBottom: 8 }}>
            <legend>Anatomy layers</legend>
            {ANATOMY_LAYERS.map((l) => (
              <div key={l.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={layers[l.id].visible}
                    onChange={(e) => setLayers({ ...layers, [l.id]: { ...layers[l.id], visible: e.target.checked } })}
                  />{' '}
                  {l.label}
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={layers[l.id].opacity}
                  onChange={(e) => setLayers({ ...layers, [l.id]: { ...layers[l.id], opacity: Number(e.target.value) } })}
                  style={{ width: '100%' }}
                />
              </div>
            ))}
          </fieldset>
          <fieldset style={{ border: '1px solid #2b343d', padding: 8 }}>
            <legend>Camera</legend>
            {(['full', 'head', 'chest', 'abdomen', 'arms', 'legs'] as CameraPreset[]).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPreset(p);
                  setNonce((n) => n + 1);
                }}
                style={{ marginRight: 4, marginBottom: 4 }}
              >
                {p}
              </button>
            ))}
          </fieldset>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, opacity: 0.8 }} data-testid="lab-hit">
            {lastHit ? JSON.stringify({ region: lastHit.region, zone: lastHit.zone }, null, 1) : 'click the patient'}
            {selected ? `\n${selected.name} (${selected.layer})` : ''}
          </pre>
        </aside>
      )}
      <main style={{ flex: 1, position: 'relative' }} data-ready={ready ? 'true' : 'false'} data-testid="lab-main">
        <ERStage
          body={body}
          visual={visual}
          layers={layers}
          preset={preset}
          presetNonce={nonce}
          onBodyPointer={(h) => setLastHit(h)}
          onSelectStructure={setSelected}
          selectedStructureId={selected?.id ?? null}
          onReady={() => setReady(true)}
        />
      </main>
    </div>
  );
}
