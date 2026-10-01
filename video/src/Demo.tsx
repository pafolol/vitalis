import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { AbsoluteFill, Freeze, OffthreadVideo, Series, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { FPS, INTRO, OUTRO, SCENES, partFrames, sceneFrames, type Scene } from './timeline';

const { fontFamily: inter } = loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] });
const { fontFamily: mono } = loadMono('normal', { weights: ['400', '500'], subsets: ['latin'] });

const C = {
  bg: '#0a0e15',
  panel: '#111722',
  line: '#1f2a3a',
  ink: '#e8edf4',
  ink2: '#9aa7b8',
  ink3: '#64728a',
  accent: '#4cc3dc',
  ecg: '#3ddc84',
};

const fade = (frame: number, total: number, d = 8) => interpolate(frame, [0, d, total - d, total], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

/** A single ECG complex drawn as a path, revealed left to right. */
function Pulse({ width = 520, progress }: { width?: number; progress: number }) {
  const d = 'M0 40 H150 l14 -9 l14 9 h22 l10 9 l16 -46 l16 62 l12 -25 h26 l20 -14 l22 14 H520';
  return (
    <svg width={width} height={(width / 520) * 80} viewBox="0 0 520 80" fill="none">
      <path d={d} stroke={C.ecg} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - progress} />
    </svg>
  );
}

function Intro() {
  const f = useCurrentFrame();
  const o = fade(f, INTRO, 10);
  const draw = interpolate(f, [4, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const up = (delay: number) => ({
    opacity: interpolate(f, [delay, delay + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    transform: `translateY(${interpolate(f, [delay, delay + 12], [14, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}px)`,
  });
  return (
    <AbsoluteFill style={{ background: C.bg, alignItems: 'center', justifyContent: 'center', opacity: o, fontFamily: inter }}>
      <Pulse progress={draw} />
      <div style={{ ...up(22), marginTop: 26, fontSize: 132, fontWeight: 700, letterSpacing: -4, color: C.ink, lineHeight: 1 }}>Vitalis</div>
      <div style={{ ...up(32), marginTop: 26, fontSize: 38, fontWeight: 500, color: C.ink2 }}>A real-time, procedurally generated 3D patient simulator</div>
      <div style={{ ...up(44), marginTop: 44, fontFamily: mono, fontSize: 21, letterSpacing: 2, color: C.ink3, textTransform: 'uppercase' }}>Educational simulation · not for clinical use</div>
    </AbsoluteFill>
  );
}

function ClipScene({ scene, index }: { scene: Scene; index: number }) {
  const f = useCurrentFrame();
  const total = sceneFrames(scene);
  const o = fade(f, total, 7);
  const cap = interpolate(f, [4, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const VW = 1712;
  const VH = 963;
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: inter, opacity: o }}>
      <div style={{ position: 'absolute', left: (1920 - VW) / 2, top: 22, width: VW, height: VH, borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.line}`, background: '#000' }}>
        <Series>
          {scene.parts.map((p, i) => (
            <Series.Sequence key={i} durationInFrames={partFrames(p)}>
              {'hold' in p ? (
                <Freeze frame={0}>
                  <OffthreadVideo muted src={staticFile(scene.clip)} trimBefore={Math.round(p.at * FPS)} style={{ width: VW, height: VH }} />
                </Freeze>
              ) : (
                <OffthreadVideo
                  muted
                  src={staticFile(scene.clip)}
                  trimBefore={Math.round(p.from * FPS)}
                  trimAfter={Math.round(p.to * FPS)}
                  playbackRate={p.rate ?? 1}
                  style={{ width: VW, height: VH }}
                />
              )}
              {'rate' in p && p.rate && p.rate > 1.5 ? (
                <div style={{ position: 'absolute', right: 18, top: 16, fontFamily: mono, fontSize: 18, color: C.ink, background: 'rgba(10,14,21,.78)', border: `1px solid ${C.line}`, borderRadius: 8, padding: '5px 11px' }}>{p.rate}× speed</div>
              ) : null}
            </Series.Sequence>
          ))}
        </Series>
      </div>
      <div style={{ position: 'absolute', left: (1920 - VW) / 2, right: (1920 - VW) / 2, top: 22 + VH, bottom: 0, display: 'flex', alignItems: 'center', gap: 26, opacity: cap }}>
        <div style={{ fontFamily: mono, fontSize: 22, color: C.accent, minWidth: 74 }}>
          {String(index + 1).padStart(2, '0')}
          <span style={{ color: C.ink3 }}> / {String(SCENES.length).padStart(2, '0')}</span>
        </div>
        <div style={{ fontSize: 30, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap' }}>{scene.title}</div>
        <div style={{ width: 1, height: 30, background: C.line }} />
        <div style={{ fontSize: 24, color: C.ink2, lineHeight: 1.25 }}>{scene.text}</div>
      </div>
    </AbsoluteFill>
  );
}

function Outro() {
  const f = useCurrentFrame();
  const o = fade(f, OUTRO, 10);
  const items: [string, string][] = [
    ['Deterministic physiology engine', 'Circulation, lungs, fluids, kidneys, metabolism and nerves, simulated 10×/s in a Web Worker. Same seed + same actions = same case.'],
    ['Real pharmacology', 'About 50 drugs with absorption, distribution, effect-site delay, synergy and antagonism.'],
    ['AI that cannot cheat', 'The AI speaks as the patient, tutors and writes scenarios, but it can never change the physiology.'],
    ['Living 3D anatomy', 'A patient built per case, with 191 anatomical structures that move with the simulation.'],
  ];
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: inter, opacity: o, padding: '210px 190px 120px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <Pulse width={150} progress={1} />
        <div style={{ fontSize: 52, fontWeight: 700, color: C.ink, letterSpacing: -1 }}>What makes it work</div>
      </div>
      <div style={{ marginTop: 56, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '44px 70px' }}>
        {items.map(([t, d], i) => {
          const a = interpolate(f, [10 + i * 9, 22 + i * 9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return (
            <div key={t} style={{ opacity: a, transform: `translateY(${(1 - a) * 12}px)`, borderTop: `2px solid ${C.accent}`, paddingTop: 20 }}>
              <div style={{ fontSize: 34, fontWeight: 600, color: C.ink }}>{t}</div>
              <div style={{ marginTop: 12, fontSize: 25, lineHeight: 1.38, color: C.ink2 }}>{d}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 190, right: 190, bottom: 84, display: 'flex', justifyContent: 'space-between', fontFamily: mono, fontSize: 20, color: C.ink3 }}>
        <span>React · Three.js · TypeScript · OpenAI</span>
        <span>EDUCATIONAL SIMULATION · NOT FOR CLINICAL USE</span>
      </div>
    </AbsoluteFill>
  );
}

export function Demo() {
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Series>
        <Series.Sequence durationInFrames={INTRO}>
          <Intro />
        </Series.Sequence>
        {SCENES.map((s, i) => (
          <Series.Sequence key={s.title} durationInFrames={sceneFrames(s)}>
            <ClipScene scene={s} index={i} />
          </Series.Sequence>
        ))}
        <Series.Sequence durationInFrames={OUTRO}>
          <Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
}

