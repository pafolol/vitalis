import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { BellOff, Bell, Volume2, VolumeX, Gauge } from 'lucide-react';
import { simClient } from '@/client/simClient';
import { useCase, useUi } from '@/client/stores';
import { RHYTHM_LABEL } from '@/sim/types';
import type { SimSnapshot } from '@/sim/engine/snapshot';
import { ArtGenerator, CapnoGenerator, EcgGenerator, PlethGenerator, ecgParamsFrom } from './waveforms';
import { audio } from '../audio';

const SAMPLE_RATE = 250;
const SWEEP_SECONDS = 6;

interface ChannelDef {
  key: 'ecg' | 'pleth' | 'art' | 'co2';
  label: string;
  color: string;
  min: number;
  max: number;
}

const CHANNELS: ChannelDef[] = [
  { key: 'ecg', label: 'II', color: '#3ee07a', min: -0.9, max: 1.5 },
  { key: 'pleth', label: 'Pleth', color: '#3fd4f0', min: -0.05, max: 1.45 },
  { key: 'art', label: 'ART', color: '#ff5470', min: 20, max: 180 },
  { key: 'co2', label: 'CO₂', color: '#f7d154', min: 0, max: 60 },
];

export interface Alarm {
  id: string;
  text: string;
  priority: 'high' | 'medium';
}

/** Evaluate monitor alarms from what the monitor can *measure* (attached devices). */
export function evaluateAlarms(s: SimSnapshot, limits: ReturnType<typeof useUi.getState>['limits'], spo2Display: number | null): Alarm[] {
  const out: Alarm[] = [];
  const m = s.therapy.monitoring;
  const cv = s.phys.cv;
  const ecgOn = m.ecg || s.therapy.defib.padsOn;
  if (ecgOn) {
    if (cv.rhythm === 'vfib') out.push({ id: 'vf', text: 'VFIB', priority: 'high' });
    else if (cv.rhythm === 'asystole') out.push({ id: 'asys', text: 'ASYSTOLE', priority: 'high' });
    else if (cv.rhythm === 'vtach') out.push({ id: 'vt', text: 'V-TACH', priority: 'high' });
    else if (cv.hr > 0 && cv.hr < limits.hrLow) out.push({ id: 'hrlo', text: `HR LOW ${Math.round(cv.hr)}`, priority: cv.hr < 40 ? 'high' : 'medium' });
    else if (cv.hr > limits.hrHigh) out.push({ id: 'hrhi', text: `HR HIGH ${Math.round(cv.hr)}`, priority: cv.hr > 160 ? 'high' : 'medium' });
  }
  if (m.spo2) {
    if (!s.derived.spo2Reliable) out.push({ id: 'spo2nosig', text: 'SpO₂ NO PULSE', priority: 'medium' });
    else if (spo2Display != null && spo2Display < limits.spo2Low) out.push({ id: 'spo2', text: `SpO₂ LOW ${Math.round(spo2Display)}`, priority: spo2Display < 85 ? 'high' : 'medium' });
  }
  const nibp = s.therapy.nibpLast;
  if (m.arterialLine) {
    if (cv.sbp < limits.sbpLow) out.push({ id: 'art', text: `ART SYS LOW ${Math.round(cv.sbp)}`, priority: cv.sbp < 70 ? 'high' : 'medium' });
  } else if (m.nibp && nibp?.ok) {
    if (nibp.sbp < limits.sbpLow) out.push({ id: 'nibplo', text: `NIBP SYS LOW ${nibp.sbp}`, priority: nibp.sbp < 70 ? 'high' : 'medium' });
    if (nibp.sbp > limits.sbpHigh) out.push({ id: 'nibphi', text: `NIBP SYS HIGH ${nibp.sbp}`, priority: 'medium' });
  }
  if (m.etco2) {
    if (s.phys.resp.rr < 1 && s.phys.resp.apneaTime > 20) out.push({ id: 'apnea', text: 'APNOEA', priority: 'high' });
    else if (s.phys.resp.rr > limits.rrHigh) out.push({ id: 'rrhi', text: `RR HIGH ${Math.round(s.phys.resp.rr)}`, priority: 'medium' });
    else if (s.phys.resp.rr > 0 && s.phys.resp.rr < limits.rrLow) out.push({ id: 'rrlo', text: `RR LOW ${Math.round(s.phys.resp.rr)}`, priority: 'medium' });
  }
  return out;
}

