/* global document, window, requestAnimationFrame */
// Records the demo clips for the submission video.
//
// Drives the running app (default http://localhost:4321) through a real use case with Playwright,
// captures browser frames over the DevTools screencast, and encodes each segment to an MP4 clip with ffmpeg.
//
//   node scripts/record-demo.mjs            → clips in video/public/clips/*.mp4 (+ clips.json)
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const URL = process.env.URL ?? 'http://localhost:4321/';
const OUT = resolve('video/public/clips');
const TMP = resolve('video/.frames');
const W = 1600;
const H = 900;
const only = process.argv[2]; // optional: 'case' | 'arrest'
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: process.env.HEADED !== '1', channel: process.env.CHANNEL || undefined, args: [...(process.env.HEADED === '1' ? ['--window-position=-2600,-2600', '--window-size=1936,1200'] : []), '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--force_high_performance_gpu'] });
const clips = [];

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // visible cursor + click ripple (headless browsers draw no pointer)
  await ctx.addInitScript(() => {
    const make = () => {
      if (document.getElementById('__cursor')) return;
      const c = document.createElement('div');
      c.id = '__cursor';
      c.style.cssText =
        'position:fixed;left:0;top:0;width:22px;height:22px;margin:-3px 0 0 -3px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);' +
        "background:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M4 2l15 11-7 1.2L8.6 21z' fill='white' stroke='black' stroke-width='1.6' stroke-linejoin='round'/></svg>\") no-repeat;";
      document.documentElement.appendChild(c);
      window.addEventListener('mousemove', (e) => (c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`), true);
      window.addEventListener(
        'mousedown',
        (e) => {
          const r = document.createElement('div');
          r.style.cssText = `position:fixed;left:${e.clientX - 16}px;top:${e.clientY - 16}px;width:32px;height:32px;border-radius:50%;border:2px solid rgba(80,200,230,.95);z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out;`;
          document.documentElement.appendChild(r);
          requestAnimationFrame(() => {
            r.style.transform = 'scale(2)';
            r.style.opacity = '0';
          });
          setTimeout(() => r.remove(), 500);
        },
        true,
      );
    };
    if (document.documentElement) make();
    document.addEventListener('DOMContentLoaded', make);
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  let frames = null;
  cdp.on('Page.screencastFrame', (f) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    if (!frames) return;
    const i = frames.list.length;
    const file = join(frames.dir, `${String(i).padStart(6, '0')}.jpg`);
    frames.writes.push(writeFile(file, Buffer.from(f.data, 'base64')));
    frames.list.push({ file, t: f.metadata.timestamp });
  });

  const rec = {
    async start(name) {
      const dir = join(TMP, name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      frames = { name, dir, list: [], marks: {}, writes: [] };
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    },
    /** remember a moment inside the current clip (seconds from clip start) */
    mark(key) {
      if (frames && frames.list.length) frames.marks[key] = frames.list[frames.list.length - 1].t - frames.list[0].t;
    },
    async stop() {
      await page.waitForTimeout(150);
      await cdp.send('Page.stopScreencast');
      const f = frames;
      frames = null;
      if (!f || f.list.length < 2) return;
      await Promise.all(f.writes);
      const lines = [];
      for (let i = 0; i < f.list.length; i++) {
        const d = i + 1 < f.list.length ? Math.max(0.001, f.list[i + 1].t - f.list[i].t) : 0.04;
        lines.push(`file '${f.list[i].file.replace(/\\/g, '/')}'`, `duration ${d.toFixed(4)}`);
      }
      lines.push(`file '${f.list[f.list.length - 1].file.replace(/\\/g, '/')}'`);
      const listFile = join(f.dir, 'list.txt');
      writeFileSync(listFile, lines.join('\n'));
      const out = join(OUT, `${f.name}.mp4`);
      const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=30,scale=${W}:${H}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`ffmpeg failed for ${f.name}`);
      const duration = f.list[f.list.length - 1].t - f.list[0].t;
      clips.push({ name: f.name, file: `clips/${f.name}.mp4`, duration: +duration.toFixed(2), frames: f.list.length, marks: f.marks });
      console.log(`clip ${f.name}: ${duration.toFixed(1)} s, ${f.list.length} frames`);
      rmSync(f.dir, { recursive: true, force: true });
    },
  };

  const move = async (loc) => {
    const b = await loc.first().boundingBox();
    if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 22 });
    await page.waitForTimeout(160);
  };
  const click = async (sel, wait = 500) => {
    const loc = typeof sel === 'string' ? page.locator(sel) : sel;
    await loc.first().waitFor({ timeout: 30000 });
    await move(loc);
    await loc.first().click();
    await page.waitForTimeout(wait);
  };
  const tid = (id) => `[data-testid="${id}"]`;
  const pause = (ms) => page.waitForTimeout(ms);
  return { page, rec, click, move, tid, pause };
}

async function openCase(ctx, scenario, seed) {
  const { page, tid } = ctx;
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.locator(tid('seed-input')).fill(seed);
  return scenario;
}

// ───────────────────────────────────────────────────────────── main use case: anaphylaxis
async function recordCase() {
  const ctx = await newPage();
  const { page, rec, click, move, tid, pause } = ctx;
  await openCase(ctx, 'swelling-after-dinner', 'VITALIS-6');
  await page.mouse.move(900, 500);

  // 1. start screen + AI scenario generation (validated against the simulator schema)
  await rec.start('01-start');
  await pause(1200);
  await move(page.locator(tid('scenario-grid')));
  await page.mouse.wheel(0, 380);
  await pause(1300);
  await page.mouse.wheel(0, -380);
  await pause(700);
  await click(tid('ai-scenario-prompt'), 200);
  await page.locator(tid('ai-scenario-prompt')).fill('');
  await page.locator(tid('ai-scenario-prompt')).pressSequentially('An elderly farmer stung by wasps who becomes wheezy and faint', { delay: 28 });
  await pause(400);
  await click(page.getByRole('button', { name: 'Generate scenario' }), 1800);
  rec.mark('generating');
  await page.getByRole('button', { name: 'Start generated case' }).waitFor({ timeout: 170000 });
  rec.mark('generated');
  await move(page.getByRole('button', { name: 'Start generated case' }));
  await pause(3000);
  await rec.stop();

  // 2. handover + first look at the patient
  await rec.start('02-arrival');
  await click(tid('scenario-swelling-after-dinner'), 300);
  await page.locator(tid('handoff')).waitFor({ timeout: 60000 });
  await pause(3200);
  await click(tid('receive-patient'), 300);
  await page.locator(tid('case-screen')).waitFor();
  await page.locator(tid('er-stage-loading')).waitFor({ state: 'hidden', timeout: 60000 });
  rec.mark('loaded');
  await pause(2500);
  await click(tid('preset-head'), 2600);
  await click(tid('preset-chest'), 2400);
  await click(tid('preset-full'), 2000);
  await rec.stop();

  // 3. monitoring + primary survey
  await rec.start('03-monitor-exam');
  await click(tid('rail-assess'), 700);
  await click(page.getByText('Attach monitoring'), 3500);
  await click(tid('nibp-start'), 600);
  await click(page.locator(tid('exam-buttons')).getByText('Breathing', { exact: true }), 1400);
  await click(page.locator(tid('exam-buttons')).getByText('Exposure / skin', { exact: true }), 1400);
  await click(page.locator(tid('exam-buttons')).getByText('Circulation', { exact: true }), 2600);
  await rec.stop();

  // 4. auscultation on the 3D body
  await rec.start('04-auscultate');
  await click(tid('rail-assess'), 500); // close drawer
  await click(tid('preset-chest'), 2000);
  await click(tid('tool-stethoscope'), 500);
  const vp = (await page.locator(tid('viewport')).boundingBox());
  await page.mouse.move(vp.x + vp.width * 0.5, vp.y + vp.height * 0.48, { steps: 25 });
  await pause(300);
  await page.mouse.down();
  await page.mouse.up();
  await pause(3800);
  await click(page.locator(`${tid('exam-popover')} button`).first(), 300);
  await click(tid('tool-pointer'), 300);
  await click(tid('preset-full'), 1500);
  await rec.stop();

  // 5. talk to the AI patient
  await rec.start('05-talk');
  await click(tid('rail-talk'), 700);
  await click(tid('chat-input'), 150);
  await page.locator(tid('chat-input')).pressSequentially('What happened? Are you allergic to anything?', { delay: 30 });
  await click(tid('chat-send'), 300);
  rec.mark('asked');
  await page.locator(`${tid('chat-log')} li`).nth(1).waitFor({ timeout: 60000 });
  rec.mark('replied');
  await pause(4500);
  await rec.stop();

  // 6. treat: IM adrenaline + high-flow oxygen
  await rec.start('06-treat');
  await click(tid('rail-meds'), 700);
  await click(tid('drug-search'), 150);
  await page.locator(tid('drug-search')).pressSequentially('adren', { delay: 60 });
  await pause(500);
  await click(tid('drug-epinephrine'), 900);
  await click(tid('route-IM'), 500);
  await click(tid('give-drug'), 1600);
  await click(tid('rail-airway'), 800);
  await click(tid('o2-nonRebreather'), 1800);
  await rec.stop();

  // 7. response over simulated minutes (drug levels + trends)
  await rec.start('07-response');
  await click(tid('rail-pharm'), 900);
  await click(page.locator(tid('topbar')).getByRole('radio', { name: '10×' }), 400);
  await page.mouse.move(vp.x + vp.width * 0.6, vp.y + vp.height * 0.8, { steps: 15 });
  await pause(24000);
  await click(page.locator(tid('topbar')).getByRole('radio', { name: '1×' }), 1500);
  await rec.stop();

  // 8. anatomy layers driven by physiology
  await rec.start('08-anatomy');
  await click(tid('rail-anatomy'), 800);
  await click(page.getByRole('button', { name: 'Heart & lungs (live)' }), 5200);
  await click(page.getByRole('button', { name: 'Skeleton' }), 600);
  await click(tid('preset-full'), 3200);
  await click(page.getByRole('button', { name: 'X-ray skin + organs' }), 3600);
  await click(page.getByRole('button', { name: 'Clinical (skin)' }), 1400);
  await rec.stop();

  // 9. diagnostics with turnaround time
  await rec.start('09-tests');
  await click(tid('rail-diagnostics'), 800);
  await click(tid('order-vbg'), 500);
  await click(tid('order-ecg12'), 700);
  await click(page.locator(tid('topbar')).getByRole('radio', { name: '10×' }), 300);
  await page.locator(tid('order-row-vbg')).filter({ hasText: /abnormal|resulted|normal/i }).waitFor({ timeout: 90000 });
  await click(page.locator(tid('topbar')).getByRole('radio', { name: '1×' }), 300);
  await click(tid('order-row-vbg'), 3000);
  await click(tid('order-row-ecg12'), 3800).catch(() => {});
  await rec.stop();

  await recordDebriefOn(ctx);
  await page.context().close();
}

async function recordDebriefOn(ctx) {
  const { page, rec, click, tid, pause } = ctx;
  // 10. end the case → debrief
  await rec.start('10-debrief');
  await click(tid('end-case'), 800);
  await click(tid('diagnosis-input'), 150);
  await page.locator(tid('diagnosis-input')).pressSequentially('Anaphylaxis', { delay: 45 });
  await pause(500);
  await click(tid('submit-end'), 400);
  await page.locator(tid('debrief')).waitFor({ timeout: 60000 });
  rec.mark('debrief');
  await pause(3000);
  const dv = await page.locator(tid('debrief')).boundingBox();
  await page.mouse.move(dv.x + dv.width * 0.42, dv.y + dv.height * 0.6, { steps: 10 });
  const smoothScroll = async (px) => {
    for (let y = 0; y < px; y += 24) {
      await page.mouse.wheel(0, 24);
      await pause(28);
    }
  };
  await smoothScroll(520);
  rec.mark('decisions');
  await pause(3500);
  await smoothScroll(420);
  rec.mark('responses');
  await pause(3000);
  await click(tid('ai-debrief'), 600);
  rec.mark('aiRequested');
  await page.locator(tid('ai-debrief-view')).waitFor({ timeout: 120000 }).catch(() => console.log('AI debrief not shown in time'));
  rec.mark('aiDebrief');
  await pause(1500);
  await smoothScroll(520);
  rec.mark('aiScrolled');
  await pause(3000);
  await rec.stop();
}

/** Quick unrecorded run of the same case (same seed and treatment), then record only the debrief. */
async function recordDebriefOnly() {
  const ctx = await newPage();
  const { page, click, tid } = ctx;
  await openCase(ctx, 'swelling-after-dinner', 'VITALIS-6');
  await click(tid('scenario-swelling-after-dinner'), 300);
  await click(tid('receive-patient'), 300);
  await page.locator(tid('er-stage-loading')).waitFor({ state: 'hidden', timeout: 60000 });
  await click(tid('rail-assess'), 400);
  await click(page.getByText('Attach monitoring'), 800);
  await click(page.locator(tid('exam-buttons')).getByText('Breathing', { exact: true }), 400);
  await click(page.locator(tid('exam-buttons')).getByText('Exposure / skin', { exact: true }), 400);
  await click(tid('rail-talk'), 400);
  await page.locator(tid('chat-input')).fill('What happened? Are you allergic to anything?');
  await click(tid('chat-send'), 300);
  await page.locator(`${tid('chat-log')} li`).nth(1).waitFor({ timeout: 60000 });
  await click(tid('rail-meds'), 400);
  await click(tid('drug-epinephrine'), 500);
  await click(tid('route-IM'), 300);
  await click(tid('give-drug'), 600);
  await click(tid('rail-airway'), 400);
  await click(tid('o2-nonRebreather'), 500);
  await click(tid('rail-diagnostics'), 400);
  await click(tid('order-vbg'), 300);
  await click(page.getByRole('button', { name: '+5 min' }), 4000);
  await click(page.getByRole('button', { name: '+5 min' }), 4000);
  await click(tid('rail-diagnostics'), 400);
  console.log('case prepared, recording debrief');
  await recordDebriefOn(ctx);
  await page.context().close();
}

// ───────────────────────────────────────────────────────────── cardiac arrest: CPR + defibrillation
async function recordArrest() {
  const ctx = await newPage();
  const { page, rec, click, tid, pause } = ctx;
  await openCase(ctx, 'collapsed-gym', 'FBVW-24X8');
  await click(tid('scenario-collapsed-gym'), 300);
  await click(tid('receive-patient'), 300);
  await page.locator(tid('er-stage-loading')).waitFor({ state: 'hidden', timeout: 60000 });
  await pause(1500);
  await rec.start('11-arrest');
  await pause(2500);
  await click(tid('rail-circulation'), 1200);
  await click(tid('defib-charge'), 1500);
  await click(tid('defib-shock'), 300);
  rec.mark('shock');
  await pause(2600);
  await click(tid('cpr-stop'), 300); // rhythm check: organised rhythm returns
  rec.mark('rosc');
  await pause(6500);
  await rec.stop();
  await page.context().close();
}

try {
  if (!only || only === 'case') await recordCase();
  if (only === 'debrief') await recordDebriefOnly();
  if (!only || only === 'arrest') await recordArrest();
} finally {
  await browser.close();
  writeFileSync(join(OUT, only ? `clips-${only}.json` : 'clips.json'), JSON.stringify(clips, null, 2));
  rmSync(TMP, { recursive: true, force: true });
}
