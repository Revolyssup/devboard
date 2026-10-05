/**
 * End-to-end verification for the "Run session" browser terminal.
 *
 * Runs its own server on a spare port with DEVBOARD_CLAUDE_BIN pointed at scripts/fake-claude.sh,
 * so nothing here spawns a real claude session. Fixtures live under $HOME — NOT /tmp, because on
 * macOS /tmp is a symlink to /private/tmp and slugForDirectory would disagree with what lsof
 * reports for the same directory.
 *
 * Asserts the real work chores are byte-identical before and after.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import puppeteer from 'puppeteer-core';

const BRAVE = process.env.DEVBOARD_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const HOME = os.homedir();
const PORT = Number(process.env.DEVBOARD_VERIFY_PORT || 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

const FIXTURE = path.join(HOME, '.devboard-verify', 'fixture-repo');
const PCHORES = path.join(HOME, '.claude', 'personal', 'chores');
const PINDEX = path.join(PCHORES, 'index.txt');
const WCHORES = path.join(HOME, '.claude', 'chores');
const PROJECTS = path.join(HOME, '.claude', 'projects');

const SID = '11111111-2222-4333-8444-555555555555';
// A second session for the ticket-semantics checks: those deliberately leave a preflight
// unredeemed, which now holds a reservation on its session until the ticket expires.
const SID2 = '66666666-7777-4888-8999-000000000001';
// And a third for the reservation checks, so the browser section that follows finds SID free.
const SID3 = '66666666-7777-4888-8999-000000000002';
const config_ticketTtlMs = 30_000; // mirrors config.ticketTtlMs
const LIVE_CHORE = '2026-08-31-verify-terminal-live.md';
const DEAD_CHORE = '2026-08-31-verify-terminal-nosession.md';
// A second resumable chore/session, distinct from LIVE_CHORE, so the browser section can prove two
// terminals stay open at once instead of the second Run click blocking on the first.
const LIVE_CHORE2 = '2026-08-31-verify-terminal-live-2.md';

const slugFor = (d) => d.replace(/[^a-zA-Z0-9]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[term]', ...a);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`[term] ${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
}

// --- fixtures ---------------------------------------------------------------------------------
const snapshotDir = (d) => {
  try {
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .join(',');
  } catch {
    return '';
  }
};
const workBefore = snapshotDir(WCHORES);
const workIndexBefore = (() => {
  try {
    return fs.readFileSync(path.join(WCHORES, 'index.txt'), 'utf8');
  } catch {
    return '';
  }
})();
const pIndexBefore = (() => {
  try {
    return fs.readFileSync(PINDEX, 'utf8');
  } catch {
    return null;
  }
})();

const transcriptDir = path.join(PROJECTS, slugFor(FIXTURE));
const transcript = path.join(transcriptDir, `${SID}.jsonl`);
const transcript2 = path.join(transcriptDir, `${SID2}.jsonl`);
const transcript3 = path.join(transcriptDir, `${SID3}.jsonl`);

function setup() {
  fs.mkdirSync(FIXTURE, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd: FIXTURE, timestamp: new Date(0).toISOString() });
  fs.writeFileSync(transcript, line + '\n');
  fs.writeFileSync(transcript2, line + '\n');
  fs.writeFileSync(transcript3, line + '\n');
  fs.mkdirSync(PCHORES, { recursive: true });

  const body = (n) =>
    `# ${n}\n\n## What is done\n- seeded by verify-terminal.mjs\n\n## What is happening\n- being verified\n\n## What is pending\n- nothing\n`;
  fs.writeFileSync(path.join(PCHORES, LIVE_CHORE), body('verify terminal live'));
  fs.writeFileSync(path.join(PCHORES, DEAD_CHORE), body('verify terminal no session'));
  fs.writeFileSync(path.join(PCHORES, LIVE_CHORE2), body('verify terminal live 2'));

  const header = 'Chore | Filename | Session ID | Directory | Started';
  const existing = pIndexBefore && pIndexBefore.trim() ? pIndexBefore.trimEnd() : header;
  fs.writeFileSync(
    PINDEX,
    [
      existing,
      `verify terminal live | ${LIVE_CHORE} | ${SID} | ${FIXTURE} | 2026-08-31`,
      `verify terminal no session | ${DEAD_CHORE} | - | - | 2026-08-31`,
      `verify terminal live 2 | ${LIVE_CHORE2} | ${SID2} | ${FIXTURE} | 2026-08-31`,
      '',
    ].join('\n')
  );
}

function teardown() {
  for (const f of [
    path.join(PCHORES, LIVE_CHORE),
    path.join(PCHORES, DEAD_CHORE),
    path.join(PCHORES, LIVE_CHORE2),
    transcript,
    transcript2,
    transcript3,
  ]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  try {
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(path.join(HOME, '.devboard-verify'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (pIndexBefore === null) {
    try {
      fs.unlinkSync(PINDEX);
    } catch {
      /* ignore */
    }
  } else {
    fs.writeFileSync(PINDEX, pIndexBefore);
  }
}

