/**
 * Remaining paths: Learning Progress Report opens the latest report in a new tab,
 * search results open a standalone tab, pagination advances, chore fuzzy search filters.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const OUT = process.env.SHOTS || '/tmp/devboard-shots';
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[extra]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1100 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('http://localhost:5178/', { waitUntil: 'networkidle0' });
await page.waitForSelector('tbody tr.row');

// sidebar shows both counts
const navCounts = await page.$$eval('.nav-count', (n) => n.map((x) => x.textContent.trim()));
check('sidebar shows both section counts', navCounts.every((c) => /^\d+$/.test(c)), navCounts.join(','));

// pagination
const firstBefore = await page.$eval('.cell-file', (e) => e.textContent.trim());
await page.evaluate(() =>
  [...document.querySelectorAll('.pager-controls .btn')].find((b) => b.textContent.includes('Next')).click()
);
await sleep(600);
const firstAfter = await page.$eval('.cell-file', (e) => e.textContent.trim());
const pageLabel = await page.$$eval('.pager-info', (p) => p.map((x) => x.textContent.trim()));
check('pagination advances the learnings table', firstBefore !== firstAfter, `${firstBefore} → ${firstAfter}`);
check('pager label updates', pageLabel.some((l) => l.includes('2 / 3')), pageLabel.join(' | '));
await page.screenshot({ path: `${OUT}/16-page2.png` });

// Chore fuzzy search: a matching query keeps the row, a non-matching one empties the panel.
// The query is derived from a chore that actually exists (chores come and go), then typo'd
// by dropping a middle character, so this still exercises fuzzy matching rather than substring.
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
const choreTitle = await page
  .$eval('.panel:last-of-type tbody tr.row .name-text', (e) => e.textContent.trim())
  .catch(() => null);

if (!choreTitle) {
  log('SKIP — chore fuzzy search (no chores tracked right now)');
} else {
  const word = choreTitle.split(/\s+/).find((w) => /^[A-Za-z]{6,}$/.test(w)) || '';
  const typo = word ? word.slice(0, 3) + word.slice(4) : '';
  if (!typo) {
    log(`SKIP — chore fuzzy search (no suitable word in "${choreTitle}")`);
  } else {
    await page.type('.panel-head input', typo);
    await sleep(800);
    const choreRowsMatch = await page.$$eval('.panel:last-of-type tbody tr.row', (r) => r.length);
    check('chore fuzzy search matches on a typo', choreRowsMatch >= 1, `"${typo}" → rows=${choreRowsMatch}`);
    await page.screenshot({ path: `${OUT}/17-chore-search.png` });
  }
}

await page.click('.panel:last-of-type .panel-head input', { clickCount: 3 });
await page.type('.panel:last-of-type .panel-head input', 'zzzznotachore');
await sleep(800);
const emptyText = await page.$eval('.panel:last-of-type .empty', (e) => e.textContent).catch(() => '');
check('chore search shows empty state for no match', emptyText.includes('No chore matches'), emptyText.trim());

// Learning Progress Report → new tab with the latest HTML report
await page.evaluate(() => window.scrollTo(0, 0));
await page.evaluate(() => [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('Personal')).click());
await page.waitForFunction(() => document.querySelector('.page-title')?.textContent.trim() === 'Personal');
await sleep(400);

const newTab = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t.page())));
await page.evaluate(() =>
  [...document.querySelectorAll('.head-actions .btn')].find((b) => b.textContent.includes('Progress Report')).click()
);
const reportPage = await newTab;
await sleep(1200);
const url = reportPage.url();
check('progress report opens in a new tab', url.includes('/reports/file/'), url);
const reportTitle = await reportPage.title().catch(() => '');
const hasContent = await reportPage.evaluate(() => document.body.innerText.length).catch(() => 0);
check('report page rendered content', hasContent > 500, `title="${reportTitle}" chars=${hasContent}`);
await reportPage.screenshot({ path: `${OUT}/18-progress-report.png` });
await reportPage.close();

// search result → standalone tab with Edit + Delete
await page.evaluate(() => [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('Work')).click());
await sleep(400);
await page.evaluate(() => document.querySelector('.head-actions .btn.primary').click());
await page.waitForSelector('.search-input');
await page.type('.search-input', 'liveness');
await sleep(800);
await page.screenshot({ path: `${OUT}/19-search-compact.png` });

const tabPromise = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t.page())));
await page.keyboard.press('Enter');
const standalone = await tabPromise;
await sleep(1200);
await standalone.waitForSelector('.standalone .md', { timeout: 8000 });
const sUrl = standalone.url();
const sActions = await standalone.$$eval('.standalone .head-actions .btn', (b) => b.map((x) => x.textContent.trim()));
check('enter opens the learning in a new tab', sUrl.includes('/learning/work/'), sUrl);
check('standalone tab is read-only with Edit + Delete', sActions.join(',') === 'Edit,Delete', sActions.join(','));
const readOnly = await standalone.$('textarea.editor');
check('standalone opens read-only (no editor)', readOnly === null);
await standalone.screenshot({ path: `${OUT}/20-standalone-from-search.png` });
await standalone.close();

await browser.close();
if (errors.length) {
  console.log('[extra] PAGE ERRORS:', errors);
  failures++;
}
console.log(failures === 0 ? '\n[extra] ALL CHECKS PASSED' : `\n[extra] ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
