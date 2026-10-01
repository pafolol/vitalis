// Usage: node scripts/shot.mjs <name> [width] [height] -- steps as JSON in env STEPS
import { chromium } from '@playwright/test';
const [name = 'shot', w = '1600', h = '960'] = process.argv.slice(2);
const steps = JSON.parse(process.env.STEPS ?? '[]');
const browser = await chromium.launch({ headless: process.env.HEADED !== '1', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'networkidle' });
for (const s of steps) {
  if (s.click) await page.locator(s.click).first().click({ timeout: 15000 });
  if (s.fill) await page.locator(s.fill[0]).first().fill(s.fill[1]);
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.waitFor) await page.locator(s.waitFor).first().waitFor({ timeout: 30000 });
  if (s.key) await page.keyboard.press(s.key);
  if (s.shot) await page.screenshot({ path: `qa-screenshots/tmp/${s.shot}.png` });
}
await page.screenshot({ path: `qa-screenshots/tmp/${name}.png` });
console.log(logs.slice(0, 30).join('\n') || 'no console errors');
await browser.close();
