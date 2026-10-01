// Builds the competition submission package:
//   submission/Vitalis-submission.zip      (demo video + project brief)
//   submission/Vitalis-Submission.pdf      (title, authors, download link, MD5 of the zip)
//
// Usage:
//   node scripts/make-submission.mjs --url "https://…/Vitalis-submission.zip" --authors "Name One, Name Two" [--affiliation "…"] [--email "…"]
//
// The zip is created once and then reused, so re-running this script to change the URL or the authors
// does NOT change the MD5. Pass --rebuild only if the video or brief changed (then re-upload the zip).
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const TITLE = 'Vitalis: A Physiology-Driven Procedural 3D Human for Real-Time Emergency Medicine Simulation';
const AUTHORS = opt('authors', 'AUTHOR NAME(S)');
const AFFILIATION = opt('affiliation', '');
const EMAIL = opt('email', '');
const URL = opt('url', 'https://REPLACE-WITH-DOWNLOAD-LINK/Vitalis-submission.zip');

const OUT = resolve('submission');
const ZIP = join(OUT, 'Vitalis-submission.zip');
const FILES = [
  ['video/out/vitalis-demo.mp4', 'Vitalis-demo.mp4'],
  ['docs/Vitalis-Project-Brief.pdf', 'Vitalis-Project-Brief.pdf'],
];
mkdirSync(OUT, { recursive: true });

if (args.includes('--rebuild') || !existsSync(ZIP)) {
  for (const [src] of FILES) if (!existsSync(src)) throw new Error(`Missing ${src} — render the video / brief first.`);
  const stage = join(OUT, '.stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const [src, name] of FILES) copyFileSync(src, join(stage, name));
  writeFileSync(
    join(stage, 'README.txt'),
    [
      TITLE,
      '',
      'Contents',
      '  Vitalis-demo.mp4           Walkthrough of a full simulated case (1920x1080, H.264).',
      '  Vitalis-Project-Brief.pdf  Two-page summary: how it is used, core features, hardest parts.',
      '',
      'Educational simulation only. Not a medical device and not clinical decision support.',
      '',
    ].join('\r\n'),
  );
  rmSync(ZIP, { force: true });
  const py = `import zipfile,os,sys\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\n[z.write(os.path.join(sys.argv[2],f),f) for f in sorted(os.listdir(sys.argv[2]))]\nz.close()`;
  const r = spawnSync('python', ['-c', py, ZIP, stage], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Could not create the zip (python is required).');
  rmSync(stage, { recursive: true, force: true });
  console.log('zip created');
} else {
  console.log('zip already exists — reusing it (MD5 unchanged). Use --rebuild to recreate.');
}

const md5 = createHash('md5').update(readFileSync(ZIP)).digest('hex');
const sizeMb = (statSync(ZIP).size / 1048576).toFixed(1);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(TITLE)}</title><style>
@page { size: A4; margin: 24mm 22mm; }
html { font-family: "Segoe UI", Arial, sans-serif; color: #18202b; font-size: 11pt; line-height: 1.45; }
h1 { font-size: 20pt; line-height: 1.2; margin: 0 0 10pt; letter-spacing: -0.3pt; }
.authors { font-size: 13pt; font-weight: 600; margin: 0; }
.aff { color: #46556a; margin: 2pt 0 0; }
h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 1pt; color: #0f4c5c; margin: 26pt 0 6pt; padding-bottom: 3pt; border-bottom: 1pt solid #cfd8e3; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 6pt 8pt 6pt 0; border-bottom: 0.6pt solid #dbe2ea; }
th { width: 26%; color: #46556a; font-weight: 600; }
.mono { font-family: Consolas, "Courier New", monospace; font-size: 11.5pt; word-break: break-all; }
a { color: #0b5cad; word-break: break-all; }
p { margin: 0 0 7pt; }
.note { margin-top: 20pt; font-size: 9.5pt; color: #56657a; }
</style></head><body>
<h1>${esc(TITLE)}</h1>
<p class="authors">${esc(AUTHORS)}</p>
${AFFILIATION ? `<p class="aff">${esc(AFFILIATION)}</p>` : ''}
${EMAIL ? `<p class="aff">${esc(EMAIL)}</p>` : ''}

<h2>Supplementary material</h2>
<table>
  <tr><th>Download link</th><td><a href="${esc(URL)}">${esc(URL)}</a></td></tr>
  <tr><th>File</th><td>Vitalis-submission.zip (${sizeMb} MB)</td></tr>
  <tr><th>MD5</th><td class="mono">${md5}</td></tr>
</table>

<h2>Contents of the zip</h2>
<table>
  <tr><th>Vitalis-demo.mp4</th><td>Walkthrough of a full simulated case, 1920×1080, H.264.</td></tr>
  <tr><th>Vitalis-Project-Brief.pdf</th><td>Two-page summary: how the simulator is used, its core features and the hardest parts of the build.</td></tr>
  <tr><th>README.txt</th><td>List of contents.</td></tr>
</table>

<h2>Verifying the download</h2>
<p>The MD5 of the downloaded zip must equal the value above.</p>
<p class="mono" style="font-size:10pt">Windows: certutil -hashfile Vitalis-submission.zip MD5<br>macOS: md5 Vitalis-submission.zip<br>Linux: md5sum Vitalis-submission.zip</p>

<p class="note">Vitalis is an educational simulation. It is not a medical device or clinical decision support, and its physiology has not been clinically validated.</p>
</body></html>`;

const htmlPath = join(OUT, 'submission.html');
writeFileSync(htmlPath, html);
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(pathToFileURL(htmlPath).href);
await p.pdf({ path: join(OUT, 'Vitalis-Submission.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
await b.close();
rmSync(htmlPath, { force: true });
console.log(`MD5  ${md5}\nZIP  ${ZIP} (${sizeMb} MB)\nPDF  ${join(OUT, 'Vitalis-Submission.pdf')}\nURL  ${URL}\nBY   ${AUTHORS}`);