// --- server -----------------------------------------------------------------------------------
let server;
async function startServer() {
  server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DEVBOARD_CLAUDE_BIN: path.join(ROOT, 'scripts', 'fake-claude.sh'),
      DEVBOARD_CODEX_BIN: path.join(ROOT, 'scripts', 'fake-claude.sh'),
      DEVBOARD_TERMINAL_ROOTS: HOME,
      DEVBOARD_FAKE_CHORE_FILE: path.join(PCHORES, LIVE_CHORE),
      DEVBOARD_FAKE_CHORE_INDEX: PINDEX,
      DEVBOARD_ALLOWED_ORIGINS: `${BASE},http://localhost:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => console.error('[server]', d.toString().trim()));

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('server did not start');
}

const post = async (body) => {
  const res = await fetch(`${BASE}/api/terminal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const valid = () => ({
  scope: 'personal',
  kind: 'chore',
  filename: LIVE_CHORE,
  sessionId: SID,
  directory: FIXTURE,
  cols: 100,
  rows: 30,
});

// --- run --------------------------------------------------------------------------------------
setup();
try {
  await startServer();

  // ---- HTTP rejection matrix (no browser needed) ----
  check('no session id → 400 NO_SESSION', ...(await (async () => {
    const r = await post({ ...valid(), sessionId: undefined });
    return [r.status === 400 && r.body.code === 'NO_SESSION', r.body.code];
  })()));

  check('bad directory → 400 BAD_DIRECTORY', ...(await (async () => {
    const r = await post({ ...valid(), directory: '/no/such/dir' });
    return [r.status === 400 && r.body.code === 'BAD_DIRECTORY', r.body.code];
  })()));

  check('dir outside roots → 400 DIR_OUTSIDE_ROOTS', ...(await (async () => {
    const r = await post({ ...valid(), directory: '/usr' });
    return [r.status === 400 && r.body.code === 'DIR_OUTSIDE_ROOTS', r.body.code];
  })()));

  check('unknown session → 400 NO_TRANSCRIPT', ...(await (async () => {
    const r = await post({ ...valid(), sessionId: '99999999-8888-4777-8666-555555555555' });
    return [r.status === 400 && r.body.code === 'NO_TRANSCRIPT', r.body.code];
  })()));

  check('traversal filename → 400', ...(await (async () => {
    const r = await post({ ...valid(), filename: '../../etc/passwd' });
    return [r.status === 400, String(r.status) + ' ' + r.body.code];
  })()));

  // ---- ticket semantics (own session: these leave the preflight unredeemed) ----
  const first = await post({ ...valid(), sessionId: SID2 });
  check('valid preflight → 200 + ticket', first.status === 200 && !!first.body.ticket);

  const badTicket = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal?ticket=nonsense`);
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => resolve('rejected'));
  });
  check('bogus ticket rejected at upgrade', badTicket === 'rejected', badTicket);

  const foreignOrigin = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal?ticket=${first.body.ticket}`, {
      origin: 'http://evil.example.com',
    });
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => resolve('rejected'));
  });
  check('foreign Origin rejected at upgrade', foreignOrigin === 'rejected', foreignOrigin);

  // ---- full duplex over a real pty ----
  const t = await post(valid());
  check('preflight for live terminal', t.status === 200, String(t.status));

  const seen = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/terminal?ticket=${t.body.ticket}`, {
      origin: BASE,
    });
    let out = '';
    const control = [];
    const timer = setTimeout(() => resolve({ out, control, timedOut: true }), 15000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        out += data.toString('utf8');
        if (out.includes('FAKE-CLAUDE ready') && !ws.__typed) {
          ws.__typed = true;
          ws.send(JSON.stringify({ t: 'i', d: 'hello there\r' }));
          setTimeout(() => ws.send(JSON.stringify({ t: 'resize', cols: 133, rows: 44 })), 300);
          setTimeout(() => ws.send(JSON.stringify({ t: 'i', d: '/end-chore\r' })), 800);
        }
      } else {
        control.push(JSON.parse(data.toString('utf8')));
      }
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve({ out, control });
    });
    ws.on('error', reject);
  });

  const ctl = (type) => seen.control.find((m) => m.t === type);
  check('ready control frame', !!ctl('ready'), ctl('ready')?.pid ? `pid ${ctl('ready').pid}` : '');
  check(
    'argv carries --resume <session>',
    seen.out.includes(`--resume ${SID}`),
    (seen.out.match(/FAKE-CLAUDE argv: .*/) || [''])[0]
  );
  check(
    'spawned in the recorded directory',
    seen.out.includes(`FAKE-CLAUDE pwd: ${FIXTURE}`),
    (seen.out.match(/FAKE-CLAUDE pwd: .*/) || [''])[0]
  );
  check('initial pty size honoured', seen.out.includes('COLS=100 ROWS=30'));
  check('stdin reaches the process', seen.out.includes('ECHO: hello there'));
  check(
    'resize propagates (SIGWINCH)',
    seen.out.includes('COLS=133 ROWS=44'),
    (seen.out.match(/SIZE COLS=\d+ ROWS=\d+/g) || []).join(' | ')
  );
  check('chore-gone pushed to client', !!ctl('chore-gone'));
  check(
    'output after chore-gone is not truncated',
    seen.out.includes('goodbye'),
    'trailing output survived'
  );
  check('exit frame sent', !!ctl('exit'));
  check('chore file actually deleted', !fs.existsSync(path.join(PCHORES, LIVE_CHORE)));
  check('chore index row removed', !fs.readFileSync(PINDEX, 'utf8').includes(LIVE_CHORE));

  // ---- process is really gone ----
  await sleep(2500);
  const psOut = await new Promise((resolve) => {
    const p = spawn('ps', ['-axo', 'args=']);
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.on('close', () => resolve(s));
  });
  check('no orphaned fake-claude left running', !psOut.includes(`--resume ${SID}`));

  // ---- a preflight reserves the session, even before the socket attaches ----
  fs.writeFileSync(path.join(PCHORES, LIVE_CHORE), '# respawned for reservation test\n');
  const held = { ...valid(), sessionId: SID3 };
  const a = await post(held);
  const b = await post(held);
  check('first preflight → 200', a.status === 200, String(a.status));
  check(
    'concurrent preflight for same session → 409 ALREADY_OPEN_HERE',
    b.status === 409 && b.body.code === 'ALREADY_OPEN_HERE',
    `${b.status} ${b.body.code}`
  );

  // and the hold is released once the unused ticket expires
  await sleep(config_ticketTtlMs + 6000);
  const c = await post(held);
  check('reservation released after ticket expiry', c.status === 200, `${c.status} ${c.body.code}`);

  // ---- browser ----
  // The /end-chore check deliberately destroyed the live chore and its index row; re-seed so the
  // panel has both a resumable row and a session-less one.
  setup();
  if (fs.existsSync(BRAVE)) {
    const browser = await puppeteer.launch({
      executablePath: BRAVE,
      headless: 'new',
      args: ['--no-sandbox', '--window-size=1600,1100'],
      defaultViewport: { width: 1600, height: 1100 },
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.nav-item')].find((n) =>
        n.textContent.includes('Personal')
      );
      el?.click();
    });
    await sleep(1200);

    // `.panel:last-of-type` is the chores panel (it renders below the learnings panel).
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('.panel:last-of-type tbody tr.row')].map((r) => ({
        file: r.querySelector('.cell-file')?.textContent.trim(),
        run: [...r.querySelectorAll('.row-actions .btn')]
          .filter((b) => b.textContent.includes('Run'))
          .map((b) => ({ disabled: b.disabled, title: b.title }))[0],
      }))
    );
    const deadRow = buttons.find((b) => b.file === DEAD_CHORE);
    const liveRow = buttons.find((b) => b.file === LIVE_CHORE);
    check(
      'Run button opens chooser even when no session recorded',
      deadRow?.run?.disabled === false,
      deadRow?.run?.title
    );
    check(
      'Run button enabled when a session is recorded',
      liveRow?.run?.disabled === false,
      liveRow?.run?.title
    );
    const liveAgentBadges = await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      return [...(r?.querySelectorAll('.run-agent-icons .agent-icon') || [])].map((x) =>
        ({ title: x.title, src: x.getAttribute('src') })
      );
    }, LIVE_CHORE);
    check(
      'Run button shows both agent badges',
      liveAgentBadges.some((x) => x.title === 'claude' && x.src === '/agents/claude.svg') &&
        liveAgentBadges.some((x) => x.title === 'codex' && x.src === '/agents/codex.webp'),
      JSON.stringify(liveAgentBadges)
    );

    const order = await page.evaluate(() => {
      const r = document.querySelector('.panel:last-of-type tbody tr.row');
      return [...(r?.querySelectorAll('.row-actions .btn') || [])].map((b) => b.textContent.trim());
    });
    check(
      'Run is appended after Delete',
      order[0]?.startsWith('Edit') && order[1]?.startsWith('Delete') && order.at(-1)?.includes('Run'),
      order.join(' | ')
    );

    // Regression: a new-agent terminal opened from an existing chore must stay restorable from
    // that row even before the new session id has been discovered and written back to the chore.
    await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      [...r.querySelectorAll('.row-actions .btn')]
        .find((x) => x.textContent.includes('Run'))
        .click();
    }, LIVE_CHORE);
    await page.waitForSelector('.run-menu-item', { timeout: 5000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.run-menu-item')]
        .find((b) => b.textContent.includes('codex') && b.textContent.includes('new session'))
        ?.click();
    });
    await page.waitForSelector('.term-overlay', { timeout: 8000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.term-overlay .overlay-head .btn')]
        .find((b) => b.textContent.includes('Minimize'))
        ?.click();
    });
    await sleep(300);
    const newAgentMinimized = await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      const run = [...(r?.querySelectorAll('.row-actions .btn') || [])].find((x) =>
        x.textContent.includes('Running')
      );
      return { rowRunning: Boolean(run), text: run?.textContent.trim() || '' };
    }, LIVE_CHORE);
    check(
      'new-agent chore session stays attached to row while minimized',
      newAgentMinimized.rowRunning,
      JSON.stringify(newAgentMinimized)
    );
    await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      [...(r?.querySelectorAll('.row-actions .btn') || [])]
        .find((b) => b.textContent.includes('Running'))
        ?.click();
    }, LIVE_CHORE);
    await sleep(300);
    await page.evaluate(() => {
      [...document.querySelectorAll('.term-overlay .btn')]
        .find((b) => b.textContent.includes('Close'))
        ?.click();
    });
    await sleep(800);

    // Open a real terminal from the UI and prove the session paints into it.
    const opened = await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      const b = [...r.querySelectorAll('.row-actions .btn')].find((x) =>
        x.textContent.includes('Run')
      );
      b.click();
      return true;
    }, LIVE_CHORE);
    check('clicked Run on the live chore', opened);
    await page.waitForSelector('.run-menu-item', { timeout: 5000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.run-menu-item')]
        .find((b) => b.textContent.includes('claude'))
        ?.click();
    });

    await page.waitForSelector('.term-overlay', { timeout: 8000 }).catch(() => {});
    await sleep(2500);
    const termText = await page
      .$eval('.term-overlay', (e) => e.innerText)
      .catch(() => '');
    check('terminal overlay mounted', termText.length > 0);
    check(
      'terminal shows the resumed session and cwd',
      termText.includes(SID) && termText.includes(FIXTURE),
      termText.slice(0, 90).replace(/\n/g, ' ')
    );
    check(
      'chore warning banner is always visible',
      /end-chore/.test(termText) && /deletes this file/.test(termText)
    );
    check('pty output rendered into xterm', /FAKE-CLAUDE ready/.test(termText));

    const headerButtons = await page.$$eval('.term-overlay .overlay-head .btn', (b) =>
      b.map((x) => x.textContent.trim())
    );
    check(
      'terminal header has fullscreen, minimize, and close',
      headerButtons.some((b) => b.includes('Fullscreen')) &&
        headerButtons.some((b) => b.includes('Minimize')) &&
        headerButtons.some((b) => b.includes('Close')),
      headerButtons.join(' | ')
    );

    await page.evaluate(() => {
      [...document.querySelectorAll('.term-overlay .overlay-head .btn')]
        .find((b) => b.textContent.includes('Fullscreen'))
        ?.click();
    });
    await sleep(400);
    check(
      'fullscreen expands terminal overlay',
      await page.$eval('.term-overlay', (e) => e.classList.contains('fullscreen')).catch(() => false)
    );
    await page.evaluate(() => {
      [...document.querySelectorAll('.term-overlay .overlay-head .btn')]
        .find((b) => b.textContent.includes('Back'))
        ?.click();
    });
    await sleep(400);
    check(
      'Back exits fullscreen',
      await page.$eval('.term-overlay', (e) => !e.classList.contains('fullscreen')).catch(() => false)
    );

    await page.evaluate(() => {
      [...document.querySelectorAll('.term-overlay .overlay-head .btn')]
        .find((b) => b.textContent.includes('Minimize'))
        ?.click();
    });
    await sleep(600);
    const minimizedState = await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      const run = [...(r?.querySelectorAll('.row-actions .btn') || [])].find((x) =>
        x.textContent.includes('Running')
      );
      return {
        backdropHidden: document.querySelector('.term-backdrop')?.classList.contains('term-minimized'),
        rowRunning: Boolean(run),
        dockRunning: Boolean(document.querySelector('.terminal-dock')),
      };
    }, LIVE_CHORE);
    check(
      'minimize hides terminal but marks session running',
      minimizedState.backdropHidden && minimizedState.rowRunning && !minimizedState.dockRunning,
      JSON.stringify(minimizedState)
    );

    await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      [...(r?.querySelectorAll('.row-actions .btn') || [])]
        .find((b) => b.textContent.includes('Running'))
        ?.click();
    }, LIVE_CHORE);
    await sleep(800);
    const restoredText = await page
      .$eval('.term-overlay', (e) => e.innerText)
      .catch(() => '');
    check(
      'Running restores terminal with buffered output',
      /FAKE-CLAUDE ready/.test(restoredText),
      restoredText.slice(0, 90).replace(/\n/g, ' ')
    );

    // ---- parallel sessions: opening a second, different session must not block on the first ----
    // LIVE_CHORE's terminal is active right now. Clicking Run on a different row used to toast
    // "Close the current terminal before opening another session." and refuse to open anything.
    await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      [...r.querySelectorAll('.row-actions .btn')].find((x) => x.textContent.includes('Run'))?.click();
    }, LIVE_CHORE2);
    await page.waitForSelector('.run-menu-item', { timeout: 5000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.run-menu-item')]
        .find((b) => b.textContent.includes('claude'))
        ?.click();
    });
    await sleep(2000);

    const noBlockToast = await page.evaluate(() =>
      [...document.querySelectorAll('.toast')].every(
        (t) => !t.textContent.includes('Close the current terminal')
      )
    );
    check('opening a second session does not toast the old single-terminal block', noBlockToast);

    const parallelState = await page.evaluate((files) => {
      const backdrops = [...document.querySelectorAll('.term-backdrop')];
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const runningFor = (file) => {
        const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
        return Boolean(
          [...(r?.querySelectorAll('.row-actions .btn') || [])].find((b) =>
            b.textContent.includes('Running')
          )
        );
      };
      return {
        totalOverlays: backdrops.length,
        visibleOverlays: backdrops.filter((b) => !b.classList.contains('term-minimized')).length,
        liveChoreRunning: runningFor(files[0]),
        liveChore2Running: runningFor(files[1]),
      };
    }, [LIVE_CHORE, LIVE_CHORE2]);
    check(
      'two terminals stay open at once, one on screen and one minimized',
      parallelState.totalOverlays === 2 &&
        parallelState.visibleOverlays === 1 &&
        parallelState.liveChoreRunning &&
        parallelState.liveChore2Running,
      JSON.stringify(parallelState)
    );

    const secondTermText = await page
      .$eval('.term-backdrop:not(.term-minimized) .term-overlay', (e) => e.innerText)
      .catch(() => '');
    check(
      'the visible terminal is the second session, not a re-render of the first',
      secondTermText.includes(SID2),
      secondTermText.slice(0, 90).replace(/\n/g, ' ')
    );

    // Close the second session — the first must survive untouched, still resumable.
    await page.evaluate(() => {
      [...document.querySelectorAll('.term-backdrop:not(.term-minimized) .btn')]
        .find((b) => b.textContent.includes('Close'))
        ?.click();
    });
    await sleep(2000);
    const sid2StillRunning = await new Promise((resolve) => {
      const p = spawn('ps', ['-axo', 'args=']);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s.includes(`--resume ${SID2}`)));
    });
    check('closing the second popup terminates only that session', !sid2StillRunning);
    const firstSurvived = await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      return Boolean(
        [...(r?.querySelectorAll('.row-actions .btn') || [])].find((b) =>
          b.textContent.includes('Running')
        )
      );
    }, LIVE_CHORE);
    check('the first session is still marked running after closing the second', firstSurvived);

    // Bring the first session back on screen for the close-terminates check below.
    await page.evaluate((file) => {
      const rows = [...document.querySelectorAll('.panel:last-of-type tbody tr.row')];
      const r = rows.find((x) => x.querySelector('.cell-file')?.textContent.trim() === file);
      [...(r?.querySelectorAll('.row-actions .btn') || [])]
        .find((b) => b.textContent.includes('Running'))
        ?.click();
    }, LIVE_CHORE);
    await sleep(600);

    // ✕ must terminate the process, not just hide the popup.
    await page.evaluate(() => {
      [...document.querySelectorAll('.term-overlay .btn')]
        .find((b) => b.textContent.includes('Close'))
        ?.click();
    });
    await sleep(2500);
    const stillRunning = await new Promise((resolve) => {
      const p = spawn('ps', ['-axo', 'args=']);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s.includes(`--resume ${SID}`)));
    });
    check('closing the popup terminates the session', !stillRunning);

    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' ; '));
    await browser.close();
  } else {
    log('SKIP browser checks — Brave not found');
  }

  // ---- real data untouched ----
  check('real work chores untouched', snapshotDir(WCHORES) === workBefore, `[${workBefore}]`);
  check(
    'real work chore index untouched',
    (() => {
      try {
        return fs.readFileSync(path.join(WCHORES, 'index.txt'), 'utf8') === workIndexBefore;
      } catch {
        return workIndexBefore === '';
      }
    })()
  );
} finally {
  server?.kill('SIGTERM');
  await sleep(400);
  teardown();
}

console.log(failures ? `\n[term] ${failures} CHECK(S) FAILED` : '\n[term] ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
