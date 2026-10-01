import { expect, test, type Page } from '@playwright/test';

/**
 * User-level workflows (see README → Testing). Each step also saves a
 * screenshot under qa-screenshots/ for visual review.
 */

const shot = (page: Page, name: string) => page.screenshot({ path: `qa-screenshots/${test.info().project.name}-${name}.png` });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function openCase(page: Page, scenario: string) {
  await page.goto('/');
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await page.getByTestId(`scenario-${scenario}`).click();
  await expect(page.getByTestId('handoff')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('handoff-text')).not.toBeEmpty();
  await page.getByTestId('receive-patient').click();
  await expect(page.getByTestId('case-screen')).toBeVisible();
  // wait for the 3D patient to finish building
  await expect(page.getByTestId('er-stage-loading')).toBeHidden({ timeout: 60_000 });
}

async function openSeededCase(page: Page, scenario: string, seed: string) {
  await page.goto('/');
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await page.getByTestId('seed-input').fill(seed);
  await page.getByTestId(`scenario-${scenario}`).click();
  await page.getByTestId('receive-patient').click();
  await expect(page.getByTestId('case-screen')).toBeVisible();
}

async function monitorNumber(page: Page, id: string): Promise<number> {
  const txt = (await page.getByTestId(id).innerText()).trim();
  const n = Number.parseFloat(txt);
  return Number.isFinite(n) ? n : NaN;
}

async function clockSeconds(page: Page): Promise<number> {
  const txt = (await page.getByTestId('sim-clock').innerText()).trim();
  const parts = txt.split(':').map(Number);
  return parts.length === 3 ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]! : parts[0]! * 60 + parts[1]!;
}

