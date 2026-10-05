/**
 * Exercises the mutating paths end-to-end through the real UI:
 * Active dot for a live session, edit → save → on-disk change, delete → file + index row gone.
 * Operates only on the scratch learning file created for this purpose.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BRAVE = process.env.DEVBOARD_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const OUT = process.env.SHOTS || '/tmp/devboard-shots';
fs.mkdirSync(OUT, { recursive: true });

const SCRATCH = '2026-08-29-devboard-scratch-test.md';
const FILE = path.join(os.homedir(), '.claude/learnings', SCRATCH);
const INDEX = path.join(os.homedir(), '.claude/learnings/index.txt');

// Seed a throwaway learning + index row. Every mutation below targets only this file;
// the run ends by deleting it through the UI, which is itself the delete assertion.
const SESSION = process.env.DEVBOARD_TEST_SESSION || '-';
const rowsBefore = fs
  .readFileSync(INDEX, 'utf8')
  .split('\n')
  .filter((l) => l.trim() && l.includes('.md')).length;
fs.writeFileSync(
  FILE,
  '# Devboard scratch test file\n\nCreated by scripts/verify-mutations.mjs. Deleted again by the same run.\n'
);
if (!fs.readFileSync(INDEX, 'utf8').includes(SCRATCH)) {
  fs.appendFileSync(
    INDEX,
    `Devboard scratch test entry — temporary, created by the mutation verifier | ${SCRATCH} | ${SESSION} | ${process.cwd()} | 2026-08-29\n`
  );
}

const log = (...a) => console.log('[mut]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
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
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

// The scratch file's session id is this live session → its Active dot must be green.
await page.goto('http://localhost:5178/', { waitUntil: 'networkidle0' });
await page.waitForSelector('tbody tr.row');

const findRow = () =>
  page.evaluateHandle((f) => {
    const rows = [...document.querySelectorAll('tbody tr.row')];
    return rows.find((r) => r.querySelector('.cell-file')?.textContent.trim() === f) || null;
  }, SCRATCH);

let row = await findRow();
check('scratch row is on page 1 (newest edit first)', Boolean(await row.asElement()));

// Only meaningful when seeded with a genuinely live session id:
//   DEVBOARD_TEST_SESSION=<uuid of a running claude session> node scripts/verify-mutations.mjs
if (SESSION !== '-') {
  const greenDots = await page.evaluate((f) => {
    const rows = [...document.querySelectorAll('tbody tr.row')];
    const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === f);
    return r ? r.querySelectorAll('.dot.on').length : -1;
  }, SCRATCH);
  check('Active dot is green for the live session', greenDots === 1, `green dots=${greenDots}`);
} else {
  log('SKIP — Active dot check (set DEVBOARD_TEST_SESSION to a live session id)');
}
await page.screenshot({ path: `${OUT}/10-active-green.png` });

// --- Edit → save ---
await page.evaluate((f) => {
  const rows = [...document.querySelectorAll('tbody tr.row')];
  const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === f);
  [...r.querySelectorAll('.row-actions .btn')].find((b) => b.textContent.trim() === 'Edit').click();
}, SCRATCH);

await page.waitForSelector('textarea.editor', { timeout: 8000 });
const banner = await page.$eval('.editing-banner', (e) => e.innerText.replace(/\n/g, ' '));
check('editing banner names the file', banner.includes(SCRATCH), banner);
await page.screenshot({ path: `${OUT}/11-editor.png` });

const MARKER = `\n\n## Verified edit\n\nWritten by the devboard editor at ${new Date().toISOString()}.\n`;
await page.focus('textarea.editor');
await page.keyboard.down('Meta');
await page.keyboard.press('ArrowDown');
await page.keyboard.up('Meta');
await page.type('textarea.editor', MARKER);
await sleep(150);
const dirtyLabel = await page.$eval('.save-state', (e) => e.textContent.trim());
check('save state shows unsaved changes', dirtyLabel === 'unsaved changes', dirtyLabel);

await page.evaluate(() =>
  [...document.querySelectorAll('.overlay-foot .btn')].find((b) => b.textContent.trim() === 'Save').click()
);
await sleep(700);
const onDisk = fs.readFileSync(FILE, 'utf8');
check('edit landed on disk', onDisk.includes('## Verified edit'));
await page.screenshot({ path: `${OUT}/12-editor-saved.png` });

// Preview renders the saved markdown
await page.evaluate(() =>
  [...document.querySelectorAll('.overlay-head .btn')].find((b) => b.textContent.trim() === 'Preview').click()
);
await page.waitForSelector('.overlay-body .md h2');
const previewText = await page.$eval('.overlay-body .md', (e) => e.innerText);
check('preview renders the new section', previewText.includes('Verified edit'));
await page.screenshot({ path: `${OUT}/13-editor-preview.png` });

await page.keyboard.press('Escape');
await sleep(400);

// --- Delete → file + index row gone ---
await page.evaluate((f) => {
  const rows = [...document.querySelectorAll('tbody tr.row')];
  const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === f);
  [...r.querySelectorAll('.row-actions .btn')].find((b) => b.textContent.trim() === 'Delete').click();
}, SCRATCH);
await page.waitForSelector('.confirm', { timeout: 5000 });
const confirmText = await page.$eval('.confirm', (e) => e.innerText.replace(/\n/g, ' '));
check('confirm dialog names the file', confirmText.includes(SCRATCH), confirmText.slice(0, 120));
await page.screenshot({ path: `${OUT}/14-confirm-delete.png` });

await page.evaluate(() =>
  [...document.querySelectorAll('.confirm-actions .btn')].find((b) =>
    b.textContent.includes('Delete')
  ).click()
);
await sleep(900);

check('file removed from disk', !fs.existsSync(FILE));
const idx = fs.readFileSync(INDEX, 'utf8');
check('index.txt row removed', !idx.includes(SCRATCH));
const stillListed = await page.evaluate(
  (f) => [...document.querySelectorAll('.cell-file')].some((c) => c.textContent.trim() === f),
  SCRATCH
);
check('row gone from the table', !stillListed);
const toastText = await page
  .$$eval('.toast', (ts) => ts.map((t) => t.textContent).join(' ~ '))
  .catch(() => '');
check('toast reports file + index row deletion', toastText.includes('index.txt row'), toastText);
await page.screenshot({ path: `${OUT}/15-after-delete.png` });

// Deleting the scratch row must not disturb any other row.
const rowsAfter = idx.split('\n').filter((l) => l.trim() && l.includes('.md')).length;
check(
  'other index rows intact',
  rowsAfter === rowsBefore,
  `before=${rowsBefore} after=${rowsAfter}`
);

await browser.close();
if (errors.length) {
  console.log('[mut] BROWSER ERRORS:', errors);
  failures++;
}
console.log(failures === 0 ? '\n[mut] ALL CHECKS PASSED' : `\n[mut] ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
