import type { AuscultationResult } from '@/sim/exam/findings';

/**
 * WebAudio synthesis: monitor tones and procedural auscultation.
 * - QRS "beep" pitch rises with SpO2 (as on real pulse oximeters).
 * - Alarm tones follow high/medium priority burst patterns.
 * - Auscultation: band-passed noise shaped by the simulated respiratory cycle
 *   (intensity = local ventilation), sinusoidal wheeze in expiration,
 *   crackle clicks in late inspiration, stridor, and S1/S2 heart sounds timed
 *   from the simulated heart rate.
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ausc: { stop: () => void; update: (r: AuscultationResult) => void } | null = null;

  ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuffer.getChannelData(0);
      // deterministic noise (LCG) — audio texture only
      let x = 12345;
      for (let i = 0; i < len; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        d[i] = (x / 0x7fffffff) * 2 - 1;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private tone(freq: number, dur: number, gain = 0.15, type: OscillatorType = 'sine', when = 0): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator();
    const gn = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    gn.gain.setValueAtTime(0, t0);
    gn.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    gn.gain.setValueAtTime(gain, t0 + dur - 0.02);
    gn.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(gn).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  qrsBeep(spo2: number | null): void {
    const f = spo2 == null ? 880 : 520 + Math.max(0, Math.min(100, spo2) - 70) * 14;
    this.tone(f, 0.06, 0.07, 'sine');
  }

  alarm(priority: 'high' | 'medium'): void {
    if (priority === 'high') {
      const seq = [0, 0.14, 0.28, 0.6, 0.74];
      seq.forEach((w) => this.tone(988, 0.11, 0.12, 'square', w));
    } else {
      [0, 0.22, 0.44].forEach((w) => this.tone(660, 0.16, 0.09, 'triangle', w));
    }
  }

  click(): void {
    this.tone(1400, 0.02, 0.05, 'square');
  }

  /** Start (or update) looped auscultation for a zone. Returns a stop function. */
  startAuscultation(initial: AuscultationResult): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noiseBuffer) return;
    this.stopAuscultation();
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(this.master);

    // Breath noise path
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.7;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0;
    src.connect(bp).connect(breathGain).connect(out);
    src.start();

    // Wheeze oscillator
    const wh = ctx.createOscillator();
    wh.type = 'sine';
    wh.frequency.value = 460;
    const wh2 = ctx.createOscillator();
    wh2.type = 'sine';
    wh2.frequency.value = 610;
    const whGain = ctx.createGain();
    whGain.gain.value = 0;
    wh.connect(whGain);
    wh2.connect(whGain);
    whGain.connect(out);
    wh.start();
    wh2.start();

    // Stridor (harsh, inspiratory)
    const st = ctx.createOscillator();
    st.type = 'sawtooth';
    st.frequency.value = 310;
    const stF = ctx.createBiquadFilter();
    stF.type = 'bandpass';
    stF.frequency.value = 900;
    const stGain = ctx.createGain();
    stGain.gain.value = 0;
    st.connect(stF).connect(stGain).connect(out);
    st.start();

    let state = initial;
    let running = true;
    let breathPhase = 0;
    let heartPhase = 0;
    let last = ctx.currentTime;
    const tick = () => {
      if (!running) return;
      const now = ctx.currentTime;
      const dt = now - last;
      last = now;
      const r = state;
      // respiratory cycle (I:E ≈ 1:2)
      if (r.respRate > 0.5) breathPhase = (breathPhase + (dt * r.respRate) / 60) % 1;
      const insp = breathPhase < 0.35;
      const x = insp ? breathPhase / 0.35 : (breathPhase - 0.35) / 0.65;
      const inspEnv = insp ? Math.sin(x * Math.PI) : 0;
      const expEnv = !insp ? Math.sin(x * Math.PI) * 0.6 : 0;
      const bronchial = r.breathQuality === 'bronchial' || r.kind === 'trachea';
      bp.frequency.value = bronchial ? 900 : 380;
      const breathLevel = r.breathIntensity * (bronchial ? inspEnv * 0.9 + expEnv * 1.2 : inspEnv + expEnv * 0.35) * 0.35;
      breathGain.gain.setTargetAtTime(breathLevel + r.snoring * inspEnv * 0.15, now, 0.02);
      whGain.gain.setTargetAtTime(r.wheeze * expEnv * 0.07, now, 0.03);
      stGain.gain.setTargetAtTime(r.stridor * inspEnv * 0.08, now, 0.02);
      // crackles: sparse clicks in late inspiration
      if (r.crackles > 0.15 && insp && x > 0.5) {
        const prob = r.crackles * dt * 60;
        if ((Math.sin(now * 997.3) + 1) / 2 < prob) this.crackle(out, 0.12 * r.crackles);
      }
      // heart sounds
      if (r.heartIntensity > 0.02 && r.heartRate > 5) {
        const prev = heartPhase;
        heartPhase = (heartPhase + (dt * r.heartRate) / 60) % 1;
        if (prev > heartPhase) this.heartSound(out, 55, r.heartIntensity * 0.5); // S1
        const s2At = Math.min(0.42, 0.33 + 20 / Math.max(40, r.heartRate) / 10);
        if (prev < s2At && heartPhase >= s2At) this.heartSound(out, 80, r.heartIntensity * 0.35); // S2
        const s3At = s2At + 0.12;
        if (r.s3 && prev < s3At && heartPhase >= s3At) this.heartSound(out, 35, r.heartIntensity * 0.25);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    this.ausc = {
      update: (r) => {
        state = r;
      },
      stop: () => {
        running = false;
        out.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        setTimeout(() => {
          try {
            src.stop();
            wh.stop();
            wh2.stop();
            st.stop();
          } catch {
            /* already stopped */
          }
          out.disconnect();
        }, 200);
      },
    };
  }

  updateAuscultation(r: AuscultationResult): void {
    this.ausc?.update(r);
  }

  stopAuscultation(): void {
    this.ausc?.stop();
    this.ausc = null;
  }

  private crackle(out: AudioNode, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const gn = ctx.createGain();
    const t0 = ctx.currentTime;
    gn.gain.setValueAtTime(gain, t0);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.012);
    src.connect(hp).connect(gn).connect(out);
    src.start(t0, Math.abs(Math.sin(t0 * 13.1)) * 1.5, 0.02);
  }

  private heartSound(out: AudioNode, freq: number, gain: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.4, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(freq, ctx.currentTime + 0.05);
    const gn = ctx.createGain();
    const t0 = ctx.currentTime;
    gn.gain.setValueAtTime(0, t0);
    gn.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
    o.connect(gn).connect(out);
    o.start(t0);
    o.stop(t0 + 0.13);
  }
}

export const audio = new AudioEngine();