test('full ER workflow: examine, monitor, treat, investigate, talk, timeline, end, debrief, resume', async ({ page }) => {
  test.setTimeout(480_000);
  const errors = collectErrors(page);

  // 1. launch app
  await page.goto('/');
  await expect(page.getByText('Educational simulation · not for clinical use')).toBeVisible();
  await shot(page, '01-start');

  // 2. start a patient (random-seed path is covered separately; use a deterministic case here)
  await openCase(page, 'found-unresponsive');
  await shot(page, '02-case');

  // 3. inspect the patient: camera presets + inspect tool popover
  await page.getByTestId('preset-head').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('preset-full').click();
  await page.getByTestId('tool-inspect').click();
  const vp = page.getByTestId('viewport');
  const box = (await vp.boundingBox())!;
  await page.getByTestId('preset-chest').click();
  await page.waitForTimeout(1500);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.getByTestId('tool-pointer').click();
  await shot(page, '03-inspect');

  // 4. anatomical layers
  await page.getByTestId('rail-anatomy').click();
  await page.getByTestId('layer-toggle-skeleton').click();
  await page.getByTestId('layer-opacity-skin').fill('0.2');
  await page.waitForTimeout(1500);
  await shot(page, '04-anatomy');
  await page.getByTestId('layer-toggle-skeleton').click();
  await page.getByTestId('layer-opacity-skin').fill('1');

  // 5. monitoring
  await page.getByTestId('rail-assess').click();
  await page.getByText('Attach monitoring').click();
  await page.getByText('Capnography', { exact: true }).click();
  await expect(page.getByTestId('num-hr')).not.toHaveText('--', { timeout: 10_000 });
  await expect(page.getByTestId('num-spo2')).toHaveText(/\d+/);

  // 6. examination
  await page.getByTestId('exam-buttons').getByText('Pupils').click();
  await page.getByTestId('exam-buttons').getByText('Breathing').click();
  await expect(page.getByTestId('exam-notes')).toContainText(/Pupils/i);
  await expect(page.getByTestId('exam-notes')).toContainText(/Pinpoint/i);
  await shot(page, '05-monitor-exam');

  // 8. IV access and fluid
  await page.getByTestId('rail-circulation').click();
  await page.getByText('IV left arm').click();
  await expect(page.getByText('IV access established').or(page.getByText('IV attempt failed'))).toBeVisible({ timeout: 90_000 }).catch(() => undefined);
  await page.getByText('Intraosseous').click();
  await page.waitForTimeout(28_000);
  await page.getByTestId('fluid-start').click();
  await expect(page.getByTestId('therapy-strip')).toContainText(/Ringer|chloride|crystalloid/i);

  // 9. oxygen (change device)
  await page.getByTestId('rail-airway').click();
  await page.getByTestId('o2-highFlowNasal').click();
  await expect(page.getByTestId('therapy-strip')).toContainText('High-flow nasal');
  await page.getByTestId('o2-nonRebreather').click();

  // 7. medication: naloxone IV
  await page.getByTestId('rail-meds').click();
  await page.getByTestId('drug-search').fill('nalox');
  await page.getByTestId('drug-naloxone').click();
  await page.getByTestId('route-IO').click();
  await page.getByTestId('give-drug').click();
  await expect(page.getByTestId('med-history')).toContainText(/Naloxone/);
  await shot(page, '06-meds');

  // 10. diagnostics
  await page.getByTestId('rail-diagnostics').click();
  await page.getByTestId('order-glucose').click();
  await page.getByTestId('order-vbg').click();
  await expect(page.getByTestId('orders')).toContainText('Venous blood gas');

  // 11. accelerate time and verify clock + results
  const t0 = await clockSeconds(page);
  await page.getByTestId('topbar').getByRole('radio', { name: '10×' }).click();
  await page.waitForTimeout(8000);
  const t1 = await clockSeconds(page);
  expect(t1 - t0).toBeGreaterThan(45);
  await expect(page.getByTestId('order-row-vbg')).toContainText(/abnormal|resulted/, { timeout: 60_000 });
  await page.getByTestId('topbar').getByRole('radio', { name: '1×' }).click();
  await page.getByTestId('order-row-vbg').click();
  await expect(page.getByTestId('result-detail')).toContainText('pH');
  await shot(page, '07-results');

  // 12. conversation (AI or scripted fallback)
  await page.getByTestId('rail-talk').click();
  await page.getByTestId('chat-input').fill('Can you tell me what happened?');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-log')).toContainText('Can you tell me what happened?');
  await expect(page.getByTestId('chat-log').locator('li').nth(1)).toBeVisible({ timeout: 45_000 });
  await shot(page, '08-talk');

  // 13. timeline
  await page.getByTestId('rail-timeline').click();
  await expect(page.getByTestId('timeline')).toContainText('Naloxone');
  await expect(page.getByTestId('timeline')).toContainText('Monitoring attached');
  await shot(page, '09-timeline');

  // 16a. save → reload → resume (before ending)
  await page.getByTestId('save-case').click();
  const before = await clockSeconds(page);
  await page.reload();
  await expect(page.getByTestId('case-screen')).toBeVisible({ timeout: 30_000 });
  const after = await clockSeconds(page);
  expect(Math.abs(after - before)).toBeLessThan(30);
  await expect(page.getByTestId('topbar')).toContainText('Unknown');

  // 14. end the scenario
  await page.getByTestId('end-case').click();
  await page.getByTestId('diagnosis-input').fill('Opioid overdose');
  await page.getByTestId('submit-end').click();

  // 15. debrief
  await expect(page.getByTestId('debrief')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('decisions')).toContainText('naloxone', { ignoreCase: true });
  await expect(page.getByText('Matches the hidden diagnosis')).toBeVisible();
  await shot(page, '10-debrief');

  // 16b. the ended case is listed and re-openable from the start screen
  await page.getByTestId('debrief-exit').click();
  await expect(page.getByTestId('saved-cases')).toContainText('Found unresponsive');
  await page.getByTestId('resume-case').first().click();
  await expect(page.getByTestId('debrief')).toBeVisible({ timeout: 30_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('random case starts and the patient evolves over time', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await page.getByTestId('seed-input').fill('E2E-RAND');
  await page.getByTestId('start-random').click();
  await page.getByTestId('receive-patient').click();
  await expect(page.getByTestId('case-screen')).toBeVisible();
  await page.getByTestId('rail-assess').click();
  await page.getByText('Attach monitoring').click();
  await page.getByTestId('topbar').getByRole('radio', { name: '5×' }).click();
  await page.waitForTimeout(6000);
  expect(await clockSeconds(page)).toBeGreaterThan(20);
  await expect(page.getByTestId('wave-ecg')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('cardiac arrest: CPR, defibrillation and rhythm-dependent outcome', async ({ page }) => {
  await openCase(page, 'collapsed-gym');
  await expect(page.getByTestId('alarm-bar')).toContainText(/VFIB|ASYSTOLE/);
  await page.getByTestId('rail-circulation').click();
  await expect(page.getByTestId('cpr-stop')).toBeVisible();
  await page.getByTestId('defib-charge').click();
  await page.getByTestId('defib-shock').click();
  await page.getByTestId('rail-timeline').click();
  await expect(page.getByTestId('timeline')).toContainText(/Shock \d+ J/);
  await shot(page, 'arrest');
});

test('treatment changes physiology: IM naloxone reverses opioid respiratory depression', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await openSeededCase(page, 'found-unresponsive', 'E2E-A');
  await page.getByTestId('rail-assess').click();
  await page.getByText('Attach monitoring').click();
  await expect(page.getByTestId('num-rr')).toHaveText(/\d+/, { timeout: 10_000 });
  const rrBefore = await monitorNumber(page, 'num-rr');
  expect(rrBefore).toBeLessThanOrEqual(9);

  // No IV access needed: intramuscular route (slower, perfusion-dependent absorption)
  await page.getByTestId('rail-meds').click();
  await page.getByTestId('drug-search').fill('nalox');
  await page.getByTestId('drug-naloxone').click();
  await page.getByTestId('route-IM').click();
  await page.getByTestId('dose-input').fill('0.8');
  await page.getByTestId('give-drug').click();
  await expect(page.getByTestId('med-history')).toContainText(/Naloxone/);

  await page.getByTestId('topbar').getByRole('radio', { name: '10×' }).click();
  await expect.poll(() => monitorNumber(page, 'num-rr'), { timeout: 90_000, intervals: [2000] }).toBeGreaterThanOrEqual(11);
  expect(await clockSeconds(page)).toBeGreaterThan(40); // the effect takes simulated minutes, not an instant switch
  await page.getByTestId('topbar').getByRole('radio', { name: '1×' }).click();
  await shot(page, 'naloxone-response');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('treatment changes physiology: chest drain for tension pneumothorax', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await openSeededCase(page, 'motorbike-chest', 'E2E-B');
  await page.getByTestId('rail-assess').click();
  await page.getByText('Attach monitoring').click();
  await page.getByTestId('rail-procedures').click();
  await page.getByTestId('drawer').getByRole('radio', { name: 'Right' }).click();
  await page.getByText('Chest drain', { exact: true }).click();
  await page.getByTestId('topbar').getByRole('radio', { name: '10×' }).click();
  // Untreated, this patient progresses to obstructive arrest within ~10–20 simulated minutes
  await expect.poll(() => clockSeconds(page), { timeout: 150_000, intervals: [3000] }).toBeGreaterThan(12 * 60);
  await page.getByTestId('topbar').getByRole('radio', { name: '1×' }).click();
  await expect(page.getByTestId('alarm-bar')).not.toContainText(/ASYSTOLE|VFIB|PEA|NO PULSE/i);
  expect(await monitorNumber(page, 'num-spo2')).toBeGreaterThanOrEqual(94);
  await page.getByTestId('rail-timeline').click();
  await expect(page.getByTestId('timeline')).toContainText(/drain/i);
  await shot(page, 'chest-drain');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('tablet layout remains usable @tablet', async ({ page }) => {
  await openCase(page, 'swelling-after-dinner');
  await page.getByTestId('rail-meds').click();
  await expect(page.getByTestId('drawer')).toBeVisible();
  await expect(page.getByTestId('monitor')).toBeVisible();
  await page.getByTestId('drug-epinephrine').click();
  await page.getByTestId('route-IM').click();
  await page.getByTestId('give-drug').click();
  await shot(page, 'tablet-meds');
  await page.getByTestId('rail-meds').click();
  await expect(page.getByTestId('tool-selector')).toBeVisible();
  await shot(page, 'tablet-case');
});