function useDisplayValues(snapshot: SimSnapshot | null) {
  // Sensor lag for SpO2 (≈ 10–20 s circulation/averaging), in simulated time
  const ref = useRef<{ t: number; spo2: number | null }>({ t: 0, spo2: null });
  if (!snapshot) return { spo2: null as number | null };
  const r = ref.current;
  const sa = snapshot.phys.resp.sao2 * 100;
  if (!snapshot.therapy.monitoring.spo2 || !snapshot.derived.spo2Reliable) {
    r.spo2 = null;
  } else if (r.spo2 == null) r.spo2 = sa;
  else {
    const dt = Math.max(0, snapshot.t - r.t);
    const tau = 12;
    r.spo2 += (sa - r.spo2) * (1 - Math.exp(-dt / tau));
  }
  r.t = snapshot.t;
  return { spo2: r.spo2 };
}

export function Monitor({ compact = false }: { compact?: boolean }) {
  const snapshot = useCase((s) => s.snapshot);
  const speed = useCase((s) => s.speed);
  const dispatch = useCase((s) => s.dispatch);
  const { limits, audioEnabled, alarmsSilencedUntil, set } = useUi();
  const canvases = useRef<Record<string, HTMLCanvasElement | null>>({});
  const { spo2 } = useDisplayValues(snapshot);
  const spo2Ref = useRef<number | null>(null);
  spo2Ref.current = spo2;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const alarms = useMemo(() => (snapshot ? evaluateAlarms(snapshot, limits, spo2) : []), [snapshot, limits, spo2]);
  const silenced = alarmsSilencedUntil > now;
  const topPriority = alarms.some((a) => a.priority === 'high') ? 'high' : alarms.length ? 'medium' : null;

  // Alarm audio
  useEffect(() => {
    if (!audioEnabled || silenced || !topPriority) return;
    audio.alarm(topPriority);
    const id = setInterval(() => audio.alarm(topPriority), topPriority === 'high' ? 3000 : 8000);
    return () => clearInterval(id);
  }, [audioEnabled, silenced, topPriority]);

  // Waveform render loop (independent of React renders)
  useEffect(() => {
    const ecg = new EcgGenerator();
    const pleth = new PlethGenerator();
    const art = new ArtGenerator();
    const co2 = new CapnoGenerator();
    ecg.onBeat = () => {
      pleth.beat();
      art.beat();
      const st = useUi.getState();
      const snap = simClient().latest;
      if (st.audioEnabled && st.qrsTone && snap && (snap.therapy.monitoring.ecg || snap.therapy.monitoring.spo2) && snap.derived.centralPulse) audio.qrsBeep(spo2Ref.current);
    };
    const buffers: Record<string, Float32Array> = {};
    const writeIdx: Record<string, number> = {};
    for (const c of CHANNELS) {
      buffers[c.key] = new Float32Array(SAMPLE_RATE * SWEEP_SECONDS).fill(NaN);
      writeIdx[c.key] = 0;
    }
    let last = performance.now();
    let acc = 0;
    let raf = 0;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const snap = simClient().latest;
      const dtWall = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      const running = (useCase.getState().speed > 0 && snap?.status.phase === 'active') || false;
      if (!snap) return;
      if (running) acc += dtWall * SAMPLE_RATE;
      const n = Math.floor(acc);
      acc -= n;
      const ep = ecgParamsFrom(snap);
      const pp = {
        attached: snap.therapy.monitoring.spo2,
        amplitude: Math.min(1.35, snap.derived.plethAmplitude),
        reliable: snap.derived.spo2Reliable,
        hr: snap.phys.cv.hr,
        pulse: snap.derived.centralPulse && snap.phys.cv.peripheralPerfusion > 0.08,
        cpr: snap.therapy.cpr.active,
        cprRate: ep.cprRate,
      };
      const cp = {
        attached: snap.therapy.monitoring.etco2,
        rr: snap.phys.resp.rr,
        etco2: snap.phys.resp.etco2,
        resistance: snap.phys.resp.resistance,
        ventilated: snap.therapy.bvm.active || snap.therapy.ventilator.on,
      };
      const dt = 1 / SAMPLE_RATE;
      for (let i = 0; i < n; i++) {
        const vals: Record<string, number> = {
          ecg: ecg.sample(dt, ep),
          pleth: pleth.sample(dt, pp),
          art: art.sample(dt, snap.phys.cv.sbp, snap.phys.cv.dbp, snap.derived.centralPulse),
          co2: co2.sample(dt, cp),
        };
        for (const c of CHANNELS) {
          const b = buffers[c.key]!;
          b[writeIdx[c.key]!] = vals[c.key]!;
          writeIdx[c.key] = (writeIdx[c.key]! + 1) % b.length;
        }
      }
      for (const c of CHANNELS) {
        const cvs = canvases.current[c.key];
        if (!cvs) continue;
        draw(cvs, buffers[c.key]!, writeIdx[c.key]!, c, isChannelActive(c.key, snap));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!snapshot) return null;
  const m = snapshot.therapy.monitoring;
  const cv = snapshot.phys.cv;
  const resp = snapshot.phys.resp;
  const ecgOn = m.ecg || snapshot.therapy.defib.padsOn;
  const hrDisplay = ecgOn ? (cv.rhythm === 'vfib' || cv.rhythm === 'asystole' ? '---' : String(Math.round(cv.hr))) : m.spo2 && spo2 != null ? String(Math.round(cv.hr)) : '--';
  const nibp = snapshot.therapy.nibpLast;
  const nibpAge = nibp ? Math.max(0, Math.round((snapshot.t - nibp.t) / 60)) : null;
  const alarmIds = new Set(alarms.map((a) => a.id));
  const channels = CHANNELS.filter((c) => c.key !== 'art' || m.arterialLine);

  return (
    <div className={clsx('flex h-full flex-col bg-mon-bg text-white', compact && 'text-[92%]')} data-testid="monitor">
      {/* header / alarms */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <Gauge size={14} className="text-white/50" />
        <span className="text-[11px] font-semibold tracking-[0.14em] text-white/55">BEDSIDE MONITOR</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            title={audioEnabled ? 'Mute monitor audio' : 'Enable monitor audio'}
            onClick={() => {
              if (!audioEnabled) audio.ensure();
              set({ audioEnabled: !audioEnabled });
            }}
            className="grid h-6 w-6 place-items-center rounded text-white/60 hover:bg-white/10 hover:text-white"
            data-testid="monitor-audio"
          >
            {audioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>
          <button
            title={silenced ? 'Alarms silenced — click to re-enable' : 'Silence alarms for 2 minutes'}
            onClick={() => set({ alarmsSilencedUntil: silenced ? 0 : Date.now() + 120000 })}
            className={clsx('grid h-6 w-6 place-items-center rounded hover:bg-white/10', silenced ? 'text-amber-300' : 'text-white/60 hover:text-white')}
          >
            {silenced ? <BellOff size={14} /> : <Bell size={14} />}
          </button>
        </div>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1.5 overflow-hidden px-2" data-testid="alarm-bar">
        {alarms.length === 0 ? (
          <span className="text-[11px] text-white/35">{Object.values(m).some(Boolean) || snapshot.therapy.defib.padsOn ? 'No active alarms' : 'No monitoring attached'}</span>
        ) : (
          alarms.map((a) => (
            <span key={a.id} className={clsx('rounded px-1.5 py-0.5 font-mono text-[11px] font-bold', a.priority === 'high' ? 'bg-red-600 text-white' : 'bg-amber-400 text-black', !silenced && a.priority === 'high' && 'alarm-flash')}>
              {a.text}
            </span>
          ))
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {channels.map((c) => (
          <div key={c.key} className="flex min-h-0 flex-1 border-t border-white/[0.06]">
            <div className="relative min-w-0 flex-1">
              <span className="absolute left-2 top-1 z-10 font-mono text-[10px] font-semibold" style={{ color: c.color }}>
                {c.label}
                {c.key === 'ecg' && ecgOn && <span className="ml-2 text-white/45">{snapshot.therapy.defib.padsOn && !m.ecg ? 'PADS · ' : ''}{RHYTHM_LABEL[cv.rhythm]}{snapshot.derived.pea ? ' · NO PULSE' : ''}</span>}
                {c.key === 'ecg' && snapshot.therapy.cpr.active && <span className="ml-2 text-amber-300">CPR</span>}
              </span>
              {!isChannelActive(c.key, snapshot) && (
                <span className="absolute inset-0 grid place-items-center font-mono text-[11px] text-white/30">{inactiveLabel(c.key)}</span>
              )}
              <canvas ref={(el) => void (canvases.current[c.key] = el)} className="absolute inset-0 h-full w-full" data-testid={`wave-${c.key}`} />
            </div>
            <div className="flex w-[118px] shrink-0 flex-col justify-center border-l border-white/[0.06] px-2.5">
              {c.key === 'ecg' && <Numeric label="HR" unit="bpm" value={hrDisplay} color={c.color} alarm={alarmIds.has('hrlo') || alarmIds.has('hrhi') || alarmIds.has('vf') || alarmIds.has('asys') || alarmIds.has('vt')} testId="num-hr" />}
              {c.key === 'pleth' && <Numeric label="SpO₂" unit="%" value={m.spo2 ? (spo2 == null ? '?' : String(Math.round(spo2))) : '--'} color={c.color} alarm={alarmIds.has('spo2')} testId="num-spo2" />}
              {c.key === 'art' && <Numeric label="ART" unit="mmHg" value={`${Math.round(cv.sbp)}/${Math.round(cv.dbp)}`} sub={`(${Math.round(cv.map)})`} color={c.color} alarm={alarmIds.has('art')} small testId="num-art" />}
              {c.key === 'co2' && (
                <div className="flex flex-col gap-1">
                  <Numeric label="EtCO₂" unit="mmHg" value={m.etco2 ? String(Math.round(resp.etco2)) : '--'} color={c.color} small testId="num-etco2" />
                  <Numeric label="RR" unit="/min" value={m.etco2 || m.ecg ? String(Math.round(resp.rr)) : '--'} color={c.color} small alarm={alarmIds.has('rrhi') || alarmIds.has('rrlo') || alarmIds.has('apnea')} testId="num-rr" />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* NIBP + temperature row */}
      <div className="grid shrink-0 grid-cols-[1fr_auto] gap-2 border-t border-white/10 px-3 py-2">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-semibold tracking-wider text-white/55">NIBP</span>
            <span className="text-[10px] text-white/35">
              {snapshot.derived.nibpMeasuring ? <span className="pulse-dot text-white/80">measuring…</span> : nibp ? (nibp.ok ? `${nibpAge} min ago` : 'failed — no pulse') : m.nibp ? 'waiting' : 'cuff off'}
              {m.nibp && snapshot.therapy.nibpIntervalMin > 0 ? ` · auto ${snapshot.therapy.nibpIntervalMin}′` : ''}
            </span>
          </div>
          <div className={clsx('tabular font-light leading-none text-mon-nibp', compact ? 'text-[28px]' : 'text-[32px]', (alarmIds.has('nibplo') || alarmIds.has('nibphi')) && 'text-red-400')} data-testid="num-nibp">
            {nibp?.ok ? (
              <>
                {nibp.sbp}/{nibp.dbp}
                <span className="ml-1.5 text-[16px] text-white/60">({nibp.map})</span>
              </>
            ) : (
              <span className="text-white/35">---/---</span>
            )}
          </div>
          <div className="mt-1.5 flex gap-1">
            <button className="rounded bg-white/10 px-2 py-0.5 text-[10.5px] font-medium hover:bg-white/20" onClick={() => dispatch({ type: 'nibp.measure' })} data-testid="nibp-start">
              Start NIBP
            </button>
            {[1, 3, 5, 15].map((mm) => (
              <button key={mm} className={clsx('rounded px-1.5 py-0.5 text-[10.5px] hover:bg-white/20', snapshot.therapy.nibpIntervalMin === mm ? 'bg-white/25 text-white' : 'bg-white/5 text-white/60')} onClick={() => dispatch({ type: 'nibp.interval', minutes: mm })}>
                {mm}′
              </button>
            ))}
          </div>
        </div>
        <div className="text-right">
          <span className="text-[10px] font-semibold tracking-wider text-white/55">TEMP</span>
          <div className="tabular text-[24px] font-light leading-tight text-mon-temp" data-testid="num-temp">
            {m.temp ? snapshot.phys.thermo.core.toFixed(1) : '--.-'}
            <span className="ml-0.5 text-[11px] text-white/50">°C</span>
          </div>
        </div>
      </div>
      {speed > 1 && <div className="shrink-0 border-t border-white/10 px-3 py-1 text-[10px] text-white/40">Time ×{speed}: waveforms drawn at real-time sweep for readability; numerics follow simulated time.</div>}
    </div>
  );
}

function isChannelActive(key: ChannelDef['key'], s: SimSnapshot): boolean {
  const m = s.therapy.monitoring;
  if (key === 'ecg') return m.ecg || s.therapy.defib.padsOn;
  if (key === 'pleth') return m.spo2;
  if (key === 'art') return m.arterialLine;
  return m.etco2;
}

function inactiveLabel(key: ChannelDef['key']): string {
  return key === 'ecg' ? 'ECG leads off' : key === 'pleth' ? 'SpO₂ probe off' : key === 'art' ? 'No arterial line' : 'Capnography off';
}

function Numeric({ label, unit, value, color, sub, alarm, small, testId }: { label: string; unit: string; value: string; color: string; sub?: string; alarm?: boolean; small?: boolean; testId?: string }) {
  return (
    <div className={clsx('rounded px-1', alarm && 'bg-red-600/25')}>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold tracking-wider" style={{ color }}>
          {label}
        </span>
        <span className="text-[9px] text-white/40">{unit}</span>
      </div>
      <div className={clsx('tabular text-right font-light leading-none', small ? 'text-[22px]' : 'text-[40px]', alarm && 'alarm-flash')} style={{ color }} data-testid={testId}>
        {value}
        {sub && <span className="ml-1 text-[12px] opacity-70">{sub}</span>}
      </div>
    </div>
  );
}

function draw(cvs: HTMLCanvasElement, buf: Float32Array, head: number, c: ChannelDef, active: boolean): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cvs.clientWidth;
  const h = cvs.clientHeight;
  if (w === 0 || h === 0) return;
  if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
    cvs.width = Math.round(w * dpr);
    cvs.height = Math.round(h * dpr);
  }
  const ctx = cvs.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!active) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.6);
    ctx.lineTo(w, h * 0.6);
    ctx.stroke();
    return;
  }
  const n = buf.length;
  const pad = 14;
  const top = pad;
  const bottom = h - 6;
  const y = (v: number) => bottom - ((v - c.min) / (c.max - c.min)) * (bottom - top);
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = c.color;
  ctx.shadowColor = c.color;
  ctx.shadowBlur = 3;
  ctx.beginPath();
  let pen = false;
  const gap = Math.floor(n * 0.03);
  for (let i = 0; i < n; i++) {
    const dist = (i - head + n) % n;
    if (dist < gap) {
      pen = false;
      continue;
    }
    const v = buf[i]!;
    if (Number.isNaN(v)) {
      pen = false;
      continue;
    }
    const x = (i / n) * w;
    const yy = Math.max(2, Math.min(h - 2, y(v)));
    if (!pen) {
      ctx.moveTo(x, yy);
      pen = true;
    } else ctx.lineTo(x, yy);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}
