// Drive the real demo page in a headless browser through both stories:
// a plan that settles and a plan that rolls back. Fails on any page error.
//   BASE=http://127.0.0.1:8787 CHROME=<path to chrome-headless-shell> node tests/ui.drive.js
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = process.env.SHOTS || 'docs/screens';
const NEW_PLAN = process.env.NEW_PLAN !== '0';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const errors = [];
const timings = {};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5, colorScheme: 'light' });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', async (d) => { errors.push('dialog: ' + d.message()); await d.dismiss(); });

  const idle = async (ms = 600_000) => {
    await page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: ms });
  };
  const headline = () => page.textContent('#headline');
  const shot = async (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const timed = async (name, fn) => { const t = Date.now(); await fn(); timings[name] = Date.now() - t; };

  await page.goto(BASE);
  if (NEW_PLAN) {
    await timed('new_plan', async () => { await page.click('#newPlan'); await page.waitForTimeout(2000); await idle(); });
  }
  await page.waitForFunction(() => /short/.test(document.getElementById('headline').textContent), null, { timeout: 30_000 });
  console.log('headline:', await headline());
  const answer = await page.textContent('#answer');
  console.log('answer:', answer);
  if (!/50 tUSD for Speaker travel completes it/.test(answer)) throw new Error('completion sentence missing');
  await shot('01-gap');

  await page.fill('#amt', '50');
  await page.selectOption('#line', 'food');
  const food = await page.textContent('#preview');
  console.log('food preview:', food);
  if (!/would not help/.test(food)) throw new Error('food top-up should not help');
  await page.selectOption('#line', 'travel');
  if (!/completes the plan/.test(await page.textContent('#preview'))) throw new Error('travel top-up should complete');
  await shot('02-preview');

  await timed('topup', async () => { await page.click('#topupBtn'); await page.waitForTimeout(1000); await idle(); });
  console.log('after top-up:', await headline());
  if (!/Ready to activate/.test(await headline())) throw new Error('plan should be covered');
  await shot('03-covered');

  await timed('activate', async () => { await page.click('#activateBtn'); await page.waitForTimeout(1000); await idle(); });
  await timed('collect', async () => { await page.click('#collectBtn'); await page.waitForTimeout(1000); await idle(); });
  console.log('after collect:', await headline());
  if (!/settled/i.test(await headline())) throw new Error('plan should settle');
  await shot('04-settled');
  await timed('pay', async () => { await page.click('#payBtn'); await page.waitForTimeout(1000); await idle(); });
  console.log('after pay:', await headline());
  if (!/Funded and paid/.test(await headline())) throw new Error('payees should be paid');
  const checks = await page.$$eval('#checks li', (els) => els.map((e) => e.className + ' ' + e.textContent));
  console.log(checks.join('\n'));
  if (checks.some((c) => c.startsWith('fail'))) throw new Error('a browser check failed');
  await shot('05-paid');

  // The failure story.
  await timed('new_plan_2', async () => { await page.click('#newPlan'); await page.waitForTimeout(2000); await idle(); });
  await page.selectOption('#line', 'travel');
  await page.fill('#amt', '50');
  await timed('topup_2', async () => { await page.click('#topupBtn'); await page.waitForTimeout(1000); await idle(); });
  await timed('spend', async () => { await page.click('#spendBtn'); await page.waitForTimeout(1000); await idle(); });
  await shot('06-spent-elsewhere');
  await page.click('#activateBtn'); await page.waitForTimeout(1000); await idle();
  await timed('collect_2', async () => { await page.click('#collectBtn'); await page.waitForTimeout(1000); await idle(); });
  console.log('after collect 2:', await headline(), '|', await page.textContent('#subline'));
  if (!/Rolled back/.test(await headline())) throw new Error('plan should roll back');
  await shot('07-rolled-back');
  await page.click('#payBtn'); await page.waitForTimeout(1000); await idle();
  const checks2 = await page.$$eval('#checks li', (els) => els.map((e) => e.className + ' ' + e.textContent));
  console.log(checks2.join('\n'));
  if (checks2.some((c) => c.startsWith('fail'))) throw new Error('a browser check failed');
  await shot('08-refunded');

  // Phone width: no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`horizontal overflow ${overflow}px at 390px`);
  await shot('09-phone');
} finally {
  await browser.close();
  writeFileSync(`${OUT}/drive-report.json`, JSON.stringify({ errors, timings }, null, 2));
}
console.log('timings ms:', JSON.stringify(timings));
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('UI drive passed');
