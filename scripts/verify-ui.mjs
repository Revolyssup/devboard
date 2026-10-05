import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BRAVE = process.env.DEVBOARD_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const OUT = process.env.SHOTS || '/tmp/devboard-shots';
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[verify]', ...a);
const errors = [];

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1600,1100'],
  defaultViewport: { width: 1600, height: 1100 },
});

const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  log('shot', name);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);

// 1. dashboard (defaults to Work)
await page.goto('http://localhost:5178/', { waitUntil: 'networkidle0' });
await page.waitForSelector('table tbody tr', { timeout: 10000 });
log('work rows:', await page.$$eval('tbody tr.row', (r) => r.length));
log('page title:', await textOf('.page-title'));
await shot('01-work-dashboard');

// 2. expand keywords on first row
await page.click('tbody tr.row .expander');
await page.waitForSelector('.keywords-row', { timeout: 5000 });
log('keyword chips:', await page.$$eval('.keywords-row .keyword-chip', (c) => c.length));
await shot('02-keywords-expanded');
await page.click('tbody tr.row .expander');

// 3. hover the Active dot tooltip
const dot = await page.$('.session-dots');
if (dot) {
  await dot.hover();
  await sleep(300);
  const tip = await page.$('.tip');
  log('tooltip shown:', Boolean(tip));
  if (tip) log('tooltip text:', (await page.$eval('.tip', (e) => e.innerText)).replace(/\n/g, ' | '));
  await shot('03-session-tooltip');
  await page.mouse.move(900, 900);
  await sleep(300);
}

// 4. Read overlay: clicking the row opens the file.
await page.click('tbody tr.row');
await page.waitForSelector('.overlay .md h1', { timeout: 8000 });
log('overlay title:', await textOf('.overlay-head h2'));
log('overlay path:', await textOf('.overlay-head .path'));
await shot('04-read-overlay');
await page.keyboard.press('Escape');
await sleep(250);

// 5. chores panel
const chorePanel = await page.$$eval('.panel-title', (t) => t.map((x) => x.textContent.trim()));
log('panels:', chorePanel);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await sleep(300);
await shot('05-chores-panel');

// 6. search overlay
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('.head-actions .btn.primary');
await page.waitForSelector('.search-input', { timeout: 5000 });
await page.type('.search-input', 'waypont');
await sleep(700);
const results = await page.$$eval('.result-file', (r) => r.map((x) => x.textContent.trim()));
log('search "waypont" =>', results);
await shot('06-search');
await page.keyboard.press('Escape');
await sleep(250);

// 7. Personal section
await page.click('.sidebar .nav-item');
await page.waitForFunction(
  () => document.querySelector('.page-title')?.textContent.trim() === 'Personal',
  { timeout: 5000 }
);
await page.waitForSelector('tbody tr.row', { timeout: 5000 });
log('personal rows:', await page.$$eval('tbody tr.row', (r) => r.length));
log('personal head buttons:', await page.$$eval('.head-actions .btn', (b) => b.map((x) => x.textContent.trim())));
log('chores panel present on personal:', await page.$$eval('.panel-title', (t) => t.some((x) => x.textContent.includes('Active chores'))));
await shot('07-personal');

// 8. personal keywords expand
await page.click('tbody tr.row .expander');
await page.waitForSelector('.keywords-row');
log('personal chips:', await page.$$eval('.keywords-row .keyword-chip', (c) => c.map((x) => x.textContent)));
await shot('08-personal-keywords');

// 9. standalone learning tab
await page.goto('http://localhost:5178/learning/personal/2026-07-20-dsa-two-sum.md', {
  waitUntil: 'networkidle0',
});
await page.waitForSelector('.standalone .md h1', { timeout: 8000 });
log('standalone title:', await textOf('.standalone .page-title'));
log('standalone actions:', await page.$$eval('.standalone .head-actions .btn', (b) => b.map((x) => x.textContent.trim())));
await shot('09-standalone');

await browser.close();

if (errors.length) {
  console.log('\n[verify] BROWSER ERRORS:');
  errors.forEach((e) => console.log('  ', e));
  process.exit(1);
}
console.log('\n[verify] no console/page errors');
