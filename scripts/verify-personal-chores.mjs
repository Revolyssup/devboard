/**
 * Personal chores: the Personal section must show its own Active chores panel backed by
 * ~/.claude/personal/chores, fully independent of the Work panel — different rows, its own
 * fuzzy search, and a delete that removes file + index row from the personal directory only.
 *
 * Seeds and deletes its own scratch chore; never touches real chore files.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BRAVE = process.env.DEVBOARD_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const OUT = process.env.SHOTS || '/tmp/devboard-shots';
fs.mkdirSync(OUT, { recursive: true });

const PDIR = path.join(os.homedir(), '.claude/personal/chores');
const WDIR = path.join(os.homedir(), '.claude/chores');
const SCRATCH = '2026-08-29-personal-chore-scratch.md';

const log = (...a) => console.log('[pchore]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => {
  log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? ' :: ' + extra : ''}`);
  if (!cond) failures++;
};

// Seed a scratch personal chore.
fs.mkdirSync(PDIR, { recursive: true });
fs.writeFileSync(
  path.join(PDIR, SCRATCH),
  `# Scratch personal chore for verification

- **Session:** verify-personal-chores
- **Directory:** ${process.cwd()}

## What is done

- Seeded by scripts/verify-personal-chores.mjs.

## What is happening

- Being verified in the Personal panel right now.

## What is pending

- Deletion through the UI at the end of this run.
- A second pending bullet, to check the counter.
`
);
const PINDEX = path.join(PDIR, 'index.txt');
if (!fs.existsSync(PINDEX)) {
  fs.writeFileSync(PINDEX, 'Chore | Filename | Session ID | Directory | Started\n');
}
if (!fs.readFileSync(PINDEX, 'utf8').includes(SCRATCH)) {
  fs.appendFileSync(
    PINDEX,
    `Scratch personal chore seeded by the verifier — zingtastic marker for fuzzy search | ${SCRATCH} | verify-personal-chores | ${process.cwd()} | 2026-08-29\n`
  );
}

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1600, height: 1200 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const choreFilenames = () =>
  page.$$eval('.panel:last-of-type tbody tr.row .cell-file', (c) =>
    c.map((x) => x.textContent.trim())
  );

// --- Work section keeps its own chores ---
await page.goto('http://localhost:5178/', { waitUntil: 'networkidle0' });
await page.waitForSelector('tbody tr.row');
await page.evaluate(() =>
  [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('Work')).click()
);
await sleep(700);
const workChores = await choreFilenames();
check('Work panel does not show the personal scratch chore', !workChores.includes(SCRATCH), workChores.join(','));

// --- Personal section has its own panel ---
await page.evaluate(() =>
  [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('Personal')).click()
);
await page.waitForFunction(() => document.querySelector('.page-title')?.textContent.trim() === 'Personal');
await sleep(800);

const hasPanel = await page.$$eval('.panel-title', (t) =>
  t.some((x) => x.textContent.includes('Active chores'))
);
check('Personal section renders an Active chores panel', hasPanel);

const personalChores = await choreFilenames();
check('Personal panel lists the personal chore', personalChores.includes(SCRATCH), personalChores.join(','));
check(
  'Personal panel excludes work chores',
  !personalChores.some((f) => fs.existsSync(path.join(WDIR, f))),
  personalChores.join(',')
);

const progress = await page.evaluate((f) => {
  const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
  const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === f);
  return r ? r.querySelector('.chore-progress')?.innerText.replace(/\n/g, ' ') : null;
}, SCRATCH);
check('progress pills counted from the three sections', /1 done.*1 now.*2 left/.test(progress || ''), progress);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await sleep(300);
await page.screenshot({ path: `${OUT}/21-personal-chores.png` });

// expand the three sections
await page.evaluate((f) => {
  const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
  rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === f).querySelector('.expander').click();
}, SCRATCH);
await sleep(400);
// innerText reflects the CSS uppercase on section labels, so compare case-insensitively.
const expanded = (await page.$eval('.panel:last-of-type .keywords-row', (e) => e.innerText)).toLowerCase();
const sectionsShown = ['what is done', 'what is happening', 'what is pending'].filter((s) =>
  expanded.includes(s)
);
check(
  'expanded row shows all three tracked sections',
  sectionsShown.length === 3,
  sectionsShown.join(' / ')
);
check(
  'expanded row shows each section body',
  expanded.includes('seeded by') && expanded.includes('deletion through the ui'),
  expanded.slice(0, 80).replace(/\n/g, ' ')
);
await page.screenshot({ path: `${OUT}/22-personal-chore-expanded.png` });

// --- personal panel fuzzy search is its own ---
await page.type('.panel:last-of-type .panel-head input', 'zingtstic');
await sleep(900);
const searched = await choreFilenames();
check('personal chore fuzzy search matches on a typo', searched.includes(SCRATCH), searched.join(','));
await page.click('.panel:last-of-type .panel-head input', { clickCount: 3 });
await page.keyboard.press('Backspace');
await sleep(700);

// --- delete removes file + index row from the personal dir only ---
// Snapshot the work dir so "untouched" compares before/after. Asserting it is merely
// non-empty would fail whenever no work chore happens to be tracked, which is a normal state.
const workChoreFiles = () => {
  try {
    return fs.readdirSync(WDIR).filter((f) => f.endsWith('.md')).sort().join(',');
  } catch {
    return ''; // dir may not exist yet — that is still a valid "before" state
  }
};
const workBefore = workChoreFiles();

await page.evaluate((f) => {
  const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
  const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === f);
  [...r.querySelectorAll('.row-actions .btn')].find((b) => b.textContent.trim() === 'Delete').click();
}, SCRATCH);
await page.waitForSelector('.confirm');
const confirmText = await page.$eval('.confirm', (e) => e.innerText.replace(/\n/g, ' '));
check('confirm names the personal end command', confirmText.includes('/end-personal-chore'), confirmText.slice(0, 130));
await page.screenshot({ path: `${OUT}/23-personal-chore-confirm.png` });

await page.evaluate(() =>
  [...document.querySelectorAll('.confirm-actions .btn')].find((b) => b.textContent.includes('Delete')).click()
);
await sleep(900);

check('personal chore file deleted', !fs.existsSync(path.join(PDIR, SCRATCH)));
check('personal index row removed', !fs.readFileSync(PINDEX, 'utf8').includes(SCRATCH));
check('work chores untouched', workChoreFiles() === workBefore, `[${workBefore || 'none tracked'}]`);
const afterDelete = await choreFilenames();
check('row gone from the personal panel', !afterDelete.includes(SCRATCH), afterDelete.join(','));
await page.screenshot({ path: `${OUT}/24-personal-after-delete.png` });

await browser.close();
if (errors.length) {
  console.log('[pchore] PAGE ERRORS:', errors);
  failures++;
}
console.log(failures === 0 ? '\n[pchore] ALL CHECKS PASSED' : `\n[pchore] ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
